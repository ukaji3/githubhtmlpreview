/*
 * GitHub HTML Preview : background service worker
 *
 *  1. Authenticated cross-origin fetch proxy (GHHP_FETCH). Cross-origin reads
 *     (incl. the github.com/.../raw -> raw.githubusercontent.com 302) must run
 *     here: content scripts use the page origin and don't get the extension's
 *     host_permissions CORS bypass. The SW fetch sends login cookies and
 *     bypasses CORS for hosts in host_permissions -> enables PRIVATE repos.
 *  2. Toolbar action click -> tell the active tab's content script to toggle
 *     the inline preview.
 *
 * Security: only github.com / raw.githubusercontent.com URLs are fetchable;
 * messages are accepted only from this extension's own contexts.
 */
'use strict';

importScripts(chrome.runtime.getURL('src/lib/util.js'));
const U = globalThis.GHHPUtil;

// Hard cap on a single proxied response body (25 MiB). Bounds memory use for
// the base64/data: inlining done downstream and limits abuse of the proxy.
const MAX_BYTES = 25 * 1024 * 1024;

async function doFetch(url, as) {
  // 1) Validate the REQUESTED url (https + github.com/*.githubusercontent.com).
  if (!U.isAllowedUrl(url)) return { ok: false, status: 0, error: 'blocked url' };
  const r = await fetch(url, { credentials: 'include', redirect: 'follow' });
  // 2) redirect:'follow' may land on a different host; re-validate the FINAL
  //    url so a 302 cannot send login cookies / leak the body to a host that
  //    is not in our allow-list.
  if (!U.isAllowedUrl(r.url)) return { ok: false, status: 0, error: 'redirect to disallowed host' };
  if (!r.ok) return { ok: false, status: r.status };
  // 3a) Reject oversize bodies up front when the server declares a length.
  const clen = Number(r.headers.get('content-length'));
  if (Number.isFinite(clen) && clen > MAX_BYTES) {
    return { ok: false, status: 0, error: 'response too large' };
  }
  if (as === 'dataurl') {
    const buf = await r.arrayBuffer();
    // 3b) Content-Length can be absent (e.g. chunked); enforce on real size.
    if (buf.byteLength > MAX_BYTES) return { ok: false, status: 0, error: 'response too large' };
    const mime = U.extMime(url)
      || (r.headers.get('content-type') || '').split(';')[0]
      || 'application/octet-stream';
    return { ok: true, status: r.status, body: 'data:' + mime + ';base64,' + U.abToBase64(buf) };
  }
  const text = await r.text();
  // 3b) Same real-size guard for text bodies when Content-Length is missing.
  if (text.length > MAX_BYTES) return { ok: false, status: 0, error: 'response too large' };
  return { ok: true, status: r.status, body: text };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!_sender || _sender.id !== chrome.runtime.id) return false; // only our own extension contexts
  if (msg && msg.type === 'GHHP_FETCH' && typeof msg.url === 'string') {
    doFetch(msg.url, msg.as || 'text')
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, status: 0, error: e.message }));
    return true; // async
  }
  return false;
});

// Toolbar icon click -> toggle the inline preview on the active tab.
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'GHHP_TOGGLE_PREVIEW' }, () => void chrome.runtime.lastError);
  }
});
