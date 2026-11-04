# ZIP recovery, source files, and provenance

[日本語](ARCHIVE_COMPATIBILITY.md)

Export ZIP captures the registered images, numeric sources, ROI photographs, and metadata at the start of the operation. If any required original, including HE/IF, is unavailable, export lists the affected files and stops. It never downloads a partial archive as a successful backup. Changes to registered data, ROIs, or alignment during export require a retry. Aligned PNGs are derived outputs, separate from the originals.

Import ZIP validates file references, sections, and ROI relationships before storing data. The review shows provenance counts. Recovery creates an independent project; it does not overwrite an existing project. Cancel stops at the next checkpoint. Failed or cancelled recovery cleans up only the temporary files created by that recovery operation.

## Older formats

- Initial v1 archives with `project.json` and per-section `atlas.json` are supported. Identical per-molecule copies share one restored original. Different byte sequences under one historical source ID are preserved as separate source variants.
- When variants are separated, the importer does not guess which source an old ROI or alignment belongs to. Original polygons and metadata remain available, but unverified legacy ROI quantification is withheld.
- Later v1 archives, v2 RAW/Parquet originals, and current original-source archives are supported. A declared file missing from an archive stops recovery in both online and offline modes.

## Provenance categories

| Category | Meaning |
|---|---|
| Registered source | The file supplied by the user in a provenance-aware version is retained. This does not certify that it was never processed outside this application. |
| Legacy archived file | The file contained in an old archive is retained. An old XLSX exporter could append ROI columns, so original registration bytes cannot be certified. |
| Legacy CSV reference values | Only the older exporter's derived CSV is available for this layer. |
| Unverified provenance | Existing records do not establish the file's origin. Saving again does not upgrade this status. |

Some old CSV exports converted missing cells to zero. Recovery does not guess which zeros were missing and does not invent missing rows. A recorded background `drop` setting is preserved, but the number of removed rows is unknown unless the source row count is available. `flag` denotes background flags. Statistics derived from these CSVs are reference statistics for the archived values.

Provenance is retained per layer through ZIP round trips. A new `originalSeries` entry or statistics algorithm marker does not turn a legacy CSV back into its registration original. PPT reports carry a short quality note on the existing MSI detail slide. No Project information page or hidden acquisition conditions are added. Existing CE/CV permissions and choices are unchanged.

If the original file is available separately, register it as a separate source for comparison instead of editing zeros in the old CSV. Automatic TXT/XLSX source rebinding is not provided. Similar values alone cannot establish measurement identity.

## Recovery protection and limits

Operation journals protect originals during import and export. In browsers with Web Locks, startup cleans up abandoned operations while leaving work active in another tab alone. Without Web Locks, uncertain active-operation records are retained conservatively. Originals referenced by an existing project or recovery copy are protected from deletion.

Completeness refers to the references registered when this export starts. Files omitted by a historical exporter, lost missing-cell states, and deleted rows cannot be recovered from an archive that never contained them. Keep the original archive: reopening and exporting in an older application can discard provenance information.
