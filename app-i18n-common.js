/* Application-owned UI phrases only. Values and scientific identifiers are not translation keys. */
AppI18n.register('common', {
  '閉じる':'Close', 'キャンセル':'Cancel', '保存':'Save', '削除':'Delete', '編集':'Edit',
  '追加':'Add', '作成':'Create', '開く':'Open', '戻る':'Back', '次へ':'Next', '適用':'Apply',
  '更新':'Update', '再読込':'Reload', '検索':'Search', '確認':'Confirm', '選択':'Select',
  'すべて':'All', 'なし':'None', '名前':'Name', '説明':'Description', '設定':'Settings',
  '読み込み中…':'Loading…', '処理中…':'Processing…', '保存中…':'Saving…',
  '読み込みに失敗しました':'Failed to load.', '保存しました':'Saved.',
  '言語':'Language', '日本語':'Japanese', '英語':'English',
  'オフライン版では外部通信を使用できません。元ファイルをPCから取り込んでください。':'External connections are unavailable in the offline version. Import the original file from this PC.',
  'これは外部サイトへのリンクです。オフライン版では開きません。':'This link points to an external site and cannot be opened in the offline version.'
});
// MRM transition roles are domain terms; the same Japanese word can also mean a UI confirmation.
AppI18n.register('mrm-role', {'定量':'Quantifier', '確認':'Qualifier', '確認用':'Qualifier'}, {scoped:true});
