# Section ordering publication fix / 切片の順番に関する公開エラー修正

## Problem / 原因

`Publish to share` can fail with:

```text
duplicate key value violates unique constraint "sections_project_id_ordinal_key"
```

Normal section creation and parquet registration used `sections.length + 1` as the next ordinal. Deleting a middle section leaves a gap, so adding to `[1, 3]` created `[1, 3, 3]`. The publisher sent the duplicate values to the database. A screenshot of the error establishes the uniqueness violation; it does not establish a particular user's preceding edit sequence.

There is also a server-side collision during a valid reorder: with stored `A:1, B:2`, updating `B` to `1` before moving `A` violates the immediate unique constraint. Client-only renumbering cannot reliably repair already published projects.

途中の切片を削除した後に追加すると、内部番号が重複する場合がありました。既存切片の番号を一件ずつ変更するサーバー処理にも、一時的な番号衝突がありました。

## Resulting behavior / 修正内容

- Both section-registration paths allocate an unused ordinal without changing existing names, IDs, or source data.
- Each new publication snapshot assigns `1..N` in the displayed section-array order. Legacy duplicate, missing, and invalid ordinal values no longer control publication order. The live local project is not rewritten by snapshot creation.
- The database independently uses that array order, so an old failed pending request can be retried **with its original request ID and unchanged payload**. Receipt hashes and revision checks retain their existing meaning.
- Retained server sections first move to distinct unused negative ordinal slots inside the same transaction, then receive their final positive positions. Their UUIDs, collaborator ROIs, shared alignments, and source paths remain associated with the same section. Only sections absent from the incoming document are deleted, as before.
- Existing negative ordinals and integer bounds are handled explicitly. Ambiguous stored client IDs are rejected atomically rather than leaving a section at a temporary position.
- The unique constraint, authentication, revision locks, Storage policies, and spatial-group protection remain in place. A failed transaction restores the preceding state.

The ordering number is internal metadata, not a new specimen label. A section named `Section 3` keeps that name even if its final published ordinal is `2` after a preceding section was removed.

## Existing server / 既存サーバーへの適用

Use **[`supabase/section_ordinal_hotfix.sql`](../supabase/section_ordinal_hotfix.sql)** for an existing publish-v2 deployment. Do not reapply `publish_safety_v2.sql` or `share_locks.sql` over a deployed spatial-group wrapper.

The hotfix replaces only the verified internal writer implementation. It detects the renamed `_publish_doc_write_before_spatial_v1` writer and preserves the guarded `_publish_doc_write_v2` wrapper. Exact function fingerprints allow known LF or CRLF source text and reject other customizations. Existing ownership, execution grants, and security attributes are retained. Applying the hotfix does not rewrite project, section, ROI, credential, receipt, or Storage records.

As required by [PUBLISH_SAFETY_V2.md](./PUBLISH_SAFETY_V2.md), production SQL application needs explicit operator approval and a verified database/Storage backup. Preparing this change and passing local tests do not mean it has been applied to production.

1. Review the PR and verify the current backup and maintenance window. Allow active publish jobs to finish.
2. Apply `section_ordinal_hotfix.sql` to the matching Supabase project as the database owner. It is transactional and rerunnable, with bounded lock and statement timeouts. If an unexpected-definition error occurs, inspect the installed functions; do not remove the fingerprint checks.
3. Confirm the final query reports both `ready = true` and `spatial_guard_preserved = true`.
4. Deploy the matching frontend changes and reload the master tabs after local saves have completed.
5. Open the existing local project and retry `Publish to share` using its intended URL. A pending request keeps its original document and uploaded source paths; the repaired server handles its old ordinal fields. Normal revision conflicts still require the existing compare/confirm workflow.
6. Check the published section order and the retained ROI/source associations. Do not clear the browser's project storage to work around this error.

For a new installation, the corrected base writer is already in `publish_safety_v2.sql`; apply `spatial_groups_v1.sql` afterward as documented. Reapplying the dedicated hotfix to this corrected writer is a verified no-op.

## Verification / 検証

All fixtures are synthetic and local. These tests do not operate on production data:

```bash
node tests/section_ordinal_regression.cjs
node tests/section_ordinal_db_regression.mjs
node tests/publish_snapshot_regression.cjs
node tests/publish_status_regression.cjs
node tests/publish_safety_db_regression.mjs
node tests/spatial_groups_db_regression.mjs
```

The client regression executes the actual normal/parquet registration and deletion methods, checks immutable snapshots, preserves references and live edits, and replays old pending requests without changing them. The SQL regression reproduces the original failure and checks fresh installation, legacy upgrades, spatial-wrapped upgrades, LF/CRLF source and script text, reorder/insert/delete, UUID/ROI/alignment retention, rollback, revision conflicts, receipt reuse, function privileges, and repeated application.

The repository's full non-browser inventory includes both new suites automatically via `tools/test.cjs`. Existing browser and multi-connection PostgreSQL workflows remain the CI gates for real-browser behavior and concurrent database sessions.
