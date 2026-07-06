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

1. パスワードを入力すると、`verify_master_pw(pw)` をサーバに投げ、`master_credentials` の bcrypt ハッシュと照合 (online 経路のみ)
2. **オフライン fallback は廃止**しました。Supabase に到達できない場合は解錠できません（旧版のハードコード SHA-256 `MASTER_FALLBACK_HASH_HEX` は削除済み。これによりパスワードをローテートしても古いクライアントハッシュで迂回されることが無くなります）
3. 認証成功は sessionStorage に **12 時間** キャッシュ（タブを閉じれば失効）

管理画面（`index.html`）ヘッダの **「パスワード変更」** ボタンから、入場系パスワードをまとめて変更できます（対象を選択）:
- **アプリ（プロジェクト一覧）に入るパスワード = マスターパスワード**: 現在のパスワードで認証 → 新パスワードを設定 → RPC `change_master_password`。初回ブートストラップのみ SQL の `set_master_password('...')` が必要（`master_credentials` に行が無いと変更 UI から設定できないため）。
- **サーバから一覧取得のパスワード = admin パスワード（全プロジェクト共通）**: マスターパスワードで認可 → 新パスワードを設定 → RPC `set_all_admin_passwords_master` が **全プロジェクトの admin 資格情報を一括更新**。以後の「サーバから一覧取得」と master 取り込み（`?import=`）は新しいパスワードが必要になります。

**各プロジェクトの viewer / admin パスワードの変更**は、管理画面のプロジェクト行（Publish 済み = server 行）の **「🔑 パスワード」** ボタンから行えます（マスターパスワードで認証 → ロール(viewer/admin)と新パスワードを指定 → RPC `set_project_password_master`）。再 Publish 不要で `project_credentials` を更新します。

> このゲートは **shoulder-surf 防止レベル** の補助的なものです。本格的な秘匿は `Publish to share` 経由で Supabase 側 (bcrypt) に置くデータでのみ成立します。

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
- `atlases anon delete` ポリシーの締め直し → r8 で publish-token DELETE ポリシーを追加 (下記)
- master pw のローテーション運用
- Sakura VPS / 自前ホスティングへの移行

---

## Phase 7-9: Public link / List of public projects / Project deletion

r2..r14 の進化で `share_locks.sql` には以下が増えています。**`share_locks.sql` 全体を SQL Editor で再実行する** だけで以下すべてが冪等に適用されます (テストで挙動が変わる場合は必ず再実行してください)。

### 追加された RPC

| RPC | 役割 |
| --- | --- |
| `unlock_public_project(_slug)` | viewer pw 不要の **公開 link** で project を開くときに呼ぶ。`projects.is_public = true` のものだけ session_token を発行。期限切れ token はサブクエリで `delete from public.session_tokens st where st.expires_at < now()` (alias を必ず付けないと OUT 引数 `expires_at` と PG 側で 42702 ambiguous エラー) |
| `delete_project_doc(_slug, _master_pw)` | 管理画面 `Delete (server)` で呼ぶ。SECURITY DEFINER で `projects` 行 + cascading children を削除し、Storage object のパス一覧を `paths jsonb` で返す。Storage object 自体は **フロントが REST DELETE で消す** (PL/pgSQL からは storage.objects を直接 delete できないため) |
| `_verify_master_pw(_pw)` | 既存。Phase 7 以降は `delete_project_doc` の冒頭でも呼ばれる |

### 追加された Storage policy (§4 atlases)

| policy 名 | 効果 |
| --- | --- |
| `atlases publish-token insert` | INSERT (新規 upload) を publish-token 必須に |
| `atlases publish-token update` | UPDATE (再 publish 上書き) を publish-token 必須に |
| **`atlases publish-token delete`** (r8 追加) | DELETE を publish-token 必須に。これがないと `Delete (server)` 実行時にフロントの REST DELETE が `403 (anon role lacks DELETE on storage.objects)` で失敗し、orphan blob が残る |

### projects テーブルの追加カラム

| カラム | 型 | 用途 |
| --- | --- | --- |
| `is_public` | boolean default false | true なら viewer pw 不要で開ける (公開 link) |
| `meta` | jsonb | project-level メタ (`memo` / `project_meta` / `T_he_to_msi_by_source` 等) を格納する dump 領域 |

### Anon SELECT grant

公開 link / 共有 link のトップレベル情報 (display name 等) を viewer pw 入力前に表示するため、anon に **限定列のみ** SELECT を grant しています:

```sql
grant select (id, slug, is_public, display_name, updated_at) on public.projects to anon;
```

これで anon は project の存在判定 + `is_public` フラグだけ読めるが、`meta` (memo / 内部状態) や `anatomy_palette` 等には触れません。

### 再適用手順

トラブル切り分け時は **`share_locks.sql` 全体を SQL Editor で再実行する** のが最短ルート (r2 以降全ステートメントが冪等)。再実行後:

```sql
-- 動作確認
select public._verify_master_pw('MSIadomine');           -- → t
select * from pg_policies where tablename = 'objects'    -- atlases 周り
   and policyname like 'atlases%';
select count(*) from public.projects where is_public;    -- 公開 link 数
```

---

## Master 用: 別 PC からの取り込み (`?import=<slug>`)

別 PC から server-only project を `Open (master)` すると、viewer は `?import=<slug>` で起動します。

| ステップ | 動作 |
| --- | --- |
| 1 | URL = `viewer/index.html?import=<slug>` |
| 2 | 「Master password を入力」モーダル — 正しければ Storage から全 blob (HE TIFF / MSI xlsx-txt / atlas.json) をダウンロード |
| 3 | IDB に書き戻し → 通常の master 画面が起動 |
| 4 | 以降の保存は auto-publish に乗って継続的にサーバ同期 |

これにより 1 人の master が複数 PC を順番に使う運用 (Phase 1 = PC A で publish → Phase 2 = PC B で `?import=` → 続きの編集 → auto-publish → Phase 3 = PC C…) が standard flow になりました。
