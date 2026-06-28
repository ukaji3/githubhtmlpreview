/*
 * GitHub HTML Preview — Spike : viewer (SANDBOXED extension page)
 * Declared under manifest "sandbox.pages", so it runs with the relaxed sandbox
 * CSP (inline + eval + whitelisted CDNs) and an OPAQUE origin. This is the only
 * MV3-legal context that can execute arbitrary fetched HTML/JS, including the
 * page's own scripts and CDN libraries (KaTeX, fonts).
 *
 * It receives the self-contained HTML from the host page and writes it into its
 * own document. The localStorage shim (injected upstream) keeps the page's
 * storage usage working despite the opaque origin.
 */
(function () {
  'use strict';

  function log(msg) {
    try { parent.postMessage({ type: 'GHHP_VIEWER_LOG', msg: String(msg) }, '*'); } catch (e) { /* noop */ }
  }

  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'GHHP_RENDER') return;
    try {
      document.open();
      document.write(e.data.html);
      document.close();
      log('rendered (' + (e.data.html ? e.data.html.length : 0) + ' bytes)');
    } catch (err) {
      log('render error: ' + err.message);
    }
  });

  // Announce readiness so the host knows it can post the payload.
  parent.postMessage({ type: 'GHHP_VIEWER_READY' }, '*');
})();
