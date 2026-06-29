# GitHub HTML Preview

GitHub リポジトリの **HTML ファイル**を、生ソースではなく **描画済みプレビュー**として
**blob ページ上にインライン表示**する Chrome 拡張(Manifest V3)。GitHub の Markdown と同じく
ファイルビューの **「Preview | Code | Blame」** セグメントで切り替えられる。**アクセス権のある
private リポジトリ**にも対応(ログイン済みセッションの Cookie で取得)。

> 背景:AI エージェントの成果物(設計書・レポート・ダッシュボード等)を HTML で出力する流れが
> 広がる一方、GitHub は Markdown と違い HTML を描画しない。本拡張はその差を埋める。

---

## 使い方

1. `chrome://extensions` で「デベロッパーモード」を ON →「パッケージ化されていない拡張機能を読み込む」
   → このフォルダ(`manifest.json` のある場所)を選択。
2. GitHub 上の HTML ファイル(例:`.../blob/main/docs/index.html`)を開く。
3. ファイルビューのツールバーに **「Preview」** セグメントが追加される(Markdown の見た目と一致)。
4. **Preview** をクリック → コード表示と入れ替わりに描画済み HTML が表示される。
   **Code** をクリックで元のソースへ戻る。
5. プレビュー内の内部 `*.html` リンクはその場で辿れる(同一リポジトリ内に制限)。外部リンクは新規タブ。
   ツールバーの拡張アイコンでも Preview/Code をトグルできる。

---

## 動作概要

```
content script (github.com / HTML blob を検出)
  ├ GitHub の「File view」セグメント(Code|Blame)に「Preview」項目を clone 注入(UI一致)
  ├ Preview 選択時: コード領域を隠し、サンドボックス viewer iframe を同じ場所に表示
  └ acquire.js が認証取得 → 自己完結 HTML を組み立て → iframe へ postMessage(GHHP_RENDER)
        ・主HTML/相対アセットの取得は background service worker に委譲
          (SW は host_permissions の CORS 緩和 + ログイン Cookie 同送 = private 取得可)
        ・相対 CSS/JS/画像/srcset/inline style/preload/poster をインライン化(data: 等)
        ・CDN(KaTeX/Google Fonts 等)はそのまま(sandbox CSP が許可)
        ・内部 *.html リンク → 同一リポジトリ内に正規化してその場でナビ、外部 → 新規タブ
        ・localStorage shim を注入(sandbox の opaque origin 対策)
        ↓
viewer.html (manifest sandbox.pages かつ web_accessible_resources, opaque origin)
  └ document.write で実行。inline/eval/CDN が CSP 上許可される MV3 の正規実行環境
```

### 設計上の要点(根拠)
- **インライン描画の核心(構成A)**:content script が `chrome-extension://…/viewer.html`(WAR)を
  github ページに直接 iframe 注入する。**WAR の拡張 iframe はホストページの `frame-src` CSP の
  対象外**のため、GitHub の厳格な CSP(`frame-src` が自社2ホストのみ)でも読み込める。
- **描画は sandbox ページが必須**:MV3 の拡張ページ CSP は `script-src 'self'` が最小で緩和不可。
  `srcdoc`/`data:` は**埋め込み元 CSP を継承**するため CDN/inline/eval が動かない。manifest
  sandbox ページは独自 CSP を持つので、取得した任意 HTML/JS を実行できる唯一の正規手段。
- **取得は service worker 経由**:content script は page origin(github.com)扱いで CORS 緩和を
  受けない。SW なら CORS 緩和 + Cookie 同送で `github.com/.../raw/` → tokenized raw の 302 を
  辿り private でも取得できる。
- **localStorage shim**:sandbox は opaque origin のため対象ページの `localStorage` が例外を
  投げる。shim を先頭注入してセッション内で機能させる。
- **信頼境界の検証**:content script は**自分の viewer iframe 由来の postMessage のみ**受理し、
  `GHHP_NAV` のパスは**現リポジトリ内に正規化・制限**(`..`/絶対 URL/別リポジトリは破棄)。
- **受け渡しストレージ不要**:インライン化により取得・描画は同一ページ内で完結し、
  ディスク/セッションストレージを一切使わない(`storage` 権限も不要)。

---

## ファイル構成

```
manifest.json            MV3 マニフェスト(content script / sandbox CSP / WAR viewer / action / icons)
src/lib/util.js          純粋ロジック(URL解決/MIME/CSS url抽出/srcset/base64/nav検証)。UMDで全文脈+Node共用
src/background.js        認証fetchプロキシ(GHHP_FETCH)+ action→Previewトグル
src/acquire.js           取得・アセット実体化・自己完結HTML組立(GHHP.acquire / GHHP.parseBlob)
src/ui.js                GHHPUi: Previewセグメント注入・選択状態・コード/プレビュー切替(GitHub UI一致, 実DOM検証対象)
src/content.js           コントローラ: 取得→viewer描画・GHHP_NAV中継・SPA再同期・action連携
src/viewer.html / viewer.js  sandbox ビューア(WAR、postMessage で受領し document.write 実行)
tools/gen-icons.js       アイコン(16/32/48/128 PNG)生成スクリプト(依存なし)
assets/icon*.png         生成済みアイコン
test/util.test.js        util.js の Node ユニットテスト(node --test)
test/ui.fixture.html     GitHub実マークアップに対するGHHPUiの実DOM検証フィクスチャ(headless Chrome)
```

---

## 開発・検証

```bash
node tools/gen-icons.js                 # アイコン再生成
node --test                             # 純粋ロジックのユニットテスト
node --check src/*.js src/lib/*.js      # 構文チェック
# Preview セグメントの注入/トグルを実 DOM(headless Chrome)で検証:
google-chrome --headless=new --no-sandbox --dump-dom test/ui.fixture.html | grep GHHP_RESULT=
```

ブラウザ実機での UI 一致/描画/ナビ/private 取得は `chrome://extensions` でアンパック読込のうえ確認する。

---

## 既知の制約

- **JS が実行時に動的取得するリソースは静的発見できない**(`fetch`/動的 import 等)。
  静的に参照されるアセット(link/script/img/srcset/source/poster/preload/CSS url())のみ実体化する。
- **CDN 依存**:KaTeX/Google Fonts 等はプレビュー時にネットワークから読み込む(sandbox CSP で許可)。
- **GitHub の DOM 変更**:Preview セグメントは GitHub の React マークアップ(`ul[aria-label="File view"]`、
  Primer の `prc-SegmentedControl-*`)に依存して注入する。GitHub 側の大幅な変更で再調整が必要になりうる。
- 取得対象は `github.com` / `raw.githubusercontent.com` に限定(SW 側で許可ホストを制限)。
- 既定はソース(Code)表示。`content.js` の `DEFAULT_TO_PREVIEW=true` で Markdown と同様に
  既定 Preview にできる(任意の HTML スクリプトを開いた瞬間に実行する点に留意)。
```
