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
7. [Range / Opacity / Rotation tweaks](#7-range--opacity--rotation-tweaks)
8. [Editing the Memo](#8-editing-the-memo)
9. [Export ZIP for local download](#9-export-zip-for-local-download)
10. [What gets saved vs discarded](#10-what-gets-saved-vs-discarded)
11. [Keyboard shortcuts](#11-keyboard-shortcuts)

---

## 1. What you can do as a viewer

- Browse section images (HE / IF / MSI) layered per compound
- Switch and compare compounds (Free / Compound mode)
- Toggle existing ROIs on/off
- Add new ROIs and delete existing ones — **only while holding the write lock** (one editor at a time)
- Compare mean intensity across sections × compounds in the ANALYSIS bar chart
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
| Top Bar | View mode toggle (Free / Compound), Export ZIP, Help |
| ROI LIST | Project-wide ROI list. Show toggle, draw new, draw on extra section |
| Sections Grid | Section panels. Click to activate (blue outline); drag to pan; wheel to zoom |
| Method (MRM) | MSI layer table for the active section. Click to switch display |
| ANALYSIS | Bar chart of the selected ROI across sections × compounds |
| Memo | Sample / Machine / Matrix / Google Keep / +α … (temporary edits) |

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

> Whole-file actions like `[all on]` / `[delete file]` live on the **thumbnail dropdown summary** (`▶ <filename>`). Recipients don't see `delete file`.

---

## 7. Range / Opacity / Rotation tweaks

Three groups in each section's toolbar:

| Field | Input | Meaning |
| --- | --- | --- |
| **Range** | min — max | Intensity window of the active MSI layer (display floor / ceiling) |
| **Opacity** | 0–100 % | Layer transparency |
| **Rotation** | -180°–180° | Whole-canvas rotation (combines with pan and zoom) |

The **🔗** icon on each field syncs that value across every section. The **`↻`** button resets translate / rotate / zoom for the panel.

> These tweaks are **temporary** — they revert to the server state on reload, and other viewers don't see them.

> Pan: drag without modifier. Zoom: mouse wheel. Rotation: the input field, optionally synced with 🔗.

---

## 8. Editing the Memo

The **Memo** form on the bottom-right lets you edit Sample / Machine / Google Keep / +α / Matrix / Derivatization.

> Memo edits are **temporary** — they're discarded on reload and never sent to the server.

---

## 9. Export ZIP for local download

The header's **Export ZIP** packages the entire viewable project into a single zip on your machine:

```
<project>_<timestamp>.zip
├─ project.json                      ← project meta + all ROIs
└─ sections/
   └─ <sectionId>/
      ├─ atlas.json                  ← section meta + meta.specimen + transforms
      └─ data/
         ├─ img_HE_Stain__<file>.tif
         ├─ img_IF_Stain__<file>.tif (optional)
         └─ msi_MSI_DA__<file>.xlsx  ← xlsx with appended User-ROI flag columns
```

Each xlsx has a **0/1 flag column** appended for every ROI drawn on that section (the original file's last 2 columns are preserved).

> ZIP is for local use only. **You cannot re-upload or publish** from the viewer side (the buttons aren't shown to viewers).

---

## 10. What gets saved vs discarded

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

## 11. Keyboard shortcuts

| Key | Action |
| --- | --- |
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
