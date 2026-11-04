# Publish protocol v2 / 公開処理の更新

This document describes a required database migration. It does **not** mean that production SQL has been applied. Production application requires the operator's explicit approval and a database/Storage backup.

この文書は必要なDB移行手順です。本番適用済みを意味しません。本番SQLの実行には管理者の明示的な承認とDB・Storageのバックアップが必要です。

## What changes / 変更点

- Each shared project has a monotonically increasing `publish_revision`. Updating it requires the exact revision from which the local copy was obtained. The check, document write, and receipt are one database transaction. Two publishers cannot silently overwrite one another.
- The same request ID and immutable payload return the same receipt after a lost response. Reusing an ID with different content is rejected. The local project records the narrow receipt only; a completed upload cannot replace newer edits or another open project.
- Metadata and original Blob references are captured at the start of a job. Required images, MSI layers, file-level MSI originals, and ROI photographs are checked before upload; missing originals stop the entire publish. Original Blob objects are retained and pinned during the job. An already verified immutable cloud original can be reused without downloading its whole contents.
- New uploads use unique `slug/publish-v2/request-id/object-id` paths and create-only requests. Anonymous/authenticated Storage UPDATE and DELETE are blocked, including with old upload tickets. Existing bytes and URLs remain readable. Shared ROI/overlay new uploads retain their existing session/path restrictions and also use create-only writes.
- An old local copy without a known server revision does not auto-publish. The sync indicator opens a comparison of counts and Memo; these are aids, not proof of identical content. Fetch the shared version as a separate local copy and keep the old one for comparison. Alternatively, publish under a new unused slug. There is no force-overwrite action that adopts the newest revision onto an unknown old copy.
- A partial server import keeps an unknown baseline and cannot auto-publish. A complete import carries the server revision and verified original paths. Publishing under a different slug copies originals into its own namespace.
- Deleting a server project removes its database records, while immutable Storage originals remain. Reference-aware administrator garbage collection is a separate, future operation; the browser does not delete these objects or assume that another saved copy no longer needs them. Retention increases Storage usage.

公開版番号の一致を確認してから、文書全体と完了記録を同一トランザクションで保存します。公開開始後の編集はその公開済み扱いになりません。途中で切り替えた別プロジェクトのタイマー・状態も変更しません。旧ローカル版の公開元が不明な場合は自動公開を停止し、共有版を別コピーで取得して比較できます。元のコピーは削除しません。意図的に別の未使用slugへ公開することもできます。

## Deployment order / 適用順序

1. Back up the database and Storage, record the current deployed application version, and stop active publish jobs. Test the exact SQL/application versions together in a disposable or staging environment. The PostgreSQL CI test must pass using separate real connections, in addition to the PGlite tests.
2. If setting up a new database, apply `supabase/schema.sql`, then `supabase/share_locks.sql` and the other feature migrations required by the deployment. For an existing database, apply any required base updates first.
3. Apply **`supabase/publish_safety_v2.sql` last**. It is transactional and rerunnable. It preserves existing projects and object bytes, initializes their publish revision to 0, invalidates legacy upload tickets, and disables legacy `upsert_project_doc` / `request_publish_session` writers. Revision 0 is a valid server baseline only after fetching that server document; it must not be assigned to an arbitrary old local copy.
4. Deploy the matching application (including `viewer/publish-safety.js` and the local storage upgrade). Reload **all master tabs**. Old tabs fail closed with an upgrade message; there is no fallback to old writer RPCs. New code against an unmigrated server also stops safely. Shared reading may continue while this publish maintenance occurs.
5. With synthetic staging data, verify a new publish, update, two stale local copies, response-lost retry, old-tab rejection, missing-original abort, new shared photo upload, and normal shared reading. Confirm old object bytes remain unchanged. Then verify the approved production release without using private patient data as test fixtures.

旧説明にある「トラブル時は `share_locks.sql` のみ再実行」は、この移行後には行わないでください。古い定義が新APIや認証判定を戻すおそれがあります。ベースSQLを更新した場合も必ず最後にv2移行を適用し、同じ検証を実施します。新フロントを先に出して旧APIへフォールバックさせる運用はありません。

## Rollback / 切り戻し

If a check fails, keep publishing disabled and investigate. Revert the frontend only to a version that understands v2 and the current IndexedDB schema. Do not restore old writer functions or remove restrictive Storage policies to make old tabs work; that reintroduces the overwrite race. Do not drop revision/receipt columns or delete objects uploaded during failed jobs. A database restore is a separate administrator decision and must account for all changes since the backup. Read-only sharing remains the safe fallback while publish is unavailable.

問題時は公開を止めたまま修正し、旧書込みRPC・上書きポリシーを復活させないでください。DBの復元はバックアップ後の変更を確認する別作業です。ローカルDBも新形式へ移行されるため、古いアプリへの単純な巻き戻しは避けます。

## Verification scope / 検証範囲

`tests/publish_safety_db_regression.mjs` exercises migration/replay, revision conflicts, malformed documents, original existence, old writer rejection, and Storage policies in isolated PGlite. `tests/publish_snapshot_regression.cjs` executes the production snapshot generator with delayed/editing/missing-source/retry cases. Existing ROI transport/deletion regressions cover photograph associations and retention. The separate PostgreSQL CI job verifies actual concurrent transaction locking; PGlite alone is not evidence of multi-connection behavior. No automated test applies SQL to production.

A tab crash before an uncommitted job has recorded its retry intent can leave conservative local Blob pins. They are not expired automatically: another live tab may still need them. This is a storage-retention limitation, not evidence that the originals can be safely deleted. Confirmed committed jobs release their pins when a lost response is reconciled.

未確定ジョブが再試行記録を保存する前にタブが終了すると、ローカル原本の保持pinが残る場合があります。別タブの利用を誤って解除しないため自動失効はしません。容量上の制約として保持し、原本を削除して解消しないでください。
