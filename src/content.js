/*
 * GitHub HTML Preview : content script (runs on github.com)
 *
 * On an HTML blob page, shows a "Preview" button. Clicking it (or the toolbar
 * icon) acquires the page via the shared GHHP module and opens a rendered
 * preview in a new tab. Status/errors are shown as a transient toast.
 */
(function () {
  'use strict';

  const BTN_ID = 'ghhp-preview-btn';
  let busy = false;

  function toast(msg, isError) {
    let t = document.getElementById('ghhp-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ghhp-toast';
      t.style.cssText =
        'position:fixed;right:16px;bottom:64px;z-index:2147483647;max-width:360px;' +
        'padding:10px 14px;border-radius:8px;font:13px system-ui,sans-serif;color:#fff;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.35);word-break:break-word;transition:opacity .3s;';
      document.body.appendChild(t);
    }
    t.style.background = isError ? '#b3261e' : '#1f2328';
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, isError ? 7000 : 3500);
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  async function runPreview() {
    const info = GHHP.parseBlob();
    if (!info) { toast('HTML ファイルのページではありません。', true); return; }
    if (busy) return;
    busy = true;
    const btn = document.getElementById(BTN_ID);
    const label = btn ? btn.textContent : '';
    if (btn) { btn.textContent = '⏳ 取得中…'; btn.disabled = true; }
    const report = {
      startedAt: new Date().toISOString(), info,
      mainOk: false, main: '', assetsOk: 0, assetsFail: [], error: null
    };
    try {
      const finalHtml = await GHHP.acquire(info, report);
      const id = uid();
      await chrome.storage.local.set({ ['bundle:' + id]: { finalHtml, report, ts: Date.now() } });
      await cleanupOldBundles(id);
      const hostUrl = chrome.runtime.getURL('src/host.html') + '#' + id;
      chrome.runtime.sendMessage({ type: 'OPEN_PREVIEW_TAB', url: hostUrl });
      const failNote = report.assetsFail.length ? `(一部アセット失敗 ${report.assetsFail.length})` : '';
      toast(`プレビューを新しいタブで開きました ${failNote}`.trim());
    } catch (e) {
      console.error('[GHHP] preview failed', e);
      const m = /HTTP (401|403|404)/.test(e.message)
        ? 'このファイルを取得できません。GitHub にログイン済みか、アクセス権があるか確認してください。'
        : 'プレビューの生成に失敗しました: ' + e.message;
      toast(m, true);
    } finally {
      busy = false;
      const b = document.getElementById(BTN_ID);
      if (b) { b.textContent = label || '▶ HTML Preview'; b.disabled = false; }
    }
  }

  // Keep only the most recent few bundles to bound storage usage.
  async function cleanupOldBundles(keepId) {
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all)
        .filter((k) => k.startsWith('bundle:') && k !== 'bundle:' + keepId)
        .map((k) => ({ k, ts: (all[k] && all[k].ts) || 0 }))
        .sort((a, b) => b.ts - a.ts);
      const stale = keys.slice(3).map((x) => x.k); // keep newest 3 (besides current)
      if (stale.length) await chrome.storage.local.remove(stale);
    } catch (e) { /* best effort */ }
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    if (!GHHP.parseBlob()) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = '▶ HTML Preview';
    btn.title = 'このHTMLファイルをレンダリングしてプレビュー';
    btn.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:9px 14px;' +
      'border-radius:9px;border:0;background:#3a36c4;color:#fff;font:600 13px system-ui,sans-serif;' +
      'cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.35);';
    btn.addEventListener('click', runPreview);
    document.body.appendChild(btn);
  }

  // GitHub is a SPA: keep the button in sync with soft navigations.
  function tick() {
    if (GHHP.parseBlob()) {
      injectButton();
    } else {
      const b = document.getElementById(BTN_ID);
      if (b) b.remove();
    }
  }

  // Toolbar icon -> preview current tab.
  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === 'GHHP_RUN_PREVIEW') runPreview();
  });

  setInterval(tick, 1200);
  tick();
})();
