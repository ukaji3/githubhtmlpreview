/*
 * GitHub HTML Preview : shared acquisition module (GHHP)
 *
 * Loaded in the content script (initial preview) and the host page
 * (in-preview navigation). Both are DOM contexts with DOMParser and can
 * message the background service worker for authenticated cross-origin fetches.
 *
 * acquire(info, report) -> self-contained HTML string:
 *   - Fetches main HTML + repo-relative assets via the SW (cookie auth -> works
 *     for private repos the user can access).
 *   - Inlines CSS (incl. url()), <style>, JS, images (src + srcset), <source>,
 *     <video poster>, <link rel=preload>, inline style="...url()", favicons.
 *   - Leaves external/CDN refs as-is (the sandbox CSP allows them).
 *   - Internal *.html links -> data-ghhp-nav + click interceptor (in-tab nav).
 *   - External links -> open in a new tab.
 *   - Injects a localStorage shim (opaque sandbox origin support).
 */
(function () {
  'use strict';

  const U = globalThis.GHHPUtil;

  async function swFetch(url, as) {
    const r = await chrome.runtime.sendMessage({ type: 'GHHP_FETCH', url, as });
    if (!r || !r.ok) {
      throw new Error('HTTP ' + (r ? r.status : '?') + (r && r.error ? ' ' + r.error : ''));
    }
    return r.body;
  }
  const fetchText = (u) => swFetch(u, 'text');
  const fetchDataUrl = (u) => swFetch(u, 'dataurl');

  async function dataUrlFor(absUrl, report) {
    try {
      const d = await fetchDataUrl(absUrl);
      report.assetsOk++;
      return d;
    } catch (e) {
      report.assetsFail.push(absUrl + ' :: ' + e.message);
      return null;
    }
  }

  async function processCssText(css, baseHref, info, report) {
    const refs = U.extractCssUrls(css).filter((r) => {
      const abs = U.resolveUrl(r.url, baseHref);
      return abs && U.isRepoRel(abs, info);
    });
    for (const r of refs) {
      const abs = U.resolveUrl(r.url, baseHref);
      const d = await dataUrlFor(abs, report);
      if (d) css = css.split(r.full).join('url(' + d + ')');
    }
    return css;
  }

  async function inlineSrcset(el, attr, baseHref, info, report) {
    const v = el.getAttribute(attr);
    if (!v) return;
    const list = U.parseSrcset(v);
    let changed = false;
    for (const item of list) {
      const abs = U.resolveUrl(item.url, baseHref);
      if (abs && U.isRepoRel(abs, info)) {
        const d = await dataUrlFor(abs, report);
        if (d) { item.url = d; changed = true; }
      }
    }
    if (changed) el.setAttribute(attr, U.buildSrcset(list));
  }

  async function inlineAttrUrl(el, attr, baseHref, info, report) {
    const ref = el.getAttribute(attr);
    if (!ref) return;
    const abs = U.resolveUrl(ref, baseHref);
    if (abs && U.isRepoRel(abs, info)) {
      const d = await dataUrlFor(abs, report);
      if (d) el.setAttribute(attr, d);
    }
  }

  // LS_SHIM / NAV_INTERCEPT scripts are provided by GHHPUtil (see src/lib/util.js).

  async function acquire(info, report) {
    const baseHref = U.dirHref(info);
    const mainUrl = U.rawUrl(info);
    report.main = mainUrl;

    const html = await fetchText(mainUrl);
    report.mainOk = true;

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const resolve = (ref) => U.resolveUrl(ref, baseHref);

    // <link rel=stylesheet> (repo) -> inline <style>; CDN left as-is
    for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
      const abs = resolve(link.getAttribute('href'));
      if (abs && U.isRepoRel(abs, info)) {
        try {
          let css = await fetchText(abs);
          css = await processCssText(css, abs, info, report);
          const style = doc.createElement('style');
          style.textContent = css;
          link.replaceWith(style);
          report.assetsOk++;
        } catch (e) { report.assetsFail.push(abs + ' :: ' + e.message); }
      }
    }

    // inline <style> blocks -> rewrite repo-relative url()
    for (const style of Array.from(doc.querySelectorAll('style'))) {
      if (style.textContent && /url\(/i.test(style.textContent)) {
        style.textContent = await processCssText(style.textContent, baseHref, info, report);
      }
    }

    // <script src> (repo) -> inline; CDN left as-is
    for (const s of Array.from(doc.querySelectorAll('script[src]'))) {
      const abs = resolve(s.getAttribute('src'));
      if (abs && U.isRepoRel(abs, info)) {
        try {
          const js = await fetchText(abs);
          const ns = doc.createElement('script');
          ns.textContent = js;
          if (s.type) ns.type = s.type;
          s.replaceWith(ns);
          report.assetsOk++;
        } catch (e) { report.assetsFail.push(abs + ' :: ' + e.message); }
      }
    }

    // images: src + srcset
    for (const img of Array.from(doc.querySelectorAll('img'))) {
      await inlineAttrUrl(img, 'src', baseHref, info, report);
      await inlineSrcset(img, 'srcset', baseHref, info, report);
      img.removeAttribute('loading');
    }
    // <picture><source>, <video><source>, <audio><source>
    for (const src of Array.from(doc.querySelectorAll('source'))) {
      await inlineAttrUrl(src, 'src', baseHref, info, report);
      await inlineSrcset(src, 'srcset', baseHref, info, report);
    }
    // media posters
    for (const v of Array.from(doc.querySelectorAll('video[poster]'))) {
      await inlineAttrUrl(v, 'poster', baseHref, info, report);
    }
    // <link rel=preload/icon/apple-touch-icon ...> hrefs
    for (const l of Array.from(doc.querySelectorAll('link[rel~="preload"][href], link[rel~="icon"][href], link[rel~="apple-touch-icon"][href], link[rel~="mask-icon"][href]'))) {
      await inlineAttrUrl(l, 'href', baseHref, info, report);
    }
    // inline style="...url()..."
    for (const el of Array.from(doc.querySelectorAll('[style]'))) {
      const st = el.getAttribute('style');
      if (st && /url\(/i.test(st)) {
        el.setAttribute('style', await processCssText(st, baseHref, info, report));
      }
    }

    // anchors: internal *.html -> in-tab nav; external http(s) -> new tab
    for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
      const c = U.classifyAnchor(a.getAttribute('href'), baseHref, info);
      if (c.action === 'nav') {
        a.setAttribute('data-ghhp-nav', c.path);
        a.setAttribute('href', '#');
        a.removeAttribute('target');
      } else if (c.action === 'external') {
        a.setAttribute('href', c.href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
      // 'skip' / 'none': leave as-is
    }

    // preludes: localStorage shim first, then nav interceptor
    const head = doc.head || doc.documentElement;
    const navScript = doc.createElement('script');
    navScript.textContent = U.NAV_INTERCEPT;
    head.insertBefore(navScript, head.firstChild);
    const shim = doc.createElement('script');
    shim.textContent = U.LS_SHIM;
    head.insertBefore(shim, head.firstChild);

    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }

  globalThis.GHHP = { acquire: acquire, parseBlob: (p) => U.parseBlobPath(p || location.pathname) };
})();
