# Supabase setup (Phase 1)

このディレクトリは **共有 ROI / 認証 / 保護コンテンツ配信** を Supabase 上に立てるためのスクリプト一式です。Phase 1 では `cor_slide_1_10` を Supabase に乗せ、ログインモーダルと ROI 共有を動かすところまでをゴールにします。

> 必要なものは Supabase の **無料プラン** だけです。クレジットカード登録なしで試せます。

> **現在テスト段階のため、リポジトリを private 化しており GitHub Pages は停止中です。** 動作確認は手元で `python3 -m http.server 8000` 等を起動してアクセスしてください (詳細はリポジトリルートの [`README.md`](../README.md))。 Supabase 側 (DB / Storage / RPC) は無影響なので、ローカル実行からでも全機能を試せます。

---

## 0. 事前準備

1. <https://supabase.com> でアカウント作成（GitHub ログイン可）
2. **New Project** を押し:
   - Name: 任意（例 `marmoset-atlas-test`）
   - Database password: 後で使うのでメモ
   - Region: 一番近いもの（例 `Northeast Asia (Tokyo)`）
3. プロジェクトが起動したら、左サイドバーから:
   - **SQL Editor** … スキーマ投入と seed 実行に使う
   - **Storage** … HE TIFF などをアップロードする
   - **Project Settings → API** … URL と anon key を取得する

---

## 1. スキーマ投入

1. Supabase の **SQL Editor → New query** を開く
2. このリポジトリの [`schema.sql`](./schema.sql) の中身を全部コピペ
3. **Run** を押す（`Success. No rows returned` が出れば OK）

これで `projects` / `project_credentials` / `sections` / `rois` / `session_tokens` の 5 テーブルと、RPC 群が作成されます。RLS は全テーブルで ON、anon key からは RPC 経由でしかアクセスできない構成です。

---

## 2. Storage バケットへのファイルアップロード

`schema.sql` を実行すると `atlases` という非公開バケットが自動作成されます。

1. Supabase の **Storage → atlases** に移動
2. 新規フォルダ `cor_slide_1_10/sections/0/` を作成
3. 以下 3 ファイルを `datasets/cor_slide_1_10/data/` から **そのままアップロード**:

   | アップロード後のパス | ローカルの元ファイル |
   | --- | --- |
   | `cor_slide_1_10/sections/0/he.tif`    | `datasets/cor_slide_1_10/data/HE_Mam_Cor_Slide 1_10.TIF` |
   | `cor_slide_1_10/sections/0/msi.xlsx`  | `datasets/cor_slide_1_10/data/260421_msi_full_data_with_rois_1_10.xlsx` |
   | `cor_slide_1_10/sections/0/overlay.json` | `datasets/cor_slide_1_10/data/260421_overlay_reproducibility_1_10.json` |

> ファイル名は何でも構いませんが、変えた場合は次の seed の `storage_paths` も合わせて変更してください。

---

## 3. seed の実行（プロジェクト + 切片 + 既存 ROI を投入）

1. [`seed_cor_slide_1_10.sql`](./seed_cor_slide_1_10.sql) を開き、**2 行のパスワードを必ず差し替え**:
   ```sql
   select set_project_password('cor_slide_1_10', 'viewer', 'change-me-viewer');
   select set_project_password('cor_slide_1_10', 'admin',  'change-me-admin');
   ```
   - viewer 用: 共同研究者と URL と一緒に共有する合鍵
   - admin 用: あなただけが知る鍵（クリアボタンを使うとき入れる）
2. Supabase の **SQL Editor → New query** に貼り付けて **Run**
3. 末尾のサニティチェックを実行して、`projects=1, sections=1, rois=5` が返ることを確認:
   ```sql
   select count(*) from projects where slug = 'cor_slide_1_10';
   select count(*) from sections s join projects p on p.id=s.project_id
                   where p.slug='cor_slide_1_10';
   select count(*) from rois r join projects p on p.id=r.project_id
                   where p.slug='cor_slide_1_10';
   ```

---

## 4. URL と anon key を控える

Supabase の **Project Settings → API** から:

- `Project URL` … `https://<project-ref>.supabase.co`
- `Project API keys → anon (public)` … `eyJ...` で始まる長い文字列

この 2 つを Claude にコピペで貼ってください。フロントエンド (`viewer/index.html`) を Supabase に向ける作業に入ります。

> **Service role key は絶対に渡さないでください。** ブラウザに置いてはいけない最強権限のキーです。

---

## 5. その後のフロー（Claude 側で実装）

- `viewer/supabase-client.js` を追加
- `viewer/index.html` 冒頭にログインモーダル
- `populateRoiList` / `finalizeDrawing` / `deleteUserRoi` を Supabase RPC 経由に
- admin 入りの時だけ「全 ROI クリア」ボタンを表示

ここまで終わったら、ブラウザで `viewer/index.html?project=cor_slide_1_10` を開いて

1. viewer パスワード → 名前 "Alice" → 既存 5 ROI が見える
2. 新しい ROI を追加してリロード → 残っている、`by Alice` の表示
3. 別ブラウザで "Bob" として入る → Alice の ROI が見える、消せる
4. admin パスワードで入る → クリアボタンが出る、押すと全消去

を確認します。

---

## トラブルシュート

| 症状 | 原因 / 対処 |
| --- | --- |
| `permission denied for function …` | RPC 実行権限。`schema.sql` の `grant execute …` が走っていない可能性。再実行する |
| `Publish に失敗しました: new row violates row-level security policy` | (1) `atlases` バケットに対する anon の書き込みポリシーが未設定、または (2) `publish_sessions` テーブルが anon から読めず Storage RLS のサブクエリが常に false になる旧版ポリシーを使っている。**最新の [`share_locks.sql`](./share_locks.sql) を SQL Editor で再実行する**（`_publish_session_valid_for_path` SECURITY DEFINER ヘルパーと、それを使う新しい `atlases publish-token insert/update` ポリシーに置き換わる） |
| `invalid credentials` | パスワード違い、または `set_project_password` のスペル違い |
| HE TIFF が読めない | Storage 側でパスが違う／signed URL の有効期限切れ。`get_signed_url` の `p_expires` を伸ばす |
| ROI が他ブラウザに反映されない | リロード必須仕様（Realtime 同期は Phase 2 以降の検討事項） |
| 全 ROI を初期状態に戻したい | admin で入って「全 ROI クリア」→ `seed_cor_slide_1_10.sql` の最後の `import_rois_jsonb` ブロックだけ再実行 |

---

## 後段（Phase 2 以降）に向けたメモ

- 切片を増やすときは `sections` に行を追加するだけ（`ordinal` で並び順を制御）
- 新規プロジェクトを作るときは `projects` に行を追加 → `set_project_password` を 2 回 → `sections` を入れる
- Realtime 同期を有効にしたい場合は Supabase の **Database → Replication** で `rois` テーブルを有効化（フロント側のリスナ実装は別途）

---

## Master 用: プロジェクト管理画面の使い方

ヘッダの **`Projects`** ボタン（共有モードでは非表示）でプロジェクト管理モーダルが開きます。

### できること

- **ローカル一覧**: そのブラウザの IndexedDB に保存されているプロジェクト
- **サーバ一覧の取得**: `[サーバから一覧取得]` を押し、admin password (例: `MSIadomine`) を入力すると、その admin pw が登録されている全プロジェクトをサーバから列挙
- **+ 新規**: プロジェクト名・実験日時・装置・Matrix・Google Keep・Memo を **一括入力** して作成。ここで入力した内容はビューア右下の Memo パネルに自動反映され、`Publish to share` 時にサーバ側 `projects.meta` にも保存される
- **Open**: そのプロジェクトを開く（サーバのみのものは share URL に飛ぶ）
- **Copy URL**: publish 済みなら share URL をクリップボードへコピー
- **×**: ローカルの記録だけ削除（サーバ側は残る）

### 必要な SQL の再実行

このプロジェクト管理画面 / メタ情報のサーバ保存 / 一覧取得を有効にするには、最新の [`share_locks.sql`](./share_locks.sql) を SQL Editor で再実行してください。冪等です。追加されるもの:

- `projects.meta jsonb` カラム（メタ情報の保存先）
- `upsert_project_doc` の `meta.memo` 書き込み拡張
- `get_project_doc` の `meta.project_meta` 返却
- 新 RPC `list_projects(_owner_password text)`

### admin password の運用

`list_projects` は **入力された admin password が一致するプロジェクトだけ** を返します。共通 admin pw（既定値は Publish モーダルの pre-fill にある `MSIadomine`）をすべてのプロジェクトで使い回せば、1 度の入力で全プロジェクトが取得できます。

> **`MSIadomine` をフロント側にハードコードしているわけではありません**。サーバ側の `project_credentials` に bcrypt ハッシュで保存された値と照合するだけ。安全のため admin password は適宜変更してください。

### 管理画面のパスワードゲート

ルートの `/index.html`（プロジェクト管理画面）と、`viewer/index.html` の master モードは、入口で **admin password の入力**を求めます。共有 URL（`#share=<slug>`）で開く受け手側には影響しません。

挙動:

1. パスワードを入力すると、まず `list_projects(pw)` をサーバに投げ、bcrypt で照合 (online 経路)
2. ネットワーク不通や Supabase 障害時のフォールバックとして、ブラウザ側で SHA-256(`pw`) を計算し、ハードコード済みの `MSIadomine` の SHA-256 と一致すれば通します（offline 経路）
3. 認証成功は sessionStorage に **12 時間** キャッシュ（タブを閉じれば失効）

> このゲートは **shoulder-surf 防止レベル** の補助的なものです。本格的な秘匿は `Publish to share` 経由で Supabase 側 (bcrypt) に置くデータでのみ成立します。
> SHA-256 fallback ハッシュを別パスワードに変更したい場合は、`index.html` 内の `MASTER_FALLBACK_HASH_HEX` を `printf '%s' '<新パスワード>' | sha256sum` の出力で差し替えてください。

---

## Phase 1: Publish と Storage 書き込みのサーバ側ガード

GitHub Pages 経由でソースが流出しても、**マスターパスワードを知らない第三者は publish できない / Storage に書き込めない** 状態にするための措置です。

### 何が変わるか

| 操作 | 旧挙動 | 新挙動 (Phase 1) |
| --- | --- | --- |
| `upsert_project_doc` (Publish RPC) | anon key だけで通った | **master pw 必須** (新しい第 1 引数 `_master_pw`) |
| Storage `atlases` への INSERT/UPDATE | anon ポリシーで誰でも書けた | **`x-publish-token` ヘッダ必須**。token は `request_publish_session(_master_pw, _slug)` でしか取れない |
| Storage `atlases` の SELECT (読み取り) | public-read | **変更なし** (UUID パスを知っている人だけが拾える前提) |
| 共有 URL からの閲覧・ROI 編集 | 普通に動く | **変更なし** |

### 適用手順

1. `supabase/share_locks.sql` を Supabase の SQL Editor で再実行 (冪等)
   - 追加されるもの: `master_credentials` テーブル / `set_master_password` / `_verify_master_pw` / `publish_sessions` テーブル / `request_publish_session` / 旧 `upsert_project_doc(7-arg)` の drop と新 `(8-arg)` の作成 / Storage 旧 anon write ポリシーの drop と publish-token ポリシーの作成
2. **マスターパスワードを 1 度だけ設定**:
   ```sql
   select public.set_master_password('MSIadomine');
   ```
   - 8 文字以上必須
   - 別の文字列にしたい場合は引数を変えるだけ。後日同じ関数を呼べば bcrypt ハッシュが上書きされる
3. フロント (`index.html` / `viewer/index.html`) を最新コードにする
   - 古い JS は `_master_pw` 引数を送らないので **publish が `unauthorized` で失敗** します。SQL とフロントは同時に更新してください
4. テスト:
   ```sql
   select public._verify_master_pw('MSIadomine');  -- → t
   select public._verify_master_pw('wrongpw');     -- → f
   ```

### Master pw のキャッシュ動線

- Master が `index.html` を開いてゲートに `MSIadomine` を入力
- 認証成功時に `sessionStorage.desi:masterPw` に 12 時間キャッシュ
- ビューアの `Publish to share` で再入力プロンプトなしに `request_publish_session` → upload → `upsert_project_doc` まで通る

### Phase 2 への積み残し

- Storage 読み取りの **signed URL 化** (現状は public-read。 UUID パス推測ができないという前提でガード)
- `atlases anon delete` ポリシーの締め直し
- master pw のローテーション運用
- Sakura VPS / 自前ホスティングへの移行
