# DESI Data Share

DESI / MSI 切片ビューア + 共有プラットフォーム。Supabase をバックエンドに、ブラウザ上で動く HTML/JS シングルアプリです。

| ページ | URL | 役割 |
| --- | --- | --- |
| **プロジェクト管理** | `/` | ローカル + サーバのプロジェクト一覧 / 新規作成 / Copy URL |
| **ビューア** | `/viewer/` | データ表示 + ROI 編集 + Publish to share |

詳細は Help モーダル内のガイドと [`supabase/README.md`](./supabase/README.md) を参照してください。Help は閲覧モードに応じて出し分けられ、**共有 URL を開いた閲覧者 (共有モード) には「共有 受け手」ガイドのみ**を表示します (管理者 / 管理画面ガイドは master / admin 用)。

---

## ⚠ 現在テスト段階のため Private 運用

このリポジトリは現在 **private** に設定されています。GitHub Free プランでは private リポジトリの GitHub Pages を配信できないため、**`https://ryoma67744.github.io/DESI_Data_Share/` の URL は停止中**です。

テスト中は以下のローカル実行で動作確認してください。

### ローカル実行手順

リポジトリをクローン (もしくはローカルフォルダ) のルートで簡易 HTTP サーバを起動します。`file://` で開くと一部の `fetch` が CORS で弾かれるため、必ずサーバ経由で開いてください。

```bash
cd /path/to/DESI_Data_Share

# Python (大抵入っている)
python3 -m http.server 8000

# もしくは npx 系
# npx serve -l 8000

# もしくは PHP
# php -S localhost:8000
```

ブラウザで `http://localhost:8000/` を開くと管理画面が起動します。Supabase 側のデータベース / Storage は GitHub Pages の状態に関係なく稼働しているため、ローカルからでも `Publish to share` 含む全機能が動作します。

### Master 認証

管理画面 (`/`) およびビューア master モードはパスワードゲートで保護されています。既定値は **`MSIadomine`** (`supabase/README.md` 参照)。

### 公開に戻すには

1. GitHub にログインし `https://github.com/Ryoma67744/DESI_Data_Share/settings` を開く
2. **Danger Zone → Change repository visibility → Make public**
3. 確定すると数分以内に GitHub Pages が再有効化され、従来の `https://ryoma67744.github.io/DESI_Data_Share/` URL が復活します
4. 公開に戻す前に、サーバ側 (Supabase) の publish RPC に master 認証を追加することを推奨 (詳細は別タスク)

---

## 構成

- `index.html` — プロジェクト管理画面 (ルート)
- `viewer/index.html` — シングルファイルのビューア本体
- `mrm.html` — MRM 管理ライブラリ (admin 専用。化合物 / トランジション / Excel 取り込み)
- `USER_GUIDE.md`, `USER_GUIDE.en.md` — 共有受け手向けガイド (**共有モードのアプリ内 Help はこれのみ表示**)
- `USER_GUIDE.manage.md`, `USER_GUIDE.manage.en.md` — プロジェクト管理ガイド (master/admin 用)
- `USER_GUIDE.master.md`, `USER_GUIDE.master.en.md` — 管理者 (admin) 向けガイド (master/admin 用)
- `supabase/` — SQL スキーマと運用 README

---

## ライセンス / フィードバック

Tailwind / SheetJS / UTIF / JSZip / supabase-js / marked / DOMPurify を CDN 経由で利用しています。
不具合や要望は GitHub Issues、または直接管理者まで。
