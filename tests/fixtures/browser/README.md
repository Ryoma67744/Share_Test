# Browser worker fixtures

These small, synthetic fixtures contain no specimen or user data. They are test
inputs, not files to publish with the application.

- `offline-smoke-data.xlsx`: compressed workbook, `Smoke` sheet, x/y/signal columns and four rows.
- `offline-smoke-deflate.tif`: 2 × 2 RGB TIFF using Adobe Deflate, with red, green, blue and white pixels.
- `offline-smoke-snappy.parquet` and `offline-smoke-zstd.parquet`: the same four x/y/signal rows, with their named codecs.
- `offline-smoke-project.zip`: importable project containing a synthetic HE PNG, 8 × 8 MSI CSV and one ROI.
- `offline-smoke.html`: executes the actual parse/Parquet worker factories extracted from the current viewer source. It does not create projects or modify IndexedDB.

Run `node tests/browser-smoke-server.cjs` (or use the bundled runtime/node.exe)
after stopping the ordinary portable server. Open
`http://127.0.0.1:8765/viewer/offline-smoke.html` and wait for its PASS/FAIL summary.
The opt-in CLI stages canonical application files and these fixtures in an OS
temporary directory, uses the unmodified production request handler, and removes
the staged copy when stopped. The normal server has no test routes.

The page also offers the synthetic import ZIP for a separate manual application
workflow test. Importing that ZIP intentionally creates a synthetic project in
the browser's current profile; delete the synthetic project afterward if desired.
