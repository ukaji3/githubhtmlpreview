# GitHub HTML Preview

GitHub リポジトリ上の **HTML ファイル**を、生ソース表示ではなく **描画済みプレビュー**として
新しいタブに表示する Chrome 拡張(Manifest V3)。**アクセス権のある private リポジトリ**にも
対応する(ログイン済みセッションの Cookie を用いて取得)。

> 背景:AI エージェントの成果物(設計書・レポート・ダッシュボード等)を HTML で出力する流れが
> 広がる一方、GitHub は Markdown と違い HTML を blob ページで描画しない。本拡張はその差を埋める。

---

## 使い方

1. `chrome://extensions` を開き、右上「デベロッパーモード」を ON。
2. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダ(`manifest.json` のある場所)を選択。
3. GitHub 上の HTML ファイルのページ(例:`.../blob/main/docs/index.html`)を開く。
4. 右下の **「▶ HTML Preview」** ボタン(またはツールバーの拡張アイコン)を押す。
5. 新しいタブに描画済みプレビューが開く。内部リンクはタブ内で辿れる(ツールバーの「◀ 戻る」で前ページへ)。

---

## 動作概要

```
content script (github.com, HTML blob ページを検出)
  └ acquire.js が認証取得 → 自己完結 HTML を組み立て → chrome.storage.session 経由で host へ
        ・主HTML/相対アセットの取得は background service worker に委譲
          (SW は host_permissions による CORS 緩和 + ログイン Cookie 同送 = private 取得可)
        ・相対 CSS/JS/画像/srcset/inline style/preload/poster をインライン化(data: 等)
        ・CDN(KaTeX/Google Fonts 等)はそのまま(sandbox CSP が許可)
        ・内部 *.html リンク → タブ内ナビ(data-ghhp-nav)、外部リンク → 新規タブ
        ・localStorage shim を注入(sandbox の opaque origin 対策)
        ↓
host.html (chrome-extension://, 非sandbox)
  └ ツールバー(戻る / ファイルパス / GitHubで開く / Raw)+ sandbox viewer 埋め込み
        ↓
viewer.html (manifest sandbox.pages, opaque origin)
  └ document.write で実行。inline/eval/CDN が CSP 上許可される MV3 の正規実行環境
```

### 設計上の要点(根拠)
- **取得は service worker 経由**:content script は page origin(github.com)扱いで
  host_permissions の CORS 緩和を受けない(公式)。SW なら CORS 緩和 + Cookie 同送で
  `github.com/.../raw/` → tokenized raw への 302 を辿って private でも取得できる。
- **描画は sandbox ページ**:MV3 の拡張ページ CSP は `script-src 'self'` が最小で緩和不可。
  sandbox ページの CSP のみ緩和でき、取得した任意 HTML/JS(CDN 含む)を実行できる。
- **localStorage shim**:sandbox は opaque origin のため対象ページの `localStorage` が
  例外を投げる。shim を先頭注入してセッション内で機能させる。
- **信頼境界の検証**:host は**自分の viewer iframe 由来の postMessage のみ**受理し、
  `GHHP_NAV` のパスは**現リポジトリ内に正規化・制限**(`..`/絶対 URL/別リポジトリは破棄)。
  これによりプレビュー中の悪意ある JS が host に任意 github.com パスを取得させる経路を塞ぐ。
- **受け渡しストレージ**:`chrome.storage.session`(メモリ常駐・ディスク非永続)を使用し、
  host は読込直後に**全経路で削除**。private 内容をディスクに残さない。

---

## ファイル構成

```
manifest.json            MV3 マニフェスト(action / icons / sandbox CSP / WAR)
src/lib/util.js          純粋ロジック(URL解決/MIME/CSS url抽出/srcset/base64)。UMDで全文脈+Node共用
src/background.js        認証fetchプロキシ(GHHP_FETCH)+ 新タブ起動 + action.onClicked
src/acquire.js           取得・アセット実体化・自己完結HTML組立(content/host 共有)
src/content.js           blob検出・Previewボタン・トースト・action連携
src/host.html / host.js  ツールバー(戻る/パス/GitHub/Raw)+ sandbox viewer 埋込 + 履歴ナビ
src/viewer.html / viewer.js  sandbox ビューア(postMessage で受領し document.write 実行)
tools/gen-icons.js       アイコン(16/32/48/128 PNG)生成スクリプト(依存なし)
assets/icon*.png         生成済みアイコン
test/util.test.js        util.js の Node ユニットテスト(node --test)
```

---

## 開発・検証

```bash
node tools/gen-icons.js     # アイコン再生成
node --test                 # 純粋ロジックのユニットテスト
node --check src/*.js src/lib/*.js   # 構文チェック
```

ブラウザ実機での描画/ナビ/private 取得は `chrome://extensions` でアンパック読込のうえ確認する。

---

## 既知の制約

- **JS が実行時に動的取得するリソースは静的発見できない**(`fetch`/動的 import 等)。
  静的に参照されるアセット(link/script/img/srcset/source/poster/preload/CSS url())のみ実体化する。
- **ページ内フラグメント(`#…`)**:内部 *.html 遷移時にスクロール位置は復元しない。
- **CDN 依存**:KaTeX/Google Fonts 等はプレビュー時にネットワークから読み込む(sandbox CSP で許可)。
  完全オフライン化や Web Store 提出(RHC 厳格化)を狙う場合は CDN 資産もローカル実体化する方針が安全。
- **ストレージ**:受け渡しに `chrome.storage.session`(メモリ常駐・ブラウザ終了で消去)を用い、
  host は読込直後に削除(ワンショット)。このためプレビュータブを**再読込すると内容は消える**
  (再度プレビューが必要)。`session` の容量上限(目安 10MB)を超える巨大ページは
  エラー表示となる(ディスクへは退避しない=private 内容を残さない方針)。
- 取得対象は `github.com` / `raw.githubusercontent.com` に限定(SW 側で許可ホストを制限)。
- inline 重畳表示(blob ページ上に直接描画)は本バージョンでは非対応(new-tab 方針)。
```
