/*
 * GitHub HTML Preview : host page (NON-sandbox extension page)
 *
 * - Reads the assembled HTML + repo context from chrome.storage.session.
 * - Toolbar: Back (history), current file path, "Open on GitHub", "Raw".
 * - Feeds the SANDBOXED viewer iframe; recreates it per render so its message
 *   listener is never lost to document.write.
 * - In-tab navigation: viewer posts GHHP_NAV (internal *.html click) ->
 *   re-acquire via the shared GHHP module and re-render in this tab.
 */
(function () {
  'use strict';

  const U = globalThis.GHHPUtil;
  const id = location.hash.slice(1);

  const fileEl = document.getElementById('file');
  const backEl = document.getElementById('back');
  const ghEl = document.getElementById('gh');
  const rawEl = document.getElementById('raw');
  const bannerEl = document.getElementById('banner');

  let repo = null;            // { owner, repo, branch }
  const history = [];         // stack of repo-relative paths
  let pendingHtml = '';

  function currentPath() { return history[history.length - 1] || ''; }

  function showBanner(msg) {
    if (!msg) { bannerEl.style.display = 'none'; bannerEl.textContent = ''; return; }
    bannerEl.style.display = 'block';
    bannerEl.textContent = msg;
  }

  function updateBar() {
    const p = currentPath();
    const full = repo ? `${repo.owner}/${repo.repo}@${repo.branch}/${p}` : p;
    fileEl.textContent = full;
    fileEl.title = full;
    backEl.disabled = history.length <= 1;
    if (repo) {
      const info = { owner: repo.owner, repo: repo.repo, branch: repo.branch, filepath: p };
      ghEl.href = U.blobUrl(info);
      rawEl.href = U.rawUrl(info);
    }
  }

  function postRender() {
    const f = document.getElementById('frame');
    if (f && f.contentWindow && pendingHtml) {
      f.contentWindow.postMessage({ type: 'GHHP_RENDER', html: pendingHtml }, '*');
    }
  }

  // Fresh viewer per render: document.write destroys the previous listener.
  function freshViewer() {
    const old = document.getElementById('frame');
    const nf = document.createElement('iframe');
    nf.id = 'frame';
    nf.src = 'viewer.html';
    old.replaceWith(nf);
  }

  function newReport(info) {
    return { startedAt: new Date().toISOString(), info, mainOk: false, main: '', assetsOk: 0, assetsFail: [], error: null };
  }

  // Acquire `path` and render it. push=true appends to history.
  async function render(path, push) {
    if (!repo) return;
    const info = { owner: repo.owner, repo: repo.repo, branch: repo.branch, filepath: path };
    const report = newReport(info);
    showBanner('');
    fileEl.textContent = '読み込み中… ' + path;
    let finalHtml;
    try {
      finalHtml = await GHHP.acquire(info, report);
    } catch (e) {
      console.error('[GHHP host] acquire failed', e);
      const m = /HTTP (401|403|404)/.test(e.message)
        ? `「${path}」を取得できません(権限またはログインを確認してください)。`
        : `「${path}」の取得に失敗しました: ${e.message}`;
      showBanner(m);
      if (push && history.length === 0) history.push(path);
      updateBar();
      return;
    }
    if (push) history.push(path);
    if (report.assetsFail.length) {
      showBanner(`一部アセットの取得に失敗しました(${report.assetsFail.length}件)。表示が一部崩れる可能性があります。`);
    }
    pendingHtml = finalHtml;
    updateBar();
    freshViewer(); // -> viewer READY -> postRender()
  }

  backEl.addEventListener('click', () => {
    if (history.length <= 1) return;
    history.pop();
    render(currentPath(), false);
  });

  window.addEventListener('message', (e) => {
    const f = document.getElementById('frame');
    if (!f || e.source !== f.contentWindow || !e.data) return; // only trust our own viewer iframe
    if (e.data.type === 'GHHP_VIEWER_READY') { postRender(); }
    else if (e.data.type === 'GHHP_VIEWER_LOG') { console.log('[GHHP viewer]', e.data.msg); }
    else if (e.data.type === 'GHHP_NAV' && e.data.path && repo) {
      const safe = U.resolveNavPath(e.data.path, { owner: repo.owner, repo: repo.repo, branch: repo.branch, filepath: currentPath() });
      if (safe) render(safe, true);
      else showBanner('リンク先がこのリポジトリ外のため、遷移を中止しました。');
    }
  });

  chrome.storage.session.get('bundle:' + id, (o) => {
    const key = 'bundle:' + id;
    const b = o && o[key];
    chrome.storage.session.remove(key); // one-shot handoff: consume immediately on every path
    if (!b || !b.report || !b.report.info) {
      showBanner('プレビュー内容が見つかりませんでした(再度プレビューしてください)。');
      return;
    }
    const info = b.report.info;
    repo = { owner: info.owner, repo: info.repo, branch: info.branch };
    history.push(info.filepath);
    pendingHtml = b.finalHtml || '';
    if (b.report.assetsFail && b.report.assetsFail.length) {
      showBanner(`一部アセットの取得に失敗しました(${b.report.assetsFail.length}件)。`);
    }
    updateBar();
    postRender(); // initial viewer iframe is already present
  });
})();
