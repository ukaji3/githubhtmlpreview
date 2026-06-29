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

  // M-6: bounded concurrency for SW-delegated asset fetches. Each acquire()
  // loop parallelizes its element-level work up to this many in-flight tasks,
  // while the loops themselves still run strictly in sequence (so the
  // stylesheet -> inline <style> url() rewrite dependency is preserved).
  const CONCURRENCY = 6;

  async function swFetch(url, as, retries) {
    // Retry once on failure: an MV3 service worker can be asleep and the first
    // sendMessage can reject (channel closed), or the fetch can transiently
    // fail. Without a retry such a blip leaves an asset un-inlined for the
    // whole session (and the result gets cached), breaking the preview.
    retries = retries == null ? 1 : retries;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'GHHP_FETCH', url, as });
        if (r && r.ok) return r.body;
        lastErr = new Error('HTTP ' + (r ? r.status : '?') + (r && r.error ? ' ' + r.error : ''));
      } catch (e) {
        lastErr = e;
      }
      if (attempt < retries) await new Promise((res) => setTimeout(res, 150 * (attempt + 1)));
    }
    throw lastErr;
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

  // Inlining-or-absolute rule: for every repo-relative reference we either
  // inline it (data:/inline content) or, if the fetch fails, fall back to the
  // ABSOLUTE repo URL. We must NEVER leave a repo-relative URL in the output:
  // the viewer document lives at chrome-extension://<id>/src/viewer.html, so a
  // relative ref would resolve against the extension origin (ERR_FILE_NOT_FOUND)
  // instead of the repo. (style/img/font load under the sandbox CSP via
  // https:/*; scripts can only run when inlined, hence swFetch's retry.)
  async function processCssText(css, baseHref, info, report) {
    const refs = U.extractCssUrls(css).filter((r) => {
      const abs = U.resolveUrl(r.url, baseHref);
      return abs && U.isRepoRel(abs, info);
    });
    for (const r of refs) {
      const abs = U.resolveUrl(r.url, baseHref);
      const d = await dataUrlFor(abs, report);
      css = css.split(r.full).join('url(' + (d || abs) + ')');
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
        item.url = d || abs; changed = true;
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
      el.setAttribute(attr, d || abs);
    }
  }

  // LS_SHIM / NAV_INTERCEPT scripts are provided by GHHPUtil (see src/lib/util.js).

  // M-6: run worker(item, index) for every item with at most `limit` tasks in
  // flight. Worker rejections propagate (matching the original serial `await`
  // semantics); per-asset failures are already swallowed by dataUrlFor and the
  // per-loop try/catch blocks, so no asset error escapes the pool. DOM edits
  // (replaceWith/setAttribute) and report mutations (assetsOk++/assetsFail.push)
  // touch independent elements and run on a single thread, so they are safe
  // under interleaving; only the assetsFail array order may differ (the set of
  // failures and the assetsOk count are unchanged).
  async function runPool(items, worker, limit) {
    const arr = Array.isArray(items) ? items : Array.from(items);
    const n = arr.length;
    if (n === 0) return;
    let cursor = 0;
    const width = Math.min(limit, n);
    const runners = new Array(width);
    for (let w = 0; w < width; w++) {
      runners[w] = (async () => {
        while (cursor < n) {
          const i = cursor++;
          await worker(arr[i], i);
        }
      })();
    }
    await Promise.all(runners);
  }

  async function acquire(info, report) {
    const baseHref = U.dirHref(info);
    const mainUrl = U.rawUrl(info);
    report.main = mainUrl;

    const html = await fetchText(mainUrl);
    report.mainOk = true;

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const resolve = (ref) => U.resolveUrl(ref, baseHref);

    // <link rel=stylesheet> (repo) -> inline <style>; CDN left as-is
    await runPool(Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]')), async (link) => {
      const abs = resolve(link.getAttribute('href'));
      if (abs && U.isRepoRel(abs, info)) {
        try {
          let css = await fetchText(abs);
          css = await processCssText(css, abs, info, report);
          const style = doc.createElement('style');
          style.textContent = css;
          link.replaceWith(style);
          report.assetsOk++;
        } catch (e) {
          report.assetsFail.push(abs + ' :: ' + e.message);
          link.setAttribute('href', abs); // fallback: absolute repo URL (style-src allows https:)
        }
      }
    }, CONCURRENCY);

    // inline <style> blocks -> rewrite repo-relative url()
    await runPool(Array.from(doc.querySelectorAll('style')), async (style) => {
      if (style.textContent && /url\(/i.test(style.textContent)) {
        style.textContent = await processCssText(style.textContent, baseHref, info, report);
      }
    }, CONCURRENCY);

    // <script src> (repo) -> inline; CDN left as-is
    await runPool(Array.from(doc.querySelectorAll('script[src]')), async (s) => {
      const abs = resolve(s.getAttribute('src'));
      if (abs && U.isRepoRel(abs, info)) {
        try {
          const js = await fetchText(abs);
          const ns = doc.createElement('script');
          ns.textContent = js;
          if (s.type) ns.type = s.type;
          s.replaceWith(ns);
          report.assetsOk++;
        } catch (e) {
          report.assetsFail.push(abs + ' :: ' + e.message);
          s.setAttribute('src', abs); // fallback: absolute repo URL (avoids extension-origin 404)
        }
      }
    }, CONCURRENCY);

    // images: src + srcset
    await runPool(Array.from(doc.querySelectorAll('img')), async (img) => {
      await inlineAttrUrl(img, 'src', baseHref, info, report);
      await inlineSrcset(img, 'srcset', baseHref, info, report);
      img.removeAttribute('loading');
    }, CONCURRENCY);
    // <picture><source>, <video><source>, <audio><source>
    await runPool(Array.from(doc.querySelectorAll('source')), async (src) => {
      await inlineAttrUrl(src, 'src', baseHref, info, report);
      await inlineSrcset(src, 'srcset', baseHref, info, report);
    }, CONCURRENCY);
    // media posters
    await runPool(Array.from(doc.querySelectorAll('video[poster]')), async (v) => {
      await inlineAttrUrl(v, 'poster', baseHref, info, report);
    }, CONCURRENCY);
    // <link rel=preload/icon/apple-touch-icon ...> hrefs
    await runPool(Array.from(doc.querySelectorAll('link[rel~="preload"][href], link[rel~="icon"][href], link[rel~="apple-touch-icon"][href], link[rel~="mask-icon"][href]')), async (l) => {
      await inlineAttrUrl(l, 'href', baseHref, info, report);
    }, CONCURRENCY);
    // inline style="...url()..."
    await runPool(Array.from(doc.querySelectorAll('[style]')), async (el) => {
      const st = el.getAttribute('style');
      if (st && /url\(/i.test(st)) {
        el.setAttribute('style', await processCssText(st, baseHref, info, report));
      }
    }, CONCURRENCY);

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
