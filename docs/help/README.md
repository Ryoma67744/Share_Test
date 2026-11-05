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

Capture uses a fresh Playwright browser context and a loopback server. External
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
