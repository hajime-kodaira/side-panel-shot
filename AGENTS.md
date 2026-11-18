# Side Panel Shot - Agent Guide (`AGENTS.md`)

このドキュメントは、AI コーディングエージェントがこのリポジトリを理解し、既存の設計思想や規約に沿って安全に変更を加えるためのガイドです。

---

## 1. プロジェクト概要

**Side Panel Shot** は、Web ページ内のサイドパネルやモーダルなどのスクロール領域（または任意の要素）を自動スクロールしながら連続撮影し、見えていない部分も含めて **1枚の縦長 PNG 画像** として保存＆クリップボードにコピーする Chrome 拡張機能（Manifest V3）です。

- **ビルドレス・ゼロ依存**: バンドラ・トランスパイラ・外部ライブラリを一切使わない純粋な Vanilla JavaScript 構成です。リポジトリのルートをそのまま Chrome に読み込ませて動作します。
- **最小権限**: `activeTab`, `scripting`, `clipboardWrite` のみを使用し、`<all_urls>` などの広範なホスト権限を要求しません。

---

## 2. ファイル構成

- `manifest.json`
  - Manifest V3 設定ファイル。アクションクリックおよびショートカット（`Alt+Shift+S`）を定義。
- `background.js`
  - Service Worker。拡張機能アイコンのクリック時にアクティブタブへ `content.js` を注入する。
  - Content Script からは直接呼べない `chrome.tabs.captureVisibleTab`（`sps-capture`）と拡張機能バッジ更新（`sps-badge`）を代行する。
  - `chrome://` や Chrome ウェブストア等のスクリプト注入不可ページでは、赤背景の `×` バッジを一時表示して通知する。
- `content.js`
  - IIFE で完結するメインスクリプト。以下のフェーズ（`pick` -> `capture` -> `done`）を管理する。
    1. **要素ピッカー UI**: マウスホバーで最寄りのスクロール領域を検出し、`↑` / `↓` キーで選択範囲の親・子への拡縮、`Click` / `Enter` で撮影開始、`Esc` またはアイコン再クリック（`window.__sidePanelShot.cancel()`）でキャンセル。
    2. **自動スクロール＆分割撮影**: 対象の種類に応じて `captureScroll` または `captureElement` を実行。
    3. **結合・出力**: `OffscreenCanvas` で 1枚の PNG に結合し、ファイルダウンロード（`sidepanel_<host>_<timestamp>.png`）とクリップボードへのコピーを実行。
- `icons/`
  - 拡張機能アイコン（`icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`）。

---

## 3. アーキテクチャと重要な設計上の制約

コードを変更する際は、以下の仕組みを壊さないよう注意してください。

### 3.1 CSP 回避と Top Layer 対応（UI オーバーレイ）
- **CSSOM 経由のスタイル設定**: 注入先ページの厳格な CSP（`style-src`）にブロックされないよう、`<style>` 要素の挿入やインライン `style="..."` 文字列の直接書き換えは行わず、`el.style.setProperty(prop, value, 'important')`（ヘルパー関数 `css()`）を使用する。
- **Closed Shadow DOM + Popover API**: ホスト要素 `[data-side-panel-shot]` は `attachShadow({ mode: 'closed' })` でページ側の CSS/JS から隔離し、`<dialog>` などのモーダル（Top Layer）より前面に出すため `popover = 'manual'` と `showPopover()` を併用している。
- **撮影中の写り込み防止と操作ブロック**: 撮影開始時はピッカー UI を非表示にした上で、透明な `host` の `pointer-events: auto` と `wheel` イベント抑止によりユーザーの誤操作やホバー表示の変化を防いでいる。

### 3.2 撮影対象の判定ロジック（`buildPlan`）
選択された要素に対して、以下の3パターンのいずれかで撮影計画（`plan`）を組み立てる：
1. **要素自体が縦スクロール可能**（`kind: 'scroll'`, `frame === scroller`）: その要素自体をスクロールして撮影。
2. **内部に主要なスクロール領域を持つパネル**（`kind: 'scroll'`, `frame !== scroller`）: `findInnerScroller()` により「固定ヘッダー＋スクロールリスト」のようなパネル構造（幅 80% 以上・面積 30% 以上）を検出し、外枠ごと1枚に収める。
3. **スクロール領域を持たない通常要素**（`kind: 'element'`）: ビューポートに収まらない場合は親スクローラ（またはページルート）をスクロールしながら撮影。
- Shadow DOM 内の要素も `composedPath()` および `getRootNode().host` を辿ることで選択・親要素への拡大に対応している。

### 3.3 スクロール撮影時のエッジケース配慮
- **`captureVisibleTab` のレート制限対策**: Chrome の呼び出し上限（約2回/秒）に抵触しないよう `CONFIG.captureIntervalMs`（600ms）の間隔を空け、`MAX_CAPTURE_VISIBLE_TAB_CALLS` 発生時は待機してリトライする。
- **Sticky ヘッダー／フッターの重複除外（`stickyInsets`）**: スクロールコンテナ内の `position: sticky` 要素の高さを計測し、2フレーム目以降の切り抜き範囲から除外することで、画像の途中にヘッダーが何度も写り込むのを防ぐ。
- **負の `scrollTop` 対応**: `flex-direction: column-reverse` 等のチャット欄では `scrollTop` が負の値で推移するため、`S.scrollTop = -1e7` を代入した結果を基準値（`base`）として先頭位置を特定する。
- **高 DPI（Retina）対応**: キャプチャ画像の幅と `window.innerWidth` の比（`scale`）から実デバイスピクセル座標を計算して切り抜き・結合を行う。
- **ページ状態の完全復元（`makeRestorer`）**: 撮影時に一時適用するスタイル（`scroll-behavior: auto`, `scroll-snap-type: none`, `scrollbar-width: none`）やスクロール位置の変更は、必ず `restorer` を通して行い、`finally` で元の状態（元々の `style` 属性の有無を含む）へ復元する。

### 3.4 画像結合とメモリ管理（`stitch`）
- `createImageBitmap` と `OffscreenCanvas` を使用し、結合完了後はすべての `ImageBitmap` に対して `.close()` を呼んでメモリを解放する。
- 画像の高さが `CONFIG.maxImageHeight`（`30000` デバイスピクセル）を超える場合は、Canvas のサイズ上限による失敗を防ぐため複数ファイル（`_1ofN.png`）へ自動分割する。

---

## 4. コーディング規約

- **依存関係を増やさない**: `package.json` や npm パッケージ、ビルドツールは原則導入しない。
- **権限を最小に保つ**: `manifest.json` の `permissions` 追加は慎重に行い、不要な権限は増やさない。
- **コードスタイル**:
  - 2スペースインデント、セミコロンあり、シングルクォート基本、`use strict` 使用。
  - グローバル汚染を防ぐため、`content.js` 側で `window` に生やすプロパティはキャンセル制御用の `window.__sidePanelShot` のみとし、終了時（`cleanup`）に `delete` する。
  - UI の表示テキスト・エラーメッセージ・コード内コメントは日本語で統一する。

---

## 5. 動作確認方法

自動テストランナーは存在しないため、コード変更後は構文チェック（`node --check`）と Chrome 実機での確認を行います。

1. **構文チェック**:
   ```bash
   node --check background.js
   node --check content.js
   ```
2. **Chrome への読み込み**:
   - `chrome://extensions` を開き、「デベロッパー モード」を有効化して「パッケージ化されていない拡張機能を読み込む」からこのリポジトリのディレクトリを選択する。
   - `manifest.json` / `background.js` 変更時は拡張機能カードの更新ボタンを押す（`content.js` は実行のたびに再注入されるため、ピッカー終了状態であればそのまま再実行で反映される）。
3. **主な確認観点**:
   - 通常のサイドパネル・縦スクロール領域が隙間や重複なく1枚に繋がるか
   - 固定ヘッダー／Sticky ヘッダーを含む領域でヘッダーが多重に写り込まないか
   - 撮影完了後・キャンセル後（`Esc` またはアイコン再クリック）に、ページのスクロール位置やスクロールバー表示が元通り復元されるか
