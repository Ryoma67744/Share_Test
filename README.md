# DESI Data Share

DESI / MSI 切片ビューア + 共有プラットフォーム。共通の HTML/JS ソースから、Supabase を使うオンライン版と、Windows PC 1台で完結するオフライン配布版を作成します。

| 実行モード | 認証・保存 | 起動方法 |
| --- | --- | --- |
| オンライン | 既存のマスターパスワード認証、Supabaseでの共有・同期、ブラウザー内のプロジェクト保存 | Web配信、または下記の簡易HTTPサーバー |
| オフライン | マスターパスワード不要。プロジェクト・フォルダー・MRMを同じブラウザープロファイル内に保存 | 配布ZIPを展開し `START_OFFLINE.bat` |

オフライン版は実行環境とライブラリを同梱するため、利用者の初回起動にもインターネット・Node.jsの事前インストール・管理者権限は不要です。クラウド共有・自動同期・クラウド全体のMRM棚卸しは使用しません。操作とバックアップ方法は [`OFFLINE_GUIDE.md`](./OFFLINE_GUIDE.md) と [`START_HERE.txt`](./START_HERE.txt) を参照してください。

| ページ | URL | 役割 |
| --- | --- | --- |
| **プロジェクト管理** | `/` | ローカル + サーバのプロジェクト一覧 / 新規作成 / Copy URL |
| **ビューア** | `/viewer/` | データ表示 + ROI 編集 + Publish to share |
| **MRM管理** | `/mrm.html` | 化合物・トランジション・使用履歴・メソッドセット |

詳細は Help モーダル内のガイドと [`supabase/README.md`](./supabase/README.md) を参照してください。Help は閲覧モードに応じて出し分けられ、**共有 URL を開いた閲覧者 (共有モード) には「共有 受け手」ガイドのみ**を表示します (管理者 / 管理画面ガイドは master / admin 用)。

ビューア上部の **Export ZIP** 横にある **PPTレポート** から、登録済みの分子名・切片名・測定情報を使ったPowerPointを作成できます。黒背景の画像一覧、白背景の分子別詳細、登録情報の順に出力します。出力前の **CV・CEを含める** は毎回初期OFFです。共有ビューもAdminログインなしで利用でき、CV・CEを含める場合だけmaster pass認証が必要です。共有adminにも同じ認証が必要で、プロジェクトのAdmin passwordとは別です。公開ビュー／viewer権限では、認証後もCV・CE以外の詳細な装置取得条件・ソースファイル名は出力しません。対象と集計方法は[共有受け手ガイド](./USER_GUIDE.md#pptレポート)と[管理者ガイド](./USER_GUIDE.master.md#pptレポート)を参照してください。

---

## オンライン版の実行と公開

オンライン版の公開先・公開状態はリポジトリの Pages 設定に従います。配信URLはデプロイ結果で確認してください。リポジトリを簡易HTTPサーバーで開く場合も、通常はオンライン設定で起動します。

`runtime-config.js` が実行モードと公開用Supabase接続設定、`app-runtime.js` が共通の起動処理を担当します。オンライン接続が失敗しても、認証を省略するオフラインモードへ自動で切り替わることはありません。

### 開発用HTTPサーバーでオンライン版を実行

リポジトリをクローン (もしくはローカルフォルダ) のルートで簡易 HTTP サーバを起動します。`file://` で開くと一部の `fetch` が CORS で弾かれるため、必ずサーバ経由で開いてください。

```bash
cd /path/to/Share_Test

# Pythonがインストールされている場合
python3 -m http.server 8000

# もしくは npx 系
# npx serve -l 8000

# もしくは PHP
# php -S localhost:8000
```

ブラウザで `http://localhost:8000/` を開くと管理画面が起動します。Supabaseへの接続とサーバー側の設定が必要です。接続できる場合はローカルのHTTPサーバーからも `Publish to share` などのオンライン機能を使用できます。この起動方法は完全オフライン配布版とは異なります。

### テスト

PR と `main` への push では [`tests.yml`](.github/workflows/tests.yml) が Linux / Node.js 22 と Windows / Node.js 24.21.0 で自動実行されます。オンライン・オフライン双方の認証、保存、ROI、画像処理、バックアップ、ローカルサーバーと、connectorとの数値一致を確認します。手元では:

```bash
npm --prefix tests ci --no-audit --no-fund
npm --prefix connector ci --no-audit --no-fund
node tools/test.cjs
```

`tools/test.cjs` は `tests/*_regression.js` と `tests/*_regression.cjs` を列挙して実行し、connector selftestも実行します。個別確認には従来どおり `node tests/viewer_preview_regression.js` や `node tests/manage_tree_regression.js` を使えます。

### Master 認証

オンラインの管理画面 (`/`) およびビューア master モードは、Supabaseに設定されたマスターパスワードで保護されています。初期構築・パスワード変更と共有URLの認証は [`supabase/README.md`](./supabase/README.md) に従ってください。オフライン版はPCとブラウザープロファイルで利用を管理し、クラウドの認証情報を保存しません。

### Pagesへ公開する

リポジトリの **Settings → Pages** で GitHub Actions による配信を設定します。[`pages.yml`](.github/workflows/pages.yml) は `main` へのpush、または手動実行でテスト・Webビルド後に `dist/web` だけを配信します。Windows実行環境、配布ZIP、テスト用データなど、リポジトリ全体をそのままアップロードする構成ではありません。Supabase側のスキーマ・RPC設定は別途必要です。

## 配布物のビルド（開発者向け）

利用者向けの同梱ZIPを生成する処理です。開発環境にはNode.js 22以降とGitが必要です。リポジトリをGitでクローンし、そのルートで次のコマンドを実行します。初回のテスト依存関係・Windows実行環境の取得にはインターネットを使います。Webビルドはコミット済みvendorファイルとNode.jsの標準機能を使用し、Windows実行環境を取得しません。

```bash
# 同じHTML/JSからオンライン配信用ファイルを生成
node tools/build.cjs --mode web --out dist/web

# 固定バージョン・ハッシュ検証付きのWindows実行環境を取得
node tools/fetch-runtime.cjs

# 実行環境・説明書を含むオフライン版とZIP/SHA256を生成
node tools/build.cjs --mode offline --out dist/offline --runtime-dir runtime --zip dist/Share_Test_Offline.zip
```

Windowsでは生成後に `.\dist\offline\START_OFFLINE.bat --verify-only` で同梱ファイルを検証できます。通常起動は `.\dist\offline\START_OFFLINE.bat` です。オフライン版は固定の `http://127.0.0.1:8765/` を使います。オンライン配信先とはブラウザーの保存領域が別で、自動同期はしません。

`runtime/`、`dist/`、生成された `HOW_TO_USE.html`・`START_OFFLINE.bat`・`offline/manifest.json` はGit管理対象外です。HTMLを手でオンライン用・オフライン用に書き換える必要はありません。変更は共通ソースへ行い、ビルドし直します。

### CIでの配布ZIP作成・リリース

- 通常のテストCIはWindowsでオフライン版をビルドし、BATの検証後にZIPとSHA256をワークフロー成果物として14日間保持します。GitHub Releaseは作成しません。
- [`release-offline.yml`](.github/workflows/release-offline.yml) の手動実行は、既定の `publish=false` ならテスト・ビルドと成果物保存のみです（保持期間30日）。
- `v*` タグへのpush、または手動実行で明示的に `publish=true` とした場合のみ、検証済みZIPとSHA256をGitHub Releaseへ公開します。手動公開の `release_tag` は、選んだコミットを指す既存の `v*` タグを指定します。既存Releaseのファイルは上書きしません。
- 配布するファイルは `Share_Test_Offline.zip` と `Share_Test_Offline.zip.sha256` です。利用者のプロジェクト、ブラウザーデータ、開発用スモークテスト素材は含めません。

### 操作説明書の管理

[`OFFLINE_GUIDE.md`](./OFFLINE_GUIDE.md) がオフライン版の詳細説明の原稿です。ビルド時に、起動前でもブラウザーで読める `HOW_TO_USE.html` を生成します。[`START_HERE.txt`](./START_HERE.txt) は短い起動手順、[`DISTRIBUTION_NOTE.txt`](./DISTRIBUTION_NOTE.txt) は配布時の案内文です。生成済み配布物を編集すると整合性検証に失敗するため、原稿を更新して再ビルドしてください。配布案内の連絡先などは本文をメールや別ファイルへコピーして記入します。

プロジェクトのExport/Import ZIPと、ローカルMRM全体のJSONバックアップ・復元は別です。MRM復元は全置換です。フォルダー階層はブラウザー内の整理情報で、プロジェクトZIPには含まれません。更新・移行の手順は操作説明書を参照してください。

---

## 構成

- `index.html` — プロジェクト管理画面 (ルート)
- `viewer/index.html` — シングルファイルのビューア本体
- `mrm.html` — MRM 管理ライブラリ (オンラインはadmin認証、オフラインはローカル保存。化合物 / トランジション / 一括登録)
- `runtime-config.js`, `app-runtime.js` — モード・接続設定と共通起動処理
- `offline/` — ローカルサーバー、外部通信制限、ローカルMRMアダプター
- `vendor/` — 固定したライブラリ・ライセンス・出所。`assets.lock.json` で検証
- `tools/` — 両モードの配布ビルド、実行環境取得、テスト実行
- `USER_GUIDE.md`, `USER_GUIDE.en.md` — 共有受け手向けガイド (**共有モードのアプリ内 Help はこれのみ表示**)
- `USER_GUIDE.manage.md`, `USER_GUIDE.manage.en.md` — プロジェクト管理ガイド (master/admin 用)
- `USER_GUIDE.master.md`, `USER_GUIDE.master.en.md` — 管理者 (admin) 向けガイド (master/admin 用)
- `connector/` — 読み取り専用の AI コネクタ (MCP / HTTP)。Node
- `tests/` — ビューアの回帰テスト
- `.github/workflows/` — Pages配信、両OSのテスト、オフライン配布物の作成・リリース
- `supabase/` — SQL スキーマと運用 README

---

## ライセンス / フィードバック

Tailwind / SheetJS / UTIF / JSZip / supabase-js / marked / DOMPurifyなどは `vendor/` に固定して同梱します。出所・ハッシュ・ライセンスは `vendor/SOURCES.json`、`assets.lock.json`、`vendor/LICENSE-*` を参照してください。配布版のWindows実行環境のライセンスも同梱します。
不具合や要望は GitHub Issues、または直接管理者まで。
