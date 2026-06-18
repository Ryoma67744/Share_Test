# DESI Data Share — Viewer's Guide

This guide is written for **users opening DESI Data Share via a share URL**.
Master-side operations (creating projects, registering layers, publishing, etc.) are out of scope here.

> The person who issued the URL should also have given you a **viewer password** separately. If you don't have it, contact them.

---

## Table of Contents

1. [What you can do as a viewer](#1-what-you-can-do-as-a-viewer)
2. [Open the URL & enter the password](#2-open-the-url--enter-the-password)
3. [Screen layout](#3-screen-layout)
4. [Showing and adding ROIs](#4-showing-and-adding-rois)
5. [View modes: Free vs Compound](#5-view-modes-free-vs-compound)
6. [Method (MRM) and switching compounds](#6-method-mrm-and-switching-compounds)
7. [Range / Opacity / Rotation tweaks](#7-range--opacity--rotation-tweaks) / [Per-layer settings (gear ⚙)](#7-bis-per-layer-display-settings-gear-) / [MSI scale bar](#7-tris-msi-scale-bar)
8. [Editing the Memo](#8-editing-the-memo)
9. [Preview overlay (image grid)](#9-preview-overlay-image-grid)
10. [Export ZIP for local download](#10-export-zip-for-local-download)
11. [What gets saved vs discarded](#11-what-gets-saved-vs-discarded)
12. [Keyboard shortcuts](#12-keyboard-shortcuts)

---

## 1. What you can do as a viewer

- Browse section images (HE / IF / MSI) layered per compound
- Switch and compare compounds (Free / Compound mode)
- Toggle existing ROIs on/off / **clip MSI to the selected ROI shape** (ROI-only)
- Add new ROIs and delete existing ones — **only while holding the write lock** (one editor at a time)
- Compare mean intensity across sections × compounds in the ANALYSIS bar chart
- **Filter the view by organ** (auto-inferred from section names, when 2+ organs exist)
- Make **temporary** display adjustments (Range / Opacity / Rotation / Pan / Zoom)
- **Temporarily** edit the Memo
- Download the entire project as a ZIP

---

## 2. Open the URL & enter the password

1. Open the URL you received in your browser (e.g. `https://.../viewer/index.html#share=<slug>`)
2. The "共有プロジェクト" (Shared project) dialog appears — enter the **viewer password** that was shared with you
3. Click **Unlock** to load the project
4. A 🔒 **Share view** badge appears in the header and the editing-related buttons are hidden automatically

The session expires after **12 hours**. Closing the tab is fine — re-opening the URL with the same password logs you back in.

> The same URL also accepts an **admin password** set by the publisher. Opening with the admin password unlocks the additional Method (MRM) columns (Precursor / Fragment / CE / CV); a regular viewer password keeps those four columns hidden.

---

## 3. Screen layout

<div style="border:1px solid #475569;border-radius:6px;overflow:hidden;font-size:11px;margin:10px 0;background:#fff;">
  <div style="background:#1e293b;color:#fff;padding:6px 10px;font-weight:600;letter-spacing:0.02em;">
    Top Bar &nbsp;—&nbsp; 🔒 Share view / Free / Compound / Export ZIP / Help
  </div>
  <div style="display:grid;grid-template-columns:170px 1fr 220px;">
    <div style="background:#f8fafc;padding:8px;border-right:1px solid #cbd5e1;">
      <div style="font-weight:600;color:#0f172a;">ROI LIST</div>
      <ul style="margin:6px 0 0 1em;padding:0;color:#475569;font-size:11px;line-height:1.5;">
        <li>+ New (requires lock)</li>
        <li>Show toggle</li>
        <li>Per-row checkbox &amp; delete</li>
      </ul>
    </div>
    <div style="padding:8px;background:#fff;">
      <div style="font-weight:600;color:#0f172a;margin-bottom:4px;">Sections Grid</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
        <div style="border:1px solid #cbd5e1;padding:6px;border-radius:4px;background:#f8fafc;">
          <div style="font-weight:600;font-size:11px;">Section 1</div>
          <div style="color:#64748b;font-size:11px;">canvas (pan/zoom)</div>
          <div style="color:#64748b;font-size:11px;">thumbs (on/off)</div>
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
        <li>Section-parallel bar chart</li>
        <li>Up to 3 compound dropdowns</li>
      </ul>
      <div style="font-weight:600;color:#0f172a;">Memo</div>
      <ul style="margin:6px 0 0 1em;padding:0;color:#475569;font-size:11px;line-height:1.5;">
        <li>Sample / Machine / Matrix …</li>
      </ul>
    </div>
  </div>
</div>

| Region | Role |
| --- | --- |
| Top Bar | View mode toggle (Free / Compound), Preview, Export ZIP, 🔑 Admin, Help |
| ROI LIST | Project-wide ROI list. Show toggle, draw new, draw on extra section |
| Sections Grid | Section panels. Click to activate (blue outline); drag to pan; wheel to zoom |
| Method (MRM) | MSI layer table for the active section. Click / ↑↓ keys to switch |
| ANALYSIS | Bar chart of the selected ROI across sections × compounds |
| Memo | Sample / Machine / Matrix / Google Keep / +α … (temporary edits) |

> Each section panel's top-left **section-name label** also shows the **Pixel pitch (μm/px)** when the publisher set it during Align (e.g. `Section 1 · 20×20 μm/px`). Both axes are always written out (`50×60 μm/px` for anisotropic, `20×20 μm/px` for isotropic) so the label is unambiguous.

> **Organ filter**: when **2 or more** organs are inferred from the section names, an **"臓器:" (Organ)** selector appears at the right of the Sections header. Picking one shows only that organ's sections in the center ("すべて"/All shows everything). This only filters the view — it never changes the data or server state.

---

## 4. Showing and adding ROIs

### 4-1. Showing or hiding existing ROIs

- Per-row **checkbox** toggles a single ROI on/off
- The **Show** toggle in the ROI LIST header toggles all ROIs

These toggles affect only your local view — they are not sent to the server.

### 4-2. Drawing a new ROI (write lock required)

In share mode, **acquiring the write lock is required** to add or modify ROIs (one writer at a time).

1. Click the section panel you want to draw on (it gets a blue outline)
2. Click **`+ 新規`** (New) on ROI LIST → the lock is requested automatically
3. Once you hold the lock, drop ≥ 3 vertices on the canvas
4. Finish by either:
   - Clicking the first vertex again
   - Double-clicking
   - Pressing **Enter**
5. Type an ROI name → **saved to the server immediately**, visible to other viewers after they reload

> If the lock is held by someone else, you'll see "ロック中: \<name\>" (Locked by …). After 30 s without a heartbeat from the holder, anyone can take it over.
> The lock is released automatically once you finish the drawing.

### 4-3. Drawing the same ROI on another section

- Click **`+ draw`** next to the ROI in the list → drawing mode for the active section
- The same ROI now spans multiple sections
- The right-side `2/3` badge means "drawn on / total sections"

### 4-4. Deleting an ROI

- The **`×`** on each row removes the ROI everywhere — propagated to the server immediately
- Deletion also requires the write lock

> While drawing you cannot switch sections. Press **Escape** to cancel (in-flight vertices are dropped).

### 4-5. ROI-only view (clip MSI to the ROI shape)

Turning on the **"ROIのみ" (ROI only)** checkbox in the ROI LIST header clips **only the MSI layers** to the shape of the **currently selected ROI**. HE / background stay fully visible, so you can compare the signal inside the ROI against the surrounding histology.

- Applies to the **currently selected ROI** (select a row in the ROI LIST).
- Sections where that ROI is **not drawn show no MSI**.
- Follows rotation / flip; turn it off to return to the full view.

---

## 5. View modes: Free vs Compound

The **Free / Compound** toggle in the top-right of the header switches between two display modes. The same ROIs and sections look very different in each, so pick whichever fits your task.

<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0;">
  <div style="border:1px solid #cbd5e1;border-radius:6px;padding:8px;background:#f8fafc;">
    <div style="font-weight:700;color:#0f172a;margin-bottom:4px;">🔵 Free</div>
    <div style="color:#475569;font-size:12px;">Each section has its <b>own combination of layers</b> turned on/off. Use it when you want HE and MSI overlaid, or when different sections should show different compounds.</div>
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
    <div style="color:#475569;font-size:12px;"><b>One compound is shown across every section</b>. Use it when you want to compare the same molecule's distribution from slice to slice. Click a row in the Method table to change the focus compound.</div>
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

### When to pick which

| Goal | Mode |
| --- | --- |
| Overlay HE on top of MSI to confirm position | **Free** (turn HE and MSI on together) |
| Show different compounds per section | **Free** |
| Compare compound X across sections 1–10 | **Compound** + select X in the Method table |
| Hunt for an interesting compound in the ANALYSIS bar chart | **Compound** + click rows in the Method table to switch focus |

### Switching modes

- Click **Free / Compound** in the header
- In Compound mode, **clicking a row in the Method table** sets the new focus compound and re-renders every section
- In Compound mode, **clicking an MSI thumbnail in the bottom thumbnail list** does the same — it sets the focus compound and applies to every section
- In Free mode, the same row click toggles a single layer on/off

---

## 6. Method (MRM) and switching compounds

The **Method (MRM)** table at the bottom-left lists every MSI layer in the active section.

| Column | Meaning | Visible when |
| --- | --- | --- |
| Compound | Compound name | Always |
| Precursor | Precursor m/z | **Admin only** |
| Fragment | Fragment (product) m/z | **Admin only** |
| CE | Collision Energy | **Admin only** |
| CV | Collision Voltage / Compensation Voltage | **Admin only** |
| Mean | Layer's mean intensity | Always |
| Max | Layer's max intensity | Always |

> Viewers opening with the regular viewer password do **not** see the Precursor / Fragment / CE / CV columns. Those are MS-instrument parameters and are revealed only when the URL is opened with the admin password.

Clicking a row:
- **Compound mode** focuses that compound across every section (handy for cross-section comparison)
- **Free mode** simply toggles that single layer on/off

> **Click a column header to sort**: Click any of the **Compound / Precursor / Fragment / CE / CV / Mean / Max** headers to reorder the table.
> - 1st click: Compound = A→Z / numeric columns = High→Low (the column-specific default).
> - 2nd click: reverse direction (Z→A / Low→High).
> - 3rd click: clears the sort and falls back to the source-file → name order.
> - The active header shows ▲ / ▼ for direction. Rows with empty values (`—`) always sink to the bottom regardless of direction. Sort state is session-only — reload reverts to the default order.

> **Keyboard navigation**: With focus inside the Method table, **↑/↓** move focus to the previous / next compound (Compound mode applies it to every section instantly, following the current sort order).

> **Compound title format**: Each row title reads `<compound>_<precursor> > <product>` (e.g. `DHA-NEG_327.4 > 283.4`). The same format appears at the top of the screen in Compound mode. Compounds without precursor / product fall back to the bare name.

> **TIC (Total Ion Current)**: A synthetic per-source map that sums every MSI layer in that source can be exposed as `__TIC__` / `TIC_<filename>`. Sections with multiple sources can switch TIC per source.

> Whole-file actions like `[all on]` / `[delete file]` live on the **thumbnail dropdown summary** (`▶ <filename>`). Recipients don't see `delete file`.

---

## 7. Range / Opacity / Rotation tweaks

Three groups in each section's toolbar:

| Field | Input | Meaning |
| --- | --- | --- |
| **Range** | min — max | Intensity window of the active MSI layer (display floor / ceiling). **Shared across every section showing the same MRM (compound)** — see the note below |
| **Opacity** | 0–100 % | Transparency of the active MSI layer |
| **Rotation** | -180°–180° | Canvas rotation (combines with pan and zoom). The **target selector to its left (Both / HE only / MSI only)** chooses which layer is rotated |

**About syncing**: **Range is always shared across every section showing the same MRM** (no toggle needed). **Opacity** and **Rotation (Both)** sync across sections only while their **🔗** icon is ON. The **`↻`** button resets translate / rotate / zoom for the panel (HE/MSI-only rotation is reset too).

> If the Opacity input is greyed out, the active MSI layer has **Apply opacity** disabled in its gear ⚙ popover. Re-enable the checkbox there and the toolbar input becomes editable again.

> These tweaks are **temporary** — they revert to the server state on reload, and other viewers don't see them.

> **Range initial values are inherited from the master**: the per-MSI Range slider (vmin/vmax) loads with the value the master set at publish time. Viewers can still adjust freely, but the change is local — reloading restores the master's value. If the master later re-tunes Range and re-publishes, the new value becomes the next-load initial.

> **Range stays the same window — same width — across sections of one compound**: changing the Range min or max on one section snaps the min/max of **every section showing the same MRM (compound)** to the same values (so the widths match too). Editing via the gear ⚙ Intensity range does the same. Other compounds are unaffected. This lets you compare several sections on one identical scale.

> Pan: drag without modifier. Zoom: mouse wheel. Rotation: the input field, optionally synced with 🔗.

> **Rotation is reflected in the bottom thumbnail list too**: changing Rotation re-renders the **MSI thumbnail list** at the bottom-center in the same orientation as the main canvas.

> **Rotate HE only / MSI only**: pick "HE only" or "MSI only" in the **target selector** left of Rotation to rotate **just one layer** on that section. Use it when HE and MSI were imported at different orientations and don't line up — rotate one of them to match. "Both" rotates the whole canvas as before. HE/MSI-only rotation is per-section and is not affected by the 🔗 sync.

> **Colormap dropdown**: The toolbar's **Colormap** lets you swap the MSI heatmap palette (Plasma / Viridis / Inferno / Hot / Jet / Grayscale). The choice is **kept inside this tab** (sessionStorage). Closing the tab reverts to the master's default. The same dropdown lives inside the Preview overlay and stays in sync, so you can keep adjusting colour after closing Preview.

---

## 7-bis. Per-layer display settings (gear ⚙)

Click the **gear ⚙** at the right edge of any layer chip to open a per-layer popover. **Right-clicking** the layer thumbnail opens the same settings popover (in Compound mode, a **left-click** switches the focus compound instead).

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

| Field | Effect |
| --- | --- |
| **Apply opacity** | When unchecked, the Opacity slider is ignored and the layer always renders at 100 %. HE/IF defaults to OFF so the histology stays as a solid backdrop; MSI defaults to ON to match the previous behaviour. |
| **Grayscale** (HE/IF only) | Render the histology as monochrome — useful when you want MSI's Plasma overlay to pop at maximum contrast. |
| **Intensity range** (MSI only) | The MSI intensity window (vmin / vmax). Linked to the toolbar Range input; changes are **shared across every section showing the same MRM** (same width). |

> The draw order is fixed: **HE/IF → others → MSI (additive blend)**. No matter the order layers were toggled, the MSI heatmap always sits on top of HE.

> All settings here persist across reloads (stored under `sec.meta.layerDisplay`).

---

## 7-tris. MSI scale bar

When an MSI layer is visible AND the publisher has set **MSI pixel size (μm/px)**, the main canvas shows a **scale bar at the bottom-left**.

<div style="display:inline-block;background:rgba(255,255,255,0.88);padding:4px 8px;border-radius:4px;font-size:11px;font-weight:600;color:#0f172a;box-shadow:0 1px 3px rgba(0,0,0,0.25);margin:6px 0;">
  <span style="display:inline-block;height:4px;width:80px;background:#0f172a;box-shadow:0 0 0 1px #fff;vertical-align:middle;margin-right:6px;"></span>200 μm
</div>

- The unit shrinks as you zoom in (e.g. 500 μm → 200 μm → 100 μm) and grows as you zoom out (100 μm → 500 μm → 1 mm). The values come from a NICE round-number set: 10 / 20 / 50 / 100 / 200 / 500 / 1000 / …
- Pan (drag) and Rotation never move the bar — it stays anchored to the bottom-left of the panel.
- The bar is hidden on sections with no MSI layer or where the publisher hasn't set a pixel size.
- The same pitch is also rendered into each section's top-left label (e.g. `Section 1 · 20×20 μm/px`).

---

## 7-quart. TIC backdrop (auto)

When a section has **no HE staining registered** and 2+ MSI series are loaded, the Viewer automatically renders a **synthetic TIC** (a grayscale image built by averaging luminance across every MSI layer) as the section's backdrop. The TIC takes the place of the missing HE image, giving you an anatomical reference even without histology.

| Case | TIC backdrop |
| --- | --- |
| HE present (with or without IF/IHC) | **Not created** — HE serves as the backdrop |
| No HE & 2+ MSI (with or without IF/IHC) | **Auto-created** |
| No HE & only 1 MSI series | **Not created** — TIC would equal that single layer |

- Draw order: **TIC (bottom) → IF/IHC (middle) → MSI (top)**. Lowering the MSI Opacity reveals TIC (and IF/IHC) underneath.
- The Layer panel shows a **`TIC backdrop (auto)`** chip. Click to toggle visibility; the on/off state is preserved across reloads via `sec.meta.visibleLayers`.
- The TIC image is the per-pixel mean luminance, normalised to 0–255 and rendered grayscale. Pixels with no MSI data stay transparent so grid-edge gaps remain visible.

---

## 8. Editing the Memo

The **Memo** form on the bottom-right lets you edit Sample / Machine / Google Keep / +α / Matrix / Derivatization.

> Memo edits are **temporary** — they're discarded on reload and never sent to the server.

---

## 9. Preview overlay (image grid)

The header **Preview** button opens a side-by-side overlay that shows every section for a single compound. It's optimised for slide-deck screenshots and quick cross-section comparison.

| Region | Role |
| --- | --- |
| **Method panel (left)** | Compound list. Click or ↑↓ keys to change focus. The right-edge splitter is **draggable** — pull it horizontally to resize the panel; the chosen width is remembered on next open. |
| **Image grid (center)** | One MSI cell per section. Each cell has a **dynamic scalebar** at the bottom and a **Section name + Pixel pitch** caption at the top. Drag to pan, wheel to zoom inside each cell. |
| **Range slider (top)** | **Project-wide vmin / vmax** so every section uses the same colour scale. The chosen range survives closing and reopening Preview. |
| **Stats / Colorbar (right)** | Statistics for the focus compound + the Plasma colour bar. |
| **🔑 Admin (top-right)** | When opened with a viewer password, this **escalates** to admin without closing Preview — the admin password modal now appears on top of the overlay. |

> The Preview Range is independent from the per-section toolbar Range; closing Preview reverts the toolbar values.
> Sections with multiple sources can flip between `TIC_<filename>` rows to inspect each source's TIC separately.

---

## 10. Export ZIP for local download

The header's **Export ZIP** packages the entire viewable project into a single zip on your machine:

```
<projectName>_<timestamp>.zip
├─ <projectName>.json                ← project meta + all ROIs + memo
└─ sections/
   └─ <sectionId>/
      ├─ atlas.json                  ← section meta + Align / display state
      └─ data/
         ├─ img_HE_Stain__<original>.tif         ← HE/IF: one file per layer
         ├─ img_IF_Stain__<original>.tif (optional)
         ├─ msi__Analyte_1.txt                    ← MSI: one file per source
         └─ msi__Analyte_2.xlsx                   ← xlsx with ROI flag columns appended
```

### Highlights

- **Root JSON is named after the project** (non-ASCII / unsafe chars replaced with `_`)
- **MSI numerical data is consolidated per source file**: registering many compounds from one Analyte / xlsx produces a single ZIP entry (acquisition-side Image_X / Image_Y are shared within a source, so consolidation is lossless)
- **xlsx gets ROI columns appended**: every ROI drawn on the section becomes a **0/1 flag column** at the end (column header = ROI name; original layout preserved)
- **txt is left untouched**: the raw bytes go straight into the ZIP (polygon coordinates remain available in the root JSON's `polysBySection`)

### What recipients can do

- ZIP is **local backup / offline distribution** (no share URL is created)
- Receiving viewer reloads it via **Import ZIP** — same machine or a different one
- Recipients **cannot re-upload or publish** from share mode (those buttons are hidden)

> Old-format ZIPs (fixed `project.json` + one file per compound) are **not importable** in the new viewer. If you only have an old ZIP, open it in the previous viewer build and re-export.

---

## 11. What gets saved vs discarded

| Action | Where it persists | Visible to others | Survives reload |
| --- | --- | --- | --- |
| Add / edit / delete ROI | **Server** | ✅ (after their reload) | ✅ |
| Range / Opacity / Rotation tweaks | (local cache only) | ❌ | ❌ |
| Pan position / zoom level | (same) | ❌ | ❌ |
| Marker colour / layer on-off | (same) | ❌ | ❌ |
| View mode (Free / Compound) | localStorage | ❌ | ✅ |
| Memo edits | (local cache only) | ❌ | ❌ |
| Vertices in flight (Escape / leave) | discarded | — | — |

Bottom line:

- **Only ROIs persist on the server** and are shared with other viewers.
- Display tweaks (colour, zoom, memo, etc.) are **session-only** and reset on reload.
- The session itself (12 h) lives in sessionStorage. Closing the tab clears it.
- ROI edits require the **write lock** — others have to wait while you hold it.

---

## 12. Keyboard shortcuts

| Key | Action |
| --- | --- |
| `↑` / `↓` | Method (MRM) table: move focus to previous / next compound |
| `Enter` | Drawing mode: commit the ROI at the current vertex set |
| `Escape` | Drawing mode: cancel (in-flight vertices are dropped) |
| `Ctrl + F5` / `Cmd + Shift + R` | Browser hard reload |

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| "Wrong password" | Make sure the viewer password matches exactly (case-sensitive) |
| `+ 新規` shows "Locked by …" | Someone else is editing. Wait ~30 s and try again |
| My ROI changes don't appear for others | Other viewers must **reload** to see them |
| Zoom / colour tweaks disappeared next time | By design — display tweaks are session-only |
| Images don't show up | The publisher's Storage settings may have changed. Contact them |

For bug reports or requests, contact the publisher or open a GitHub Issue.
