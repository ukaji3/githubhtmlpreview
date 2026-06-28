/*
 * GitHub HTML Preview : background service worker
 *
 *  1. Authenticated cross-origin fetch proxy (GHHP_FETCH). Cross-origin reads
 *     (incl. the github.com/.../raw -> raw.githubusercontent.com 302) must run
 *     here: content scripts use the page origin and don't get the extension's
 *     host_permissions CORS bypass. The SW fetch sends login cookies and
 *     bypasses CORS for hosts in host_permissions -> enables PRIVATE repos.
 *  2. Open the preview host page in a new tab (OPEN_PREVIEW_TAB).
 *  3. Toolbar action click -> ask the active tab's content script to preview.
 *
 * Security: only github.com / raw.githubusercontent.com URLs are fetchable.
 */
'use strict';

importScripts(chrome.runtime.getURL('src/lib/util.js'));
const U = globalThis.GHHPUtil;

// Let the content script (untrusted context) use storage.session for the
// one-shot preview handoff (kept in memory, never persisted to disk).
try {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch (e) { /* older Chrome without setAccessLevel */ }

const ALLOW = ['https://github.com/', 'https://raw.githubusercontent.com/'];
function allowed(url) { return ALLOW.some((p) => url.startsWith(p)); }

async function doFetch(url, as) {
  if (!allowed(url)) return { ok: false, status: 0, error: 'blocked url' };
  const r = await fetch(url, { credentials: 'include', redirect: 'follow' });
  if (!r.ok) return { ok: false, status: r.status };
  if (as === 'dataurl') {
    const buf = await r.arrayBuffer();
    const mime = U.extMime(url)
      || (r.headers.get('content-type') || '').split(';')[0]
      || 'application/octet-stream';
    return { ok: true, status: r.status, body: 'data:' + mime + ';base64,' + U.abToBase64(buf) };
  }
  return { ok: true, status: r.status, body: await r.text() };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!_sender || _sender.id !== chrome.runtime.id) return false; // only our own extension contexts
  if (msg && msg.type === 'OPEN_PREVIEW_TAB' && typeof msg.url === 'string') {
    chrome.tabs.create({ url: msg.url }, (tab) => sendResponse({ ok: true, tabId: tab && tab.id }));
    return true;
  }
  if (msg && msg.type === 'GHHP_FETCH' && typeof msg.url === 'string') {
    doFetch(msg.url, msg.as || 'text')
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, status: 0, error: e.message }));
    return true; // async
  }
  return false;
});

// Toolbar icon click: trigger a preview of the current tab if it is an HTML blob.
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'GHHP_RUN_PREVIEW' }, () => void chrome.runtime.lastError);
  }
});
