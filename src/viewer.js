/*
 * GitHub HTML Preview : viewer (SANDBOXED extension page)
 * Declared under manifest "sandbox.pages", so it runs with the relaxed sandbox
 * CSP (inline + eval + whitelisted CDNs) and an OPAQUE origin. This is the only
 * MV3-legal context that can execute arbitrary fetched HTML/JS, including the
 * page's own scripts and CDN libraries (KaTeX, fonts).
 *
 * It receives the self-contained HTML from the host, writes it into its own
 * document, and reports the rendered content height to the parent so the parent
 * can size the iframe to its content. That keeps a SINGLE (page) scrollbar,
 * matching GitHub's Markdown preview (no inner iframe scrollbar / no double bar).
 */
(function () {
  'use strict';

  function log(msg) {
    try { parent.postMessage({ type: 'GHHP_VIEWER_LOG', msg: String(msg) }, '*'); } catch (e) { /* noop */ }
  }

  function measuredHeight() {
    var de = document.documentElement, b = document.body;
    return Math.max(
      de ? de.scrollHeight : 0, de ? de.offsetHeight : 0,
      b ? b.scrollHeight : 0, b ? b.offsetHeight : 0
    );
  }

  function postHeight() {
    try { parent.postMessage({ type: 'GHHP_VIEWER_HEIGHT', height: measuredHeight() }, '*'); } catch (e) { /* noop */ }
  }

  var hTimer = null;
  function postHeightDebounced() {
    if (hTimer) return;
    hTimer = setTimeout(function () { hTimer = null; postHeight(); }, 80);
  }

  // After rendering, report the content height now and again as async assets
  // (CDN scripts, web fonts, KaTeX, images) change layout.
  function setupHeightReporting() {
    postHeight();
    [50, 200, 600, 1200, 2500].forEach(function (t) { setTimeout(postHeight, t); });
    try { window.addEventListener('load', postHeight); } catch (e) { /* noop */ }
    try {
      if (window.ResizeObserver) {
        var ro = new ResizeObserver(postHeightDebounced);
        if (document.documentElement) ro.observe(document.documentElement);
        if (document.body) ro.observe(document.body);
      }
    } catch (e) { /* noop */ }
  }

  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'GHHP_RENDER') return;
    try {
      document.open();
      document.write(e.data.html);
      document.close();
      log('rendered (' + (e.data.html ? e.data.html.length : 0) + ' bytes)');
      setupHeightReporting();
    } catch (err) {
      log('render error: ' + err.message);
    }
  });

  // Announce readiness so the parent knows it can post the payload.
  parent.postMessage({ type: 'GHHP_VIEWER_READY' }, '*');
})();
