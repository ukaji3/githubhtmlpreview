/*
 * GitHub HTML Preview : pure utility module (no DOM, no chrome.* APIs).
 *
 * UMD-style: exported as CommonJS (Node tests) AND attached to globalThis
 * (content script / service worker / extension page). Keeping the testable
 * logic here lets it be unit-tested headlessly with `node --test`.
 */
(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof globalThis !== 'undefined') { globalThis.GHHPUtil = api; }
})(function () {
  'use strict';

  const GH = 'https://github.com';

  const MIME = {
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
    mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject', mp4: 'video/mp4', webm: 'video/webm',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', map: 'application/json',
    txt: 'text/plain', xml: 'application/xml', wasm: 'application/wasm'
  };

  function extMime(url) {
    const m = String(url).split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i);
    return m ? MIME[m[1].toLowerCase()] : undefined;
  }

  // /{owner}/{repo}/{blob|blame}/{branch}/{filepath...} -> info (HTML files only) | null
  function parseBlobPath(pathname) {
    const m = String(pathname || '').match(/^\/([^/]+)\/([^/]+)\/(?:blob|blame)\/([^/]+)\/(.+)$/);
    if (!m) return null;
    let filepath;
    try { filepath = decodeURIComponent(m[4]); } catch (e) { filepath = m[4]; }
    filepath = filepath.replace(/[?#].*$/, '');
    if (!/\.x?html?$/i.test(filepath)) return null;
    return { owner: m[1], repo: m[2], branch: m[3], filepath: filepath };
  }

  function repoRoot(info) {
    return `${GH}/${info.owner}/${info.repo}/raw/${info.branch}/`;
  }
  function dirHref(info) {
    return repoRoot(info) + info.filepath.replace(/[^/]*$/, '');
  }
  function blobUrl(info, filepath) {
    return `${GH}/${info.owner}/${info.repo}/blob/${info.branch}/${filepath || info.filepath}`;
  }
  function rawUrl(info, filepath) {
    return repoRoot(info) + (filepath || info.filepath);
  }
  function isRepoRel(absUrl, info) {
    return typeof absUrl === 'string' && absUrl.startsWith(repoRoot(info));
  }

  function resolveUrl(ref, baseHref) {
    try { return new URL(ref, baseHref).href; } catch (e) { return null; }
  }

  function isHttpAbs(href) {
    return /^https?:\/\//i.test(String(href || ''));
  }

  // True only for https URLs whose host is github.com, raw.githubusercontent.com,
  // or any *.githubusercontent.com host. The wildcard covers the 302 redirect
  // targets the auth fetch proxy follows (objects/codeload/media.githubusercontent.com).
  // Used by the service worker to validate the FINAL host after redirects, so it
  // must reject look-alikes (github.com.evil.com), non-https, and parse errors.
  function isAllowedUrl(url) {
    try {
      const u = new URL(String(url));
      if (u.protocol !== 'https:') return false;
      const h = u.hostname;
      return h === 'github.com'
        || h === 'raw.githubusercontent.com'
        || h.endsWith('.githubusercontent.com');
    } catch (e) {
      return false;
    }
  }

  // repo-relative path (e.g. "docs/kinematics.html") of an internal URL, else null
  function repoRelPath(absUrl, info) {
    if (!isRepoRel(absUrl, info)) return null;
    return absUrl.substring(repoRoot(info).length).replace(/[?#].*$/, '');
  }

  // Extract non-data url(...) references from a CSS string.
  function extractCssUrls(css) {
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    const out = [];
    let m;
    while ((m = re.exec(String(css))) !== null) {
      const u = m[2].trim();
      if (/^data:/i.test(u)) continue;
      out.push({ full: m[0], url: u });
    }
    return out;
  }

  // srcset attribute <-> list of {url, descriptor}
  //
  // WHATWG-style token scan (HTML Standard "parse a srcset attribute",
  // simplified to "descriptor = up to next comma"). Unlike a naive
  // value.split(','), this never splits on commas that live INSIDE a URL
  // (e.g. `data:image/png;base64,AAAA`), which previously corrupted such
  // candidates. The returned shape stays {url, descriptor}[] so buildSrcset
  // round-trips unchanged.
  function parseSrcset(value) {
    const s = String(value == null ? '' : value);
    const len = s.length;
    const out = [];
    const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
    let i = 0;
    while (i < len) {
      // 1) skip any leading whitespace and commas (candidate separators)
      while (i < len && (isWs(s[i]) || s[i] === ',')) i++;
      if (i >= len) break;
      // 2) collect a run of non-whitespace as the URL token (may contain commas)
      const start = i;
      while (i < len && !isWs(s[i])) i++;
      let token = s.slice(start, i);
      // 3) a trailing comma terminates this candidate -> descriptor is empty
      if (token.charCodeAt(token.length - 1) === 0x2c /* ',' */) {
        token = token.replace(/,+$/, '');
        if (token) out.push({ url: token, descriptor: '' });
        continue;
      }
      // 4) otherwise skip whitespace, then read the descriptor up to the
      //    next comma (which is consumed at the top of the next iteration)
      while (i < len && isWs(s[i])) i++;
      const dStart = i;
      while (i < len && s[i] !== ',') i++;
      const descriptor = s.slice(dStart, i).trim();
      out.push({ url: token, descriptor: descriptor });
    }
    return out;
  }
  function buildSrcset(list) {
    return list.map((e) => (e.descriptor ? e.url + ' ' + e.descriptor : e.url)).join(', ');
  }

  // bytes (Uint8Array | ArrayBuffer | Buffer) -> base64 string
  function abToBase64(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof Buffer !== 'undefined') return Buffer.from(u).toString('base64');
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < u.length; i += CH) {
      bin += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    }
    return btoa(bin); // eslint-disable-line no-undef
  }

  // Decide how an anchor should be treated in the preview.
  // -> { action: 'nav', path } | { action: 'external', href } | { action: 'skip' } | { action: 'none' }
  function classifyAnchor(href, baseHref, info) {
    if (!href) return { action: 'skip' };
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) return { action: 'skip' };
    if (isHttpAbs(href)) {
      const rel = repoRelPath(href, info);
      if (rel && /\.x?html?($|[?#])/i.test(href)) return { action: 'nav', path: rel };
      return { action: 'external', href: href };
    }
    const abs = resolveUrl(href, baseHref);
    if (!abs) return { action: 'skip' };
    if (isRepoRel(abs, info)) {
      if (/\.x?html?($|[?#])/i.test(abs)) return { action: 'nav', path: repoRelPath(abs, info) };
      return { action: 'none' }; // repo-relative non-HTML: leave as-is
    }
    return { action: 'external', href: abs };
  }

  // Constrain a GHHP_NAV path to the current repo root.
  // Resolves against repoRoot and rejects '..'/absolute/cross-repo targets.
  // -> safe repo-relative path | null
  function resolveNavPath(path, info) {
    if (typeof path !== 'string' || !path) return null;
    const abs = resolveUrl(path, repoRoot(info));
    if (!abs || !isRepoRel(abs, info)) return null;
    return repoRelPath(abs, info) || null;
  }

  // GitHub Primer SegmentedControl item state (matches github.com blob SSR):
  //   selected  -> <li data-selected> <button aria-current="true" --separator-color:transparent>
  //   unselected-> <button aria-current="false" --separator-color:var(--borderColor-default)>
  function segItemSelection(selected) {
    return selected
      ? { dataSelected: true, ariaCurrent: 'true', separator: 'transparent' }
      : { dataSelected: false, ariaCurrent: 'false', separator: 'var(--borderColor-default)' };
  }

  // Scripts injected (as strings) into the rendered document.
  const LS_SHIM =
    "(function(){try{window.localStorage.getItem('__ghhp_probe');}catch(e){" +
    "var m={};var s={getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null;}," +
    "setItem:function(k,v){m[k]=String(v);},removeItem:function(k){delete m[k];}," +
    "clear:function(){m={};},key:function(i){return Object.keys(m)[i]||null;}};" +
    "Object.defineProperty(s,'length',{get:function(){return Object.keys(m).length;}});" +
    "try{Object.defineProperty(window,'localStorage',{value:s,configurable:true});}catch(e2){}}})();";

  const NAV_INTERCEPT =
    "(function(){document.addEventListener('click',function(e){" +
    "var a=e.target&&e.target.closest&&e.target.closest('a[data-ghhp-nav]');" +
    "if(!a)return;e.preventDefault();" +
    "try{parent.postMessage({type:'GHHP_NAV',path:a.getAttribute('data-ghhp-nav')},'*');}catch(_){}" +
    "},true);})();";

  return {
    GH, MIME, extMime, parseBlobPath, repoRoot, dirHref, blobUrl, rawUrl,
    isRepoRel, resolveUrl, isHttpAbs, isAllowedUrl, repoRelPath, extractCssUrls,
    parseSrcset, buildSrcset, abToBase64, classifyAnchor, resolveNavPath, segItemSelection, LS_SHIM, NAV_INTERCEPT
  };
});
