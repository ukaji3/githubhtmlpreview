'use strict';
const test = require('node:test');
const assert = require('node:assert');
const U = require('../src/lib/util.js');

test('extMime maps extensions and is case-insensitive', () => {
  assert.equal(U.extMime('a/b/style.css'), 'text/css');
  assert.equal(U.extMime('x.PNG'), 'image/png');
  assert.equal(U.extMime('https://h/p/app.js?v=1'), 'text/javascript');
  assert.equal(U.extMime('f.woff2'), 'font/woff2');
  assert.equal(U.extMime('noext'), undefined);
  assert.equal(U.extMime('f.unknownext'), undefined);
});

test('parseBlobPath: valid HTML blob', () => {
  assert.deepEqual(
    U.parseBlobPath('/o/r/blob/main/docs/index.html'),
    { owner: 'o', repo: 'r', branch: 'main', filepath: 'docs/index.html' }
  );
});

test('parseBlobPath: strips query/hash', () => {
  const i = U.parseBlobPath('/o/r/blob/main/docs/a.html?x=1#frag');
  assert.equal(i.filepath, 'docs/a.html');
});

test('parseBlobPath: rejects non-HTML and non-blob', () => {
  assert.equal(U.parseBlobPath('/o/r/blob/main/readme.md'), null);
  assert.equal(U.parseBlobPath('/o/r/tree/main'), null);
  assert.equal(U.parseBlobPath('/o/r'), null);
});

test('repoRoot/dirHref/blobUrl/rawUrl/isRepoRel', () => {
  const i = { owner: 'o', repo: 'r', branch: 'main', filepath: 'docs/index.html' };
  assert.equal(U.repoRoot(i), 'https://github.com/o/r/raw/main/');
  assert.equal(U.dirHref(i), 'https://github.com/o/r/raw/main/docs/');
  assert.equal(U.blobUrl(i), 'https://github.com/o/r/blob/main/docs/index.html');
  assert.equal(U.rawUrl(i, 'docs/a.css'), 'https://github.com/o/r/raw/main/docs/a.css');
  assert.ok(U.isRepoRel('https://github.com/o/r/raw/main/docs/a.css', i));
  assert.ok(!U.isRepoRel('https://cdn.jsdelivr.net/x.js', i));
});

test('resolveUrl handles relative, parent and absolute', () => {
  const base = 'https://github.com/o/r/raw/main/docs/';
  assert.equal(U.resolveUrl('assets/x.css', base), 'https://github.com/o/r/raw/main/docs/assets/x.css');
  assert.equal(U.resolveUrl('../up.css', base), 'https://github.com/o/r/raw/main/up.css');
  assert.equal(U.resolveUrl('https://cdn/x.js', base), 'https://cdn/x.js');
});

test('repoRelPath returns internal path or null', () => {
  const i = { owner: 'o', repo: 'r', branch: 'main', filepath: 'docs/index.html' };
  assert.equal(U.repoRelPath('https://github.com/o/r/raw/main/docs/kinematics.html', i), 'docs/kinematics.html');
  assert.equal(U.repoRelPath('https://cdn/x.js', i), null);
});

test('isHttpAbs', () => {
  assert.ok(U.isHttpAbs('https://x'));
  assert.ok(U.isHttpAbs('http://x'));
  assert.ok(!U.isHttpAbs('/rel'));
  assert.ok(!U.isHttpAbs('mailto:a@b'));
});

test('extractCssUrls finds non-data urls, skips data:', () => {
  const css = "a{background:url(img/a.png)} @font-face{src:url('f.woff2')} b{x:url(\"data:image/png;base64,Z\")}";
  assert.deepEqual(U.extractCssUrls(css).map((r) => r.url), ['img/a.png', 'f.woff2']);
});

test('parseSrcset/buildSrcset round-trip', () => {
  const list = U.parseSrcset('a.png 1x, b.png 2x');
  assert.deepEqual(list, [{ url: 'a.png', descriptor: '1x' }, { url: 'b.png', descriptor: '2x' }]);
  assert.equal(U.buildSrcset(list), 'a.png 1x, b.png 2x');
  assert.equal(U.buildSrcset([{ url: 'c.png', descriptor: '' }]), 'c.png');
});

test('abToBase64 for Buffer and Uint8Array', () => {
  assert.equal(U.abToBase64(Buffer.from('hi')), 'aGk=');
  assert.equal(U.abToBase64(new Uint8Array([104, 105])), 'aGk=');
});

test('classifyAnchor: skip fragments and protocols', () => {
  const i = { owner: 'o', repo: 'r', branch: 'main', filepath: 'docs/index.html' };
  const base = U.dirHref(i);
  assert.equal(U.classifyAnchor('#main', base, i).action, 'skip');
  assert.equal(U.classifyAnchor('mailto:a@b.com', base, i).action, 'skip');
  assert.equal(U.classifyAnchor('tel:123', base, i).action, 'skip');
  assert.equal(U.classifyAnchor('', base, i).action, 'skip');
  assert.equal(U.classifyAnchor(null, base, i).action, 'skip');
});

test('classifyAnchor: relative internal *.html -> nav', () => {
  const i = { owner: 'o', repo: 'r', branch: 'main', filepath: 'docs/index.html' };
  const base = U.dirHref(i);
  assert.deepEqual(U.classifyAnchor('kinematics.html', base, i), { action: 'nav', path: 'docs/kinematics.html' });
  assert.deepEqual(U.classifyAnchor('../top.html', base, i), { action: 'nav', path: 'top.html' });
});

test('classifyAnchor: absolute repo *.html -> nav', () => {
  const i = { owner: 'o', repo: 'r', branch: 'main', filepath: 'docs/index.html' };
  const base = U.dirHref(i);
  assert.deepEqual(
    U.classifyAnchor('https://github.com/o/r/raw/main/docs/x.html', base, i),
    { action: 'nav', path: 'docs/x.html' }
  );
});

test('classifyAnchor: external -> external (new tab)', () => {
  const i = { owner: 'o', repo: 'r', branch: 'main', filepath: 'docs/index.html' };
  const base = U.dirHref(i);
  assert.deepEqual(U.classifyAnchor('https://example.com/p', base, i), { action: 'external', href: 'https://example.com/p' });
});

test('classifyAnchor: repo-relative non-HTML -> none (left as-is)', () => {
  const i = { owner: 'o', repo: 'r', branch: 'main', filepath: 'docs/index.html' };
  const base = U.dirHref(i);
  assert.equal(U.classifyAnchor('data/table.json', base, i).action, 'none');
});

test('resolveNavPath: keeps in-repo paths, rejects traversal/cross-repo/absolute', () => {
  const i = { owner: 'owner', repo: 'repo', branch: 'branch', filepath: 'docs/index.html' };
  assert.equal(U.resolveNavPath('docs/kinematics.html', i), 'docs/kinematics.html');
  assert.equal(U.resolveNavPath('kinematics.html', i), 'kinematics.html');
  assert.equal(U.resolveNavPath('sub/dir/page.html', i), 'sub/dir/page.html');
  assert.equal(U.resolveNavPath('../../../../otherowner/otherrepo/raw/main/x.html', i), null);
  assert.equal(U.resolveNavPath('../../../../../../settings/profile', i), null);
  assert.equal(U.resolveNavPath('https://attacker.example/evil', i), null);
  assert.equal(U.resolveNavPath('https://github.com/owner/repo/raw/branch/ok.html', i), 'ok.html');
  assert.equal(U.resolveNavPath('', i), null);
  assert.equal(U.resolveNavPath(null, i), null);
});

test('injected scripts (LS_SHIM, NAV_INTERCEPT) are syntactically valid JS', () => {
  assert.doesNotThrow(() => new Function(U.LS_SHIM)); // eslint-disable-line no-new-func
  assert.doesNotThrow(() => new Function(U.NAV_INTERCEPT)); // eslint-disable-line no-new-func
  assert.ok(U.NAV_INTERCEPT.includes("type:'GHHP_NAV'"));
  assert.ok(U.LS_SHIM.includes('localStorage'));
});
