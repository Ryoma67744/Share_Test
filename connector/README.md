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

## ChatGPT で使う（カスタムGPT Action・ホスト版）

ChatGPT はあなたのPC内のプログラムを直接呼べないため、同じ受付係を**ネット上に置いて（HTTPS）＋APIキーで守り**、ChatGPTの**カスタムGPT**に登録します。中身（読むだけの機能）は共通、**読み取り専用のまま**です。

### 1. デプロイ（例: Render）
1. このリポジトリを GitHub に置く。
2. [render.com](https://render.com) → **New > Blueprint** → このリポジトリを選ぶ（`connector/render.yaml` を検出）。
3. Render が HTTPS の URL（例 `https://desi-share-connector.onrender.com`）と `CONNECTOR_API_KEY`（自動生成）を用意します。**このAPIキーを控える**。
   - 既定は `PUBLIC_ONLY=true`（**公開プロジェクトのみ**）。非公開も読むなら（かつこの入口を信頼できるなら）Render 側で `PUBLIC_ONLY=false` にし、`OWNER_ADMIN_PASSWORD` / `PROJECT_PW__<slug>` を**シークレット環境変数**として追加（**master pw は絶対に入れない**）。
   - 無料プランは無操作でスリープします（初回アクセスが少し遅い）。
- Render を使わずローカルで試すなら: `CONNECTOR_API_KEY=<任意の長い文字列> npm run serve` → `cloudflared tunnel` / `ngrok` で公開URLを作る（稼働中のみ有効）。

### 2. 動作確認（デプロイ後）
```bash
curl https://あなたのURL/healthz
curl -H "Authorization: Bearer あなたのAPIキー" https://あなたのURL/projects
```

### 3. カスタムGPT に登録
1. ChatGPT（有料プラン）で **Explore GPTs > Create > Configure > Create new action**。
2. **Import** に `https://あなたのURL/openapi.json` を指定（または内容を貼り付け）。
3. スキーマの `servers[0].url` を**あなたのURL**に置き換える。
4. **Authentication** = API Key → **Auth Type: Bearer**、キーに **`CONNECTOR_API_KEY`** を入力。
5. 保存。以後「読めるプロジェクトを一覧して」「プロジェクトXのROI *Day6* の化合物Yの平均を出して」等で使えます。

### 大きな生データの解析
`get_matrix` はホスト版では応答が大きくなりすぎないよう**控えめに上限**（既定1万行）＋ `downsample` で制御します。**大量の生データをじっくり解析**したい場合は、ローカル版で `to_file` にCSVを書き出し、**ChatGPTのデータ分析にアップロード**する方が確実です。

### セキュリティ
- **APIキーは秘密**に（漏れると、この入口が読める範囲まで露出します）。
- **既定は公開のみ**（`PUBLIC_ONLY=true`）。非公開を出すのは、入口を信頼できる場合だけ。
- **master パスワードは絶対に置かない**（読み取り専用の担保）。

## 内部のしくみ
- サーバの**読み取り専用RPC**（`unlock_public_project` / `unlock_project` / `get_project_doc` / `list_rois`）と、**公開ストレージ**からの取得のみを使います。
- MSI の数値化は、Webアプリ本体と**同一のパースロジック**を移植しているので、数値が一致します。
- ROI内の値は、生の行を `buildMsiGrid` でピクセル格子に対応づけ、`pointInPolygon` で内側だけ集めた**生強度**です（表示用の0–255輝度ではありません）。
- 構成: `src/server.js`(Claude用MCP) と `src/http.js`(ChatGPT用HTTP) は**同じコア** `src/tools.js` を共有します。

## 後日拡張（任意）
- サーバ側でも書き込みを厳密に不可能化したい場合は、専用の「読み取り専用トークン/RPC」を別途追加できます（本コネクタは既に読み取り専用です）。
