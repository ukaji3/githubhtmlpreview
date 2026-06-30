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

test('parseBlobPath: valid HTML blame', () => {
  assert.deepEqual(
    U.parseBlobPath('/o/r/blame/main/docs/index.html'),
    { owner: 'o', repo: 'r', branch: 'main', filepath: 'docs/index.html' }
  );
});

test('parseBlobPath: strips query/hash', () => {
  const i = U.parseBlobPath('/o/r/blob/main/docs/a.html?x=1#frag');
  assert.equal(i.filepath, 'docs/a.html');
});

test('parseBlobPath: rejects non-HTML and non-blob/blame', () => {
  assert.equal(U.parseBlobPath('/o/r/blob/main/readme.md'), null);
  assert.equal(U.parseBlobPath('/o/r/tree/main'), null);
  assert.equal(U.parseBlobPath('/o/r'), null);
  assert.equal(U.parseBlobPath('/o/r/commits/main/docs/index.html'), null); // not blob or blame
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

test('parseSrcset: width descriptors and extra whitespace', () => {
  assert.deepEqual(
    U.parseSrcset('  small.png  480w ,  large.png   1024w  '),
    [{ url: 'small.png', descriptor: '480w' }, { url: 'large.png', descriptor: '1024w' }]
  );
});

test('parseSrcset: does NOT split on commas inside a data: URL', () => {
  // M-5: a naive value.split(',') corrupted base64 data URLs. The token scan
  // keeps the comma that belongs to the URL and only the space/comma between
  // candidates separates them.
  assert.deepEqual(
    U.parseSrcset('data:image/png;base64,AAAA 1x, b.png 2x'),
    [{ url: 'data:image/png;base64,AAAA', descriptor: '1x' }, { url: 'b.png', descriptor: '2x' }]
  );
});

test('parseSrcset: candidates without a descriptor', () => {
  assert.deepEqual(U.parseSrcset('only.png'), [{ url: 'only.png', descriptor: '' }]);
  // comma-separated, no descriptors (trailing-comma path -> empty descriptor)
  assert.deepEqual(
    U.parseSrcset('a.png, b.png'),
    [{ url: 'a.png', descriptor: '' }, { url: 'b.png', descriptor: '' }]
  );
  // single data URL with no descriptor keeps its inner comma
  assert.deepEqual(
    U.parseSrcset('data:image/gif;base64,R0lGOD'),
    [{ url: 'data:image/gif;base64,R0lGOD', descriptor: '' }]
  );
});

test('parseSrcset: empty / nullish input -> []', () => {
  assert.deepEqual(U.parseSrcset(''), []);
  assert.deepEqual(U.parseSrcset('   '), []);
  assert.deepEqual(U.parseSrcset(',, ,'), []);
  assert.deepEqual(U.parseSrcset(null), []);
  assert.deepEqual(U.parseSrcset(undefined), []);
});

test('parseSrcset -> buildSrcset round-trip preserves data URL candidates', () => {
  const src = 'data:image/png;base64,AAAA 1x, b.png 2x';
  const list = U.parseSrcset(src);
  assert.equal(U.buildSrcset(list), 'data:image/png;base64,AAAA 1x, b.png 2x');
});

test('isAllowedUrl: allows github.com / raw / *.githubusercontent.com over https', () => {
  assert.ok(U.isAllowedUrl('https://github.com/o/r/raw/main/docs/index.html'));
  assert.ok(U.isAllowedUrl('https://raw.githubusercontent.com/o/r/main/x.png'));
  assert.ok(U.isAllowedUrl('https://objects.githubusercontent.com/github-production-release/x'));
  assert.ok(U.isAllowedUrl('https://codeload.githubusercontent.com/o/r/zip/main'));
  assert.ok(U.isAllowedUrl('https://media.githubusercontent.com/media/o/r/main/big.bin'));
});

test('isAllowedUrl: rejects look-alikes, non-https, foreign, and malformed hosts', () => {
  assert.ok(!U.isAllowedUrl('https://github.com.evil.com/x'));        // suffix look-alike
  assert.ok(!U.isAllowedUrl('http://github.com/x'));                  // not https
  assert.ok(!U.isAllowedUrl('https://evil.com/x'));                   // unrelated host
  assert.ok(!U.isAllowedUrl('https://notgithubusercontent.com/x'));   // missing the dot boundary
  assert.ok(!U.isAllowedUrl('not a url'));                            // parse error -> false
  assert.ok(!U.isAllowedUrl(''));
  assert.ok(!U.isAllowedUrl(null));
  assert.ok(!U.isAllowedUrl(undefined));
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

test('segItemSelection matches GitHub SegmentedControl representation', () => {
  assert.deepEqual(U.segItemSelection(true), { dataSelected: true, ariaCurrent: 'true', separator: 'transparent' });
  assert.deepEqual(U.segItemSelection(false), { dataSelected: false, ariaCurrent: 'false', separator: 'var(--borderColor-default)' });
});

test('injected scripts (LS_SHIM, NAV_INTERCEPT) are syntactically valid JS', () => {
  assert.doesNotThrow(() => new Function(U.LS_SHIM)); // eslint-disable-line no-new-func
  assert.doesNotThrow(() => new Function(U.NAV_INTERCEPT)); // eslint-disable-line no-new-func
  assert.ok(U.NAV_INTERCEPT.includes("type:'GHHP_NAV'"));
  assert.ok(U.LS_SHIM.includes('localStorage'));
});
