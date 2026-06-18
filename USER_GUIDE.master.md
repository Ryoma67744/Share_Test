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
9. [Section / Compound 名の変更](#9-section--compound-名の変更)
10. [Export ZIP — 手元バックアップと配布](#10-export-zip--手元バックアップと配布)
11. [Publish to share / Auto-publish / Sync インジケータ](#11-publish-to-share--auto-publish--sync-インジケータ)
12. [共有 URL とパスワードの渡し方](#12-共有-url-とパスワードの渡し方)
13. [再 publish の挙動](#13-再-publish-の挙動)
14. [別 PC からの取り込み (`?import=<slug>`)](#14-別-pc-からの取り込み-importslug)
15. [永続化の信頼性 (IndexedDB)](#15-永続化の信頼性-indexeddb)
16. [アップロード進捗 / 大ファイル対策](#16-アップロード進捗--大ファイル対策)
17. [Storage 容量の目安](#17-storage-容量の目安)
18. [困ったときは](#18-困ったときは)
19. [MRM 管理ライブラリ (mrm.html)](#19-mrm-管理ライブラリ-mrmhtml)

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

> **補足: 主画面ツールバーの「片側回転」**: 主画面の **Rotation** には対象セレクタ **(両方 / HEのみ / MSIのみ)** があります。HE と MSI が別の向きで取り込まれて重ならないとき、**片方だけ**を回して重ね合わせの向きを揃えられます。角度は `section.meta.viewerTransform.rotHE / rotMSI` に保存され、**公開時に Viewer にも反映**されます。これは表示上の重ね合わせ補正で、**この Align モーダルのアフィン変換 (μm/px・ROI 座標など科学的なアライメント) とは別系統**です。座標精度が必要な整合は引き続き Align モーダルで行ってください。

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
- **Source 別 TIC** … 同一切片に複数 source (xlsx / txt 等) を登録している場合、`TIC_<file名>` のように source ごとの TIC を別行で挿入します。1st Scan のみ TIC を見て位置決めしたい、といった用途向け。
- いずれの MSI も **Plasma カラーマップ** で着色して表示されるので、グレースケールよりも信号領域が見やすくなっています。

### 5-1-bis. Source ドロップダウン (Per-source T_he_to_msi)

Align モーダル上部に **Source** ドロップダウンが表示されます (複数 source ある切片のみ)。各 source 名の頭に **整列状態アイコン** が付きます:

- **✓** = 対応点(ランドマーク)で整列済み
- **△** = スライダーのみの暫定値 (ランドマークなし)
- **−** = 未整列

| 値 | 効果 |
| --- | --- |
| **全ソース共通** (`__all__`) | 1 つの T を **全 source に broadcast**。同切片内の source が同じ物理スキャン (例: POS / NEG) を表す通常運用向け。**全 source が同一グリッドのときは既定** になります。 |
| 個別 fid (例: `Analyte 1.txt`) | その source 専用の T を `world_coords.T_he_to_msi_by_source[fid]` に保存。source ごとに位置がずれる場合はこちらで個別 align。 |

- **「全ソースへ反映」ボタン** (同一グリッド時のみ表示): いま表示している整列 T を、同一グリッドの **全 source にコピー保存** します。片方の source だけ整列済みのとき、もう片方へワンクリックで反映できます (合わせ済みの source を表示した状態で押す)。
- **未整列ソースの自動フォールバック**: ランドマーク無しの暫定エントリ (△) は、別 source の正規整列 (✓) を **覆い隠しません**。描画時は legacy / 正規の T にフォールバックするため、片方の source だけ未整列でも HE が巨大化・ズレしません。
- Save 時は legacy `T_he_to_msi` も常に最新値で更新されるため、旧 viewer / フォールバック経路でも正しい T が見つかります。同一 source 内の compound は同じ T を共有します。

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
- **Save**: 現在の値を `sec.meta.world_coords.T_he_to_msi` (+ `T_he_to_msi_by_source[fid]`) と `msi_um_per_px` に書き込み、IndexedDB に永続化。ROI の物理スケールにも即時反映。

> **modal の HE/MSI サムネは主画面と同じ向きで表示** されます。主画面で Rotation や Flip H/V を適用していると、modal でも同じ向き (内部 -90° MSI 回転 + Rotation + Flip すべて反映) で並びます。クリックしたランドマークは内部で raw HE/MSI pixel 座標に逆変換して保存されるので、Solve や T 計算はそのまま動きます (向きを変えても結果は変わりません)。

> **メイン画面の下のサムネ一覧にも反映**: 主画面で Rotation / Flip H・V を変えると、レイヤーバー (中央下) の **MSI サムネ一覧** も主画面と同じ向きで再描画されます (Align モーダル内のサムネだけでなく、メイン画面のサムネ一覧も追従します)。

> Save 後にメイン canvas を見ると、HE が MSI の下、MSI が上に乗った状態で描画され、左下に **スケールバー** が出ます。バーは round な値 (10/20/50/100/200/500 μm, 1/2/5/10 mm) を自動選択し、**マウスホイールで拡大すると刻みが細かく** なります。

> Save 後、各切片パネル左上の **section 名ラベル** に `Section 1 · 20×20 μm/px` のように **Pixel pitch (X×Y)** が併記されます (X==Y でも常に両方を表記して軸を曖昧にしません)。これは share recipient の閲覧画面と Preview の cell title でも同じ書式で表示されます (受け手が解像度を確認できるようにするため)。

---

## 6. レイヤー個別の表示設定 (歯車 ⚙)

各レイヤーのチップ右端の **歯車 ⚙** をクリックすると、そのレイヤー専用の小ポップオーバーが開きます。サムネイル画像を **右クリック** しても同じ設定ポップオーバーが出ます。

> **Compound モードのサムネ左クリック**: Compound モードでは、レイヤーバーの **MSI サムネを左クリック** するとフォーカス化合物が切替わり全切片に反映されます (Method テーブル行クリックと同じ)。設定ポップオーバーを開くときは **右クリック (または歯車 ⚙)** を使ってください。

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

### 6-4. TIC 背景の自動付与 (HE 未登録切片)

**HE (`HE_STAIN`) が登録されていない**切片で、かつ MSI が **2 種類以上**ある場合、Viewer 側 (Master 自身もこの挙動になります) は自動的に合成 TIC 画像 (`HE_STAIN_TIC` キー) を背景として注入します。

| 条件 | 挙動 |
| --- | --- |
| HE 登録あり | 通常通り HE が背景 |
| HE なし & IF/IHC のみ登録 | **TIC を最下層、IF/IHC を中間、MSI を最上層**として重ねる |
| HE なし & IF/IHC もなし & MSI 2 種類以上 | TIC が背景になる |
| HE なし & MSI 1 種類のみ | TIC は作らない (1 種類だけだと TIC = その 1 種類で意味なし) |

- TIC 画像は全 MSI レイヤーのピクセル輝度を平均し、0–255 にグレースケール正規化したものです。データなしのピクセルは透明のまま残ります。
- Layer 一覧に **`TIC backdrop (auto)`** チップが現れ、クリックで表示 ON/OFF が可能。状態は `sec.meta.visibleLayers` に永続化。
- 既存のプロジェクト (この機能リリース前に作成) では、初回ロード時に TIC がレイヤー一覧に出ますが visibleLayers 初期値には入りません。Master 側で一度手動でクリックして ON にし、保存しておけば、その状態が公開時に Viewer 側へ引き継がれます。
- **発動条件は HE のみ判定**: IF/IHC を登録していても、HE がなければ TIC が作成されます (IF/IHC は分子マーカーオーバーレイで解剖学的リファレンスとしては機能しない、という前提)。

### 6-5. MSI Range の Viewer 継承

Master が各 MSI の Range スライダー (Toolbar の Range 入力 or 歯車 ⚙ の Intensity range) を調整した値は、公開時に **`sec.meta.layerDisplay[key].vmin/vmax`** として保存され、Viewer 側でその MSI を表示する際の **初期 Range** として復元されます。

- **同じ MRM の全切片で Range を共通化 (= 同じ幅)**: ある切片で Range の min/max を変えると、**同じ MRM (同じ MSI キー) を表示している全切片**の min/max が同じ値に揃います (幅も同一)。Toolbar / 歯車 ⚙ どちらの編集でも全切片へ伝播し、各切片の `layerDisplay` に保存されます。複数切片を同一スケールで比較・公開するのに使います。
- Master が「この MSI はこの強度帯で見て欲しい」という意図でスライダーを絞り込んだ状態を、そのまま Viewer に届けられます。
- Viewer は自由に Range を変えられますが、リロードすると Master の保存値に戻ります (Viewer 側の変更は一時的)。
- Range を更新した後は通常の Save → Publish 操作で公開してください。再公開しないと Viewer 側には新しい値は届きません。
- `actualMin / actualMax` (スライダー両端) は Viewer のローカルデータから再計算されるので、データ差異があっても破綻しません。

---

## 7. ROI を引く

1. アクティブにしたい切片パネルをクリック
2. ROI LIST 上の `+ 新規` をクリック (描画モード ON)
3. キャンバス上を順にクリックして 3 点以上の頂点
4. 確定: 始点クリック / ダブルクリック / **Enter**
5. ROI 名を入力

別切片に同じ ROI を描くには各行の `+ draw` ボタン。

> 描画途中で **Escape** → 中止。複数切片で `polysBySection` に蓄積されます。

> **ROIのみ表示**: ROI LIST ヘッダの **「ROIのみ」** チェックを ON にすると、選択中の ROI の形に **MSI レイヤーだけ** を切り抜いて表示します (HE / 背景は全体表示)。ROI が無い切片は MSI 非表示。回転 / 反転にも追従し、OFF で全体表示に戻ります。

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

> **Colormap dropdown**: ツールバー右側の **Colormap** で MSI ヒートマップの色 (Plasma / Viridis / Inferno / Hot / Jet / Grayscale) を選べます。Master の選択は `project.meta.colormap` に保存され、Publish to share 経由で recipient の初期表示色になります。recipient 側でも同じ dropdown が見え、自分のタブだけで色を変えられます (sessionStorage)。

> **列クリックでソート**: Method テーブルの列ヘッダ (Compound / Precursor / Fragment / CE / CV / Mean / Max) をクリックすると並び替えできます。1 回目で既定方向 (Compound = A→Z / 数値 = High→Low)、2 回目で逆方向、3 回目で sourceFile→name の既定順に戻ります。空セル (`—`) は方向に依らず末尾固定。並びはセッション中のみ保持され、Share Preview 側の Method パネルにも同じソートが反映されます。↑/↓ キーの focus 移動も表示順に従います。

---

## 9. Section / Compound 名の変更

### 9-1. Section 名 (master のみ)

各切片パネル左上の **canvas-label** (例: `Section 1`) を **ダブルクリック** すると prompt が開き、任意の名前 (例: `260504_Killifish_Sec1`) に rename できます。

- master 画面のみ有効 (share recipient 画面ではダブルクリックを無視)
- 重複名は弾かれます (同 project 内で displayName ユニーク)
- 変更内容は `_flushSave` + IDB 読み戻しで **永続化を確認** してから「変更しました」を表示
- 変更後の名前は Toolbar の section picker / Preview cell title / 統計テーブル列ヘッダ / Pixel pitch ラベルすべてで即時反映

### 9-2. Compound 名 (master のみ)

中央下の **Method (MRM) テーブルの Compound セル** をダブルクリックすると、化合物表示名のみ変更できます (同セル右側の precursor / product / CE / CV はそのまま)。

- 変更名は project 全切片に broadcast (同じ compound key を持つ全 section に反映)
- IDB 永続化 + verify 後に確定。失敗すれば赤エラーバナーで通知。

### 9-3. 臓器ごとの表示フィルタ

複数臓器 (例: Brain / Heart / Placenta) を 1 プロジェクトにまとめている場合、Sections ヘッダ右の **「臓器:」** セレクタで中央グリッドを臓器ごとに絞り込めます (「すべて」で全表示)。

- 臓器は **切片名から自動推定** されます (例: `E15-2-1_Brain1` → `Brain`)。臓器が **2 種類以上** 検出されたときだけセレクタが出ます。
- 表示の絞り込みのみで、データやサーバ状態は変更しません。
- 自動判定が合わないときは **`section.meta.organ`** を設定すると上書きできます (切片名のリネームで臓器トークンを揃えるのも簡単な方法です)。

> rename 後に表示が古いままなら **F5 でリロード**。永続化済みなら新しい名前で復元されます。

### 9-3. Section の Flip H / V (master のみ)

ツールバーの **Flip グループ** に `⇄` (左右反転) と `⇅` (上下反転) ボタンがあります。
切片取り込み後に「MSI が左右逆 / 上下逆だった」と気づいた時にやり直し用として使えます。

- ボタンをクリックすると **その切片の MSI と HE/IF が同じ軸で反転** (HE は再 align 不要)
- ROI の表示位置も自動追従。新規 ROI 描画も反転後の見た目通りに頂点を打てる
- 状態は `sec.meta.flip = { lr, ud }` に保存され IDB / publish 経由で recipient へも継承
- もう一度同じボタンを押せば元に戻る (toggle)
- share recipient 画面ではボタンが非表示で、master の選択がそのまま表示される

---

## 10. Export ZIP — 手元バックアップと配布

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

## 11. Publish to share / Auto-publish / Sync インジケータ

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

> 再 publish の挙動は「13. 再 publish の挙動」を必ずご確認ください。

### 11-1. Auto-publish on save

一度 publish した project では、以後の保存 (queueSave) が走るたびに **自動で再 publish** が試行されます。明示的に `Publish to share` を押し直さなくても、ROI / Memo / Align / rename などの変更がサーバに同期され続けます。

- 初回 publish 時に master pw が記憶されます (sessionStorage)。同セッション中は再入力不要。
- 別タブ / 別 session で開いた場合は次回 publish 時に master pw を再要求 (sync indicator が `needs-master-pw` になる)。

### 11-2. Sync インジケータ

ヘッダ右側に小さな **同期状態バッジ** が出ます。色とラベルで現在の auto-publish 状態が分かります。

| 状態 | ラベル | 意味 |
| --- | --- | --- |
| `synced` (緑) | Synced | 全保存済み。サーバと一致。 |
| `uploading` (青) | Uploading… | publish 中 (storage upload + RPC)。完了で `synced` に戻る。 |
| `local-saved` (灰) | Local saved | IDB のみ更新済み。次回保存時に publish 再試行。 |
| `conflict` (赤) | Conflict | サーバ側で別端末が同時 publish した形跡 (`updated_at` 不一致)。バッジクリックで manual `Publish to share` を案内。 |
| `needs-master-pw` (紫) | Master pw 必要 | sessionStorage に master pw が無い。クリックで再入力モーダル。 |
| `error` (赤) | Error | publish に失敗。クリックで詳細トースト。 |

- 未保存変更がある状態でタブを閉じようとすると **beforeunload 警告** が出ます (sync 完了 / error の両方で)。

---

## 12. 共有 URL とパスワードの渡し方

- URL: `https://.../viewer/index.html#share=<slug>`
- viewer password を **別チャネル** (Slack / メール) で
- admin password を渡すのは「相手にも管理者ビュー (Method 全列) を見せたい」ときのみ

> URL は `Share info` ボタン (Publish 後) または管理画面の `Copy URL` で再表示できます。

---

## 13. 再 publish の挙動

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

## 14. 別 PC からの取り込み (`?import=<slug>`)

別 PC や別ブラウザプロファイルで **「サーバから一覧取得」** から server-only project を Open しようとすると、URL が `viewer/index.html?import=<slug>` 形式になり、初回オープン時に master pw を要求されます。

| ステップ | 動作 |
| --- | --- |
| 1 | 管理画面で `Open (master)` をクリック |
| 2 | viewer に `?import=<slug>` で遷移 |
| 3 | 「Master password を入力」モーダル — 正しければ Storage から全 blob をダウンロード |
| 4 | IDB に書き戻し → 通常の master 画面が表示される |
| 5 | 以降は同 PC 内で auto-publish が回るので別 PC との同期も自動 |

> 1 人が複数 PC を順番に使う運用では、Phase 1 で publish した内容を Phase 2 の PC で `?import=` 経由で取り込み、続きの編集 → auto-publish → 次の PC で取り込み… を繰り返すのが標準フロー。

---

## 15. 永続化の信頼性 (IndexedDB)

過去に「Section 2 が IDB から消えた」事象を踏まえ、保存系 (queueSave / _flushSave) には以下の 3 層対策が入っています。

| 対策 | 内容 |
| --- | --- |
| **Loud failure** | IDB put 失敗 (QuotaExceeded 等) を `console.warn` で握りつぶさず、ヘッダに赤エラーバナーを出す。`error` 状態で sync インジケータも赤化。 |
| **Verify after write** | put 直後に `getProject(id)` で読み戻し、section / compound 数 / 該当 displayName が一致するか確認。不一致なら `_showSaveError` でユーザに通知。 |
| **Quota 監視** | `navigator.storage.estimate()` で空き容量をプロアクティブにチェックし、80% 超で警告トースト。`navigator.storage.persist()` をリクエストして OS の自動クリーンアップから保護。 |
| **3 回リトライ + exp backoff** | put 系は 3 回まで自動リトライ (200ms → 400ms → 800ms)。永続化エラーは `_showSaveError` でユーザに通知。 |
| **beforeunload 警告** | 未保存 / sync エラー時にタブ閉じ確認ダイアログ。 |

---

## 16. アップロード進捗 / 大ファイル対策

実装済みの対策:

- **並列アップロード** (concurrency = 4)
- **自動リトライ** (1 ファイルあたり最大 3 回, backoff 800ms → 1.6s → 3.2s)
- **進捗モーダル** (パーセント / 完了ファイル数 / バイト数 / プログレスバー)

大ファイル (1.5 GB クラス) のアドバイス:

- 切片あたり MSI xlsx は 50–500 MB / HE TIFF は 50–300 MB が現実的目安
- 1 プロジェクト合計 1 GB を超える場合、Supabase Free Tier (1 GB) は不足 → **Pro プラン (100 GB)** を検討
- ネットワーク不安定な環境では安定回線で publish を実施

---

## 17. Storage 容量の目安

| プラン | Storage | 帯域 | 月額 |
| --- | --- | --- | --- |
| Free | 1 GB | 5 GB / 月 | $0 |
| **Pro** | **100 GB** | **250 GB / 月** | **$25** |

ファイルサイズ上限は Free / Pro どちらも標準 50 MB → ダッシュボード設定で 5 GB まで引き上げ可能。

> 1.5 GB プロジェクトを想定するなら Pro プラン必須。Free 枠で進めると 1 つ目で容量も帯域も即破綻します。

---

## 18. 困ったときは

| 症状 | 対処 |
| --- | --- |
| Publish 中にエラー | 進捗モーダルが消えてアラート表示。Network タブで失敗 PUT を確認、再試行 |
| `new row violates row-level security policy` | `share_locks.sql` の Storage ポリシーを再実行 (`supabase/README.md` 参照) |
| 大量孤児ファイルで Storage 容量逼迫 | Supabase ダッシュボードの Storage 画面で `<slug>/<oldSectionId>/` 以下を手動削除 |
| 同じ slug で別プロジェクトを上書きしてしまった | 復元手段なし。命名は慎重に |
| パスワードを忘れた | Supabase SQL Editor で `select set_project_password('<slug>', 'admin', '<新>');` を直接実行 |
| 「サーバから一覧取得」で 0 件 | admin pw が一致するプロジェクトが無い (まだ Publish していない、または別 admin pw を使った) |

---

## 19. MRM 管理ライブラリ (mrm.html)

化合物・トランジション・使用履歴を一元管理する **admin 専用ページ** です。管理画面 (`/`) の **「MRM管理」** ボタンから開きます (**admin password 必須**)。

### 19-1. できること
- 化合物 (`+ 化合物`) とトランジション (`+ トランジション`) の手動追加・編集・削除。タグ (分類)・Polarity・通し番号・強度メモ・役割 (定量/確認)・推奨 ★ を管理。
- ビューアの Method (MRM) 表で行を選んで **「選択を管理へ登録」** すると、測定結果からこのライブラリへ登録できます (タグ・役割・サンプル種を付与)。
- 選択したトランジションを **`.exp` 出力** (Waters テンプレートへ差し込み)。

### 19-2. Excel から MRM を一括取り込み
既存の MRM リスト (xlsx) をそのまま取り込めます。ツールバーの **`Excel取り込み`** ボタンから:

1. `.xlsx` / `.xls` を選択。
2. シート全体を自動解析し、**カテゴリ見出し + `CompoundName / Precursor / Product / CV / CE` のヘッダ行を持つブロック**を検出します。
   - **複数ブロックが縦横に並んでいても** (例: 左右に複数レーン) まとめて検出します。
   - 列は **ヘッダ名で対応付け** るため、**CV と CE の順序が入れ替わっていても** 正しく読みます。
   - 見出し (例: `Amino acid`, `13C6-Glucose`) は **タグ (分類)** になります。
   - **極性** は見出し横の `+ / −` マーカー、無ければ化合物名の `NEG` / `POS` から推定します。
3. **プレビュー** で、取り込むブロック・タグ名・極性 (— = 名前から推定 / + / −) を確認・修正します。
4. **`取り込み実行`** で一括登録します。

> **冪等 (安全に再実行可)**: 同名化合物は更新、同一トランジション (precursor / product / CE / CV が同じ) はスキップされるため、取り込みを繰り返しても重複しません。
>
> 取り込みは本番 Supabase に書き込みます。初回は **小さな試験用ファイル** で結果を確認してから本番リストを取り込むことを推奨します。
