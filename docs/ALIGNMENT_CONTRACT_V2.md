# HE/IF–MSI alignment contract v2

## 目的と変更範囲

新しい位置合わせは、HE/IFの原画像座標からMSIの旧ラスタ画素境界座標への行列 `T_he_to_msi` を正として保存します。対応点から合わせたHE/IFをMSIと同じ表示変換で描画し、レイヤーごとの回転差による再ずれを防ぎます。既存の位置合わせは、開くだけ・変更しない保存では新形式に変換しません。

[`supabase/alignment_contract_v2.sql`](../supabase/alignment_contract_v2.sql) は、この新形式を旧アプリが誤って上書きしないための追加SQLです。`sections.meta` と `share_alignments.payload` のJSONB列を使用します。テーブルの列変更、既存行の一括変換、原画像・MSIデータ・ROI・資格情報の書き換えは行いません。

SQLは既存の公開writerと共有位置合わせwriterを内部名へ移し、既存の関数本体を保持したまま互換性チェックを外側に追加します。spatial wrapper、切片番号修正済みのbase writer、共有保存の認証・版照合はそのまま呼び出します。公開要求の認証、セッション、版数、ハッシュ、receiptを処理する `publish_project_doc_v2` の本体は変更しません。

## 保存レコード

新形式の各レコードは次を持ちます。`byFrame`、`bySource`、`byGroup`、`sharedByCoordinate` と、レイヤー直下に保存する互換用レコードが対象です。

| 項目 | 値・条件 |
| --- | --- |
| `alignmentContractVersion` | JSON数値 `2` |
| `renderContract` | `msi-shared-display-v1` |
| `alignment_raster_basis` | `legacy-msi-pixel-edges-v1`。座標の単位は変更しない |
| `T_he_to_msi` | 有限数の3×3アフィン行列。最終行は `[0,0,1]` |
| 行列式 | 有限で絶対値が `1e-12` 以上。既存のフロント側検証と同じ条件 |
| `frame.version` | `msi-alignment-frame-v2` |
| `frame.key` | 既存の測定・座標配置を識別する空でないキー。表示方式だけを理由に変更しない |

反転、平行移動、回転、均一倍率に加え、異方的倍率やせん断を持つ有効なアフィン行列も保存できます。SQLは行列をスライダーの値から作り直しません。グループID・グループ座標系の検証は既存のspatial保護が引き続き担当します。

新しい契約フィールドがない従来のレコードは従来の解釈を維持します。新形式と宣言したレコードで、フィールドの欠落、未知の版、異なるbasis、不正な行列がある場合は保存を拒否します。

## 適用順序

1. 対象環境の通常の変更承認・バックアップ手順を実施し、テスト環境で先に検証します。このPRにSQLを含めることと、本番DBへ適用することは別です。
2. 既存環境では `publish_safety_v2.sql` と共有位置合わせ機能が導入済みであることを確認します。競合エラーが旧 `40001` の場合は、専用の [`conflict_error_hotfix.sql`](../supabase/conflict_error_hotfix.sql) とその手順を先に確認します。
3. 切片番号の修正が未適用の場合は、先に [`section_ordinal_hotfix.sql`](../supabase/section_ordinal_hotfix.sql) を適用します。spatial導入済み環境でも、その専用hotfixを使用します。既存環境へ `share_locks.sql` や `publish_safety_v2.sql` 一式を再適用しません。
4. `alignment_contract_v2.sql` を一つのトランザクションとして適用します。新規環境ではベースSQL、公開v2、必要なspatial SQLの後に実施します。
5. 次の読み取りで機能を確認します。

   ```sql
   select public.alignment_contract_capabilities_v2();
   ```

   期待値は `{"version":2,"renderContract":"msi-shared-display-v1","protectDowngrade":true}` です。
6. 対応する新アプリを配布し、既に開いているタブを更新します。オフライン配布物も同じリリースのものを使用します。

スクリプトは再実行可能です。導入時には既知の関数本体を確認し、想定と異なるカスタマイズや未修正writerを検出すると全体を中止します。CRLF/LFの違いだけは同一と扱います。停止した場合はエラーと関数定義を確認し、fingerprintを削除して強行したり、古いスキーマ全体を再投入したりしないでください。

本SQLより後に古い `share_locks.sql`、`publish_safety_v2.sql`、`spatial_groups_v1.sql` を再適用しないでください。切片番号hotfixも、この追加wrapperを導入する前に完了させます。将来のwriter変更は、このwrapper構成を認識した専用の差分として行います。

## 要求時の互換性マーカー

- 公開時: `_meta.alignmentWriteProtocol = 2`
- 共有位置合わせの保存時: `p_payload.alignmentWriteProtocol = 2`

新形式を含む要求、新形式が既に保存されているsectionの更新、保護された共有位置合わせを消し得る再公開にはマーカーが必要です。新しいフロントエンドは送信時に付加します。マーカーは保存前に除去されるため、旧アプリが読み取ったデータを再送するだけでは新形式対応を名乗れません。

sectionのトリガーは `meta.alignment` の内容を変更しない無関係のmetadata更新を許可します。位置合わせの正となるレコードや行列の変更・削除にはprotocolが必要です。公開writer全体には別途の要求チェックがあり、旧publisherが新形式を含むsectionを消す操作をこの例外で通すことはできません。既存のROI更新・共通座標へのROI変換も引き続き使用できます。

マーカーは認証情報ではありません。既存のmasterパスワード・共有トークン・プロジェクト所属・版数検査が引き続き必要です。内部writerと検証関数はクライアントから直接実行できません。元の公開endpointのowner/ACLは保持します。トリガーで使うトランザクション内の設定も処理後に復元し、次の要求へ持ち越しません。

### 公開待ちジョブとreceipt

既存の `publish_project_doc_v2` は送信された `_meta` 全体をハッシュに含めます。同じ要求IDでマーカーを変更して再送した場合、既にreceiptがあれば従来どおり `publish_request_reused_with_different_document` で拒否します。この検査を緩めたり、過去のreceiptを書き換えたりしません。

フロントエンドの `PublishSafety.run` は、公開待ちジョブの再開時に保存済みreceiptを先に確認します。既にcommit済みならそのreceiptを採用し、未commitのときだけ送信します。未commitの旧ジョブには送信段階でマーカーを付けられます。準備済みドキュメントのsnapshotを編集する必要はありません。最新の保存内容を旧データで上書きしようとした場合は、従来の版数検査または新しい契約保護で停止します。

## 拒否と明示的削除

旧クライアントによる更新には `alignment_upgrade_required` を返します。保持する同じレコードpathで新形式の印を落とす更新は、マーカーが `2` でも `alignment_contract_downgrade` として拒否します。新形式の内容が不正なら `invalid_alignment_contract` です。いずれも要求全体をロールバックし、部分的な保存や版数更新を残しません。

新アプリからの明示的なレコード削除やscope変更は可能です。例えば、共通グループへ再適用して個別overrideのpathを除去できます。既存の `delete_share_alignment` による「masterの位置合わせへ戻す」操作や、新アプリからのsection削除も引き続き使えます。既存のspatial規則で禁止されていたグループの暗黙的消去は、今回のSQLによって許可されません。

## 旧版・ZIP・オフライン版

新アプリは旧データを読み、旧レコードを勝手に新しい表示方式へ変換しません。新形式を旧アプリが正しく表示する保証はありません。今回の直前版のmanaged resolverは未知の `frame.version` を拒否し、未確認のHE/IFを重ねません。新形式を表示・編集するにはアプリを更新してください。単に `renderContract` フィールドを追加しただけで全ての過去版が安全になる、という互換性は主張しません。

ZIPには行列と契約情報をそのまま保存します。新形式を含むZIPは、機能名を無視する旧importerが誤って読み進めないよう、対応するarchive formatで書き出します。新しいimporterは旧形式も読みます。不明な将来版の契約は、identityや均一倍率に置き換えません。

MSI座標で書き出すaligned PNGは、従来どおり `T_he_to_msi` のみを適用します。画面の回転や反転を焼き込まず、MSIラスタとCSV座標との対応を維持します。画面のcomposite出力は、表示側の契約に従います。

## 検証

```sh
npm ci --prefix tests
node tests/alignment_contract_db_regression.mjs
```

このテストは一時的なPGliteデータベースだけを使用します。本番への接続は行いません。新旧payload、反転・一般アフィン、共有・公開の版競合、receipt再実行、未commitの旧ジョブ、原関数/ACL/データの保持、SQL再適用、CRLF、spatial保護、切片UUID・順序、明示的削除、未修正writer・未知のカスタマイズに対する停止を確認します。

アプリだけを旧版へ戻すと、新形式を編集できなくなります。新形式の保存後に互換性guardを取り除いて旧アプリに書かせる切り戻しは行わず、対応版への更新または個別に検証した変換を選んでください。
