# ローカル保存 DB v6 / Local storage DB v6

## 更新手順

1. 旧版を開いているタブで保存を終え、重要なデータを原本付き Export ZIP として保管します。IndexedDB 内のコピーだけをバックアップにしないでください。
2. 旧版の管理・ビューアタブを閉じてから、新版を開きます。別タブが残ると更新が待機します。再読込で未保存編集を失わないよう、先に保存してください。
3. DB `desi-projects` を v6 に追加的に更新します。既存の project/blob 内容は書き換えません。旧 project の revision 欠損は読込時だけ `0` と扱い、最初の保存で原子的に版を進めます。
4. 全クライアントを更新してください。旧 v4/v5 固定クライアントは更新後の DB を開けません。古い無条件上書きや、下書き設定を無視した保存を防ぐための動作です。ブラウザーのデータを消さず、新版へ再読込してください。

v5 は `project_recovery`、`blob_pins`、`archive_jobs` を追加します。保存は project と一覧索引を同じ transaction で確定し、保存元の `storageRevision` が一致しないと永続下書きに退避します。削除済み ID を古い編集から復活させません。新規作成・ZIP/サーバ取込は create-only で、ID 衝突時は新しい ID を発行します。

v6 はブラウザー単位の `preferences` を追加します。回復用下書きの自動作成は初期 ON で、管理画面・master ビューアの **回復用下書き (件数)・設定** から変更できます。各保存 transaction が最新の設定を読むため、別タブにも適用されます。OFF では新しい競合下書きと編集セッションの project コピーを作りませんが、CAS による競合拒否と編集中の原本 pin は維持します。既存の下書きは設定変更で削除しません。設定は project や共有・ZIP のデータには含めません。

終了した編集セッションは Web Lock を取得した状態で確認します。正常保存後の revision が一致し、保持原本も全て保存済み project が参照している場合は重複した回復候補を除去します。OFF で作られたコピーなしのセッションは、他の project・下書き・job 等が参照していない原本だけを解放します。古いセッション、未保存の追加原本、生存状態が不明なセッションはこの重複整理の対象にしません。

回復した下書きは新 ID と共有先を持たないコピーになります。編集中の原本は project の読込と同じ transaction で pin し、同じタブで追加した原本も保存前から保持します。正常な切替・終了では保持を解放します。終了処理が完了したか不明な場合は保持が残り、Web Locks によって他の生存タブが使っていないことを確認した上で、管理画面から復元・明示破棄できます。期限だけで消しません。Web Locks が利用できない環境では閉じたタブの自動判定・解放を行わず、安全側で保持します。

原本の blob ID は不変です。ファイル差替えは新 ID を使い、同 ID の bytes 上書きを拒否します。ファイル名だけの変更は専用 API で更新します。全削除/GC は project、下書き、tab/job pin、archive staging の参照を確認します。参照がある間は、削除操作後もディスク使用量がすぐ減らないことがあります。

## ロールバック

DB を旧版に戻したり削除したりしないでください。アプリを戻す場合も v6 の共有保存モジュール、下書き設定と CAS 境界を保持したビルドが必要です。旧版コードをそのまま再配布するとローカル DB を開けなくなります。サーバ側 publish CAS / legacy writer 遮断は別の SQL 移行であり、このローカル DB 更新だけでは代替できません。v6 の下書き設定に追加のサーバ SQL は不要です。

## English operational notes

Finish saving in old tabs, export important projects with originals, close the old tabs, and then load the new build. The additive v6 upgrade keeps existing project and original records intact. Legacy projects receive a read-only revision-zero token; their first successful save advances the revision atomically. Do not erase browser data when an old fixed-v4/v5 page reports a version error: update/reload the page.

Project saves and summaries commit together using an expected revision. Conflicting edits become durable recovery drafts when automatic recovery is enabled (the default). DB v6 adds a browser-wide preference, read within each save transaction. When disabled, conflicts still fail without overwriting the saved project, but no new recovery snapshot is made. Existing drafts remain available. This preference is not exported or published. Deleted projects cannot be resurrected by stale saves. Creation and import are create-only; an ID collision allocates a fresh local ID. Recovery produces an independent, unlinked copy.

Editing-tab pins are created atomically with project reads and retain newly added originals before their project save. Normal switching/closing releases retention; uncertain or abnormal termination leaves a durable snapshot. Web Locks prevent recovery/discard of live sessions. Closed sessions can be restored or explicitly discarded in the manager. There is no expiry-based deletion; without Web Locks, uncertain sessions remain retained. Every original deletion checks projects, recovery drafts, session/job pins and archive staging references.

DB v6 omits redundant ended-session snapshots only when a successful-save marker, the current revision and all retained originals agree. Snapshot-free sessions created with recovery disabled retain originals while active; cleanup holds their Web Lock and rechecks every reference. Legacy/unknown sessions and unsaved extra originals remain protected.

Blob IDs identify immutable original bytes; replacements require a new ID. Filename-only changes use a metadata patch. Disk usage may remain until dependent tabs/jobs or recovery drafts release their references. For rollback, keep DB v6, recovery preferences and the CAS write boundary: never downgrade or delete the database. Server publish CAS and disabling legacy writers require their own SQL migration; recovery preferences require no additional server SQL.
