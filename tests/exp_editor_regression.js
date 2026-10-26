'use strict';

// Portable draft regressions exercise the same serializer used by the editor.
// The fixture models the app's flat layout; it is not a vendor qualification.
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
globalThis.crypto ||= webcrypto;

async function main() {
    const { parseExp, createDraft, writeEditedExp } = await import('../mrm/exp-core.mjs');
    const { createDraftArchive, restoreDraftArchive, restoreSavedDocument, serializeEditorDocument, editorStateKey, safeDownloadName, libraryChoices } = await import('../mrm/exp-editor.mjs');
    const text = [
        'Polarity,Negative', 'NoOfChannels,2', 'NumSIRMasses,2', 'FunctionScanTime(sec),0.0400',
        ...[1, 2].flatMap(i => [
            `CompoundName_${i},重複した名前`, `Mass(amu)_${i},89.0000`, `Mass2(amu)_${i},43.0000`,
            `ConeVoltage(V)_${i},20.00`, `CollisionEnergy(eV)_${i},11.00`, `SIRMass${i},89`, `SIRMass_2_${i},43`,
            `Dwell(s)_${i},${i === 1 ? '0.0100' : '0.0200'}`, `CompoundComment_${i},channel ${i}`,
        ]), 'UnknownLine,Keep me', '',
    ].join('\r\n');
    const original = new TextEncoder().encode(text);
    const doc = parseExp(original, { filename: '日本語.exp' });
    const originalCe = doc.rows[1].ce;
    const rows = createDraft(doc); rows[1].ce = '15';
    const archive = await createDraftArchive(doc, rows);
    assert.equal(archive.version, 1);
    assert.match(archive.sha256, /^[0-9a-f]{64}$/);
    const restored = await restoreDraftArchive(JSON.parse(JSON.stringify(archive)));
    assert.equal(restored.document.filename, '日本語.exp');
    assert.equal(restored.rows[1].ce, '15');
    assert.equal(restored.rows[1].details.dwell, '0.0200');
    assert.deepEqual(restored.rows.map(row => row.id), ['channel-1', 'channel-2']);
    assert.deepEqual(restored.selectedIds, ['channel-1', 'channel-2']);
    const output = new TextDecoder().decode(writeEditedExp(restored.document, restored.rows));
    assert.equal(output, text.replace('CollisionEnergy(eV)_2,11.00', 'CollisionEnergy(eV)_2,15'));
    assert.equal(doc.rows[1].ce, originalCe, 'Editing must never mutate the immutable original');

    const untouched = await createDraftArchive(doc, createDraft(doc));
    const roundTrip = await restoreDraftArchive(untouched);
    assert.deepEqual(writeEditedExp(roundTrip.document, roundTrip.rows), original);

    const brokenHash = structuredClone(archive); brokenHash.sha256 = '0'.repeat(64);
    await assert.rejects(() => restoreDraftArchive(brokenHash), /ハッシュ/);
    const saved = { id: 'saved-1', revision: 1, source_sha256: archive.sha256, payload: archive.document };
    const serverRoundTrip = await restoreSavedDocument(saved);
    assert.deepEqual(writeEditedExp(serverRoundTrip.document, serverRoundTrip.rows), writeEditedExp(doc, rows));
    assert.deepEqual(serverRoundTrip.selectedIds, ['channel-1', 'channel-2']);
    await assert.rejects(() => restoreSavedDocument({ ...saved, source_sha256: '0'.repeat(64) }), /ハッシュが一致/);
    const damagedSaved = structuredClone(saved);
    damagedSaved.payload.originalBase64 = Buffer.from(text.replace('Dwell(s)_2,0.0200', 'Dwell(s)_2,0.9000')).toString('base64');
    await assert.rejects(() => restoreSavedDocument(damagedSaved), /ハッシュが一致/);
    await assert.rejects(() => restoreSavedDocument({ payload: archive.document }), /ハッシュがありません/);
    const brokenVersion = structuredClone(archive); brokenVersion.version = 2;
    await assert.rejects(() => restoreDraftArchive(brokenVersion), /バージョン/);
    const brokenBase64 = structuredClone(archive); brokenBase64.document.originalBase64 = '<script>';
    await assert.rejects(() => restoreDraftArchive(brokenBase64), /Base64/);
    const brokenRows = structuredClone(archive); brokenRows.document.rows.reverse();
    await assert.rejects(() => restoreDraftArchive(brokenRows), /不正/);
    const injectedText = structuredClone(archive); injectedText.document.rows[0].name = 'a\nNoOfChannels,20';
    await assert.rejects(() => restoreDraftArchive(injectedText), /不正/);
    const nonFinite = structuredClone(archive); nonFinite.document.rows[0].cv = 'Infinity';
    await assert.rejects(() => restoreDraftArchive(nonFinite), /不正/);
    const invalidRows = createDraft(doc); invalidRows[0].precursor = '';
    await assert.rejects(() => createDraftArchive(doc, invalidRows), /修正/);

    // Partial export does not discard unselected rows from a resumable document.
    const partialArchive = await createDraftArchive(doc, rows, ['channel-2']);
    assert.deepEqual(partialArchive.document.selectedIds, ['channel-2']);
    const partialDraft = await restoreDraftArchive(JSON.parse(JSON.stringify(partialArchive)));
    assert.deepEqual(partialDraft.selectedIds, ['channel-2']);
    assert.equal(partialDraft.rows.length, 2);
    assert.equal(partialDraft.rows[1].ce, '15');
    const partialPayload = serializeEditorDocument(doc, rows, ['channel-2']);
    const partialSaved = await restoreSavedDocument({ ...saved, payload: partialPayload });
    assert.deepEqual(partialSaved.selectedIds, ['channel-2']);
    assert.equal(partialSaved.rows.length, 2);
    assert.deepEqual((await restoreDraftArchive(await createDraftArchive(doc, rows, []))).selectedIds, [], 'An explicit empty selection stays empty');
    assert.deepEqual((await restoreSavedDocument({ ...saved, payload: serializeEditorDocument(doc, rows, []) })).selectedIds, []);
    const legacyArchive = structuredClone(archive); delete legacyArchive.document.selectedIds;
    assert.deepEqual((await restoreDraftArchive(legacyArchive)).selectedIds, ['channel-1', 'channel-2'], 'Legacy drafts default to all rows');
    assert.deepEqual((await restoreSavedDocument({ ...saved, payload: legacyArchive.document })).selectedIds, ['channel-1', 'channel-2'], 'Legacy methods default to all rows');
    assert.deepEqual(serializeEditorDocument(doc, rows, ['channel-2', 'channel-1']).selectedIds, ['channel-1', 'channel-2'], 'Selection keeps original channel order');
    for (const badSelection of [null, 'channel-1', [1], ['channel-3'], ['channel-1', 'channel-1']]) {
        const badArchive = structuredClone(archive); badArchive.document.selectedIds = badSelection;
        await assert.rejects(() => restoreDraftArchive(badArchive), /選択状態が不正/);
        await assert.rejects(() => restoreSavedDocument({ ...saved, payload: badArchive.document }), /選択状態が不正/);
        assert.throws(() => serializeEditorDocument(doc, rows, badSelection), /選択状態が不正/);
    }
    const allSelectedKey = editorStateKey(rows, ['channel-1', 'channel-2']);
    const partialSelectedKey = editorStateKey(rows, ['channel-2']);
    assert.notEqual(allSelectedKey, partialSelectedKey, 'Changing checkbox state is an unsaved change');
    assert.notEqual(partialSelectedKey, editorStateKey(rows, []));
    assert.equal(allSelectedKey, editorStateKey(rows, ['channel-2', 'channel-1']), 'Selection click order does not make a change');
    const unselectedEdit = structuredClone(rows); unselectedEdit[0].name = 'unchecked edit';
    assert.notEqual(partialSelectedKey, editorStateKey(unselectedEdit, ['channel-2']), 'Unselected row changes remain in the dirty fingerprint');

    assert.equal(safeDownloadName('../bad\nname.exp', '_edited.exp'), '.._bad_name_edited.exp');
    assert.equal(safeDownloadName('名前.EXP', '.mrm-draft.json'), '名前.mrm-draft.json');
    const choices = libraryChoices([{ id: 'c', name: '<img src=x>', polarity: '-', transitions: [
        { id: 'a', precursor: 89, product: 43, ce: 11, cv: 20 },
        { id: 'b', precursor: 89, product: 43, ce: 15, cv: 20 },
    ] }]);
    assert.equal(choices.length, 2, 'Duplicate mass pairs retain their distinct condition choices');
    assert.equal(choices[0].name, '<img src=x>', 'Names remain text, not HTML markup');
    assert.equal(choices[1].ce, 15);
    console.log('exp editor regression: passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
