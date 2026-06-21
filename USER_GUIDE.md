# DESI Data Share 閲覧者ガイド

このガイドは **共有 URL を受け取って DESI Data Share を閲覧している方** 向けの説明書です。
データ作成側 (Master) の操作 (新規プロジェクト作成、レイヤー登録、Publish to share など) はここでは扱いません。

> URL を発行した方から **viewer password** が別途共有されているはずです。手元にない場合は発行者に問い合わせてください。

---

## 目次

1. [このアプリで閲覧者ができること](#1-このアプリで閲覧者ができること)
2. [URL を開く・パスワード入力](#2-url-を開くパスワード入力)
3. [画面構成](#3-画面構成)
4. [ROI の表示と追加](#4-roi-の表示と追加)
5. [View モード: Free と Compound の使い分け](#5-view-モード-free-と-compound-の使い分け)
6. [Method (MRM) と化合物の切替](#6-method-mrm-と化合物の切替)
7. [Range / Opacity / Rotation の調整](#7-range--opacity--rotation-の調整) / [レイヤー個別設定 (歯車 ⚙)](#7-bis-レイヤー個別の表示設定-歯車-) / [MSI スケールバー](#7-tris-msi-スケールバー)
8. [Memo の編集](#8-memo-の編集)
9. [Preview overlay (画像グリッド)](#9-preview-overlay-画像グリッド)
10. [Export ZIP で手元に保存](#10-export-zip-で手元に保存)
11. [保存されること・破棄されること](#11-保存されること破棄されること)
12. [キーボードショートカット](#12-キーボードショートカット)

---

## 1. このアプリで閲覧者ができること

- 切片画像 (HE / IF / MSI) を化合物単位で重ねて閲覧
- 化合物の切替・比較 (Free / Compound モード)
- 既存 ROI の表示・非表示 / **選択 ROI の形で MSI を切り抜き表示** (ROIのみ)
- **書き込みロック取得時** に新規 ROI の追加・既存 ROI の削除 (同時編集者は 1 名)
- ANALYSIS バーグラフで切片 × 化合物の Mean Intensity を比較
- **臓器ごとに表示を絞り込み** (切片名から自動判定、臓器が 2 種類以上のとき)
- 表示パラメタ (Range / Opacity / Rotation / Pan / Zoom) の **一時的な** 調整
- Memo の **一時的な** 編集
- プロジェクト全体を ZIP でダウンロード

---

## 2. URL を開く・パスワード入力

1. 提供者から渡された URL (例: `https://.../viewer/index.html#share=<slug>`) をブラウザで開く
2. 「共有プロジェクト」モーダルが開くので、別途共有された **viewer password** を入力
3. **Unlock** を押すとプロジェクトが読み込まれる
4. ヘッダ右に 🔒 **Share view** バッジが付き、編集系ボタンは自動的に隠れる

> 同じ URL でも、提供者が設定した **admin password** で開くと管理者ビューになります。管理者ビューでは Method (MRM) テーブルの Precursor / Fragment / CE / CV まで表示されます。通常の viewer password ではこれら 4 列は隠れます。

セッションは **12 時間** で失効します。タブを閉じても再度 URL を開けば同じパスワードでログインし直せます。

---

## 3. 画面構成

<div style="border:1px solid #475569;border-radius:6px;overflow:hidden;font-size:11px;margin:10px 0;background:#fff;">
  <div style="background:#1e293b;color:#fff;padding:6px 10px;font-weight:600;letter-spacing:0.02em;">
    Top Bar &nbsp;—&nbsp; 🔒 Share view / Free / Compound / Export ZIP / Help
  </div>
  <div style="display:grid;grid-template-columns:170px 1fr 220px;">
    <div style="background:#f8fafc;padding:8px;border-right:1px solid #cbd5e1;">
      <div style="font-weight:600;color:#0f172a;">ROI LIST</div>
      <ul style="margin:6px 0 0 1em;padding:0;color:#475569;font-size:11px;line-height:1.5;">
        <li>+ 新規 (要ロック取得)</li>
        <li>Show トグル</li>
        <li>各 ROI のチェックボックス・削除</li>
      </ul>
    </div>
    <div style="padding:8px;background:#fff;">
      <div style="font-weight:600;color:#0f172a;margin-bottom:4px;">Sections Grid</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
        <div style="border:1px solid #cbd5e1;padding:6px;border-radius:4px;background:#f8fafc;">
          <div style="font-weight:600;font-size:11px;">Section 1</div>
          <div style="color:#64748b;font-size:11px;">canvas (パン/ズーム)</div>
          <div style="color:#64748b;font-size:11px;">thumbs (ON/OFF)</div>
        </div>
        <div style="border:1px solid #cbd5e1;padding:6px;border-radius:4px;background:#f8fafc;">
          <div style="font-weight:600;font-size:11px;">Section 2</div>
          <div style="color:#64748b;font-size:11px;">canvas</div>
          <div style="color:#64748b;font-size:11px;">thumbs</div>
        </div>
        <div style="border:1px solid #cbd5e1;padding:6px;border-radius:4px;background:#f8fafc;">
          <div style="font-weight:600;font-size:11px;">Section 3</div>
          <div style="color:#64748b;font-size:11px;">canvas</div>
          <div style="color:#64748b;font-size:11px;">thumbs</div>
        </div>
      </div>
      <div style="margin-top:8px;padding:6px;border:1px dashed #cbd5e1;border-radius:4px;background:#fafafa;">
        <div style="font-weight:600;color:#0f172a;font-size:11px;">Method (MRM)</div>
        <div style="color:#64748b;font-size:11px;">Compound / Precursor / Product / CE / CV / Range</div>
      </div>
    </div>
    <div style="background:#f8fafc;padding:8px;border-left:1px solid #cbd5e1;">
      <div style="font-weight:600;color:#0f172a;">ANALYSIS</div>
      <ul style="margin:6px 0 8px 1em;padding:0;color:#475569;font-size:11px;line-height:1.5;">
        <li>切片並列バーグラフ</li>
        <li>化合物プルダウン × 3</li>
      </ul>
      <div style="font-weight:600;color:#0f172a;">Memo</div>
      <ul style="margin:6px 0 0 1em;padding:0;color:#475569;font-size:11px;line-height:1.5;">
        <li>Sample / Machine / Matrix …</li>
      </ul>
    </div>
  </div>
</div>

| 領域 | 役割 |
| --- | --- |
| Top Bar | 表示モード切替 (Free / Compound)・Preview・Export ZIP・🔑 Admin・Help |
| ROI LIST | 全切片共通の ROI 一覧。表示トグル・新規描画・各 ROI への追加描画 |
| Sections Grid | 切片パネル。クリックでアクティブ (青枠) 化、ドラッグでパン、ホイールでズーム |
| Method (MRM) | アクティブ切片の MSI レイヤー一覧。クリック / ↑↓ キーで切替 |
| ANALYSIS | 選択 ROI に対する切片 × 化合物 のバーグラフ |
| Memo | Sample / Machine / Matrix / Google Keep / +α … (一時編集) |

> 各切片パネル左上の **section 名ラベル** には、提供者が Align 設定で μm/px を入れていれば「Section 1 · 20×20 μm/px」のように **Pixel pitch (μm/px)** が併記されます。X / Y の値は常に両方表記されます (異方性 = `50×60 μm/px` / 等方 = `20×20 μm/px`)。

> **臓器フィルタ**: 切片名の先頭トークンから臓器が **2 種類以上** 推定されると、Sections ヘッダ右に **「臓器:」** セレクタが出ます。選ぶとその臓器の切片だけが中央に表示されます (「すべて」で全表示)。表示の絞り込みのみで、データやサーバ状態は変わりません。

---

## 4. ROI の表示と追加

### 4-1. 既存 ROI の表示制御

- ROI LIST 各行の **チェックボックス** で個別に表示 ON/OFF
- ヘッダの **Show** トグルで全 ROI を一括 ON/OFF

これらの操作はサーバには送られず、自分の画面でのみ反映されます。

### 4-2. 新規 ROI を描く (書き込みロック必須)

共有モードで ROI を書き込むには、**書き込みロックの取得が必須** です (同時に 1 名のみ)。

1. ROI を描きたい切片パネルをクリックしてアクティブ化
2. ROI LIST 上の **`+ 新規`** をクリック → 自動的にロック取得を試行
3. ロックが取れたら描画モードに入り、キャンバス上で 3 点以上の頂点を打つ
4. 確定方法 (いずれか):
   - 最初の頂点をもう一度クリック
   - ダブルクリック
   - **Enter** キー
5. ROI 名を入力 → **サーバに即時保存**、他の閲覧者にもリロード後に反映される

> ロック取得に失敗した場合は「ロック中: ◯◯」と表示されます。前の人がブラウザを閉じていれば 30 秒以内に自動で取り直せます。
> 描画完了後、ロックは自動で解放されます。

### 4-3. 既存 ROI を別の切片にも描く

- ROI LIST 各行の **`+ draw`** ボタン → アクティブ切片で描画モード ON
- 同じ ROI が複数切片で共有されます
- 行右の `2/3` 等のバッジは「描画済 / 全切片数」

### 4-4. ROI の削除

- ROI LIST 各行の **`×`** で削除 → 全切片分が消え、サーバにも即時反映
- 削除も書き込みロック取得中のみ有効

> 描画モード中は他のパネルへの切替はできません。**Escape** で中止 (描画途中の頂点は破棄)。

### 4-5. ROIのみ表示 (MSI を ROI の形に切り抜き)

ROI LIST ヘッダの **「ROIのみ」** チェックを ON にすると、**選択中の ROI の形に MSI レイヤーだけ** を切り抜いて表示します。HE / 背景は全体表示のまま残るので、ROI 内の信号と周囲の組織像を見比べられます。

- 対象は **現在選択中の ROI** (ROI LIST で行を選択)。
- その ROI が **描かれていない切片では MSI は表示されません**。
- 回転 / 反転にも追従します。OFF で全体表示に戻ります。

---

## 5. View モード: Free と Compound の使い分け

ヘッダ右上の **Free / Compound** トグルで表示モードを切替えます。同じ ROI / 同じ切片でも見え方が大きく変わるため、用途に応じて選んでください。

<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0;">
  <div style="border:1px solid #cbd5e1;border-radius:6px;padding:8px;background:#f8fafc;">
    <div style="font-weight:700;color:#0f172a;margin-bottom:4px;">🔵 Free</div>
    <div style="color:#475569;font-size:12px;">切片ごとに <b>任意のレイヤー組合せ</b> を ON/OFF できる。HE と MSI を同時に重ねたい / 切片 A は化合物 X、切片 B は化合物 Y を見たい、など個別表示向け。</div>
    <div style="margin-top:8px;display:flex;gap:4px;justify-content:space-around;">
      <div style="border:1px solid #94a3b8;padding:4px 6px;border-radius:3px;font-size:10px;background:#fff;">
        <div style="font-weight:600;">Section 1</div>
        <div style="color:#64748b;">[A, B]</div>
      </div>
      <div style="border:1px solid #94a3b8;padding:4px 6px;border-radius:3px;font-size:10px;background:#fff;">
        <div style="font-weight:600;">Section 2</div>
        <div style="color:#64748b;">[C, D]</div>
      </div>
      <div style="border:1px solid #94a3b8;padding:4px 6px;border-radius:3px;font-size:10px;background:#fff;">
        <div style="font-weight:600;">Section 3</div>
        <div style="color:#64748b;">[B]</div>
      </div>
    </div>
  </div>
  <div style="border:1px solid #2563eb;border-radius:6px;padding:8px;background:#eff6ff;">
    <div style="font-weight:700;color:#1d4ed8;margin-bottom:4px;">🟦 Compound</div>
    <div style="color:#475569;font-size:12px;"><b>1 つの化合物</b> を全切片で揃えて表示する。切片間で同じ分子の分布を見比べたい時に使う。フォーカス化合物は Method テーブルの行クリックで切替。</div>
    <div style="margin-top:8px;display:flex;gap:4px;justify-content:space-around;">
      <div style="border:1px solid #2563eb;padding:4px 6px;border-radius:3px;font-size:10px;background:#fff;">
        <div style="font-weight:600;">Section 1</div>
        <div style="color:#1d4ed8;">[X]</div>
      </div>
      <div style="border:1px solid #2563eb;padding:4px 6px;border-radius:3px;font-size:10px;background:#fff;">
        <div style="font-weight:600;">Section 2</div>
        <div style="color:#1d4ed8;">[X]</div>
      </div>
      <div style="border:1px solid #2563eb;padding:4px 6px;border-radius:3px;font-size:10px;background:#fff;">
        <div style="font-weight:600;">Section 3</div>
        <div style="color:#1d4ed8;">[X]</div>
      </div>
    </div>
  </div>
</div>

### 用途別の選び方

| やりたいこと | 適したモード |
| --- | --- |
| HE と MSI を重ねて位置確認 | **Free** (HE と MSI を同時 ON) |
| 切片ごとに別の化合物を見比べる | **Free** |
| 化合物 X が切片 1〜10 でどう変化するか比較 | **Compound** + Method テーブルで X を選択 |
| ANALYSIS バーグラフで候補化合物を探索 | **Compound** + Method 行クリックでフォーカス切替 |

### 切替方法

- ヘッダ右上の **Free / Compound** トグルでモード切替
- Compound モード時は **Method テーブルの行をクリック** すると、その化合物が新しいフォーカスになり全切片に即時反映される
- Compound モード時は **中央下のサムネ一覧の MSI サムネをクリック** しても同じくフォーカス化合物を切替できる (全切片に即時反映)
- Free モード時は Method テーブルの行クリックで個別レイヤーの ON/OFF

---

## 6. Method (MRM) と化合物の切替

中央下の **Method (MRM)** テーブルにアクティブ切片の MSI レイヤー一覧が出ます。

| 列 | 意味 | 表示条件 |
| --- | --- | --- |
| Compound | 化合物名 | 常に表示 |
| Precursor | プリカーサ m/z | **管理者のみ** |
| Fragment | フラグメント (プロダクト) m/z | **管理者のみ** |
| CE | Collision Energy | **管理者のみ** |
| CV | Collision Voltage / Compensation Voltage | **管理者のみ** |
| Mean | レイヤーの強度平均 | 常に表示 |
| Max | レイヤーの強度最大値 | 常に表示 |

> 通常の viewer password で開いた閲覧者には Precursor / Fragment / CE / CV の 4 列は **表示されません**。これらは MS の機械パラメタなので、管理者ビュー (admin password で開いた場合) でのみ参照できます。

行をクリックすると:
- **Compound モード** … 全切片で同じ化合物がフォーカス表示される (切片間比較に便利)
- **Free モード** … その行のレイヤーの ON/OFF を切替

> **列クリックでソート**: Method テーブルの **列ヘッダ (Compound / Precursor / Fragment / CE / CV / Mean / Max)** をクリックすると並び替えできます。
> - 1 回目: Compound = A→Z / 数値列 = High→Low (既定方向)
> - 2 回目: 逆方向 (Z→A / Low→High)
> - 3 回目: 既定順 (sourceFile→name) に戻る
> - 列ヘッダに ▲ / ▼ が出てソート方向を示します。値が空の行 (`—`) は方向に依らず末尾に固定されます。並び順はセッション中のみ保持され、リロードで既定に戻ります。

> **キーボード操作**: Method テーブル上で **↑/↓ キー** を押すと前後の化合物に focus が移動します(Compound モードなら全切片に即時反映、ソート後の表示順に従います)。

> **化合物名の表示形式**: 行頭タイトルは `<化合物名>_<precursor> > <product>` (例: `DHA-NEG_327.4 > 283.4`) で、Compound モードでは画面上部のフォーカス表示にも同じ書式が出ます。precursor/product が記録されていない化合物では化合物名のみ表示されます。

> **TIC (Total Ion Current)**: 各 source の MSI レイヤー全部を合算した擬似マップを別行 (`__TIC__` / `TIC_<file名>`) として登録できます。複数 source ある切片では source ごとに TIC を切替えて見られます。

> ファイル単位での一括 ON/OFF や削除は、**サムネイル領域のドロップダウン (`▶ <ファイル名>`)** の右側にある `[all on]` / `[delete file]` ボタンから行えます。閲覧者には `delete file` は表示されません。

---

## 7. Range / Opacity / Rotation の調整

セクションツールバー (各切片パネル上部) の 3 つのグループ:

| 項目 | 入力 | 意味 |
| --- | --- | --- |
| **Range** | min — max | アクティブ MSI レイヤーの **強度値レンジ**。表示する輝度の上下限。**同じ MRM (化合物) を表示している全切片で min/max が共通化**されます (下の補足参照) |
| **Opacity** | 0–100 % | アクティブ MSI レイヤーの **不透明度** |
| **Rotation** | -180°〜180° | キャンバスの **回転角** (パン・ズームと組み合わせ)。左の **対象セレクタ (両方 / HEのみ / MSIのみ)** で回す対象を選べます |

**同期について**: **Range は同じ MRM の全切片に常に共通化** されます (トグル不要)。**Opacity** と **Rotation (両方)** は各項目右の **🔗** を ON にしたときだけ全切片へ同期します。**`↻`** ボタンは translate / rotate / zoom (パン位置・回転・倍率) のリセット (HE/MSI 個別回転もリセットされます)。

> Opacity 入力がグレーアウトしているときは、そのアクティブ MSI レイヤーの **Apply opacity が OFF** になっています(歯車 ⚙ 内の設定)。チェックを入れ直せばツールバー側も再び編集可能になります。

> これらの調整は **一時的** で、再ロードするとサーバ側の状態に戻ります。他の閲覧者にも反映されません。

> **Range の初期値は Master から継承**: 各 MSI の Range (vmin/vmax) スライダーは、Master が公開時に設定した値が自動的に初期値として読み込まれます。閲覧者側で自由に変更できますが、リロードすると再び Master の値に戻ります。Master が後から Range を再調整して再公開すれば、次回の閲覧時にその新しい値が初期値となります。

> **Range は同じ化合物の全切片で「同じ窓・同じ幅」に揃う**: ある切片で Range の min か max を変えると、**同じ MRM (化合物) を表示している全切片**の min/max が同じ値に揃います (幅も同じになります)。歯車 ⚙ の Intensity range から変えても同様です。別の化合物には影響しません。これにより複数切片を同一スケールで比較できます。

> パン: ドラッグ (修飾キーなし) / ズーム: マウスホイール / 回転: Rotation 入力か、ヘッダの 🔗 で他切片と同期。

> **回転は下のサムネ一覧にも反映**: Rotation を変えると、中央下の **MSI サムネ一覧** も主画面と同じ向きで再描画されます。

> **HE だけ / MSI だけを回す**: Rotation 左の **対象セレクタ** で「HEのみ」または「MSIのみ」を選ぶと、その切片で **片方のレイヤーだけ** を回せます。HE と MSI が別の向きで取り込まれていてうまく重ならないとき、片方だけ回して向きを合わせる用途です。「両方」を選ぶと従来どおりキャンバス全体が回ります。HE/MSI 個別回転は切片ごとの調整で、🔗 同期の対象外です。

> **Colormap dropdown**: ツールバーの **Colormap** で MSI ヒートマップの色を変えられます (Plasma / Viridis / Inferno / Hot / Jet / Grayscale)。選択は **同じタブ内なら保持** (sessionStorage)。タブを閉じれば master の既定色に戻ります。Preview overlay の同じ dropdown とも同期するので、Preview を閉じた後も主画面で色を切り替え続けられます。

---

## 7-bis. レイヤー個別の表示設定 (歯車 ⚙)

各レイヤーチップ右端の **歯車 ⚙** をクリックすると、そのレイヤー専用のポップオーバーが開きます。サムネイル画像を **右クリック** しても同じ設定が出ます (Compound モードでの **左クリック** はフォーカス化合物の切替です)。

<div style="border:1px solid #cbd5e1;border-radius:6px;padding:10px;background:#fff;margin:10px 0;font-size:12px;display:grid;grid-template-columns:1fr 1fr;gap:10px;">
  <div style="border:1px solid #94a3b8;border-radius:4px;padding:8px;background:#f8fafc;">
    <div style="font-weight:600;color:#0f172a;margin-bottom:4px;">MSI レイヤー</div>
    <ul style="margin:4px 0 0 1.2em;padding:0;color:#475569;font-size:11px;line-height:1.6;">
      <li><b>Apply opacity</b> ✓ (既定 ON)</li>
      <li>Opacity (0–100%)</li>
      <li>Intensity range (vmin / vmax)</li>
    </ul>
  </div>
  <div style="border:1px solid #2563eb;border-radius:4px;padding:8px;background:#eff6ff;">
    <div style="font-weight:600;color:#1d4ed8;margin-bottom:4px;">HE / IF レイヤー</div>
    <ul style="margin:4px 0 0 1.2em;padding:0;color:#475569;font-size:11px;line-height:1.6;">
      <li><b>Apply opacity</b> ☐ (既定 OFF — 常時不透明)</li>
      <li>Opacity (チェック OFF 時はグレーアウト)</li>
      <li><b>Grayscale (モノクロ表示)</b></li>
    </ul>
  </div>
</div>

| 項目 | 効果 |
| --- | --- |
| **Apply opacity** | チェック OFF で Opacity スライダーの値を無視して常時 100% で描画。HE/IF は既定 OFF なので、HE は常に不透明な下地として残ります。MSI は既定 ON で従来動作。 |
| **Grayscale** (HE/IF のみ) | HE/IF をモノクロ化。MSI の Plasma 色を最大コントラストで見たいときに ON にする。 |
| **Intensity range** (MSI のみ) | MSI 信号の強度ウィンドウ (vmin / vmax)。ツールバーの Range と連動し、変更は **同じ MRM の全切片に共通化** されます (同じ幅)。 |

> 描画順は **HE/IF → その他 → MSI(加算合成)** に固定されています。HE がレイヤーパネルで何番目に並んでいても、MSI ヒートマップが必ず HE の上に乗って見えます。

> 設定変更は再ロード後も保持されます(`sec.meta.layerDisplay` に永続化)。

---

## 7-tris. MSI スケールバー

MSI レイヤーが表示されていて、提供者側で **MSI pixel size (μm/px)** が設定されている切片では、メイン canvas の **左下にスケールバー** が出ます。

<div style="display:inline-block;background:rgba(255,255,255,0.88);padding:4px 8px;border-radius:4px;font-size:11px;font-weight:600;color:#0f172a;box-shadow:0 1px 3px rgba(0,0,0,0.25);margin:6px 0;">
  <span style="display:inline-block;height:4px;width:80px;background:#0f172a;box-shadow:0 0 0 1px #fff;vertical-align:middle;margin-right:6px;"></span>200 μm
</div>

- マウスホイールで拡大すると刻みが細かくなり (例: 500 μm → 200 μm → 100 μm)、縮小で粗く (100 μm → 500 μm → 1 mm) 自動切替されます (NICE = 10/20/50/100/200/500/1000…)。
- パン (ドラッグ) や Rotation で画面が回っても **バーは画面左下に固定** で表示されます。
- MSI レイヤーが OFF の切片や、提供者が pixel size を未設定のままの切片では非表示になります。
- 各切片パネル左上のラベルにも `Section 1 · 20×20 μm/px` の形で同じ pixel pitch (X×Y) が併記されます。

---

## 7-quart. TIC 背景の自動表示

セクションに **HE 染色画像が登録されておらず**、かつ MSI 画像が 2 種類以上ある場合、Viewer は自動的に **合成 TIC 画像** (全 MSI レイヤーの輝度を平均したグレースケール画像) を背景として描画します。HE が無い切片でも解剖学的なリファレンスが見えるようにする狙いです。

| ケース | TIC 背景 |
| --- | --- |
| HE あり (IF/IHC の有無は問わず) | **作成されない** (HE が背景として描画) |
| HE なし & MSI 2 種類以上 (IF/IHC の有無は問わず) | **自動作成** |
| HE なし & MSI 1 種類のみ | **作成されない** (TIC = その 1 種類で意味なし) |

- 描画順は **TIC (最下層) → IF/IHC (中間) → MSI (最上層)**。MSI の Opacity を下げると下に TIC (+ IF/IHC) が透けて見えます。
- Layer 一覧に **`TIC backdrop (auto)`** チップが出ます。クリックで表示 ON/OFF を切り替えられ、ON/OFF 状態はリロード後も保持されます (`sec.meta.visibleLayers`)。
- TIC 画像はラスター単位の平均輝度を 0–255 に正規化してグレースケール化したものです。データなしのピクセルは透明として残るので、グリッド境界が黒抜けで残ります。

---

## 8. Memo の編集

右下の **Memo** フォームで Sample / Machine / Google Keep / +α / Matrix / Derivatization が編集可能です。

> Memo の編集も **一時的** で、再ロードで破棄されます。サーバには送られません。

---

## 9. Preview overlay (画像グリッド)

ヘッダの **Preview** ボタンで、全切片を 1 つの化合物で並べて見られる **プレビューオーバーレイ** が開きます。スライド資料用の見栄え確認や、切片間比較の素早い俯瞰に向いています。

| 領域 | 役割 |
| --- | --- |
| **Method パネル (左)** | 化合物テーブル。↑↓ キー / クリックで focus 化合物切替。**右端のスプリッタを左右にドラッグ** すると幅を変更できます (次回もサイズが復元されます)。|
| **画像グリッド (中央)** | 全切片 × focus 化合物の MSI 画像。各セル下部に **動的スケールバー** + 左上に **Section 名 + Pixel pitch** が出ます。各セルでドラッグでパン、ホイールでズーム可能。|
| **Range スライダー (上部)** | **全切片共通** の vmin / vmax。ここを動かすと全切片の表示レンジが揃います。Range は preview を閉じても保持されます (再オープン時に同値で開きます)。|
| **Stats / Colorbar (右)** | focus 化合物の統計と Plasma カラーバー。|
| **🔑 Admin (右上)** | viewer password で開いている場合に admin に **昇格** できます。preview を閉じずにそのまま admin password を入力できます。|

> Preview の Range スライダーはメイン画面の Range とは独立した一時値です。preview を閉じると元の値に戻ります。
> 複数 source がある切片では `TIC_<file名>` を選ぶと **source ごとの TIC** が表示されます。

---

## 10. Export ZIP で手元に保存

ヘッダの **Export ZIP** で、現在閲覧中のプロジェクト全体を ZIP にまとめてダウンロードできます。

```
<プロジェクト名>_<timestamp>.zip
├─ <プロジェクト名>.json                  ← プロジェクトメタ + ROI 全体 + Memo
└─ sections/
   └─ <sectionId>/
      ├─ atlas.json                       ← 切片メタ + Align / 表示状態
      └─ data/
         ├─ img_HE_Stain__<元ファイル名>.tif        ← HE/IF はレイヤー単位
         ├─ img_IF_Stain__<元ファイル名>.tif (任意)
         ├─ msi__Analyte_1.txt              ← MSI はソースファイル単位で 1 ファイル
         └─ msi__Analyte_2.xlsx             ← xlsx には ROI 0/1 列が追記される
```

### 主な特徴

- **ルート JSON 名はプロジェクト名と同じ**(ASCII 英数字 + `_-` 以外は `_` に置換)
- **MSI 数値データはソースファイル単位で 1 ファイル**: 同じ Analyte / xlsx から複数化合物を登録していても、ZIP 内では 1 ファイルにまとめられます(同一切片・同一ソースは Image_X / Image_Y が一致するため)
- **xlsx には ROI 列を追記**: その切片で描画されている全 ROI が **0/1 のフラグ列** として末尾に追加されます(列名 = ROI 名、xlsx の元レイアウトは保持)
- **txt は無加工**: 元バイナリそのままを格納(ROI 情報はルート JSON の `polysBySection` で参照可能)

### 受け手側での扱い

- ZIP は **手元バックアップ / オフライン配布用**(共有 URL は生成されない)
- 受け手は **Import ZIP** で同じビューアに取り込めます(別環境でも可)
- 受け手側からの **再アップロード / Publish は不可**(共有モードでは該当ボタン非表示)

> 旧形式の ZIP(`project.json` 固定名・化合物ごとに別ファイル)は **新ビューアでは Import 非対応** です。古い ZIP しか手元にない場合は、旧ビューアで開いてから再 Export してください。

---

## 11. 保存されること・破棄されること

| 操作 | 保存先 | 他の閲覧者に見える | 再ロード後に残る |
| --- | --- | --- | --- |
| ROI の追加・編集・削除 | **サーバ** | ✅ (再ロード後反映) | ✅ |
| Range / Opacity / Rotation の調整 | (ローカルキャッシュのみ) | ❌ | ❌ |
| パン位置・ズーム倍率 | (同上) | ❌ | ❌ |
| マーカー色・レイヤー ON/OFF | (同上) | ❌ | ❌ |
| View モード (Free / Compound) | localStorage | ❌ | ✅ |
| Memo の編集 | (ローカルキャッシュのみ) | ❌ | ❌ |
| 描画途中の頂点 (Escape / 離脱) | (破棄) | — | — |

要点:

- **ROI のみがサーバに保存** され、他の閲覧者と共有されます
- 表示調整 (色味・倍率・メモ等) は **その場限り**。再ロードで初期状態に戻ります
- セッション情報 (12 時間有効) は sessionStorage に保持。タブを閉じると失効します
- ROI 編集は **書き込みロック取得中のみ** 有効。ロック保持者がいる間、他の閲覧者は待機します

---

## 12. キーボードショートカット

| キー | 機能 |
| --- | --- |
| `↑` / `↓` | Method (MRM) テーブル: 前後の化合物に focus 移動 |
| `Enter` | 描画モード中: 現在の頂点で ROI を確定 |
| `Escape` | 描画モード中: 中止 (途中の頂点は破棄) |
| `Ctrl + F5` / `Cmd + Shift + R` | ブラウザの強制再読み込み |

---

## 困ったときは

| 症状 | 確認ポイント |
| --- | --- |
| パスワードが違うと出る | 提供者から共有された viewer password が正確か (大文字小文字含む) |
| `+ 新規` が「ロック中」のまま | 別の閲覧者が編集中。30 秒待って再試行 |
| ROI の変更が他の人に見えない | 他の閲覧者がページを **再読み込み** しないと反映されません |
| 表示の倍率や色味が次に開くと戻っている | 仕様 — 表示調整はその場限りです |
| 画像が表示されない | 提供者側の Storage 設定が変わった可能性。提供者に問い合わせ |

不具合や要望は GitHub Issues、または提供者までご連絡ください。
