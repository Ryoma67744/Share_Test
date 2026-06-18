# DESI Data Share — Admin Guide (Data Sharing)

This guide is for the **master / admin** publishing data with DESI Data Share. If you only need project bookkeeping, see "Project Management". Recipients of a share URL should read "Data sharing (recipient)".

---

## Table of Contents

1. [Overall flow](#1-overall-flow)
2. [Opening a project](#2-opening-a-project)
3. [Registering HE / IF layers](#3-registering-he--if-layers)
4. [Registering MSI layers](#4-registering-msi-layers)
5. [Align — overlaying HE/IF on MSI](#5-align--overlaying-heif-on-msi)
6. [Per-layer display settings (gear ⚙)](#6-per-layer-display-settings-gear-)
7. [Drawing ROIs](#7-drawing-rois)
8. [Filling in the Memo](#8-filling-in-the-memo)
9. [Renaming sections / compounds](#9-renaming-sections--compounds)
10. [Export ZIP — local backup & distribution](#10-export-zip--local-backup--distribution)
11. [Publish to share / Auto-publish / Sync indicator](#11-publish-to-share--auto-publish--sync-indicator)
12. [Sharing the URL & passwords](#12-sharing-the-url--passwords)
13. [What happens on re-publish](#13-what-happens-on-re-publish)
14. [Cross-PC import (`?import=<slug>`)](#14-cross-pc-import-importslug)
15. [IndexedDB persistence reliability](#15-indexeddb-persistence-reliability)
16. [Upload progress / large files](#16-upload-progress--large-files)
17. [Storage capacity](#17-storage-capacity)
18. [Troubleshooting](#18-troubleshooting)
19. [MRM library manager (mrm.html)](#19-mrm-library-manager-mrmhtml)

---

## 1. Overall flow

```
[Manager /]
   │ + New project / Open
   ▼
[Viewer /viewer/]
   │ Register HE/IF/MSI → ROIs → Memo
   ▼
[Publish to share]
   │ slug + viewer pw + admin pw
   ▼
[Share URL + passwords]
   ▼
Send to collaborators (URL and viewer pw on separate channels)
```

---

## 2. Opening a project

- **New**: in the manager, click `+ 新規プロジェクト` → fill in metadata → `Create` → viewer
- **Existing**: click `Open` on a project row in the manager

The viewer's `← Projects` button takes you back to the manager.

---

## 3. Registering HE / IF layers

Click `+ HE/IF` on a section panel:

1. Pick a layer name (`HE Stain` / `IF Stain` / custom)
2. Pick the **image file** (TIFF / PNG / JPEG)
   - TIFF is decoded by UTIF.js automatically
3. Optional: pick the **transform JSON**:
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
4. `Register` overlays the image aligned to the MSI coordinate system

> Without a transform JSON the HE/IF is shown at the bare canvas size (no alignment). You can re-align it interactively later via the **`Align`** button on each section panel — see §5.

---

## 4. Registering MSI layers

`+ MSI` on a section panel:

### 4-1. xlsx
1. Pick the source `.xlsx`
2. Confirm sheet name (default `MSI_Data`) and **header row** (default 4)
3. `Reload columns` to refresh column labels
4. Pick the **X / Y columns** (default `Image_X`, `Image_Y`)
5. Pick the **intensity columns** (Ctrl/Cmd-click for multi-select; each becomes its own MSI layer)
6. Confirm **Data start row** (default 5)
7. `Register` creates one `MSI_<col>` layer per selected column

### 4-2. txt
- Analyte (`Analyte (converted from imzML)`) or generic TSV/CSV
- Specify a layer name (e.g. `MSI_DA`) and the value column index

---

## 5. Align — overlaying HE/IF on MSI

Click **`Align`** on a section panel to open a modal that aligns HE/IF layers to the MSI coordinate system. Use this when no transform JSON was supplied at registration time, or whenever you want to re-align manually.

> **Note: the main-view "rotate one side"**: the main toolbar's **Rotation** has a target selector **(Both / HE only / MSI only)**. When HE and MSI were imported at different orientations and don't line up, rotate **just one of them** to match. The angle is stored in `section.meta.viewerTransform.rotHE / rotMSI` and is **shipped to viewers on publish**. This is a display-level overlay fix and is **separate from this Align modal's affine transform (μm/px, ROI coordinates, and other scientific alignment)** — keep using the Align modal for coordinate-accurate registration.

<div style="border:1px solid #cbd5e1;border-radius:6px;padding:10px;background:#f8fafc;margin:10px 0;font-size:12px;">
  <div style="font-weight:600;color:#0f172a;margin-bottom:6px;">Align modal layout</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
    <div style="border:1px solid #94a3b8;border-radius:4px;padding:6px;background:#fff;">
      <div style="font-weight:600;font-size:11px;">Left: HE/IF thumbnail</div>
      <div style="color:#64748b;font-size:11px;">Layer dropdown to switch<br>Click to add a landmark</div>
    </div>
    <div style="border:1px solid #94a3b8;border-radius:4px;padding:6px;background:#fff;">
      <div style="font-weight:600;font-size:11px;">Right: MSI thumbnail (Plasma)</div>
      <div style="color:#64748b;font-size:11px;">Compound dropdown<br>“TIC (synthetic)” may appear at the top</div>
    </div>
  </div>
  <div style="margin-top:6px;border:1px dashed #cbd5e1;border-radius:4px;padding:6px;background:#fafafa;">
    <div style="font-weight:600;font-size:11px;">Bottom: MSI pixel size / Manual / Solve</div>
    <div style="color:#64748b;font-size:11px;">μm/px · Flip · Scale · Rotate · Offset X/Y</div>
  </div>
</div>

### 5-1. MSI selector

- The compound dropdown switches the MSI thumbnail.
- **TIC (synthetic)** appears at the top whenever a section has many MRM transitions but no real `MSI_TIC` layer. It sums the luminance of every MSI series — handy as a high-contrast landmark target.
- **Per-source TIC**: when the section has multiple sources, an extra `TIC_<filename>` row is inserted per source so you can pick the correct TIC for each acquisition (e.g. only the 1st-scan TIC).
- All MSI thumbnails are tinted with the **Plasma colormap**, so signal regions are far easier to see than raw grayscale.

### 5-1-bis. Source dropdown (per-source T_he_to_msi)

The Align modal shows a **Source** dropdown at the top whenever a section has more than one MSI source. Each source name is prefixed with an **alignment-status icon**:

- **✓** = aligned with landmarks
- **△** = provisional (sliders only, no landmarks)
- **−** = not aligned yet

| Value | Behaviour |
| --- | --- |
| **All sources** (`__all__`) | One T is broadcast to **every source** under the section. Use it when sources represent the same physical scan (e.g. POS / NEG). **Default when all sources share the same grid.** |
| Specific fid (e.g. `Analyte 1.txt`) | T is stored per-source under `world_coords.T_he_to_msi_by_source[fid]`. Use it when sources have meaningfully different positions. |

- **"全ソースへ反映" (Apply to all sources) button** (shown only when sources share a grid): copies the alignment T currently shown to **every same-grid source**. When only one source is aligned, this reflects it to the others in one click (show the aligned source, then press it).
- **Auto-fallback for un-aligned sources**: a provisional entry (△, no landmarks) never **shadows** a genuine alignment (✓) on another source. At render time the legacy / genuine T is used, so HE never blows up or drifts even if one source is left un-aligned.
- Save always also updates the legacy `T_he_to_msi`, so older viewers and the fallback path keep working. Compounds within the same source share the same T.

### 5-2. MSI pixel size

Enter `X / Y` in μm/px. This drives both the ROI physical scale and the **scale bar** drawn on the bottom-left of the main canvas. DESI typically has square pixels (X == Y), so a single value is enough.

### 5-3. Manual section (live sliders)

| Control | Range | Effect |
|---|---|---|
| Flip Horizontal / Vertical | checkbox | Mirror HE left-right or top-bottom |
| Scale | 5–500 % | Resize HE |
| Rotate | -180°–180° | Rotate HE |
| Offset X / Y | -2000–2000 px | Translate HE |

Both the slider and the numeric input edit the same value. The Section panel behind the modal previews the result live, so you can fine-tune while watching the overlay.

### 5-4. Landmark mode

Click ≥ 3 corresponding points on each thumbnail, then **`Solve`** runs a complex-LSE similarity transform (rotation + isotropic scale + translation) and pushes the result into the Manual sliders.

| Button | Action |
|---|---|
| `Reset to identity` | Reset all Manual fields |
| `Clear all` | Remove every landmark on both sides |
| `Solve` | Estimate the affine and populate Manual |

### 5-5. Cancel / Save

- **Cancel**: Restore the snapshot taken when the modal opened (preview rolls back).
- **Save**: Write the current values into `sec.meta.world_coords.T_he_to_msi` (+ `T_he_to_msi_by_source[fid]`) and `msi_um_per_px`, persist to IndexedDB, and refresh the ROI physical scale.

> **The modal's HE / MSI thumbnails render in the same orientation as the main canvas** — the section's Rotation, Flip H/V, and the implicit -90° MSI bake are all applied. Clicking a landmark stores the raw HE/MSI pixel coordinate (the orientation transform is reversed internally), so Solve and T computation behave identically regardless of the visible orientation.

> **Reflected in the main screen's bottom thumbnail list too**: changing Rotation / Flip H·V on the main screen re-renders the **MSI thumbnail list** in the layer bar (bottom-center) in the same orientation — not just the Align-modal thumbnails, but the main-screen list as well.

> After Save, the main canvas renders **HE underneath, MSI on top (additive blend)** with a **scale bar** at the bottom-left. The bar auto-picks a round value (10 / 20 / 50 / 100 / 200 / 500 μm; 1 / 2 / 5 / 10 mm) and **shrinks the unit when you zoom in**.

> Save also updates the section's top-left **canvas-label** to include the **Pixel pitch** in `X×Y μm/px` form (e.g. `Section 1 · 20×20 μm/px` for isotropic, `50×60 μm/px` for anisotropic — both axes are always written so the label is unambiguous). The same label is rendered for share recipients and inside the Preview overlay's cell titles, so collaborators can verify the acquisition resolution without opening the Align modal.

---

## 6. Per-layer display settings (gear ⚙)

Click the **gear ⚙** at the right edge of any layer chip to open a per-layer popover. **Right-clicking** the layer thumbnail opens the same settings popover.

> **Left-clicking thumbnails in Compound mode**: in Compound mode, **left-clicking an MSI thumbnail** in the layer bar switches the focus compound and applies to every section (same as clicking a Method-table row). Use **right-click (or the gear ⚙)** to open the settings popover.

<div style="border:1px solid #cbd5e1;border-radius:6px;padding:10px;background:#fff;margin:10px 0;font-size:12px;display:grid;grid-template-columns:1fr 1fr;gap:10px;">
  <div style="border:1px solid #94a3b8;border-radius:4px;padding:8px;background:#f8fafc;">
    <div style="font-weight:600;color:#0f172a;margin-bottom:4px;">MSI layer</div>
    <ul style="margin:4px 0 0 1.2em;padding:0;color:#475569;font-size:11px;line-height:1.6;">
      <li><b>Apply opacity</b> ✓ (default ON)</li>
      <li>Opacity (0–100%)</li>
      <li>Intensity range (vmin / vmax)</li>
    </ul>
  </div>
  <div style="border:1px solid #2563eb;border-radius:4px;padding:8px;background:#eff6ff;">
    <div style="font-weight:600;color:#1d4ed8;margin-bottom:4px;">HE / IF layer</div>
    <ul style="margin:4px 0 0 1.2em;padding:0;color:#475569;font-size:11px;line-height:1.6;">
      <li><b>Apply opacity</b> ☐ (default OFF — always opaque)</li>
      <li>Opacity (greyed out while OFF)</li>
      <li><b>Grayscale</b></li>
    </ul>
  </div>
</div>

### 6-1. Apply opacity

- **Checked**: The Opacity slider value is applied to rendering.
- **Unchecked**: The slider value is ignored — the layer always renders at 100 %. The slider is still visible but disabled.
- **Defaults**: HE/IF off, MSI on. As a result HE stays as a solid backdrop while only MSI fades out when its opacity drops.
- Persisted in `sec.meta.layerDisplay[key].applyOpacity`, so the choice survives reloads.

> The toolbar Opacity input also follows this flag. With the active MSI's Apply opacity set to OFF, the toolbar input greys out and a tooltip explains why.

### 6-2. Grayscale (HE/IF only)

- Renders the histology layer in monochrome, perfect for letting MSI's Plasma overlay pop at maximum contrast.
- BT.601 luma collapses RGB into a single channel; alpha is preserved.
- Persisted in `sec.meta.layerDisplay[key].grayscale`.

### 6-3. Layer draw order (HE → others → MSI)

The main canvas always paints **HE/IF first, then anything else, then MSI on top with additive (`lighter`) blending**. The order does NOT depend on the order in which layers were toggled — HE never covers MSI.

### 6-4. Automatic TIC backdrop (sections without HE)

When a section has **no HE (`HE_STAIN`) registered** and 2+ MSI series exist, the Viewer (master included) automatically injects a synthetic TIC image (`HE_STAIN_TIC` key) as the backdrop.

| Case | Behaviour |
| --- | --- |
| HE registered | HE acts as backdrop, no TIC injection |
| No HE, IF/IHC only | **TIC at the bottom, IF/IHC in the middle, MSI on top** |
| No HE, no IF/IHC, 2+ MSI | TIC becomes the backdrop |
| No HE, only 1 MSI | No TIC (a single-series TIC would equal that series) |

- The TIC is built by averaging luminance across every MSI layer, then normalising to 0–255 grayscale. Pixels with no MSI data stay transparent so grid-edge gaps remain visible.
- The Layer panel exposes a **`TIC backdrop (auto)`** chip; clicking it toggles visibility. The on/off state persists in `sec.meta.visibleLayers`.
- For projects created before this feature shipped, the TIC chip appears in the Layer panel but isn't visible by default. As the master, toggle it on once and save — the chosen state then ships to viewers on the next publish.
- **Detection key is HE only**: IF/IHC registrations don't suppress TIC creation (IF/IHC are molecular overlays, not anatomical references).

### 6-5. Viewer inherits the master's MSI Range

The master's Range slider (Toolbar Range or the gear ⚙ "Intensity range") writes its value into **`sec.meta.layerDisplay[key].vmin/vmax`**. The Viewer reads that field on load and uses it as the **initial Range** for the corresponding MSI.

- **Range is shared — same window, same width — across every section of one MRM**: changing the Range min/max on one section snaps the min/max of **every section showing the same MRM (same MSI key)** to the same values (identical width). Edits from the Toolbar or the gear ⚙ both propagate to all sections and are saved into each section's `layerDisplay`. Use it to compare and publish several sections on one identical scale.
- Whatever intensity window the master pinned for each MSI is what the viewer sees on first paint.
- Viewers can re-tune Range freely, but the change is local — reloading restores the master's value.
- The master needs to re-publish after tuning Range; saved-but-unpublished changes don't reach viewers.
- `actualMin` / `actualMax` (slider endpoints) are re-derived from the viewer's local raster, so the slider stays consistent even if the data differs slightly.

---

## 7. Drawing ROIs

1. Click a section panel to make it active
2. Click `+ 新規` in ROI LIST (drawing mode ON)
3. Drop ≥ 3 vertices by clicking on the canvas
4. Finish with: first-vertex click / double-click / **Enter**
5. Type an ROI name

Click `+ draw` on an existing ROI row to extend it onto another section.

> **Escape** during drawing cancels (in-flight vertices are dropped). Multi-section ROIs accumulate in `polysBySection`.

> **ROI-only view**: turning on the **"ROIのみ" (ROI only)** checkbox in the ROI LIST header clips **only the MSI layers** to the shape of the selected ROI (HE / background stay full). Sections without that ROI show no MSI. It follows rotation / flip and turns off to restore the full view.

---

## 8. Filling in the Memo

The Memo panel at the bottom right of the viewer:

| Field | Notes |
| --- | --- |
| Sample | sample name |
| Experiment date | date |
| Machine | DESI / TIMS / LTQ / Other |
| Matrix | shown only for non-DESI machines |
| Google Keep | URL of a related note |
| Memo | free text |
| Derivatization | derivatization step |

Values auto-save to IndexedDB (~400 ms debounce). On Publish they're also written to the server's `projects.meta.memo`.

> The Method (MRM) table's **Precursor / Fragment / CE / CV** columns are **admin-only**. Visitors entering with the regular viewer password don't see them; only those who unlock with the admin password do.

> **Colormap dropdown**: The toolbar's **Colormap** picker (Plasma / Viridis / Inferno / Hot / Jet / Grayscale) sets the MSI heatmap palette. Your choice is stored in `project.meta.colormap` and ships with Publish to share, so recipients open with the colour you picked. Recipients see the same dropdown and can override locally (kept in sessionStorage for that tab only).

> **Click a column header to sort**: Click any of the Compound / Precursor / Fragment / CE / CV / Mean / Max headers to reorder the rows. 1st click applies the column's default direction (Compound = A→Z, numeric columns = High→Low), 2nd click reverses it, 3rd click clears the sort and falls back to the legacy source-file → name order. Empty cells (`—`) always sink to the bottom. Sort is session-only and shared with the SharePreview Method panel; ↑/↓ keys also follow the displayed order.

---

## 9. Renaming sections / compounds

### 9-1. Rename a section (master only)

**Double-click** the top-left **canvas-label** of any section panel (e.g. `Section 1`) to open a prompt and rename it (e.g. `260504_Killifish_Sec1`).

- Master view only — share recipients ignore double-clicks.
- Duplicate names within the same project are rejected.
- The new name is `_flushSave`-d and **read back from IDB** before showing "Section 名を ... に変更しました". If persistence fails, an error banner appears.
- Toolbar section picker, Preview cell title, stats column header and the Pixel pitch label all update immediately.

### 9-2. Rename a compound (master only)

**Double-click** the **Compound cell** in the Method (MRM) table to rename only the compound's display name. Precursor / Fragment / CE / CV are untouched.

- The new name is broadcast to every section that holds the same compound key.
- Persisted with verify-after-write; failures surface as a red error banner.

> If a rename appears to revert after reload, hit F5; if it persists in IDB, the new name will be restored.

### 9-3. Section Flip H / V (master only)

The toolbar's **Flip** group has `⇄` (mirror left-right) and `⇅` (mirror up-down) buttons for the active section. They're the answer to "I imported this slide upside-down / mirrored — fix it without re-importing."

- Each click flips **both MSI and HE/IF in that section together** (no need to re-run Align for HE).
- ROI positions follow automatically, and new ROIs you draw afterwards land where you visually click.
- The state lives in `sec.meta.flip = { lr, ud }` and travels via IDB + publish, so recipients see the flipped orientation.
- Click again to undo (toggle).
- Share recipients have the buttons hidden — the master's choice is the final orientation.

### 9-4. Organ display filter

When several organs (e.g. Brain / Heart / Placenta) are stored in one project, the **"臓器:" (Organ)** selector at the right of the Sections header filters the center grid by organ ("すべて"/All shows everything).

- The organ is **auto-inferred from the section name** (e.g. `E15-2-1_Brain1` → `Brain`). The selector appears only when **2 or more** organs are detected.
- It only filters the view — no data is changed.
- If the auto-inference is wrong, set **`section.meta.organ`** to override it (renaming sections so the organ token matches is another easy approach).

---

## 10. Export ZIP — local backup & distribution

The **Export ZIP** button packages the entire project (images, MSI numerical data, ROIs, memo, alignment, etc.) into a single download. Unlike Publish, no server is involved; the receiver re-imports it later via **Import ZIP** in the same or another viewer instance.

### 9-1. File layout (new format)

```
<projectName>_<YYYY-MM-DDTHH-MM-SS>.zip
├── <projectName>.json               ← project meta + all ROIs + memo (root JSON name = project name)
└── sections/
    └── <sectionId>/
        ├── atlas.json               ← per-section meta + layer definitions (Align / Display / state)
        └── data/
            ├── img_HE_Stain__<original>.tif    ← HE/IF: one file per layer
            ├── msi__Analyte_1.txt              ← MSI: one file per source file
            └── msi__Analyte_2.xlsx             ← (with ROI columns appended)
```

### 9-2. Root JSON named after the project

The root JSON is `<projectName>.json` (non-ASCII / unsafe chars replaced with `_`). On import the loader scans for any root-level `*.json` whose `format` field equals `desi_data_share_v1`, so renaming the file outside the viewer is fine.

### 9-3. MSI data is consolidated per source file

Old format wrote one ZIP entry per compound, so 17 compounds registered from the same `Analyte 1.txt` produced 17 identical-content files. **The new format writes one file per source file**, regardless of how many compounds it produced.

Example: 17 compounds from `Analyte 1.txt` → old format = 17 files, **new format = single `data/msi__Analyte_1.txt` containing all 17 compounds**.

<div style="border:1px solid #cbd5e1;border-radius:6px;padding:8px;background:#f8fafc;margin:10px 0;font-size:12px;">
  <div style="font-weight:600;color:#0f172a;margin-bottom:6px;">Why "same section ⇒ same XY" holds</div>
  <div style="color:#475569;">DESI/MSI typically acquires every MRM transition in a single source file with synchronised raster, so all compounds from one source share Image_X / Image_Y exactly. The new format leverages this so consolidation is lossless.</div>
</div>

### 9-4. ROI columns appended to xlsx

xlsx sources keep their original column layout, with **0/1 flag columns appended at the end** — one per ROI drawn on the section (column header = ROI name). Recipients can open the file in Excel / R / Python and immediately compute "compound × ROI" aggregates. txt sources are written as-is (their format is too free-form to safely augment); the polygon coordinates remain available in the root JSON's `polysBySection`.

| Column | Meaning |
|---|---|
| Image_X / Image_Y | Acquisition position (MSI pixel) |
| (original intensity columns) | Compound 1, Compound 2, …, Compound N |
| (original trailing columns) | Preserves the source xlsx layout |
| **Cortex (new)** | 1 if inside ROI Cortex, else 0 |
| **Hippocampus (new)** | Same |

### 9-5. atlas.json `path` semantics

Each section's `atlas.json` carries a `path` for every MSI layer entry. **Multiple `msiSeries[layerKey]` entries pointing at the same `path` is the new normal.** On import the path becomes the dedup key — only one IndexedDB blob is created per unique path, even if many compounds reference it.

### 9-6. Import (= restore)

Use the header's **Import ZIP**:
- The loader finds the root-level `*.json` whose `format` is `desi_data_share_v1` and treats it as project metadata
- Each `sections/<id>/atlas.json` rebuilds one section
- Compounds sharing a `path` collapse to a single IDB blob
- Fresh ids are minted so the imported project never collides with the source

> **Old-format ZIPs** (fixed `project.json` + per-layer `msi_<layerKey>__` paths) are **not supported**. The importer raises a clear "old-format ZIP not supported" error. Re-export with the latest viewer.

### 9-7. ZIP is independent of Publish

- Export ZIP is for **local backup and offline distribution** (no share URL is generated)
- Recipients use the viewer's **Import ZIP** to load it back into IndexedDB
- The receiving viewer cannot re-publish or re-export from share mode (those buttons are hidden)
- ZIP is fully self-contained — nothing depends on Supabase being reachable

### 9-8. Size guidance

- Per section: HE TIFF 50–300 MB / MSI xlsx 50–500 MB
- Source-file dedup means the new format shrinks ZIPs by **roughly 1 / N** (N = compounds per source) compared to the old per-compound layout
- For projects > 1 GB, ZIP distribution is often more practical than Publish (avoids upload-bandwidth bottleneck)

---

## 11. Publish to share / Auto-publish / Sync indicator

The header's `Publish to share` button:

| Field | Meaning |
| --- | --- |
| **Project slug** | URL identifier (alphanumerics, `_`, `-`) |
| **Viewer password** | What recipients type (≥ 4 chars) |
| **Admin password** | Pre-filled with `MSIadomine` (≥ 4 chars) |

Pressing `Publish`:

1. **Master password is verified** — the value from the management-page gate is reused if still cached; otherwise a prompt asks for it
2. Server issues a 1-hour **publish session token**
3. All blobs (TIFF / xlsx / txt) upload to Supabase Storage in parallel (concurrency 4) — the token is sent as a header and validated by RLS
4. A progress modal shows live `X / N files (Y MB / Z MB)`
5. Each file retries up to 3 times with exponential backoff
6. `upsert_project_doc` is called with the master password to update the DB
7. On success a Share URL modal opens with URL + viewer/admin passwords

> Without the master password, a third party with only the anon key cannot publish or write to Storage. Authentication is enforced server-side via bcrypt in Supabase.

> Read "13. What happens on re-publish" before re-running on a previously-published slug.

### 11-1. Auto-publish on save

Once a project has been published, every subsequent save (queueSave) automatically attempts to **re-publish in the background**. ROI / Memo / Align / rename changes flow to the server without you re-clicking `Publish to share`.

- Master pw is cached in sessionStorage on the first publish — no re-prompt within the session.
- Different tab / new session → next publish re-prompts (sync indicator turns `needs-master-pw`).

### 11-2. Sync indicator

A small **sync badge** sits in the header. Its color and label show the current auto-publish state.

| State | Label | Meaning |
| --- | --- | --- |
| `synced` (green) | Synced | All saved + matches server. |
| `uploading` (blue) | Uploading… | Publish in flight (storage upload + RPC). Returns to `synced` on success. |
| `local-saved` (gray) | Local saved | IDB updated but server not yet. Next save retries publish. |
| `conflict` (red) | Conflict | Another device published in the meantime (`updated_at` mismatch). Click to resolve via manual Publish. |
| `needs-master-pw` (purple) | Master pw needed | sessionStorage has no master pw — click to re-enter. |
| `error` (red) | Error | Publish failed. Click for a detailed toast. |

- Closing the tab while sync isn't `synced` triggers the **beforeunload warning**.

---

## 12. Sharing the URL & passwords

- URL: `https://.../viewer/index.html#share=<slug>`
- Send the viewer password on a **separate channel** (Slack, e-mail)
- Only share the admin password with people you want to grant the admin view (full Method table)

> The URL is also accessible later via `Share info` (post-publish) or `Copy URL` on the manager page.

---

## 13. What happens on re-publish

★ Important: **publishing the same slug a second time fully overwrites the server-side project.**

| Item | Behaviour |
| --- | --- |
| `projects` row | display_name / anatomy_palette / meta updated |
| **Viewer password** | **Always** overwritten with the new value |
| **Admin password** | Overwritten if the field is non-empty; otherwise unchanged |
| **sections** table | Wiped and re-inserted |
| **rois** table | **Wiped and re-inserted** (any ROIs added by recipients are gone) |
| **Storage `<slug>/...`** | Same path: upserted; new path: added; **old paths remain (orphans)** |

Caveats:

- ROIs added by recipients via the share URL are **lost on re-publish**
- Existing 12 h session tokens stay valid even after a password change
- Storage orphans accumulate and eat into your Supabase quota (cleanup is a future task)

---

## 14. Cross-PC import (`?import=<slug>`)

When you `Open (master)` a server-only project from another PC / browser profile, the URL switches to `viewer/index.html?import=<slug>` and the first open prompts for the master password.

| Step | Action |
| --- | --- |
| 1 | Click `Open (master)` on the manager page |
| 2 | Viewer loads at `?import=<slug>` |
| 3 | Master password modal — correct value triggers a Storage download of every blob |
| 4 | Blobs land in IndexedDB; the master view boots normally |
| 5 | Subsequent saves auto-publish, so the second PC stays in sync with the first |

> The recommended workflow for one operator across multiple PCs: publish from PC A, `?import=` on PC B and continue editing, auto-publish, `?import=` on PC C, and so on.

---

## 15. IndexedDB persistence reliability

After we observed a "Section 2 silently disappeared from IDB" event, the save path (queueSave / _flushSave) now has three layers of defence.

| Layer | Detail |
| --- | --- |
| **Loud failure** | An IDB put failure (QuotaExceeded etc.) is no longer just `console.warn`-ed — a red error banner appears in the header, and the sync indicator turns `error`. |
| **Verify after write** | Each put is followed by a `getProject(id)` read-back that confirms section count + the relevant displayName persisted. Mismatches surface via `_showSaveError`. |
| **Quota monitoring** | `navigator.storage.estimate()` is polled proactively — at >80 % usage a warning toast appears. `navigator.storage.persist()` is requested so the OS doesn't silently evict the store. |
| **3-retry exp backoff** | Put operations retry up to 3 times (200 ms → 400 ms → 800 ms). Permanent failure surfaces the same red banner. |
| **beforeunload warning** | Closing the tab while there are unsaved changes / sync errors triggers a confirmation dialog. |

---

## 16. Upload progress / large files

Already implemented:

- **Parallel uploads** (concurrency = 4)
- **Auto retry** (up to 3 times per file, backoff 800 ms → 1.6 s → 3.2 s)
- **Progress modal** with percentage, files done, MB done, progress bar

Tips for large (~1.5 GB) projects:

- Per section, expect MSI xlsx around 50–500 MB and HE TIFF around 50–300 MB
- A project total over 1 GB blows past the Supabase Free tier — consider **Pro (100 GB)**
- Publish from a stable network if uploading large files

---

## 17. Storage capacity

| Plan | Storage | Bandwidth | Monthly |
| --- | --- | --- | --- |
| Free | 1 GB | 5 GB / month | $0 |
| **Pro** | **100 GB** | **250 GB / month** | **$25** |

Per-file size cap defaults to 50 MB on both plans, raisable to 5 GB from the dashboard settings.

> A 1.5 GB project pretty much requires Pro. The Free tier will hit both storage and bandwidth limits on the very first publish.

---

## 18. Troubleshooting

| Symptom | Action |
| --- | --- |
| Publish errors mid-upload | Progress modal closes and an alert appears. Inspect failed PUTs in DevTools' Network tab and retry |
| `new row violates row-level security policy` | Re-run the storage policies in `share_locks.sql` (see `supabase/README.md`) |
| Storage quota filling up with orphans | Manually delete `<slug>/<oldSectionId>/` from the Supabase Storage dashboard |
| Accidentally published over an existing slug | No undo — be careful with names |
| Forgot the password | In the Supabase SQL Editor, run `select set_project_password('<slug>', 'admin', '<new>');` |
| `サーバから一覧取得` returns 0 rows | The admin pw matches no projects yet (none published, or a different admin pw was used) |

---

## 19. MRM library manager (mrm.html)

An **admin-only page** for managing compounds, transitions and usage history in one place. Open it from the **"MRM管理"** button on the dashboard (`/`) — **an admin password is required**.

### 19-1. What you can do
- Add / edit / delete compounds (`+ 化合物`) and transitions (`+ トランジション`). Manage tags (categories), polarity, serial number, intensity notes, role (quantify/confirm) and the recommended ★ flag.
- Select rows in the viewer's Method (MRM) table and click **"選択を管理へ登録"** to register them into this library straight from measurement results (with tags / role / sample types).
- Export selected transitions to a **`.exp`** file (substituted into a Waters template).

### 19-2. Bulk-import MRM from Excel
You can import an existing MRM list (xlsx) as-is. Use the **`Excel取り込み`** button on the toolbar:

1. Pick a `.xlsx` / `.xls` file.
2. The whole sheet is parsed automatically, detecting **blocks that have a category title plus a `CompoundName / Precursor / Product / CV / CE` header row**.
   - **Multiple blocks laid out vertically and horizontally** (e.g. several lanes side by side) are all detected.
   - Columns are matched **by header name**, so a **swapped CV/CE order is read correctly**.
   - Each title (e.g. `Amino acid`, `13C6-Glucose`) becomes a **tag (category)**.
   - **Polarity** is taken from a `+ / −` marker next to the title, or inferred from `NEG` / `POS` in the compound name.
3. In the **preview**, review/adjust which blocks to import, the tag names, and polarity (— = infer from name / + / −).
4. Click **`取り込み実行`** to bulk-register.

> **Idempotent (safe to re-run)**: existing compounds are updated and identical transitions (same precursor / product / CE / CV) are skipped, so repeating an import never creates duplicates.
>
> The import writes to the production Supabase. For the first run, verify the result with a **small test file** before importing the full list.
