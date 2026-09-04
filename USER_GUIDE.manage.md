# DESI Data Share — プロジェクト管理ガイド

このガイドは **DESI Data Share の管理画面 (`/`)** だけを対象にしたマニュアルです。データの登録 / 公開や受け手向けの操作については、Help モーダル右上の読者タブで「データ共有 (admin)」「データ共有 (受け手)」を選んでください。

---

## 目次

1. [この画面でできること](#1-この画面でできること)
2. [ログイン (パスワード)](#2-ログイン-パスワード)
3. [画面構成](#3-画面構成)
4. [新規プロジェクトを作成する](#4-新規プロジェクトを作成する)
5. [プロジェクトを開く・削除する](#5-プロジェクトを開く削除する)
6. [サーバから一覧取得 (別 PC でも見る)](#6-サーバから一覧取得-別-pc-でも見る)
7. [URL のコピー](#7-url-のコピー)
8. [データの保存先](#8-データの保存先)
9. [ビルドタグ (右下バッジ)](#9-ビルドタグ-右下バッジ)
10. [困ったときは](#10-困ったときは)

---

## 1. この画面でできること

- 自分が作成したプロジェクトの一覧表示 (ローカル + サーバ)
- 新規プロジェクトの作成 (実験日 / 装置 / Matrix / Google Keep / Memo を一括入力)
- 既存プロジェクトを開く / 削除する
- 公開済みプロジェクトの **共有 URL を 1 クリックでコピー**
- サーバから過去公開したプロジェクトを呼び出す (別 PC からでも一覧可)

データの登録 (HE/IF, MSI) や `Publish to share` は、ここから `Open` してビューアに入った後の操作です (詳細は「データ共有 (admin)」)。

---

## 2. ログイン (パスワード)

管理画面の入口で admin password を要求されます。

- 既定値は `MSIadomine` (Publish モーダルの admin password 欄に pre-fill されるもの)
- 認証が通ると **12 時間** sessionStorage に保持され、再入力不要
- タブを閉じれば失効
- Supabase が接続できる場合は `list_projects(pw)` を呼んで bcrypt 照合
- オフライン時は SHA-256 でローカル比較に fallback

> このゲートは shoulder-surfing 防止レベルです。本格的な秘匿は Supabase 側 (bcrypt) で実現されています。

---

## 3. 画面構成

- **ヘッダ**: タイトル + Help ボタン
- **アクション行**: `+ 新規プロジェクト` / `サーバから一覧取得`
- **プロジェクト一覧**: 各行は以下の情報とアクション
  - 名前 + バッジ (`Local` / `Local + Server` / `Server only`)
  - 実験日 / 装置 / Matrix / Google Keep / Memo の冒頭
  - `Open` / `Copy URL` / `Delete`

### バッジの意味

| バッジ | 意味 |
| --- | --- |
| **Local** | このブラウザの IndexedDB にだけある (未 publish、または別 PC で作成等) |
| **Local + Server** | ローカルにもサーバにもある (この PC で publish したもの) |
| **Server only** | サーバのみ (別 PC で publish した、ローカルから削除済み等) |
| **空** | このローカル記録に切片が 1 つもない (作成しただけの状態)。開いても「レイヤーがありません」にしかなりません |

---

## 4. 新規プロジェクトを作成する

1. `+ 新規プロジェクト` ボタンを押す
2. メタ情報フォーム:
   - **プロジェクト名** (必須)
   - **実験日時**: `<input type="date">`
   - **装置**: DESI / TIMS / LTQ / Other
   - **Matrix**: 装置が DESI 以外の場合のみ表示
   - **Google Keep**: 関連ノートの URL (任意)
   - **Memo**: 自由記述
3. `Create` でビューアに遷移、すぐに HE/IF/MSI を登録できる状態に

ここで入力した値はビューア右下の Memo パネルにそのまま反映されます。

---

## 5. プロジェクトを開く・削除する

行ごとのバッジに応じて出るボタンが変わります。

| 行のバッジ | 出るボタン | 用途 |
| --- | --- | --- |
| Local / Local + Server | `Open` / `Copy URL` / `Delete` | この PC で編集 / 共有 URL コピー / IDB から削除 |
| **Server only** | **`Open (master)` / `Share view` / `Delete (server)`** | 別 PC で publish した project をこの PC で master 編集 / share recipient として閲覧 / **サーバから完全削除** |

### 5-1. Server only 行のボタン詳細

- **Open (master)**: viewer に `?import=<slug>` 付きで遷移し、**master password** (この管理画面に入るときと同じもの) で認証して Storage から blob をダウンロードし、master 画面が起動します。
  - 管理画面で一度入力していればセッション中は聞かれません。
  - parquet (TIMS ノンターゲット) は**ダウンロードせず Storage から直接読みます** (数百 MB を IndexedDB に置くと容量超過で壊れるため)。
  - 取り込んだ直後は共有パスワード (viewer / admin) が引き継がれません。編集すると同期インジケータが **🔑 共有パスワード未設定** になるので、1 回だけクリック → `Publish to share` でパスワードを設定してください。以降は通常の auto-publish フローに乗ります。
- **Share view**: 普通の `#share=<slug>` リンクで viewer に遷移 (viewer pw 入力 → 受け手と同じ画面)。
- **Delete (server)**: master pw を要求 → 確認ダイアログ → サーバの `projects` 行 + 関連子テーブル (sections / rois / project_credentials / session_tokens / roi_locks) + Storage 配下 `<slug>/...` のオブジェクトをすべて削除。**復旧手段なし** なので注意。

### 5-2. Local / Local + Server 行の Delete

- ローカル IndexedDB のみから削除
- サーバに publish 済みなら **サーバ側のデータは残る** (`Server only` に変わる)
- サーバ側も消したいときは Server only 行に切替えて `Delete (server)` か、Supabase ダッシュボードから手動削除

---

## 6. サーバから一覧取得 (別 PC でも見る)

別 PC で publish したプロジェクトをこの PC でも一覧したいときに使います。

1. `サーバから一覧取得` ボタンを押す
2. **admin password** を入力 (既定 `MSIadomine`)
3. その admin pw が登録されているプロジェクトがすべて表示される
4. 入力した pw は sessionStorage に 12 時間キャッシュ (次回はプロンプトなし)
5. ローカルに無い project には **`Server only`** バッジが付き、`Open (master)` / `Share view` / `Delete (server)` ボタンが出ます

> 共通 admin pw を運用していれば、どの PC でも同じパスワードで全プロジェクトを呼び出せます。
> 1 人で複数 PC を順番に使う運用では、Phase 1 で publish → Phase 2 PC で `Open (master)` (= `?import=<slug>`) → 続きの編集 → auto-publish → 次の PC で `Open (master)` … が標準フローです。

---

## 7. URL のコピー

Publish 済みのプロジェクトには `Copy URL` ボタンが出ます。

- クリックでクリップボードに `https://.../viewer/index.html#share=<slug>` をコピー
- ボタンが `Copied ✓` に一瞬切替わる
- viewer password と admin password は **別チャネル** (Slack / メール) で受け手に渡してください

未 publish のプロジェクトは `URL なし` (disabled) が表示されます。`Open` → ビューアで `Publish to share` してから戻ると `Copy URL` が現れます。

---

## 8. データの保存先

| 場所 | 何が入る | 範囲 |
| --- | --- | --- |
| **ローカル IndexedDB** (`desi-projects` DB) | プロジェクトメタ + 切片構造 + ROI + Memo + 登録ファイル本体 (TIFF/xlsx/txt/parquet/.raw.zip) | このブラウザのこのプロファイル限定 |
| **Supabase** (publish 済のみ) | 切片構造 / ROI / Memo / 圧縮バイナリ / bcrypt パスワード | サーバ全体 |
| **localStorage** | 最後に開いたプロジェクト ID、レイアウト寸法 | このブラウザのこのプロファイル |
| **sessionStorage** | admin pw キャッシュ、master 解錠フラグ | このタブのみ |

> 重要: ローカル IndexedDB の容量は無制限ではありません。ブラウザのストレージ逼迫時に削除されることがあるので、**重要なプロジェクトは必ず Publish to share でサーバに退避**してください。

---

## 9. ビルドタグ (右下バッジ)

画面右下に **`v:YYYY-MM-DD-rN`** という小さなビルドタグが常時出ています。

- ファイル更新後にハードリロード (Ctrl+F5) すれば必ず最新版になります — タグの値が変わっていれば適用済の確認になります
- バグ報告時に「v:2026-05-08-r15」のようにタグを添えていただけると再現確認が早くなります
- share recipient 画面 / master 画面 / 管理画面すべてに同じタグが出ます

---

## 10. 困ったときは

| 症状 | 対処 |
| --- | --- |
| `Init failed: The requested version (X) is less than the existing version (Y)` | DB スキーマのバージョン不整合。最新コードに更新してハードリロード (Ctrl+F5) |
| サーバ一覧取得でエラー | admin pw が違う、または Supabase が接続できない |
| URL コピーボタンが出ない | まだ Publish to share していない。`Open` → ビューアで Publish |
| パスワードを入力しても先に進めない | キャッシュをクリア + 再ロード。それでもダメなら admin pw を変更した可能性 |
| 別 PC からプロジェクトが見えない | `サーバから一覧取得` で admin pw を入力し直してください |
| `Delete (server)` で「失敗: N 件」 | Storage の publish-token DELETE policy が未適用。`supabase/share_locks.sql` の §4 を再実行してください |
| `Open (master)` で master pw を聞かれる | `?import=<slug>` 経由の初回オープンには master password が必要です (管理画面に入るときと同じもの) |
| `Open (master)` でパスワードを入れると一覧に戻ってしまう | 古いビルドはプロジェクト個別の **admin password** を要求していました。admin password を設定せずに publish したプロジェクトには正解が存在しないため、何を入れても戻ります。ページを更新して最新版で開き直すか、`🔑 パスワード` で admin を設定してください |
| 開いたら「レイヤーがありません」と出る | 一覧で **空** バッジが付いていないか確認してください (作成しただけのプロジェクト)。データのある方を開いてください |
| 同じプロジェクトが 2 行に出る | 古いビルドが作ったフォルダ情報の重複です。最新版で開くと 1 行に畳まれ、フォルダ操作を 1 回行うとサーバ側にも反映されます |
