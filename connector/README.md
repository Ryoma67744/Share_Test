# DESI Data Share — 読み取り専用 AI コネクタ（MCP）

このアプリの**公開/自分の非公開プロジェクト**を、AI（Claude など）に**読ませて解析**させるための小さな“受付係”です。

- **読み取り専用**：AIは**閲覧・数値取得だけ**。**登録・編集・削除は一切できません**（書き込み用の鍵＝マスターパスワードをこの受付係に渡さないため、サーバが書き込みを拒否します。書き込みツールも用意していません）。
- **数値解析OK**：ROI×化合物の強度統計や、必要なら生の `{x, y, value}` まで読み出せます。
- **秘密は手元だけ**：非公開プロジェクトのパスワードは、あなたのPCの `.env` にのみ置き、AIには渡りません。
- **既存アプリに影響なし**：これは独立した追加部品です。本体（`viewer/index.html` など）やサーバの仕組みは変更していません。

## 必要なもの
- Node.js 18 以上（`fetch` が標準で使えるため）。

## セットアップ
```bash
cd connector
npm install
cp .env.example .env      # そして .env を編集
```
`.env` の中身:
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` … 公開値（Webアプリに元から入っているもの）。既定で記入済み。
- `OWNER_ADMIN_PASSWORD` …（任意）**非公開**プロジェクトを読むときだけ設定。公開のみでよければ空のまま。
- `PROJECT_PW__<slug>` …（任意）プロジェクトごとに別パスワードを使う場合。
- **`MASTER` パスワードは絶対に入れない**（入れても使いません。読み取り専用の担保です）。

## 動作確認（ネット不要）
```bash
npm run selftest
```
パース・ROI抽出・統計の数値が期待どおりか（＝アプリと同じロジックか）を確認します。

## Claude Desktop への登録
`claude_desktop_config.json`（Claude Desktop の設定ファイル）に追記:
```json
{
  "mcpServers": {
    "desi-share": {
      "command": "node",
      "args": ["/absolute/path/to/connector/src/server.js"]
    }
  }
}
```
`/absolute/path/to/connector` は、この `connector` フォルダの絶対パスに置き換えてください。Claude Desktop を再起動すると `desi-share` の道具が使えます。

## 使えるツール（すべて読み取り専用）
- `list_projects` … 読めるプロジェクト一覧。
- `get_project(slug)` … 要約（メモ・化合物・ROI）。重い解析なし。
- `list_compounds(slug)` … 化合物一覧（precursor/product m/z 付き）。
- `get_roi_stats(slug, {section?, roi?, compound?})` … ROI内の**生強度の統計**（平均/中央値/最大/最小/四分位/n/sd）。
- `get_matrix(slug, {compound, section, roi?, max_rows?, downsample?, to_file?})` … 生の `{x,y,value}`。大きい場合は `downsample`/`max_rows` で調整、または `to_file:true` で**フルCSVをローカルファイルに書き出し**（会話に載せず、AIのコード実行ツールで読み込ませる）。

## 使用例（Claude への頼み方）
- 「desi-share で読めるプロジェクトを一覧して」
- 「プロジェクト `260422_...` の要約を出して」
- 「その中の ROI *Day6* の化合物 *LPI(18:1)* の平均強度を出して」
- 「化合物 *LPI(18:1)* の生データ（section 1）を `to_file` で取得して、Python(コード実行)で ROI 間の強度を比較して」

## しくみ（内部）
- サーバの**読み取り専用RPC**（`unlock_public_project` / `unlock_project` / `get_project_doc` / `list_rois`）と、**公開ストレージ**からの取得のみを使います。
- MSI の数値化は、Webアプリ本体と**同一のパースロジック**を移植しているので、数値が一致します。
- ROI内の値は、生の行を `buildMsiGrid` でピクセル格子に対応づけ、`pointInPolygon` で内側だけ集めた**生強度**です（表示用の0–255輝度ではありません）。

## 後日拡張（任意）
- ChatGPT の Action やチーム共有で使うには、この受付係を**ネット上に置き（HTTPS）＋エンドポイント認証**を足す構成にします（パスワードはサーバ側のみ、AIには渡しません）。
- サーバ側でも書き込みを厳密に不可能化したい場合は、専用の「読み取り専用トークン/RPC」を別途追加できます（本コネクタは既に読み取り専用です）。
