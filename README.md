# GitHub HTML Preview

GitHub リポジトリの **HTML ファイル**を、生ソースではなく **描画済みプレビュー**として
**blob / blame ページ上にインライン表示**する Chrome 拡張(Manifest V3)。GitHub の Markdown と同じく
ファイルビューの **「Preview | Code | Blame」** セグメントで切り替えられる。**アクセス権のある
private リポジトリ**にも対応(ログイン済みセッションの Cookie で取得)。

> 背景:AI エージェントの成果物(設計書・レポート・ダッシュボード等)を HTML で出力する流れが
> 広がる一方、GitHub は Markdown と違い HTML を描画しない。本拡張はその差を埋める。

---

## 使い方

1. `chrome://extensions` で「デベロッパーモード」を ON →「パッケージ化されていない拡張機能を読み込む」
   → このフォルダ(`manifest.json` のある場所)を選択。
2. GitHub 上の HTML ファイル(例:`.../blob/main/docs/index.html` または `.../blame/main/docs/index.html`)を開く。
3. ファイルビューのツールバーに **「Preview」** セグメントが追加される(Markdown の見た目と一致)。
4. **Preview** をクリック → コード表示と入れ替わりに描画済み HTML が表示される。
   **Code** や **Blame** をクリックで元の表示へ戻る。
5. プレビュー内の内部 `*.html` リンクはその場で辿れる(同一リポジトリ内に制限)。外部リンクは新規タブ。
   ツールバーの拡張アイコンでも Preview/Code をトグルできる。

---

## 動作概要

```
content script (github.com / HTML blob・blame を検出)
  ├ GitHub の「File view」セグメント(Code|Blame)に「Preview」項目を clone 注入(UI一致)
  ├ Preview 選択時: コード領域を隠し、サンドボックス viewer iframe を同じ場所に表示
  └ acquire.js が認証取得 → 自己完結 HTML を組み立て → viewer の READY 受信後に postMessage(GHHP_RENDER)
        ・主HTML/相対アセットの取得は background service worker に委譲
          (SW は host_permissions の CORS 緩和 + ログイン Cookie 同送 = private 取得可)
          (SW は要求 URL と 302 追従後の最終 URL を許可ホストで検証 + 25MiB の応答上限)
        ・相対 CSS/JS/画像/srcset/inline style/preload/poster をインライン化(data: 等)
        ・CDN(KaTeX/Google Fonts 等)はそのまま(sandbox CSP が許可)
        ・内部 *.html リンク → 同一リポジトリ内に正規化してその場でナビ、外部 → 新規タブ
        ・localStorage shim を注入(sandbox の opaque origin 対策)
        ・描画済み HTML は owner/repo/branch/filepath キーで LRU(上限20)キャッシュ
        ↓
viewer.html / viewer.js (manifest sandbox.pages かつ web_accessible_resources, opaque origin)
  ├ document.write で実行。inline/eval/CDN が CSP 上許可される MV3 の正規実行環境
  └ viewer.js が描画後の内容高さを測定し postMessage(GHHP_VIEWER_HEIGHT) で親へ報告
        ↑
content script が iframe を内容高さに追従(scrolling="no", 200–20000px に clamp)
  → 内側スクロールバーを排し、ページ側の単一スクロールバーへ統一(Markdown と一致)
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
- **単一スクロールバー(内容高さ追従)**:opaque origin の viewer iframe は内側に独自のスクロールバーを
  持ち二重化しやすい。`viewer.js` が描画後に `documentElement`/`body` の scroll/offsetHeight の最大値を
  測り、即時・遅延タイマ(50/200/600/1200/2500ms)・`load`・`ResizeObserver` で `GHHP_VIEWER_HEIGHT` を
  親へ報告する。content script はこれを受けて iframe 高さを内容に追従させ(`scrolling="no"`、200–20000px に
  clamp)、内側バーを排してページ側の単一スクロールバーへ統一する(Markdown プレビューと一致)。clamp 上限は
  `height:100vh` 等による暴走を抑止する。
- **取得経路の host 検証とサイズ上限**:SW は要求 URL に加え、`redirect:'follow'` 後の**最終 URL** も
  `isAllowedUrl` で検証する。許可は https かつ `github.com` / `raw.githubusercontent.com` /
  `*.githubusercontent.com`(`objects`/`codeload`/`media` 等の 302 追従先)のみで、`github.com.evil.com` の
  ような look-alike・非 https・パース不能は拒否する。302 が許可外ホストへ着地した場合はステータスに依らず本文を
  破棄し(ログイン Cookie・本文の漏えい防止)、応答本文は 25MiB を上限とする(Content-Length 宣言時は事前に、
  chunked 等で欠落する場合は実バイト/文字数で遮断)。
- **描画キャッシュの境界化(LRU)と並行再入ガード**:描画済み HTML は `owner/repo/branch/filepath` を
  複合キーにキャッシュする。パス単独キーでは別 owner/repo/branch の同名パスが衝突して古い文書を誤表示し得る
  ため座標を全て含める。挿入順を保つ `Map` で上限 20 件を超えたら最古を退避する単純 LRU により無制限な増加を
  防ぐ。さらに各描画に単調増加の seq を割り当て、非同期取得の完了時・キャッシュ commit 時に「最新の描画かつ
  Preview 継続中」のみ反映する(SPA 再同期やナビ連打での並行再入による誤コミットを排除)。
- **blob/blame 両対応**:`parseBlobPath` が `/blob/` と `/blame/` の両パスを認識するため、
  blame ページからも Preview を起動できる。URL のビュー種別(blob/blame)は取得パスに影響しない
  (raw URL は常に `/raw/{branch}/{filepath}` で統一される)。

---

## ファイル構成

```
manifest.json            MV3 マニフェスト(content script / sandbox CSP / WAR viewer / action / icons)
src/lib/util.js          純粋ロジック(URL解決/MIME/CSS url抽出/srcset/base64/nav検証)。UMDで全文脈+Node共用
src/background.js        認証fetchプロキシ(GHHP_FETCH)+ action→Previewトグル
src/acquire.js           取得・アセット実体化・自己完結HTML組立(GHHP.acquire / GHHP.parseBlob)
src/ui.js                GHHPUi: Previewセグメント注入・選択状態・コード/プレビュー切替(GitHub UI一致, 実DOM検証対象)
src/content.js           コントローラ: 取得→viewer描画・iframe高さ追従・GHHP_NAV中継・SPA再同期・action連携
src/viewer.html          sandbox ビューアのエントリ(WAR。viewer.js を読み込むだけの最小 DOM)
src/viewer.js            sandbox ビューア本体: postMessage 受領→document.write 実行→内容高さを GHHP_VIEWER_HEIGHT 報告
tools/gen-icons.js       アイコン(16/32/48/128 PNG)生成スクリプト(依存なし)
assets/icon*.png         生成済みアイコン
test/util.test.js        util.js の Node ユニットテスト(parseSrcset/isAllowedUrl 等。node --test)
test/ui.fixture.html     GHHPUi の Preview セグメント注入/トグルを実 DOM 検証するフィクスチャ(headless Chrome)
test/controller.fixture.html  content.js の取得→viewer→READY→GHHP_RENDER 往復を実 DOM 検証(headless Chrome)
test/height.fixture.html      viewer.js の内容高さ報告(GHHP_VIEWER_HEIGHT≥内容高さ)=二重スクロールバー修正を検証(headless Chrome)
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

## プライバシー

**このエクステンションはユーザーデータを一切収集・送信しない。**

- 通信先は `github.com` と `*.githubusercontent.com` のみ(ユーザー操作時のみ)
- 描画キャッシュはメモリのみ(ディスク非永続、タブ閉じで消去)
- アナリティクス・テレメトリ・外部サービス連携なし
- `storage` / `cookies` 等の権限は使用していない

詳細は [PRIVACY.md](./PRIVACY.md) を参照。

---

## 既知の制約

- **JS が実行時に動的取得するリソースは静的発見できない**(`fetch`/動的 import 等)。
  静的に参照されるアセット(link/script/img/srcset/source/poster/preload/CSS url())のみ実体化する。
- **CDN 依存**:KaTeX/Google Fonts 等はプレビュー時にネットワークから読み込む(sandbox CSP で許可)。
- **GitHub の DOM 変更**:Preview セグメントは GitHub の React マークアップ(`ul[aria-label="File view"]`、
  Primer の `prc-SegmentedControl-*`)に依存して注入する。GitHub 側の大幅な変更で再調整が必要になりうる。
- 取得対象は https かつ `github.com` / `raw.githubusercontent.com`(及び 302 追従先の
  `*.githubusercontent.com`)に限定(SW が `isAllowedUrl` で要求 URL と最終 URL を検証)。
- **sandbox CSP の `connect-src https:`**:viewer は CDN ライブラリ(KaTeX 等)が実行時に行う `fetch`/
  `XHR` を成立させるため `connect-src https:` を広く開けている。これは設計判断によるもので、viewer は
  **opaque origin の sandbox ページ**として動くため github の Cookie も拡張の host_permissions も持たない。
  したがってこの広い `connect-src` を通じて外部へ出得るのは**被プレビュー文書自身がそのスクリプトで送る内容に
  限られ**、拡張の認証情報や他オリジンのデータは原理的に漏れない(認証取得は SW のみが host_permissions と
  ログイン Cookie で実行する)。
- 既定は Preview 表示(Markdown の Preview と同じ挙動に準拠)。`content.js` の `DEFAULT_TO_PREVIEW` を
  `false` にすると Code 表示を既定にできる。

---

## ライセンス

[MIT](./LICENSE)
