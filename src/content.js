/*
 * GitHub HTML Preview : content script controller (runs on github.com)
 *
 * Wires the UI helpers (GHHPUi) to acquisition (GHHP.acquire), the sandbox
 * viewer (viewer.html WAR), and GitHub's SPA lifecycle. UI/DOM matching logic
 * lives in src/ui.js (verified separately in a real DOM); this file owns state,
 * fetching/rendering, messaging, and re-sync.
 */
(function () {
  'use strict';

  const U = globalThis.GHHPUtil;
  const Ui = globalThis.GHHPUi;
  // GitHub Markdown opens rendered (Preview) by default; mirror that.
  const DEFAULT_TO_PREVIEW = true;

  // Tunables (extracted from former inline literals; values are unchanged so
  // behaviour is preserved while becoming configurable in one place).
  const MIN_FRAME_H = 200;        // px: minimum viewer iframe height
  const MAX_FRAME_H = 20000;      // px: clamp runaway content height (e.g. height:100vh)
  const INITIAL_FRAME_H = 480;    // px: initial iframe height before content reports back
  const RAF_FALLBACK_MS = 300;    // ms: sync fallback when rAF is throttled (background tab)
  const POLL_MS = 1500;           // ms: periodic re-sync against SPA/React re-renders
  const CACHE_MAX = 20;           // max cached rendered HTML docs (simple bounded LRU)

  let previewInfo = null;   // { owner, repo, branch, filepath } currently previewed
  let previewActive = false;
  let currentFrame = null;  // the live viewer iframe
  let pendingHtml = '';     // payload to post once the viewer signals READY
  let lastKey = null;       // detects soft navigation to another file
  let autoActivated = false;
  let pendingAutoPreview = false; // set when navigating blame→blob for Preview
  let building = false;      // guards against re-entrant renders during an in-flight acquire
  let renderSeq = 0;         // monotonic render id; only the latest render may commit (M-1)
  const htmlCache = new Map(); // key: owner/repo/branch/filepath -> rendered HTML (H-1, M-3)

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'));
  }

  function errorDoc(path, msg) {
    return '<!DOCTYPE html><meta charset="utf-8"><body style="font:14px system-ui,sans-serif;color:#cf222e;padding:24px">'
      + '<h3>プレビューを生成できませんでした</h3><p><code>' + escapeHtml(path) + '</code></p>'
      + '<pre style="white-space:pre-wrap;color:#57606a">' + escapeHtml(msg) + '</pre>'
      + '<p style="color:#57606a">GitHub にログイン済みか、ファイルへのアクセス権があるか確認してください。</p></body>';
  }

  // Cache key includes the full file coordinates so the same path under a
  // different owner/repo/branch never collides and shows a stale doc (H-1).
  function cacheKey(info) {
    return info.owner + '/' + info.repo + '/' + info.branch + '/' + info.filepath;
  }

  // Bounded insert into the rendered-HTML cache: a Map preserves insertion
  // order, so evicting keys().next() drops the oldest entry once over the
  // cap (simple LRU, M-3).
  function cacheSet(key, html) {
    htmlCache.set(key, html);
    if (htmlCache.size > CACHE_MAX) {
      const oldest = htmlCache.keys().next().value;
      if (oldest !== undefined) htmlCache.delete(oldest);
    }
  }

  async function renderPath(path) {
    const host = Ui.ensureHost();
    if (!host) return;
    const seq = ++renderSeq;   // claim the latest render slot (M-1)
    building = true;
    try {
      host.textContent = '';
      const loading = document.createElement('div');
      loading.style.cssText = 'padding:24px;font:14px system-ui,sans-serif;color:#57606a';
      loading.textContent = '読み込み中… ' + path;
      host.appendChild(loading);

      const info = { owner: previewInfo.owner, repo: previewInfo.repo, branch: previewInfo.branch, filepath: path };
      const key = cacheKey(info);
      const report = { startedAt: new Date().toISOString(), info, mainOk: false, main: '', assetsOk: 0, assetsFail: [], error: null };
      let html = htmlCache.get(key);
      if (html == null) {
        try {
          html = await GHHP.acquire(info, report);
          // Abort if a newer render started or the user left Preview while the
          // (async) acquire was in flight: only the latest render commits (M-1).
          if (seq !== renderSeq || !previewActive) return;
          // Only cache a fully-assembled render: if any asset failed to inline,
          // a transient fetch miss must not be baked in for the rest of the
          // session (next view re-attempts and can self-heal).
          if (report.assetsFail.length === 0) cacheSet(key, html);
        } catch (e) {
          if (seq !== renderSeq || !previewActive) return;
          html = errorDoc(path, e.message);
        }
      }
      if (seq !== renderSeq || !previewActive) return; // stale render or user switched back to Code
      previewInfo = info;
      pendingHtml = html;

      // Fresh viewer iframe AFTER payload is ready: the viewer's READY signal
      // triggers exactly one GHHP_RENDER carrying the correct HTML.
      host.textContent = '';
      const frame = document.createElement('iframe');
      frame.id = Ui.FRAME_ID;
      // Height follows the rendered content (see GHHP_VIEWER_HEIGHT handler) so
      // there is no inner iframe scrollbar -> single page scrollbar, matching
      // GitHub Markdown. Start at a sensible min to avoid an initial flash.
      frame.style.cssText = 'width:100%;height:' + INITIAL_FRAME_H + 'px;border:0;background:#fff;display:block;';
      frame.scrolling = 'no';
      frame.src = chrome.runtime.getURL('src/viewer.html'); // WAR + manifest sandbox page
      host.appendChild(frame);
      currentFrame = frame;
    } finally {
      // Only the most recent render clears the in-flight guard, so an older
      // render returning early cannot reopen the door for sync() while the
      // latest acquire is still pending (M-1).
      if (seq === renderSeq) building = false;
    }
  }

  async function activatePreview() {
    const info = GHHP.parseBlob();
    if (!info) return;
    // Markdown-style: Preview lives on the /blob/ view. If on /blame/,
    // navigate to /blob/ via the Code tab's SPA link (preserves content script
    // state + htmlCache, avoiding a full re-render).
    if (/\/blame\//.test(location.pathname)) {
      const ul = Ui.segControl();
      if (ul) {
        const codeBtn = Array.from(ul.querySelectorAll(':scope > li:not([' + Ui.PREVIEW_TAB_ATTR + ']) button'))
          .find((b) => { const t = b.textContent.trim().toLowerCase(); return t === 'code'; });
        if (codeBtn) {
          // Flag so sync() auto-activates Preview after the SPA nav lands.
          pendingAutoPreview = true;
          codeBtn.click();
          return;
        }
      }
      // Fallback: hard navigate if we can't find the Code button.
      pendingAutoPreview = true;
      location.pathname = location.pathname.replace(/\/blame\//, '/blob/');
      return;
    }
    previewInfo = info;
    previewActive = true;
    Ui.markSelected(true);
    Ui.showPreviewArea();
    await renderPath(info.filepath);
  }

  function deactivatePreview() {
    previewActive = false;
    currentFrame = null;
    Ui.markSelected(false);
    Ui.hidePreviewArea();
  }

  window.addEventListener('message', (e) => {
    if (!currentFrame || e.source !== currentFrame.contentWindow || !e.data) return;
    if (e.data.type === 'GHHP_VIEWER_READY') {
      currentFrame.contentWindow.postMessage({ type: 'GHHP_RENDER', html: pendingHtml }, '*');
    } else if (e.data.type === 'GHHP_VIEWER_HEIGHT' && typeof e.data.height === 'number') {
      // size the iframe to its content (single page scrollbar). Clamp to avoid
      // runaway growth from pages using fixed `height:100vh` etc.
      const h = Math.min(Math.max(e.data.height, MIN_FRAME_H), MAX_FRAME_H);
      currentFrame.style.height = h + 'px';
    } else if (e.data.type === 'GHHP_NAV' && e.data.path) {
      const safe = U.resolveNavPath(e.data.path, previewInfo);
      if (safe) renderPath(safe);
    }
  });

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === 'GHHP_TOGGLE_PREVIEW') {
      if (previewActive) deactivatePreview(); else activatePreview();
    }
  });

  function sync() {
    const info = GHHP.parseBlob();
    if (!info) { lastKey = null; return; }
    const key = info.owner + '/' + info.repo + '/' + info.branch + '/' + info.filepath;
    if (key !== lastKey) {
      lastKey = key;
      previewActive = false;
      currentFrame = null;
      autoActivated = false;
      const stale = document.getElementById(Ui.HOST_ID);
      if (stale) stale.remove();
    }
    const ul = Ui.segControl();
    if (!ul) return;
    Ui.injectPreviewTab(ul, { onPreview: activatePreview, onLeave: deactivatePreview });
    Ui.bindGithubItems(ul, deactivatePreview);
    if (DEFAULT_TO_PREVIEW && !autoActivated && !previewActive) {
      autoActivated = true;
      activatePreview();
    }
    if (pendingAutoPreview && !previewActive && !building) {
      pendingAutoPreview = false;
      activatePreview();
    }
    if (previewActive) {
      // re-assert against a React re-render that reset our state/area
      Ui.markSelected(true);
      Ui.showPreviewArea();
      if (!building && !document.getElementById(Ui.FRAME_ID) && previewInfo) renderPath(previewInfo.filepath);
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    let done = false;
    const run = () => { if (done) return; done = true; scheduled = false; try { sync(); } catch (e) { /* keep observer alive */ } };
    requestAnimationFrame(run); // fast path
    setTimeout(run, RAF_FALLBACK_MS); // fallback when rAF is throttled (e.g., background tab)
  }

  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(schedule, POLL_MS);
  schedule();
})();
