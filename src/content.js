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
  // GitHub Markdown opens rendered (Preview) by default. Kept false so page
  // scripts are not auto-executed on every file open; set true to fully mirror.
  const DEFAULT_TO_PREVIEW = false;

  let previewInfo = null;   // { owner, repo, branch, filepath } currently previewed
  let previewActive = false;
  let currentFrame = null;  // the live viewer iframe
  let pendingHtml = '';     // payload to post once the viewer signals READY
  let lastKey = null;       // detects soft navigation to another file
  let autoActivated = false;
  let building = false;      // guards against re-entrant renders during an in-flight acquire
  const htmlCache = new Map();

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'));
  }

  function errorDoc(path, msg) {
    return '<!DOCTYPE html><meta charset="utf-8"><body style="font:14px system-ui,sans-serif;color:#cf222e;padding:24px">'
      + '<h3>プレビューを生成できませんでした</h3><p><code>' + escapeHtml(path) + '</code></p>'
      + '<pre style="white-space:pre-wrap;color:#57606a">' + escapeHtml(msg) + '</pre>'
      + '<p style="color:#57606a">GitHub にログイン済みか、ファイルへのアクセス権があるか確認してください。</p></body>';
  }

  async function renderPath(path) {
    const host = Ui.ensureHost();
    if (!host) return;
    building = true;
    try {
      host.textContent = '';
      const loading = document.createElement('div');
      loading.style.cssText = 'padding:24px;font:14px system-ui,sans-serif;color:#57606a';
      loading.textContent = '読み込み中… ' + path;
      host.appendChild(loading);

      const info = { owner: previewInfo.owner, repo: previewInfo.repo, branch: previewInfo.branch, filepath: path };
      const report = { startedAt: new Date().toISOString(), info, mainOk: false, main: '', assetsOk: 0, assetsFail: [], error: null };
      let html = htmlCache.get(path);
      if (html == null) {
        try {
          html = await GHHP.acquire(info, report);
          htmlCache.set(path, html);
        } catch (e) {
          html = errorDoc(path, e.message);
        }
      }
      if (!previewActive) return; // user switched back to Code while fetching
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
      frame.style.cssText = 'width:100%;height:480px;border:0;background:#fff;display:block;';
      frame.scrolling = 'no';
      frame.src = chrome.runtime.getURL('src/viewer.html'); // WAR + manifest sandbox page
      host.appendChild(frame);
      currentFrame = frame;
    } finally {
      building = false;
    }
  }

  async function activatePreview() {
    const info = GHHP.parseBlob();
    if (!info) return;
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
      const h = Math.min(Math.max(e.data.height, 200), 20000);
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
    setTimeout(run, 300);       // fallback when rAF is throttled (e.g., background tab)
  }

  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(schedule, 1500);
  schedule();
})();
