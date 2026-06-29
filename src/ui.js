/*
 * GitHub HTML Preview : UI helpers (GHHPUi)
 *
 * Stateless DOM logic for matching GitHub's blob "File view" segmented control
 * (Preview | Code | Blame) and swapping the code area for the preview iframe.
 * Kept free of chrome.* / GHHP.acquire and side-effect-free at load time so it
 * can be unit-verified in a real DOM (headless Chrome) against GitHub's actual
 * SegmentedControl markup. All mutations are idempotent (written only when the
 * current value differs) to coexist with GitHub's React re-renders.
 *
 * Depends on GHHPUtil.segItemSelection (src/lib/util.js).
 */
(function () {
  'use strict';

  const U = globalThis.GHHPUtil;
  const SEG_SEL = 'ul[aria-label="File view"]';
  const PREVIEW_TAB_ATTR = 'data-ghhp-preview-tab';
  const BOUND_ATTR = 'data-ghhp-bound';
  const HOST_ID = 'ghhp-preview-host';
  const FRAME_ID = 'ghhp-preview-frame';

  function setAttr(el, n, v) { if (el && el.getAttribute(n) !== v) el.setAttribute(n, v); }
  function rmAttr(el, n) { if (el && el.hasAttribute(n)) el.removeAttribute(n); }
  function setVar(el, n, v) { if (el && el.style.getPropertyValue(n) !== v) el.style.setProperty(n, v); }
  function setDisplay(el, v) { if (el && el.style.display !== v) el.style.display = v; }

  function segControl() { return document.querySelector(SEG_SEL); }

  function codeArea() {
    return document.querySelector('[class*="CodeBlob-module__codeBlobWrapper"]')
      || document.querySelector('[class*="BlobContent-module__blobContentSection"]')
      || (document.querySelector('.react-code-file-contents') &&
          document.querySelector('.react-code-file-contents').closest('[class*="blobContentSection"], [class*="codeBlobWrapper"], section'));
  }

  function setItemSelected(li, on) {
    const st = U.segItemSelection(on);
    const btn = li.querySelector('button');
    if (st.dataSelected) setAttr(li, 'data-selected', ''); else rmAttr(li, 'data-selected');
    setAttr(btn, 'aria-current', st.ariaCurrent);
    setVar(btn, '--separator-color', st.separator);
  }

  function markSelected(previewOn) {
    const ul = segControl();
    if (!ul) return;
    const items = Array.from(ul.querySelectorAll(':scope > li'));
    const prev = items.find((li) => li.hasAttribute(PREVIEW_TAB_ATTR));
    const gh = items.filter((li) => !li.hasAttribute(PREVIEW_TAB_ATTR));
    if (!prev) return;
    if (previewOn) { setItemSelected(prev, true); gh.forEach((li) => setItemSelected(li, false)); }
    else { setItemSelected(prev, false); if (gh[0]) setItemSelected(gh[0], true); }
  }

  function bindGithubItems(ul, onLeave) {
    ul.querySelectorAll(':scope > li:not([' + PREVIEW_TAB_ATTR + ']) button').forEach((b) => {
      if (b.hasAttribute(BOUND_ATTR)) return;
      b.setAttribute(BOUND_ATTR, '');
      b.addEventListener('click', () => { if (onLeave) onLeave(); }, true); // Code/Blame leave preview
    });
  }

  // Clone an existing segment for pixel-exact Primer styling, relabel "Preview",
  // and insert it first -> matches Markdown's "Preview | Code | Blame".
  function injectPreviewTab(ul, handlers) {
    if (ul.querySelector('[' + PREVIEW_TAB_ATTR + ']')) return true; // already present
    const items = Array.from(ul.querySelectorAll(':scope > li'));
    if (!items.length) return false;

    const li = items[0].cloneNode(true);
    li.setAttribute(PREVIEW_TAB_ATTR, '');
    setItemSelected(li, false);
    const txt = li.querySelector('.segmentedControl-text, [data-text]') || li.querySelector('div, span');
    if (txt) { txt.textContent = 'Preview'; txt.setAttribute('data-text', 'Preview'); }
    const btn = li.querySelector('button');
    if (btn) {
      btn.removeAttribute('id');
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (handlers && handlers.onPreview) handlers.onPreview();
      });
    }
    ul.insertBefore(li, ul.firstChild);
    bindGithubItems(ul, handlers && handlers.onLeave);
    return true;
  }

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    const code = codeArea();
    if (!code || !code.parentElement) return null;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'width:100%;display:none;';
    code.parentElement.insertBefore(host, code.nextSibling);
    return host;
  }

  function showPreviewArea() {
    setDisplay(codeArea(), 'none');
    const host = ensureHost();
    if (host) setDisplay(host, '');
  }

  function hidePreviewArea() {
    const host = document.getElementById(HOST_ID);
    if (host) setDisplay(host, 'none');
    setDisplay(codeArea(), '');
  }

  globalThis.GHHPUi = {
    SEG_SEL: SEG_SEL, PREVIEW_TAB_ATTR: PREVIEW_TAB_ATTR, HOST_ID: HOST_ID, FRAME_ID: FRAME_ID,
    segControl: segControl, codeArea: codeArea, setItemSelected: setItemSelected,
    markSelected: markSelected, bindGithubItems: bindGithubItems, injectPreviewTab: injectPreviewTab,
    ensureHost: ensureHost, showPreviewArea: showPreviewArea, hidePreviewArea: hidePreviewArea
  };
})();
