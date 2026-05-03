# DESI Data Share — 管理者ガイド (データ共有)

このガイドは **DESI Data Share でデータを公開する側 (master / admin)** 向けです。プロジェクトの棚卸しだけなら「プロジェクト管理」、共有 URL を受け取った閲覧者には「データ共有 (受け手)」を参照してください。

---

## 目次

1. [全体フロー](#1-全体フロー)
2. [プロジェクトを開く](#2-プロジェクトを開く)
3. [HE / IF レイヤーを登録](#3-he--if-レイヤーを登録)
4. [MSI レイヤーを登録](#4-msi-レイヤーを登録)
5. [Align — HE/IF を MSI に重ねる](#5-align--heif-を-msi-に重ねる)
6. [レイヤー個別の表示設定 (歯車 ⚙)](#6-レイヤー個別の表示設定-歯車-)
7. [ROI を引く](#7-roi-を引く)
8. [Memo の入力](#8-memo-の入力)
9. [Export ZIP — 手元バックアップと配布](#9-export-zip--手元バックアップと配布)
10. [Publish to share](#10-publish-to-share)
11. [共有 URL とパスワードの渡し方](#11-共有-url-とパスワードの渡し方)
12. [再 publish の挙動](#12-再-publish-の挙動)
13. [アップロード進捗 / 大ファイル対策](#13-アップロード進捗--大ファイル対策)
14. [Storage 容量の目安](#14-storage-容量の目安)
15. [困ったときは](#15-困ったときは)

---

## 1. 全体フロー

```
[管理画面 /]
   │ + 新規プロジェクト or Open
   ▼
[ビューア /viewer/]
   │ HE/IF/MSI 登録 → ROI → Memo
   ▼
[Publish to share]
   │ slug + viewer pw + admin pw
   ▼
[Share URL + Passwords]
   ▼
共同研究者に渡す (URL と viewer pw を別チャネルで)
```

---

## 2. プロジェクトを開く

- **新規**: 管理画面で `+ 新規プロジェクト` → メタ情報入力 → `Create` → ビューア
- **既存**: 管理画面のプロジェクト一覧で `Open`

ビューアの `← Projects` ボタンで管理画面に戻れます。

---

## 3. HE / IF レイヤーを登録

各切片パネル右上の `+ HE/IF` ボタンから:

1. レイヤー名 (`HE Stain` / `IF Stain` / 任意 custom) を選択
2. **画像ファイル** (TIFF / PNG / JPEG) を選択
   - TIFF は UTIF.js で自動デコード
3. **変換 JSON** (任意) を選択。フォーマット:
   ```json
   {
     "T_he_to_msi": [
       [-0.283, -0.0005,  87.87],
       [ 0.0005, -0.283, 115.64],
       [ 0.0,    0.0,    1.0  ]
     ],
     "he_um_per_px":  { "x": 0.25, "y": 0.25 },
     "msi_um_per_px": { "x": 50.0, "y": 50.0 }
   }
   ```
4. `Register` で確定 → MSI 座標系に整合してキャンバスに重なる

> 変換 JSON を省略すると HE/IF はそのキャンバスサイズで表示 (位置整合なし)。後から **`Align` ボタン**(各切片パネル上部)で対話的にアライメントできます — 詳細は §5。

---

## 4. MSI レイヤーを登録

各切片パネルの `+ MSI` ボタンから:

### 4-1. xlsx 形式
1. ソースファイル (`.xlsx`) を選択
2. シート名 (既定 `MSI_Data`) と **ヘッダ行** (既定 4) を確認
3. `Reload columns` で列ラベルを再読込
4. **X 列** / **Y 列** (既定 `Image_X`, `Image_Y`) を選択
5. **強度列** を Ctrl/Cmd で複数選択 (各列が独立した MSI レイヤーになる)
6. **Data start row** (既定 5) を確認
7. `Register` で各列ごとに `MSI_<列名>` のレイヤーが作成される

### 4-2. txt 形式
- Analyte (`Analyte (converted from imzML)`) または一般 TSV/CSV
- レイヤー名 (例 `MSI_DA`) と value column 番号を指定して登録

---

## 5. Align — HE/IF を MSI に重ねる

各切片パネル上部の **`Align`** ボタンを押すと、HE/IF を MSI 座標系に整合させるための専用モーダルが開きます。`+ HE/IF` 登録時に変換 JSON を渡していない場合や、再アライメントしたい場合に使います。

<div style="border:1px solid #cbd5e1;border-radius:6px;padding:10px;background:#f8fafc;margin:10px 0;font-size:12px;">
  <div style="font-weight:600;color:#0f172a;margin-bottom:6px;">Align モーダルの構成</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
    <div style="border:1px solid #94a3b8;border-radius:4px;padding:6px;background:#fff;">
      <div style="font-weight:600;font-size:11px;">左パネル: HE/IF サムネ</div>
      <div style="color:#64748b;font-size:11px;">Layer ドロップダウンで切替<br>クリックでランドマーク追加</div>
    </div>
    <div style="border:1px solid #94a3b8;border-radius:4px;padding:6px;background:#fff;">
      <div style="font-weight:600;font-size:11px;">右パネル: MSI サムネ (Plasma)</div>
      <div style="color:#64748b;font-size:11px;">MSI ドロップダウンで化合物切替<br>「TIC (合成)」が先頭に出る場合あり</div>
    </div>
  </div>
  <div style="margin-top:6px;border:1px dashed #cbd5e1;border-radius:4px;padding:6px;background:#fafafa;">
    <div style="font-weight:600;font-size:11px;">下部: MSI pixel size / Manual / Solve</div>
    <div style="color:#64748b;font-size:11px;">μm/px・Flip・Scale・Rotate・Offset X/Y</div>
  </div>
</div>

### 5-1. MSI セレクタ

- 化合物名のドロップダウンで MSI サムネを切替できます。
- **TIC (合成)** … MRM トランジションを多数登録していて `MSI_TIC` レイヤーが無いとき、先頭に自動で挿入されます。全 MSI 系列の輝度を加算した擬似 TIC で、ランドマーク picking 用に使うのが目的です。
- いずれの MSI も **Plasma カラーマップ** で着色して表示されるので、グレースケールよりも信号領域が見やすくなっています。

### 5-2. MSI pixel size

`X / Y` (μm/px) を入力。これが ROI の物理スケール (μm 単位) や、メイン canvas 左下の **スケールバー** の根拠になります。一般に DESI は X==Y の正方形ピクセルなので 1 か所だけ入力して OK。

### 5-3. Manual セクション (リアルタイムスライダー)

| 項目 | 範囲 | 効果 |
|---|---|---|
| Flip Horizontal / Vertical | チェック | HE を左右 / 上下反転 |
| Scale | 5–500 % | HE の拡大縮小 |
| Rotate | -180°–180° | HE の回転 |
| Offset X / Y | -2000–2000 px | HE の平行移動 |

**スライダーまたは数値 input** どちらでも編集可能。背後の Section パネルがリアルタイムでプレビューされるため、アライメント結果を視認しながら微調整できます。

### 5-4. Landmark モード

両パネルに対応点を ≥ 3 組クリックして打ち、**`Solve`** を押すと complex-LSE の similarity transform (回転 + 等方スケール + 並進) を解いて Manual のスライダーに反映します。

| ボタン | 動作 |
|---|---|
| `Reset to identity` | Manual の値をすべて初期値に戻す |
| `Clear all` | 打ったランドマーク両側を全消去 |
| `Solve` | ランドマークから Affine を推定して Manual に反映 |

### 5-5. Cancel / Save

- **Cancel**: モーダルを開いた時点の値に戻す。プレビューも巻き戻る。
- **Save**: 現在の値を `sec.meta.world_coords.T_he_to_msi` と `msi_um_per_px` に書き込み、IndexedDB に永続化。ROI の物理スケールにも即時反映。

> Save 後にメイン canvas を見ると、HE が MSI の下、MSI が上に乗った状態で描画され、左下に **スケールバー** が出ます。バーは round な値 (10/20/50/100/200/500 μm, 1/2/5/10 mm) を自動選択し、**マウスホイールで拡大すると刻みが細かく** なります。

---

## 6. レイヤー個別の表示設定 (歯車 ⚙)

各レイヤーのチップ右端の **歯車 ⚙** をクリックすると、そのレイヤー専用の小ポップオーバーが開きます。サムネイル画像クリックでも近い設定が出ます。

<div style="border:1px solid #cbd5e1;border-radius:6px;padding:10px;background:#fff;margin:10px 0;font-size:12px;display:grid;grid-template-columns:1fr 1fr;gap:10px;">
  <div style="border:1px solid #94a3b8;border-radius:4px;padding:8px;background:#f8fafc;">
    <div style="font-weight:600;color:#0f172a;margin-bottom:4px;">MSI レイヤーの場合</div>
    <ul style="margin:4px 0 0 1.2em;padding:0;color:#475569;font-size:11px;line-height:1.6;">
      <li><b>Apply opacity</b> ✓ (既定 ON)</li>
      <li>Opacity (0–100%)</li>
      <li>Intensity range (vmin / vmax)</li>
    </ul>
  </div>
  <div style="border:1px solid #2563eb;border-radius:4px;padding:8px;background:#eff6ff;">
    <div style="font-weight:600;color:#1d4ed8;margin-bottom:4px;">HE / IF レイヤーの場合</div>
    <ul style="margin:4px 0 0 1.2em;padding:0;color:#475569;font-size:11px;line-height:1.6;">
      <li><b>Apply opacity</b> ☐ (既定 OFF — 常時不透明)</li>
      <li>Opacity (チェック OFF 時はグレーアウト)</li>
      <li><b>Grayscale (モノクロ表示)</b></li>
    </ul>
  </div>
</div>

### 6-1. Apply opacity (透明化を反映するか)

- **チェック ON**: Opacity スライダーの値が描画に反映される。
- **チェック OFF**: スライダー値を無視して常時 100% で描画。スライダーは見えるがグレーアウト。
- **既定**: HE/IF は OFF、MSI は ON。これにより HE は常に不透明な「下地」として残り、MSI ヒートマップだけ Opacity で薄められる体験が標準になります。
- 状態は `sec.meta.layerDisplay[key].applyOpacity` に永続化。リロード後も保持。

> ツールバー上部の Opacity 入力もこの設定と連動します。アクティブ MSI で Apply opacity OFF なら、ツールバーの Opacity がグレーアウトして「このレイヤーは Apply opacity が OFF です」とツールチップが出ます。

### 6-2. Grayscale (HE/IF のみ)

- HE/IF レイヤーをモノクロ化して描画。MSI の Plasma 色を最大コントラストで見せたいときに有用。
- BT.601 luma で R/G/B → 単色化(透明度はそのまま)。
- 状態は `sec.meta.layerDisplay[key].grayscale` に永続化。

### 6-3. レイヤー描画順 (HE → 他 → MSI)

メイン canvas は常に **HE/IF が下、MSI が上(加算合成)** の順で描画されます。これは表示状態 (visibleLayers) の登録順に依存しない仕様で、HE が MSI を覆い隠さないようにする目的の挙動です。

---

## 7. ROI を引く

1. アクティブにしたい切片パネルをクリック
2. ROI LIST 上の `+ 新規` をクリック (描画モード ON)
3. キャンバス上を順にクリックして 3 点以上の頂点
4. 確定: 始点クリック / ダブルクリック / **Enter**
5. ROI 名を入力

別切片に同じ ROI を描くには各行の `+ draw` ボタン。

> 描画途中で **Escape** → 中止。複数切片で `polysBySection` に蓄積されます。

---

## 8. Memo の入力

ビューア右下の Memo パネル:

| 項目 | 内容 |
| --- | --- |
| Sample | サンプル名 |
| Experiment date | 実験日 |
| Machine | DESI / TIMS / LTQ / Other |
| Matrix | 装置が DESI 以外の場合のみ表示 |
| Google Keep | 関連ノート URL |
| Memo | 自由記述 |
| Derivatization | 誘導体化処理 |

入力値は IndexedDB に約 400ms で自動保存。Publish 時にサーバの `projects.meta.memo` にも送られます。

> Method (MRM) テーブルの **Precursor / Fragment / CE / CV** は **管理者のみ表示** (admin password で開いた閲覧者にも見える)。通常の viewer pw だけで開いた閲覧者には隠されます。

---

## 9. Export ZIP — 手元バックアップと配布

ヘッダの **Export ZIP** で、現在のプロジェクト全体(画像・MSI 数値・ROI・Memo・Align など)を 1 つの ZIP にまとめてダウンロードできます。Publish と違ってサーバを介さず、後日 `Import ZIP` で同じビューア(あるいは別環境)に復元できます。

### 9-1. ファイル構造(新形式)

```
<プロジェクト名>_<YYYY-MM-DDTHH-MM-SS>.zip
├── <プロジェクト名>.json            ← プロジェクトメタ + 全 ROI + Memo (ルート JSON 名 = プロジェクト名)
└── sections/
    └── <sectionId>/
        ├── atlas.json               ← 切片メタ + 各レイヤー定義 (Align / Display / 表示状態)
        └── data/
            ├── img_HE_Stain__<元ファイル名>.tif    ← HE/IF はレイヤーごと
            ├── msi__Analyte_1.txt                   ← MSI はソースファイル単位で 1 ファイル
            └── msi__Analyte_2.xlsx                   ← 同上(ROI 列追記済み)
```

### 9-2. ルート JSON 名がプロジェクト名

`<プロジェクト名>.json` というファイル名で出力されます (ASCII 英数字 + `_` `-` 以外は `_` に置換)。Import 時はルート直下の任意の `*.json` を `format` フィールドで判別して読むので、リネームしても問題ありません。

### 9-3. MSI データはソースファイル単位で 1 ファイルに統合

旧形式では 1 化合物 = 1 ファイル(同じ xlsx でも複数 MSI レイヤーを登録すると同じバイナリが複製出力)。**新形式では同じソースファイルから登録された MSI 化合物は ZIP 内で 1 ファイルにまとめられます**。

例: `Analyte 1.txt` から 17 化合物登録 → 旧形式では 17 ファイル、新形式では `data/msi__Analyte_1.txt` の **1 ファイル**(中身に 17 化合物全件あり)。

<div style="border:1px solid #cbd5e1;border-radius:6px;padding:8px;background:#f8fafc;margin:10px 0;font-size:12px;">
  <div style="font-weight:600;color:#0f172a;margin-bottom:6px;">同一切片の MSI ファイルが「同じ XY」を共有する根拠</div>
  <div style="color:#475569;">DESI/MSI 取得は通常、1 ソース内の全 MRM トランジションが同期スキャンで取得されるため、同一切片で同一ソース由来のデータは Image_X / Image_Y が完全に一致します。新形式はこれを利用して 1 ファイルに集約しています。</div>
</div>

### 9-4. xlsx には ROI 列が追記される

xlsx ソースは元の列構造を保持したまま、**末尾に各 ROI ごとの 0/1 フラグ列が追加** されます(列名 = ROI 名)。受け手は Excel / R / Python でそのまま読んで「化合物 × ROI」の集計を実行可能。txt は安全に書き換える術が無いため無加工で出力(ROI 情報は ルート JSON の `polysBySection` で参照可能)。

| 列 | 意味 |
|---|---|
| Image_X / Image_Y | 取得位置(MSI ピクセル) |
| (元の強度列) | 化合物 1, 化合物 2, ..., 化合物 N |
| (元の末尾 2 列) | 元 xlsx のレイアウト維持 |
| **Cortex (新規)** | ROI Cortex 内なら 1、外なら 0 |
| **Hippocampus (新規)** | 同上 |

### 9-5. atlas.json の `path` 解釈

各切片の `atlas.json` は MSI レイヤー定義に `path` フィールドを持ちます。**複数の `msiSeries[layerKey]` が同じ `path` を共有するのが新形式の正常状態**。Import 時はこの path をキーに blob を 1 度だけ復元 → IDB 容量も圧縮されます。

### 9-6. Import (= 復元)

ヘッダの **Import ZIP** で取り込み:
- ZIP ルート直下の `*.json` を探索 → `format=desi_data_share_v1` を持つものをプロジェクトメタとして採用
- `sections/<id>/atlas.json` から各切片を再構築
- `path` が共有された MSI 化合物は **1 つの blob に集約** されて IDB に格納
- 新しい id を採番(元プロジェクトと衝突しない)

> **旧形式の ZIP**(`project.json` 固定名 + `msi_<layerKey>__` 個別ファイル)は **非対応**。Import すると「旧形式の ZIP は非対応です」エラーが出ます。最新版で再 Export してください。

### 9-7. ZIP は Publish とは独立

- Export ZIP は **手元保存と他者への配布専用**(共有 URL は生成されない)
- 受け手は viewer の **Import ZIP** から取り込めば同等のビューアで閲覧可能
- 受け手側は Publish to share / Export 操作を **再度行えない**(共有モードでは該当ボタン非表示)
- ZIP は self-contained。サーバ不要で完結

### 9-8. サイズ目安

- 切片 1 つあたり: HE TIFF 50–300 MB / MSI xlsx 50–500 MB
- ソース単位重複排除のため、新形式は旧形式比で **同一ソース複数化合物登録時の ZIP サイズが 1 / N に縮小**(N = 化合物数)
- 1 GB 超のケースは Publish to share でなく ZIP 配布が現実的(帯域節約)

---

## 10. Publish to share

ヘッダの `Publish to share` ボタン:

| 項目 | 内容 |
| --- | --- |
| **Project slug** | URL の識別子 (英数字 / `_` / `-`) |
| **Viewer password** | 受け手が入力するパスワード (4 文字以上) |
| **Admin password** | 既定で `MSIadomine` が pre-fill (4 文字以上) |

`Publish` を押すと:

1. **Master password の確認** — 管理画面のゲートで通したパスワードがそのまま使われます (キャッシュなしの場合のみ再入力プロンプト)
2. サーバから 1 時間有効な **publish session token** を取得
3. 全 blob (TIFF / xlsx / txt) を Supabase Storage に並列 (4 同時) アップロード — token をヘッダで送り、サーバ側 RLS で検証
4. 進捗モーダルで `X / N files (Y MB / Z MB)` をライブ表示
5. 各ファイルは最大 3 回までリトライ (exponential backoff)
6. `upsert_project_doc` を master pw 付きで呼んで DB を更新
7. 完了後、Share URL モーダルが開く (URL + viewer/admin pw を一覧表示)

> Master password を知らない第三者は、たとえ Supabase の anon key を取得していても publish も Storage 書き込みもできません。サーバ側 (Supabase) の bcrypt 照合で守られています。

> 再 publish の挙動は次節「12. 再 publish の挙動」を必ずご確認ください。

---

## 11. 共有 URL とパスワードの渡し方

- URL: `https://.../viewer/index.html#share=<slug>`
- viewer password を **別チャネル** (Slack / メール) で
- admin password を渡すのは「相手にも管理者ビュー (Method 全列) を見せたい」ときのみ

> URL は `Share info` ボタン (Publish 後) または管理画面の `Copy URL` で再表示できます。

---

## 12. 再 publish の挙動

★重要: **同じ slug で 2 回目以降の publish を実行すると、サーバ側のプロジェクトは完全に上書きされます。**

| 対象 | 挙動 |
| --- | --- |
| `projects` 行 | display_name, anatomy_palette, meta が上書き |
| **viewer password** | 入力した新しい値で **必ず上書き** |
| **admin password** | 入力欄が空でなければ上書き、空ならそのまま |
| **sections テーブル** | 全削除 → 再挿入 |
| **rois テーブル** | **全削除 → 再挿入** (受け手が追加した ROI も消える) |
| **Storage `<slug>/...`** | 同パスは upsert で上書き、新パスは追加。**古いパスのファイルは残る (孤児)** |

注意点:

- 受け手が共有 URL から追加した ROI は **再 publish で消えます**
- パスワード変更時、12 時間以内の既存セッショントークンは有効のまま
- Storage 孤児が累積すると Supabase 容量を圧迫 (今後の課題: クリーンアップ機能)

---

## 13. アップロード進捗 / 大ファイル対策

実装済みの対策:

- **並列アップロード** (concurrency = 4)
- **自動リトライ** (1 ファイルあたり最大 3 回, backoff 800ms → 1.6s → 3.2s)
- **進捗モーダル** (パーセント / 完了ファイル数 / バイト数 / プログレスバー)

大ファイル (1.5 GB クラス) のアドバイス:

- 切片あたり MSI xlsx は 50–500 MB / HE TIFF は 50–300 MB が現実的目安
- 1 プロジェクト合計 1 GB を超える場合、Supabase Free Tier (1 GB) は不足 → **Pro プラン (100 GB)** を検討
- ネットワーク不安定な環境では安定回線で publish を実施

---

## 14. Storage 容量の目安

| プラン | Storage | 帯域 | 月額 |
| --- | --- | --- | --- |
| Free | 1 GB | 5 GB / 月 | $0 |
| **Pro** | **100 GB** | **250 GB / 月** | **$25** |

ファイルサイズ上限は Free / Pro どちらも標準 50 MB → ダッシュボード設定で 5 GB まで引き上げ可能。

> 1.5 GB プロジェクトを想定するなら Pro プラン必須。Free 枠で進めると 1 つ目で容量も帯域も即破綻します。

---

## 15. 困ったときは

| 症状 | 対処 |
| --- | --- |
| Publish 中にエラー | 進捗モーダルが消えてアラート表示。Network タブで失敗 PUT を確認、再試行 |
| `new row violates row-level security policy` | `share_locks.sql` の Storage ポリシーを再実行 (`supabase/README.md` 参照) |
| 大量孤児ファイルで Storage 容量逼迫 | Supabase ダッシュボードの Storage 画面で `<slug>/<oldSectionId>/` 以下を手動削除 |
| 同じ slug で別プロジェクトを上書きしてしまった | 復元手段なし。命名は慎重に |
| パスワードを忘れた | Supabase SQL Editor で `select set_project_password('<slug>', 'admin', '<新>');` を直接実行 |
| 「サーバから一覧取得」で 0 件 | admin pw が一致するプロジェクトが無い (まだ Publish していない、または別 admin pw を使った) |
