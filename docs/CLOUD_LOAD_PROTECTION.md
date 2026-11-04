# Cloud load protection / 共有読み込み中の原本保持

共有画面とサーバからの取り込みでは、ダウンロードしたBlobを「読み込み中の保持記録」と同じIndexedDBトランザクションで保存します。別タブで共有画面を開いたり、キャッシュ整理を行ったりしても、使用中・取り込み途中の原本は削除されません。MSI、HE/IF、取り込み時のROI写真に同じ保護を適用します。共有画面で後から取得する画像や欠損Blobの復旧も、その画面の保持記録へ追加します。

- サーバ取り込みが完了すると、新しいローカルプロジェクトの保存と保持記録の解除を同一トランザクションで行います。既存のローカル版は置換しません。保存に失敗した場合は、今回の取り込みだけが所有し、他のプロジェクト・下書き・ジョブ・タブが使用していないBlobだけを回収します。
- 共有画面の保持はタブの実行環境が生きている間続きます。`pagehide`だけでは解除しません。戻る／進むキャッシュから同じ画面が再開する可能性があるためです。
- 再読み込み、終了、クラッシュでWeb Lockが解放された読み込みだけを、次の共有読み込みなどで回収します。確認用のWeb Lockを保持したままIndexedDBの削除を行うため、生存確認と回収の間に別の所有者を削除することはありません。
- Web Locksを利用できない環境、旧バージョンが保存した未所有Blob、所有状態が不明な保持記録には期限による自動削除を行いません。容量が残る場合があります。単にプロジェクトから参照されていないことを理由に一括削除しません。
- 元の読み込みが終了した時点で別の読み込み・出力ジョブが同じBlobを保持していた場合、そのBlobを残します。最後の借用が終わっても元の所有記録が既にない場合は、自動回収しません。表示処理のエラーで読み込み後の画面切替が完了しなかった場合も、タブ終了が確認できるまでは保持します。
- 読み込みの保持と通常の編集中プロジェクトの保持は別です。既存プロジェクトを開いたまま別の共有版を取り込んでも、そのダウンロードが既存プロジェクトの原本として登録されることはありません。

この変更は既存のIndexedDB v5の`blob_pins`を利用します。サーバSQL、公開Storageの原本、認証、数値解析、公開revision、ローカルCASの仕様は変更しません。

Cloud imports and shared views save each downloaded Blob and its load lease atomically. Imports transfer ownership to a new persisted project in the same transaction that removes the lease. Aborting a load can reclaim only its own unreferenced bytes; other projects, editing snapshots, recovery drafts, archive jobs, and live load leases remain authoritative references.

Each load holds a distinct Web Lock for its lifetime. Reclamation obtains that same lock with `ifAvailable` and holds it through the cleanup transaction. The code never releases a load lock merely because `pagehide` fires, so a suspended page is not treated as dead. A real reload or renderer exit releases the lock. Without Web Locks, or for legacy bytes with unknown ownership, automatic cleanup retains the data rather than guessing from elapsed time.

The lifecycle follows [Web Locks termination](https://www.w3.org/TR/web-locks/#termination-of-locks). Held locks may make a page ineligible for BFCache; closing/reloading and restoring a suspended page are therefore checked separately.

Verification is isolated from user data: `blob_load_lease_regression.cjs` checks transaction rollback, ownership, CAS coexistence, commit/abort, legacy retention, and unsupported-lock behavior. `blob_load_lease_browser_regression.cjs` uses real Chromium tabs, IndexedDB, Web Locks, production cloud import/load functions, a suspended import, another shared load, real write/commit transaction aborts, back/forward navigation, reload, and a renderer crash. The browser test reports whether back/forward actually restored BFCache or reloaded; the current Chromium run used reload fallback. A separate persisted-pagehide check verifies that the application itself does not release the lease. Existing project-store browser regressions also exercise conflict recovery and original retention.
