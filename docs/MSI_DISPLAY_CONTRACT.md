# MSI display, numerical data and migration contract

This contract covers MSI import, rendering, ROI statistics, CSV/ZIP export and the connector. It separates the appearance of an image from the measurement rows used to quantify it. “Original” means the file supplied to this application; it does not undo preprocessing performed before import.

## 1. Data boundaries

| Layer | Responsibility | Must not be used for |
| --- | --- | --- |
| Original source | File bytes, source identity, format and native schema/type | Replacing the original with a rewritten CSV or image |
| Measurement rows | Original row identity/order, X/Y, values and cell states | Display clipping, coordinate snapping or duplicate collapse |
| Display geometry/raster | Source-to-display mapping, duplicate representative values, colour and mask | Quantitative Mean/SD/Max, counts or numeric export |
| Display state | Range, palette, Otsu, interpolation, pan/zoom, rotation, flips, visible sections | Changing measurement membership or analysis scope |
| Derived statistics | Explicit source/ROI membership and versioned calculations | Writing aggregate values back to source rows |

For the same source revision, ROI definition and explicit analysis scope, changing display state must leave quantitative source-row membership, Mean, SD, Max, n and standard numerical export unchanged. Image exports may change with display settings.

Original sources remain authoritative. JavaScript Number arithmetic is IEEE 754 binary floating point; retaining a file's exact decimal text is not a promise of unlimited-precision arithmetic.

## 2. Measurements and statistics

- Preserve duplicate-coordinate rows. If a coordinate is inside an ROI, every valid original measurement row at that coordinate contributes. The display can show their arithmetic mean in a separate raster.
- `n` is the number of valid original measurement rows. `nUniqueCoordinates` counts their distinct valid X/Y coordinates. Neither is the number of biological specimens.
- Mean and Max use original values. SD is descriptive population SD: `sqrt(sum((value - mean)^2) / n)`. No change to a sample-SD estimator is implied.
- Zero and negative measurements remain valid. Blank, missing, null, NaN and invalid tokens are not converted to measured zero. Rows remain in original-data output even when excluded from a numerical aggregate.
- With no valid values, return `n: 0` and `mean`, `sd`, `max` as `null`, not zero.
- Invalid-coordinate rows can contribute to whole-section statistics if their section and numeric value are known; they cannot be placed arbitrarily on an image or assigned to a spatial ROI.
- Keep native FLOAT precision and do not narrow DOUBLE to Float32 for quantification. Unsafe INT64 or unsupported exact DECIMAL arithmetic must be identified explicitly, never silently rounded into a reported result. The original file/schema remains available.
- Method and Preview whole-section Mean/Max are separate from ROI statistics. Parquet file-wide footer extrema and display-raster maxima are not substitutes for a calculated section-specific Max.
- Missing original sources leave quantitative results unavailable. Do not infer intensities from PNG grayscale.

Mandatory duplicate fixture:

| Original coordinate | Original intensity | Display representative |
| --- | ---: | ---: |
| A | 10 | 20 (shared with the next row) |
| A | 30 | 20 |
| B | 100 | 100 |

An ROI containing A and B must give `n=3`, `nUniqueCoordinates=2`, `mean=140/3`, `max=100`, and `sd=sqrt(13400/9)`. A display pixel mean of 60 or a last-write mean of 65 is not a quantitative result for these three rows.

## 3. Display geometry and orientation

Original measurement X/Y, MSI raster coordinates, HE image pixels and screen coordinates are distinct spaces. Original coordinates are not overwritten by raw-coordinate snapping. Irregular coordinates use proportional display geometry, with a bounded display raster where necessary; display allocation must not compress gaps into ordinal coordinate indices. Display aggregation caused by raster resolution does not merge measurement rows.

The image and its ROI overlay use the same forward transform; clicks use its inverse. Whole-view rotation, MSI-only rotation, reflections and fitting must agree across the main canvas, thumbnails, Align and Preview. HE-only rotation belongs to the HE path. Horizontal and vertical flip buttons operate on the current screen axes. Display operations do not re-estimate HE alignment or rewrite landmarks.

The historical default includes a 180° rotation. Internal transform inconsistencies can be fixed without declaring that default to be the source software's correct orientation. A global default change requires a matching asymmetric source image. Preserve an intentionally saved `shareDefaultRotation`; do not apply it twice. Non-square pixel scale bars use the screen direction mapped back into MSI physical coordinates, not an average of X/Y pitch.

New ROIs retain numeric raster-space polygon vertices with a frozen source-anchored frame:

```json
{
  "geometryBySection": {
    "<sectionId>": {
      "version": "msi-source-v1",
      "sourceRef": "<source identity>",
      "displayGeometry": {
        "version": "msi-proportional-v1",
        "x": { "origin": 0, "step": 1 },
        "y": { "origin": 0, "step": 1 },
        "W": 100,
        "H": 80
      }
    }
  }
}
```

The numbers above are illustrative. Vertices are not relabelled as raw X/Y. The frozen origin/step mapping anchors them to their source, even if the currently displayed source/raster changes. Evaluate the original measurement point mapped into this frozen frame. Raster integer coordinates represent measurement sample locations; rendering places them at pixel centers with the corresponding half-pixel offset, and the click inverse removes that offset.

Use the same point-in-polygon predicate in the viewer, connector and CSV membership path. The existing ray-crossing test uses `(yi > y) !== (yj > y)` and a strict `x < intersection`; it has a half-open boundary convention. Boundary fixtures define expected membership rather than assuming every boundary point is included. Legacy polygon numbers remain unchanged.

Shared `poly_msi` JSON stores the vertices and geometry in an envelope. Legacy polygon arrays remain readable. Updated viewer and connector code must be deployed together to consume new envelopes; no SQL schema migration is required for the JSON payload.

## 4. Otsu and display diagnostics

Otsu creates a background visibility mask from source-derived total signal. Its switch, threshold and strength can change the image, including image exports. They must not remove ROI measurement rows, alter Method/Preview statistics or drop/flag rows in standard numerical CSV output. Explicit image-alignment tools may use a silhouette mask to estimate an alignment; merely toggling background visibility does not rerun alignment.

Use the UI wording **背景を非表示（Otsu）**. The histogram is a display adjustment even when hosted inside the ANALYSIS panel. Display settings can be recorded separately in export metadata.

Automatic outlier clipping uses **p99.9**. Saturated-position counts depend on ties, sample size and the current window; do not describe them as exactly the top 0.1%. Ordinary clipping, palette, Range and interpolation do not receive a generic `⚠ 加工` badge. Report actual duplicates, invalid coordinates, unavailable precision or unresolved legacy geometry with specific details.

## 5. Export and restoration

- Preserve and bundle original TXT/CSV, XLSX, raw ZIP and Parquet source bytes in `Source/`, deduplicated by blob. Keep original series definitions so import can restore the original parser/column selection. Verify original-to-bundled byte hashes in export tests.
- CSV follows its reference source's original row order. Keep original coordinates, duplicate rows, missing/invalid rows and source row associations.
- Join columns by verified original-row identity or a complete unique-coordinate bijection. Never join on row count alone or use sorted-index fallback. Export ambiguous sources separately.
- Each derived `Data/<name>.csv` has a `Data/<name>.source-cells.json` sidecar with `version: "msi-source-cells-v1"`, row IDs, coordinates and per-column source-row/cell metadata. Cell metadata records available type, state, token, source type and formula information.
- Exact restoration of source spelling/types/states rests on the ZIP containing original sources and their definitions. A standalone CSV cannot distinguish every null/undefined/blank/invalid representation; a sidecar supplies context but is not a substitute for missing source bytes.
- Add ROI information only as derived data; do not rewrite original XLSX files with added ROI columns. Unknown coordinate membership must not masquerade as ordinary outside-ROI membership.
- `manifest.displaySettings` records Otsu/display choices separately. Standard numerical exports have no Otsu drop/flag option and include hidden sections.
- Parquet remains an original-file ZIP export. Do not eagerly materialize every compound as a giant CSV or keep every column in Float64 memory.

## 6. Displayed-section state

One section-ID selection drives the main grid, Preview, visible statistics columns and automatic Same Range. The floating **表示切片** list supports individual checkboxes, organ group checkboxes with indeterminate state, name search, selected count and “show all.” It works for one organ, includes unclassified sections and keeps at least one section visible. Group actions cover the whole group even during list search.

Selection is tab-local, scoped by project/share context, and is not written into project metadata or automatically published. Preview open/close does not reset it. Rename/reorder retains IDs; new sections appear and deleted IDs are removed. Hidden images leave the grid and are restored from the list.

Pan/zoom/rotation belong to section IDs. Resizing after selection changes preserves the viewed image position; manual Range is retained. Automatic Same updates from displayed sections; Individual remains per-section. Hiding an active image moves only the toolbar's image target. ROI analysis and numerical export retain their independent scope. Defer hiding a section with an unfinished ROI until the drawing is completed/cancelled.

Late asynchronous loads may populate caches but must not resurrect hidden cells, change another compound's window or render into a different project's UI.

## 7. Legacy migration and audit

1. Retain original bytes, legacy polygons, transforms, share angles and HE alignment. Do not destructively normalize them.
2. Reconstruct a legacy ROI's original raster/axis correspondence from its source. Record geometric source-row membership before old Otsu exclusion or duplicate averaging. If several sources are possible, do not silently pick one.
3. New source-anchored geometry and legacy piecewise geometry must produce explicit, repeatable membership. A nonlinear legacy grid cannot be migrated by transforming only polygon vertices with one affine matrix. Preserve unresolved polygons and report quantitative membership as unavailable.
4. A legacy ROI drawn after MSI-only rotation may differ from the author's anatomical intent. Preserve its saved representation; resolving intent requires the matching original image/project.
5. Invalidate legacy `rawMean`/`rawTrueMax`, averaged/last-write ROI grids and obsolete diagnostics. Recalculate from original rows under the current numerical contract. `ent.legacyQuantAudit` retains prior aggregate values and a reason when available.
6. Keep quantitative caches independent of colour, Range, Otsu and section visibility. Source/row-parser, quantitative and required geometry versions distinguish incompatible caches. Reopening or repeating migration must not apply transformations twice.

Audit old versus corrected results separately from display invariance:

| Case | Legacy result that may change | Required explanation |
| --- | --- | --- |
| Duplicate A=10,30; B=100 | Mean 60 or 65, n=2 | Correct result uses all three original rows: Mean 140/3, n=3 |
| Blank converted to zero | Mean/count biased by extra zero | Missing row retained in source; not counted as valid zero |
| Otsu hid a measured location | ROI membership/count depended on display | ROI now includes all valid original rows geometrically inside it |
| DOUBLE narrowed to Float32 | Rounded means/extrema | Recalculate at source precision |
| Legacy compressed or ambiguous grid | Spatial membership may differ or be unavailable | Preserve old representation, identify source mapping, compare row IDs |
| Source unavailable | Old cached number looked current | Mark unavailable; never derive from PNG |

An audit should identify source revision, section, compound, ROI/frame version, old/new values and counts, row-membership comparison, and the reason for each difference. Do not promise unchanged incorrect legacy results.

## 8. Verification and release limits

Run the viewer and management regression suites and connector selftest, with Parquet dependencies installed so those cases are not skipped:

```sh
node tests/viewer_preview_regression.js
node tests/manage_tree_regression.js
cd connector
npm ci --no-audit --no-fund
npm run selftest
```

Regression fixtures must cover the duplicate example; zero/negative/missing/invalid cells; DOUBLE and unsafe integers; irregular coordinates and raw jitter; Otsu/display invariance; ambiguous CSV joins; source-byte/ZIP restoration; ROI forward/inverse mapping across rotations/reflections; source-anchored and unresolved legacy ROIs; non-square pitch; and section-selection/Range/async state. Use strict equality for unchanged row membership and deterministic same-runtime calculations; justify any cross-runtime floating-point tolerance.

Passing synthetic/model tests is not a substitute for visual inspection of a running browser or comparison with the user's original MSI image. Original orientation, anatomical intent of old rotated ROIs and real-project migration remain evidence-dependent checks. Report the actual tests performed and remaining limits with each release; this document itself is not a test-completion report.
