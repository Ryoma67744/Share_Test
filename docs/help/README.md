# Guided Help maintenance

`manifest.json` is the shared Japanese / English source for all 13 chapters.
Each chapter contains numbered steps, numerical effects, persistence, feature
coverage and screenshots. Shared viewer / administrator audiences omit author
management, import and MRM chapters. Shared ratio edits are personal overrides.
Offline mode retains all local functionality and explicitly excludes publication.

The current app uses mixed Japanese / English labels. Both Help languages use
the same actual UI screenshots; captions and alternative text are translated.
Do not translate a screenshot by drawing fake controls over it. When the app UI
itself gains a locale switch, add separate locale captures in the manifest.

Run from the repository root after installing `tests` development dependencies:

```
node tools/help-capture.cjs
node tools/help-docs.cjs
node tools/help-pdf.cjs
node tests/help_regression.cjs
node tests/help_browser_regression.cjs
node tests/distribution_regression.cjs
```

The existing `help-capture.cjs` workflow uses a fresh Playwright browser context and a loopback server. External
requests and non-GET requests are blocked. Inputs are the existing synthetic
offline ZIP (extended deterministically with two numeric source columns), the
synthetic exp fixture and local MRM sample data. No account or real project is
used. `capture-manifest.json` records viewport, browser version, source version,
fixture hashes, screenshot hashes, application source hashes and capture scenarios. The source hashes identify the captured working tree even before it has a commit. `--ratio-only` refreshes
the ratio screen after changes without recapturing the other scenarios.

Capture actual working controls and wait for images, computation and transient
toasts to finish. Review the resulting PNGs. Never substitute a design mock for
a product screenshot. Update the manifest, recapture affected screens and run
the guide generator when controls, permissions or calculations change.

`tools/help-docs.cjs` appends a generated supplement to the six existing guides
and OFFLINE_GUIDE, retaining their detailed legacy instructions. `tools/docs.cjs`
builds a standalone HOW_TO_USE with Japanese / English content and embedded
images. The normal build copies sources unchanged and requires neither a
browser nor Python. The checked-in USER_GUIDE.pdf is regenerated from the common viewer content with `tools/help-pdf.cjs`; inspect its rendered pages after regeneration. The interactive guide also prints all chapters for the
selected language and audience through its Print / PDF button.

Image paths are repository-relative `docs/help/images/*.png`. The reader resolves
them relative to `help.js`, so root, viewer, GitHub Pages subpaths and offline
server all use the same assets. Build and offline routing allow only manifest
JSON and PNGs in the public Help directory, not authoring files or arbitrary
paths. Tests verify asset provenance, dead links, translations, audience scope,
source hashes, path safety, focus restoration and unchanged application hashes.

`--kmd-only` refreshes the actual non-target/KMD workspace using a synthetic 12-mass, two-CH2-series extension of the same fixture. KMD is covered in the Compare chapter; Otsu and TIC controls are covered in Compare and Display. Offline launch is documented by the three explicit startup steps in HOW_TO_USE, not by a simulated launcher screenshot. The Projects screenshot shows the management page after startup.

## Measured brain example

The `brain-*` images are a separate, approved measured-data example. Their
provenance is recorded in `brain-example-provenance.json`; they are deliberately
not added to the synthetic `capture-manifest.json`. The scientific figures are
numerical re-renderings. Only `brain-viewer` and `brain-ratio-settings` are actual
application screenshots. Both Help languages use these same figures, with
translated surrounding text rather than text baked into the image.

The original RAW ZIP and project metadata are **not included** in this repository
or in web/offline distributions. Reproduction requires the approved local inputs
and installed `connector` dependencies as well as the `tests` dependencies:

```
node tools/help-brain-example.mjs --source /local/original.raw.zip --metadata /local/project.json
```

The tool verifies the original RAW SHA256, section, function, channels and
known measurement counts before producing the figures. It reads those inputs
without changing them. `--out /local/review-directory` keeps all generated PNGs
and the provenance JSON outside the repository; `--render-only` skips browser
capture and produces only the scientific figures. Run the full command for a
complete checked-in asset set. The normal build does not require the originals,
Node canvas or a browser, and never downloads experimental data.

The numerical pipeline uses the existing RAW parser, proportional grid, saved
orientation, ratio core, HotMetal LUT, smoothing and report renderer. The common
MSI range is 0 to each molecule's finite-source p99.5; the Range comparison also
shows the original maximum. Linear 10 and Median 3 share exactly the same range,
palette and detail rectangle. Median 3 is the 7×7 display-index median, evaluated
on the full original grid before selecting the displayed detail. Native browser
Linear interpolation may differ slightly from the deterministic report sampler.
No smoothing or display clipping changes source values or measured masks.

The ratio example divides Malate-1 by Glutamate on the same original scan rows.
The two illustrative denominator thresholds are 0 and 10,000, with the same
display range 0–1.5. The latter threshold is not a detection limit or a recommended
analysis cutoff. Gray marks excluded ratios; it is distinct from a valid zero.
ROI A/B are temporary 30×25-grid rectangles for explaining source-row statistics,
not anatomical regions and not ROIs saved to the shared project. The provenance
records their exact bounds, source statistics and ratio statistics.

Screenshot capture imports a sanitized two-molecule local clone into a fresh
offline browser context, verifies its actual numerical raster and calculated
ratio counts, and blocks external requests and non-GET/HEAD requests. It does not
publish or modify a shared project. The provenance stores only the approved
source hash, source slug/section, calculation settings, numerical statistics,
illustrative ROI definitions, asset hashes and application-source hashes. It
does not copy free-form project metadata, account information or local paths.

After updating these assets, review all figures and both screenshots, regenerate
the guides/PDF, and run the Help and distribution checks listed above. Keep the
figure scale limits and caption values synchronized with the provenance; do not
describe the scientific figures as screenshots.
