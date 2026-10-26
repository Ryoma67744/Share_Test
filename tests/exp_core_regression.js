'use strict';
// Pure byte-level regression tests. Fixture is synthetic; these checks do not
// substitute for opening representative files in the target MassLynx version.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async function () {
  const core = await import('../mrm/exp-core.mjs');
  const { parseExp, createDraft, validateEdits, writeEditedExp, verifyExport, serializeDocument, restoreDocument, ExpError, validateSelectedExport, writeSelectedExp } = core;
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/exp/flat-mrm-synthetic.exp'), 'utf8');
  const selectionFixture = fs.readFileSync(path.join(__dirname, 'fixtures/exp/flat-mrm-selection-synthetic.exp'), 'utf8');
  const { buildExp } = await import('../connector/src/exp.js');
  const builtWithHeader = buildExp('GENERAL INFORMATION\r\n' + selectionFixture.replaceAll('\n', '\r\n'), [
    { name: 'Lactate-NEG', precursor: 89, product: 43, cv: 20, ce: 11 },
    { name: 'NEG_13C-Lactate-NEG', precursor: 92, product: 46, cv: 20, ce: 11 },
  ]);
  const utf8 = text => new TextEncoder().encode(text);
  const decode = bytes => new TextDecoder().decode(bytes);
  const bytesEqual = (actual, expected) => assert.deepEqual(Buffer.from(actual), Buffer.from(expected));
  const read = (text = fixture, options = {}) => parseExp(utf8(text), options);
  const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ExpError && error.code === code);
  let checks = 0;
  function test(name, run) { run(); checks++; console.log('ok ' + name); }

  test('parse exposes immutable values and independent original bytes', () => {
    const source = utf8(fixture), doc = parseExp(source, { filename: 'past.exp' });
    assert.equal(doc.filename, 'past.exp');
    assert.equal(doc.polarity, 'negative');
    assert.equal(doc.rows[0].precursor, '89.0000');
    assert.equal(doc.rows[1].details.dwell, '0.0200');
    assert.equal(doc.rows[1].details.delay, '0.0042');
    assert.equal(doc.rows[0].details.formula, 'C3H6O3');
    assert.equal(doc.rows[0].details.comment, 'keep this, including its comma');
    assert.equal(doc.capabilities.structural, false);
    assert.ok(Object.isFrozen(doc) && Object.isFrozen(doc.rows) && Object.isFrozen(doc.rows[0].details));
    source.fill(0);
    bytesEqual(writeEditedExp(doc, createDraft(doc)), utf8(fixture));
    throwsCode(() => createDraft({ ...doc }), 'DOCUMENT');
  });

  test('no-op retains LF, CRLF, CR, mixed newlines, blank lines, and absent EOF newline', () => {
    for (const text of [fixture, fixture.replace(/\n/g, '\r\n'), fixture.replace(/\n/g, '\r'), fixture.replace(/\n/g, (_, offset) => offset % 2 ? '\r\n' : '\n'), fixture.trimEnd(), fixture + '\n\n']) {
      const doc = read(text);
      bytesEqual(writeEditedExp(doc, createDraft(doc)), utf8(text));
    }
  });

  test('single CE change is exactly one original value replacement', () => {
    const doc = read(), rows = createDraft(doc);
    rows[1].ce = '15';
    assert.equal(validateEdits(doc, rows).changedCells, 1);
    const output = writeEditedExp(doc, rows);
    bytesEqual(output, utf8(fixture.replace('CollisionEnergy(eV)_2,11.0000', 'CollisionEnergy(eV)_2,15')));
    assert.deepEqual(verifyExport(doc, output, rows), { valid: true, changedCells: 1 });
    assert.equal(parseExp(output).rows[1].details.dwell, '0.0200');
  });

  test('Q1 and Q3 patch both their SIR and MRM copies and nothing else', () => {
    const doc = read(), rows = createDraft(doc);
    rows[0].precursor = '90.25'; rows[0].product = '44.5';
    const expected = fixture.replace('SIRMass1,89.0000', 'SIRMass1,90.25')
      .replace('Mass(amu)_1,89.0000', 'Mass(amu)_1,90.25')
      .replace('SIRMass_2_1,43.0000', 'SIRMass_2_1,44.5')
      .replace('Mass2(amu)_1,43.0000', 'Mass2(amu)_1,44.5');
    bytesEqual(writeEditedExp(doc, rows), utf8(expected));
  });

  test('equivalent numeric formatting and reverting changes preserves original tokens', () => {
    const doc = read(), rows = createDraft(doc);
    rows[0].ce = '11.0'; rows[1].precursor = '9.2e1'; rows[0].cv = '+20';
    assert.equal(validateEdits(doc, rows).changedCells, 0);
    bytesEqual(writeEditedExp(doc, rows), utf8(fixture));
    rows[0].name = 'changed'; rows[0].name = doc.rows[0].name;
    bytesEqual(writeEditedExp(doc, rows), utf8(fixture));
  });

  test('high precision decimal tokens are compared and emitted without Number rounding', () => {
    const source = fixture.replace('CollisionEnergy(eV)_1,11.0000', 'CollisionEnergy(eV)_1,11.000000000000000001');
    const doc = read(source), rows = createDraft(doc);
    assert.equal(rows[0].ce, '11.000000000000000001');
    rows[0].ce = '11.000000000000000002';
    assert.equal(validateEdits(doc, rows).changedCells, 1);
    bytesEqual(writeEditedExp(doc, rows), utf8(source.replace('11.000000000000000001', '11.000000000000000002')));
    rows[0].ce = '11000000000000000001e-18';
    bytesEqual(writeEditedExp(doc, rows), utf8(source));
    const mismatch = fixture.replace('SIRMass1,89.0000', 'SIRMass1,89.000000000000000001');
    throwsCode(() => read(mismatch), 'MASS_MISMATCH');
  });

  test('numeric token surrounding whitespace is retained', () => {
    const source = fixture.replace('CollisionEnergy(eV)_1,11.0000', 'CollisionEnergy(eV)_1,  11.0000 \t');
    const doc = read(source), rows = createDraft(doc); rows[0].ce = ' 15 ';
    bytesEqual(writeEditedExp(doc, rows), utf8(source.replace('  11.0000 \t', '  15 \t')));
  });

  test('Japanese and markup are data; unknown settings remain byte-identical', () => {
    const source = fixture.replace('VendorSetting,retain exactly', 'VendorSetting,保持 ☃ unknown');
    const doc = read(source), rows = createDraft(doc);
    rows[0].name = '乳酸 <img src=x onerror=alert(1)>, 測定';
    const output = writeEditedExp(doc, rows);
    assert.equal(parseExp(output).rows[0].name, rows[0].name);
    bytesEqual(output, utf8(source.replace('CompoundName_1,Lactate-NEG', 'CompoundName_1,' + rows[0].name)));
  });

  test('identical channels remain separate rows in original order', () => {
    const source = fixture.replace('92.0000', '89.0000').replace('46.0000', '43.0000')
      .replace('Mass(amu)_2,92.0000', 'Mass(amu)_2,89.0000').replace('Mass2(amu)_2,46.0000', 'Mass2(amu)_2,43.0000')
      .replace('CompoundName_2,NEG_13C-Lactate-NEG', 'CompoundName_2,Lactate-NEG');
    const doc = read(source), rows = createDraft(doc);
    assert.notEqual(rows[0].id, rows[1].id);
    rows[1].ce = 19;
    bytesEqual(writeEditedExp(doc, rows), utf8(source.replace('CollisionEnergy(eV)_2,11.0000', 'CollisionEnergy(eV)_2,19')));
  });

  test('unsupported row additions, removals, reordering and fake identifiers are rejected', () => {
    const doc = read(), rows = createDraft(doc);
    for (const candidate of [[...rows, { ...rows[0] }], rows.slice(1), rows.slice().reverse(), [{ ...rows[0], id: 'foreign' }, rows[1]], [null, rows[1]], new Array(rows.length), {}, null]) {
      assert.equal(validateEdits(doc, candidate).valid, false);
      throwsCode(() => writeEditedExp(doc, candidate), 'EDITS');
    }
  });

  test('finite strict numeric inputs reject empty, partial, non-numeric and nonpositive mass', () => {
    const doc = read();
    for (const value of ['', '  ', '12abc', '0x12', 'NaN', 'Infinity', NaN, Infinity, null, false, {}, []]) {
      const rows = createDraft(doc); rows[0].ce = value;
      assert.equal(validateEdits(doc, rows).valid, false, String(value));
    }
    for (const value of [0, -1, '0', '-0.01']) {
      const rows = createDraft(doc); rows[0].precursor = value;
      assert.equal(validateEdits(doc, rows).valid, false);
    }
    const rows = createDraft(doc); rows[0].ce = -15; rows[0].cv = 0;
    assert.equal(validateEdits(doc, rows).valid, true, 'No unverified instrument-specific range is invented.');
  });

  test('name controls, line injection, invalid Unicode, excessive lengths reject', () => {
    const doc = read();
    for (const value of ['x\nNoOfChannels,8', 'x\rdata', 'x\u0000', 'x\u001b', 'x\u007f', 'x\u0085', 'x\u2028', 'x\u2029', '\ud800', 'x'.repeat(1025), 12, null]) {
      const rows = createDraft(doc); rows[0].name = value;
      assert.equal(validateEdits(doc, rows).valid, false);
    }
  });

  test('missing keys, extra channels, invalid suffixes, duplicate keys and count mismatch reject', () => {
    for (const key of ['NumSIRMasses', 'NoOfChannels', 'CompoundName_2', 'Mass(amu)_1', 'SIRMass1', 'SIRMass_2_1', 'ConeVoltage(V)_2', 'CollisionEnergy(eV)_2']) {
      const source = fixture.split('\n').filter(line => !line.startsWith(key + ',')).join('\n');
      throwsCode(() => read(source), 'MISSING_KEY');
    }
    throwsCode(() => read(fixture + 'Mass(amu)_3,123\n'), 'CHANNEL_INDEX');
    throwsCode(() => read(fixture + 'Mass(amu)_0,123\n'), 'CHANNEL_INDEX');
    throwsCode(() => read(fixture + 'Mass(amu)_01,123\n'), 'CHANNEL_INDEX');
    throwsCode(() => read(fixture + 'Mass(amu)_1,89\n'), 'DUPLICATE_KEY');
    throwsCode(() => read(fixture.replace('NoOfChannels,2', 'NoOfChannels,3')), 'COUNT');
    throwsCode(() => read(fixture.replace('NoOfChannels,2', 'NoOfChannels,2.5')), 'COUNT');
    throwsCode(() => read(fixture.replace('SIRMass1,89.0000', 'SIRMass1,90.0000')), 'MASS_MISMATCH');
    throwsCode(() => read(fixture.replace('SIRDelay2,0.0042', 'SIRDelay2,0.0043')), 'SETTING_MISMATCH');
  });

  test('multiple functions and unknown function modes fail closed', () => {
    throwsCode(() => read(fixture + fixture), 'DUPLICATE_KEY');
    throwsCode(() => read(fixture.replace('NumFunctions,1', 'NumFunctions,2')), 'FUNCTIONS');
    throwsCode(() => read(fixture + '[Function 2]\nScanType,SCAN\n'), 'FUNCTIONS');
    throwsCode(() => read(fixture + 'FunctionIndex,2\n'), 'FUNCTIONS');
    throwsCode(() => read(fixture.replace('FunctionType,MRM', 'FunctionType,13')), 'FUNCTION_TYPE');
  });

  test('sample-list, lock-mass and SLAuto dependent values reject active or uncertain flags', () => {
    for (const key of ['UseAsLockMass1', 'UseSampleList1', 'UseSampleList_21', 'UseSLMassesP_1', 'UseSLMassesD_1']) {
      for (const value of ['1', 'true', '', 'unknown']) throwsCode(() => read(fixture.replace(key + ',0', key + ',' + value)), 'DEPENDENT_VALUE');
    }
    throwsCode(() => read(fixture + 'SLAutoCone_1,1\n'), 'DEPENDENT_VALUE');
    const source = fixture.replace('SIRAutoDwell1,0', 'SIRAutoDwell1,1').replace('AutoDwell_1,0', 'AutoDwell_1,1');
    const doc = read(source), rows = createDraft(doc); rows[0].ce = 12;
    bytesEqual(writeEditedExp(doc, rows), utf8(source.replace('CollisionEnergy(eV)_1,11.0000', 'CollisionEnergy(eV)_1,12')));
  });

  test('polarity never inferred from names; conflicting explicit signs reject', () => {
    const doc = read(fixture.replace('Polarity,ES-\n', ''));
    assert.equal(doc.polarity, null);
    assert.equal(read(fixture.replace('Polarity,ES-', 'Polarity,1')).polarity, null);
    throwsCode(() => read(fixture + 'IonMode,positive\n'), 'POLARITY');
    assert.equal(read(fixture.replace('Polarity,ES-', 'Polarity,ES+')).polarity, 'positive');
  });

  function utf16(text, bigEndian, bom) {
    const bytes = Buffer.from(text, 'utf16le');
    if (bigEndian) bytes.swap16();
    return new Uint8Array(Buffer.concat([bom ? Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]) : Buffer.alloc(0), bytes]));
  }
  test('UTF-8 BOM is preserved for no-op and editing', () => {
    const source = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(fixture)]);
    const doc = parseExp(source), rows = createDraft(doc);
    assert.equal(doc.bom, true); assert.equal(doc.encoding, 'utf-8');
    bytesEqual(writeEditedExp(doc, rows), source);
    rows[0].name = '乳酸';
    bytesEqual(writeEditedExp(doc, rows), new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(fixture.replace('CompoundName_1,Lactate-NEG', 'CompoundName_1,乳酸'))]));
  });

  test('UTF-16 LE/BE BOM and explicit BOM-less modes preserve exact bytes', () => {
    for (const bigEndian of [false, true]) for (const bom of [false, true]) {
      const encoding = bigEndian ? 'utf-16be' : 'utf-16le';
      const source = utf16(fixture.replace(/\n/g, '\r\n'), bigEndian, bom);
      const doc = parseExp(source, { encoding: bom ? 'auto' : encoding }), rows = createDraft(doc);
      assert.equal(doc.encoding, encoding);
      bytesEqual(writeEditedExp(doc, rows), source);
      rows[1].name = '乳酸 😀'; rows[0].cv = 31.5;
      const expected = fixture.replace(/\n/g, '\r\n').replace('CompoundName_2,NEG_13C-Lactate-NEG', 'CompoundName_2,乳酸 😀').replace('ConeVoltage(V)_1,20.0000', 'ConeVoltage(V)_1,31.5');
      bytesEqual(writeEditedExp(doc, rows), utf16(expected, bigEndian, bom));
      assert.equal(restoreDocument(serializeDocument(doc, rows)).document.encoding, encoding);
    }
  });

  test('wrong encodings, invalid UTF-8, NUL/binary and oversize files reject', () => {
    throwsCode(() => parseExp(new Uint8Array([0xff, 0xff])), 'ENCODING');
    throwsCode(() => parseExp(new Uint8Array()), 'EMPTY');
    throwsCode(() => parseExp(new Uint8Array(core.MAX_EXP_BYTES + 1)), 'SIZE');
    throwsCode(() => parseExp(fixture), 'INPUT');
    throwsCode(() => read(fixture + '\0'), 'BINARY');
    throwsCode(() => read(fixture + '\n'.repeat(50000)), 'SIZE');
    throwsCode(() => parseExp(utf16(fixture, false, true), { encoding: 'utf-16be' }), 'ENCODING');
    throwsCode(() => parseExp(new Uint8Array([0xff, 0xfe, 0x41])), 'ENCODING');
    throwsCode(() => read(fixture, { encoding: 'latin1' }), 'ENCODING');
  });

  test('Shift_JIS editing encodes known Japanese independently and preserves other bytes', () => {
    const marker = 'Lactate-NEG';
    const [before, after] = fixture.split(marker);
    // 日本 = 93 FA 96 7B; 東京 = 93 8C 8B 9E in Windows-31J / Shift_JIS.
    const source = Buffer.concat([Buffer.from(before), Buffer.from([0x93, 0xfa, 0x96, 0x7b]), Buffer.from(after)]);
    throwsCode(() => parseExp(source), 'ENCODING');
    const doc = parseExp(source, { encoding: 'shift_jis' }), rows = createDraft(doc);
    assert.equal(rows[0].name, '日本');
    bytesEqual(writeEditedExp(doc, rows), source);
    rows[0].name = '東京';
    bytesEqual(writeEditedExp(doc, rows), Buffer.concat([Buffer.from(before), Buffer.from([0x93, 0x8c, 0x8b, 0x9e]), Buffer.from(after)]));
    rows[0].name = '😀';
    assert.equal(validateEdits(doc, rows).valid, false);
    throwsCode(() => writeEditedExp(doc, rows), 'EDITS');
  });

  test('Windows-1252 keeps high bytes and blocks unrepresentable replacement', () => {
    const source = Buffer.from(fixture.replace('Lactate-NEG', 'Café µ'), 'latin1');
    const doc = parseExp(source, { encoding: 'windows-1252' }), rows = createDraft(doc);
    assert.equal(rows[0].name, 'Café µ');
    bytesEqual(writeEditedExp(doc, rows), source);
    rows[0].name = 'Déjà';
    bytesEqual(writeEditedExp(doc, rows), Buffer.from(fixture.replace('Lactate-NEG', 'Déjà'), 'latin1'));
    rows[0].name = '乳酸'; assert.equal(validateEdits(doc, rows).valid, false);
  });

  test('export verification independently rejects changes to any unrelated byte', () => {
    const doc = read(), rows = createDraft(doc); rows[0].ce = 15;
    const output = writeEditedExp(doc, rows);
    throwsCode(() => verifyExport(doc, utf8(decode(output).replace('0.0200', '0.0100')), rows), 'EXPORT_CHANGED');
    throwsCode(() => verifyExport(doc, utf8(decode(output) + '\n'), rows), 'EXPORT_CHANGED');
  });

  test('snapshot roundtrip reconstructs original and edits, ignoring untrusted metadata', () => {
    const doc = read(fixture, { filename: 'past.exp' }), rows = createDraft(doc);
    rows[0].ce = '15.5'; rows[1].name = '乳酸';
    const snapshot = serializeDocument(doc, rows);
    const restored = restoreDocument(JSON.parse(JSON.stringify(snapshot)));
    bytesEqual(writeEditedExp(restored.document, restored.rows), writeEditedExp(doc, rows));
    assert.equal(restored.document.filename, 'past.exp');
    assert.ok(!('details' in snapshot.rows[0]));
    snapshot.rows[0].details = { dwell: 99 };
    snapshot.rows[0].channel = 999;
    const sanitized = restoreDocument(snapshot);
    assert.equal(sanitized.rows[0].details.dwell, '0.0100');
    assert.equal(sanitized.rows[0].channel, 1);
  });

  test('snapshot invalid version, malformed base64, bogus row values/IDs fail', () => {
    const doc = read(), baseline = serializeDocument(doc, createDraft(doc));
    for (const patch of [{ version: 2 }, { parserVersion: 'future' }, { profile: 'unknown' }, { encoding: 'auto' }, { originalBase64: '?bad?' }, { filename: {} }, { rows: [] }]) {
      throwsCode(() => restoreDocument({ ...baseline, ...patch }), 'SNAPSHOT');
    }
    const fakeId = JSON.parse(JSON.stringify(baseline)); fakeId.rows[0].id = 'other';
    throwsCode(() => restoreDocument(fakeId), 'SNAPSHOT');
    const fakeNumber = JSON.parse(JSON.stringify(baseline)); fakeNumber.rows[0].cv = '10abc';
    throwsCode(() => restoreDocument(fakeNumber), 'SNAPSHOT');
    const invalidRows = createDraft(doc); invalidRows[0].ce = '';
    throwsCode(() => serializeDocument(doc, invalidRows), 'EDITS');
  });

  test('large supported snapshots restore without regexp recursion or data loss', () => {
    const source = fixture + 'VendorLargeComment,' + 'a'.repeat(850000);
    const doc = read(source), rows = createDraft(doc);
    rows[0].cv = '21';
    const restored = restoreDocument(serializeDocument(doc, rows));
    bytesEqual(writeEditedExp(restored.document, restored.rows), utf8(source.replace('ConeVoltage(V)_1,20.0000', 'ConeVoltage(V)_1,21')));
  });

  // Written independently as the exact output for retaining channel 2. The
  // blank left by removed channel 1 is intentionally retained.
  const secondSelected = `; Synthetic regression fixture only; not a vendor-validated acquisition method.
NumFunctions,1
FunctionType,MRM
Polarity,ES-
NumSIRMasses,1
SIRMass1,92.0000
SIRMass_2_1,46.0000
SIRAutoDwell1,0
SIRDwellTime1,0.0200
SIRDelay1,0.0042
UseAsLockMass1,0
UseSampleList1,0
UseSampleList_21,0
NoOfChannels,1

UseSLMassesP_1,0
UseSLMassesD_1,0
Mass(amu)_1,92.0000
Mass2(amu)_1,46.0000
AutoDwell_1,0
Dwell(s)_1,0.0200
ConeVoltage(V)_1,20.0000
CollisionEnergy(eV)_1,11.0000
InterChannelDelay(s)_1,0.0042
CompoundName_1,NEG_13C-Lactate-NEG

CompoundFormula_1,C3H6O3
CompoundComment_1,another comment
FunctionScanTime(sec),0.0242
`;

  test('selected output removes every excluded key, renumbers both blocks and keeps row-specific conditions', () => {
    const doc = read(selectionFixture), rows = createDraft(doc), before = JSON.stringify(rows);
    assert.deepEqual(validateSelectedExport(doc, rows, ['channel-2']), {
      valid: true, errors: [], selectedCount: 1, excludedCount: 1, changedCells: 0,
    });
    const output = writeSelectedExp(doc, rows, ['channel-2']);
    bytesEqual(output, utf8(secondSelected));
    const parsed = parseExp(output);
    assert.equal(parsed.rows[0].precursor, '92.0000');
    assert.deepEqual(parsed.rows[0].details, doc.rows[1].details);
    assert.equal(parsed.rows[0].id, 'channel-1');
    assert.equal(JSON.stringify(rows), before, 'Selection export does not mutate the full draft.');
    bytesEqual(writeEditedExp(doc, rows), utf8(selectionFixture), 'The original document still has both rows.');
  });

  test('all selected preserves existing byte-exact behavior even with unknown dependencies', () => {
    for (const source of [fixture, selectionFixture, selectionFixture.replace('FunctionScanTime(sec),0.0379', 'FunctionScanTime(sec),123')]) {
      const doc = read(source), rows = createDraft(doc);
      assert.equal(validateSelectedExport(doc, rows, ['channel-2', 'channel-1']).valid, true);
      bytesEqual(writeSelectedExp(doc, rows, ['channel-2', 'channel-1']), utf8(source));
      rows[0].ce = '13.5';
      bytesEqual(writeSelectedExp(doc, rows, ['channel-1', 'channel-2']), writeEditedExp(doc, rows));
    }
  });

  test('GENERAL INFORMATION section headers survive selected export byte-for-byte', () => {
    for (const header of ['GENERAL INFORMATION', ' GENERAL INFORMATION \t', 'GENERAL INFORMATION,', 'GENERAL INFORMATION, \t', '[GENERAL INFORMATION]', 'general information']) {
      for (const newline of ['\n', '\r\n', '\r']) {
        const source = header + newline + selectionFixture.replaceAll('\n', newline);
        const expected = header + newline + secondSelected.replaceAll('\n', newline);
        for (const encode of [utf8, text => utf16(text, false, true), text => utf16(text, true, true)]) {
          const doc = parseExp(encode(source)), rows = createDraft(doc);
          assert.equal(validateSelectedExport(doc, rows, ['channel-2']).valid, true);
          bytesEqual(writeSelectedExp(doc, rows, ['channel-2']), encode(expected));
          bytesEqual(writeSelectedExp(doc, rows, ['channel-1', 'channel-2']), encode(source));
        }
      }
    }
  });

  test('GENERAL INFORMATION does not allow unknown settings or duplicate sections', () => {
    for (const header of ['GENERAL INFORMATION,2,1', 'GENERAL INFORMATION\nCreatedBy,Test', 'GENERAL INFORMATION\nChannelOrder,2,1', 'GENERAL INFORMATION\nVendorRetentionTime_2,2.50', 'GENERAL INFORMATION\n[GENERAL INFORMATION]', 'GENERAL INFORMATION extra']) {
      const source = header + '\n' + selectionFixture, doc = read(source), rows = createDraft(doc);
      assert.equal(validateSelectedExport(doc, rows, ['channel-2']).valid, false, header);
      throwsCode(() => writeSelectedExp(doc, rows, ['channel-2']), 'SELECTION');
      bytesEqual(writeSelectedExp(doc, rows, ['channel-1', 'channel-2']), utf8(source));
    }
  });

  test('existing builder output with GENERAL INFORMATION supports selected export', () => {
    const source = builtWithHeader, doc = read(source), rows = createDraft(doc);
    const output = writeSelectedExp(doc, rows, ['channel-2']);
    const parsed = parseExp(output);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].name, doc.rows[1].name);
    assert.ok(decode(output).startsWith('GENERAL INFORMATION\r\n'));
    assert.ok(decode(output).includes('FunctionScanTime(sec),0.0137\r\n'));
  });

  test('selection IDs reject zero, duplicate, unknown, non-array and sparse values', () => {
    const doc = read(selectionFixture), rows = createDraft(doc);
    for (const ids of [[], ['channel-1', 'channel-1'], ['channel-3'], ['channel-1', 'foreign'], [null], null, {}, new Set(['channel-1']), new Array(1)]) {
      assert.equal(validateSelectedExport(doc, rows, ids).valid, false);
      throwsCode(() => writeSelectedExp(doc, rows, ids), 'SELECTION');
    }
    const validation = validateSelectedExport(doc, rows, []);
    assert.equal(validation.selectedCount, 0); assert.equal(validation.excludedCount, 2);
  });

  test('excluded invalid edits are ignored but excluded row identities and order are still validated', () => {
    const doc = read(selectionFixture), rows = createDraft(doc);
    rows[0].name = '\ninvalid'; rows[0].precursor = ''; rows[0].ce = 'Infinity';
    rows[1].precursor = '93.5'; rows[1].product = '47'; rows[1].ce = '13';
    assert.equal(validateSelectedExport(doc, rows, ['channel-2']).changedCells, 3);
    const output = writeSelectedExp(doc, rows, ['channel-2']);
    const expected = secondSelected.replace('SIRMass1,92.0000', 'SIRMass1,93.5')
      .replace('Mass(amu)_1,92.0000', 'Mass(amu)_1,93.5').replace('SIRMass_2_1,46.0000', 'SIRMass_2_1,47')
      .replace('Mass2(amu)_1,46.0000', 'Mass2(amu)_1,47').replace('CollisionEnergy(eV)_1,11.0000', 'CollisionEnergy(eV)_1,13');
    bytesEqual(output, utf8(expected));
    assert.equal(validateSelectedExport(doc, rows, ['channel-1']).valid, false);
    assert.equal(validateSelectedExport(doc, rows, ['channel-1', 'channel-2']).valid, false);
    for (const candidate of [rows.slice(1), rows.slice().reverse(), [null, rows[1]], [{ ...rows[0], id: 'foreign' }, rows[1]], new Array(2), null]) {
      assert.equal(validateSelectedExport(doc, candidate, ['channel-2']).valid, false);
      throwsCode(() => writeSelectedExp(doc, candidate, ['channel-2']), 'SELECTION');
    }
    const minimal = createDraft(doc).map(({ id, name, precursor, product, cv, ce }) => ({ id, name, precursor, product, cv, ce }));
    bytesEqual(writeSelectedExp(doc, minimal, ['channel-2']), utf8(secondSelected), 'Only row IDs and editable values are trusted from a draft.');
  });

  test('unknown numbered and unnumbered dependencies block subset but never alter full export', () => {
    for (const record of ['VendorRetentionTime_2,2.50', 'VendorSetting,unknown', 'ChannelOrder,2,1', 'EndMarker,untouched', 'CompoundAlias_1,Lactate', 'unexpected marker', '[Function1', 'Polarity']) {
      const source = selectionFixture + record + '\n', doc = read(source), rows = createDraft(doc);
      const result = validateSelectedExport(doc, rows, ['channel-2']);
      assert.equal(result.valid, false, record);
      assert.ok(result.errors.some(error => error.message.includes(record.split(',')[0])), record);
      throwsCode(() => writeSelectedExp(doc, rows, ['channel-2']), 'SELECTION');
      bytesEqual(writeSelectedExp(doc, rows, ['channel-1', 'channel-2']), utf8(source));
    }
    const duplicate = read(selectionFixture + 'Polarity,ES-\n');
    assert.equal(validateSelectedExport(duplicate, createDraft(duplicate), ['channel-1']).valid, false);
  });

  test('known Function 1 markers and comments retain their exact placement and bytes', () => {
    for (const marker of ['[Function 1]', 'Function1', 'Function_1:', '; channel 2 note', '# channel 1 note', '// channel 2 note']) {
      const source = marker + '\n' + selectionFixture, doc = read(source);
      bytesEqual(writeSelectedExp(doc, createDraft(doc), ['channel-2']), utf8(marker + '\n' + secondSelected));
    }
  });

  test('manual AutoDwell, complete timing pairs and verified original total are mandatory for subset', () => {
    const sources = [
      selectionFixture.replace('FunctionScanTime(sec),0.0379', 'FunctionScanTime(sec),0.1960'),
      selectionFixture.replace('FunctionScanTime(sec),0.0379', 'FunctionScanTime(sec),0.037900000000000001'),
      selectionFixture.replace('FunctionScanTime(sec),0.0379', 'FunctionScanTime(sec),NaN'),
      selectionFixture.replace('FunctionScanTime(sec),0.0379', 'FunctionScanTime(sec),-1'),
      selectionFixture.replace('SIRAutoDwell1,0', 'SIRAutoDwell1,1').replace('AutoDwell_1,0', 'AutoDwell_1,1'),
      selectionFixture.replace('SIRDwellTime1,0.0100', 'SIRDwellTime1,0').replace('Dwell(s)_1,0.0100', 'Dwell(s)_1,0'),
      selectionFixture.replace('SIRDelay1,0.0037', 'SIRDelay1,-0.0037').replace('InterChannelDelay(s)_1,0.0037', 'InterChannelDelay(s)_1,-0.0037'),
      selectionFixture.replace('SIRDwellTime1,0.0100', 'SIRDwellTime1,1e-129').replace('Dwell(s)_1,0.0100', 'Dwell(s)_1,1e-129'),
    ];
    for (const key of ['SIRAutoDwell1', 'AutoDwell_1', 'SIRDwellTime1', 'Dwell(s)_1', 'SIRDelay1', 'InterChannelDelay(s)_1', 'FunctionScanTime(sec)']) {
      sources.push(selectionFixture.split('\n').filter(line => !line.startsWith(key + ',')).join('\n'));
    }
    for (const source of sources) {
      const doc = read(source), rows = createDraft(doc);
      assert.equal(validateSelectedExport(doc, rows, ['channel-2']).valid, false, source);
      throwsCode(() => writeSelectedExp(doc, rows, ['channel-2']), 'SELECTION');
      bytesEqual(writeSelectedExp(doc, rows, ['channel-1', 'channel-2']), utf8(source));
    }
  });

  test('scan time is summed exactly with heterogeneous per-channel timing and exponent notation', () => {
    const source = selectionFixture.replaceAll('0.0100', '1e-2').replaceAll('0.0037', '0.003700000000000001')
      .replace('FunctionScanTime(sec),0.0379', 'FunctionScanTime(sec),0.037900000000000001');
    const doc = read(source), rows = createDraft(doc);
    const output = decode(writeSelectedExp(doc, rows, ['channel-1']));
    assert.ok(output.includes('FunctionScanTime(sec),0.013700000000000001\n'));
    assert.ok(output.includes('SIRDwellTime1,1e-2\n'));
    assert.ok(output.includes('Dwell(s)_1,1e-2\n'));
    bytesEqual(writeSelectedExp(doc, rows, ['channel-2']), utf8(secondSelected));
  });

  function makeChannels(channels) {
    const lines = ['NumFunctions,1', 'FunctionType,MRM', 'Polarity,ES-', 'NumSIRMasses,' + channels.length];
    channels.forEach((value, n) => {
      const i = n + 1;
      lines.push(`SIRMass${i},${value}`, `SIRMass_2_${i},${value - 1}`, `SIRAutoDwell${i},0`, `SIRDwellTime${i},0.01`, `SIRDelay${i},0.0037`, `UseAsLockMass${i},0`, `UseSampleList${i},0`, `UseSampleList_2${i},0`);
    });
    lines.push('NoOfChannels,' + channels.length);
    channels.forEach((value, n) => {
      const i = n + 1;
      lines.push(`UseSLMassesP_${i},0`, `UseSLMassesD_${i},0`, `Mass(amu)_${i},${value}`, `Mass2(amu)_${i},${value - 1}`, `AutoDwell_${i},0`, `Dwell(s)_${i},0.01`, `ConeVoltage(V)_${i},20`, `CollisionEnergy(eV)_${i},11`, `InterChannelDelay(s)_${i},0.0037`, `CompoundName_${i},Compound ${value}`, `CompoundFormula_${i},Formula ${value}`, `CompoundComment_${i},Comment ${value}`);
    });
    const ticks = channels.length * 137;
    lines.push('FunctionScanTime(sec),' + (ticks / 10000).toFixed(4));
    return lines.join('\n') + '\n';
  }

  test('first, middle and last exclusions preserve source order and renumber multidigit suffixes', () => {
    const values = Array.from({ length: 12 }, (_, i) => 100 + i), source = makeChannels(values), doc = read(source), rows = createDraft(doc);
    for (const selected of [[2, 11], [1, 3, 12], [12], [1], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]]) {
      const ids = selected.slice().reverse().map(i => 'channel-' + i);
      const expected = makeChannels(selected.map(i => values[i - 1])).replace(/FunctionScanTime\(sec\),([\d.]+)\n/, (_, total) => 'FunctionScanTime(sec),' + String(Number(total)) + '\n');
      bytesEqual(writeSelectedExp(doc, rows, ids), utf8(expected));
    }
  });

  test('subset retains key whitespace, value whitespace and exact original newlines', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const source = selectionFixture.replace('SIRMass2,92.0000', '  SIRMass2 \t,  92.0000\t')
        .replace('UseSampleList_22,0', '\tUseSampleList_22 \t,0')
        .replace('NoOfChannels,2', 'NoOfChannels, 2 \t')
        .replace('FunctionScanTime(sec),0.0379', 'FunctionScanTime(sec), 0.0379 \t').replaceAll('\n', newline);
      const expected = secondSelected.replace('SIRMass1,92.0000', '  SIRMass1 \t,  92.0000\t')
        .replace('UseSampleList_21,0', '\tUseSampleList_21 \t,0')
        .replace('NoOfChannels,1', 'NoOfChannels, 1 \t')
        .replace('FunctionScanTime(sec),0.0242', 'FunctionScanTime(sec), 0.0242 \t').replaceAll('\n', newline);
      const doc = read(source), rows = createDraft(doc);
      bytesEqual(writeSelectedExp(doc, rows, ['channel-2']), utf8(expected));
    }
    const source = selectionFixture.replace('SIRMass2,92.0000\n', 'SIRMass2,92.0000\r\n').trimEnd();
    const expected = secondSelected.replace('SIRMass1,92.0000\n', 'SIRMass1,92.0000\r\n').trimEnd();
    const doc = read(source);
    bytesEqual(writeSelectedExp(doc, createDraft(doc), ['channel-2']), utf8(expected));
  });

  test('subset output preserves UTF-8 BOM and UTF-16 LE/BE encodings and original key bytes', () => {
    const sourceText = selectionFixture.replace('UseSampleList_22,0', ' \tUseSampleList_22 \t,0');
    const expectedText = secondSelected.replace('UseSampleList_21,0', ' \tUseSampleList_21 \t,0');
    const source = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(sourceText)]), doc = parseExp(source);
    bytesEqual(writeSelectedExp(doc, createDraft(doc), ['channel-2']), new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(expectedText)]));
    for (const bigEndian of [false, true]) for (const bom of [false, true]) {
      const encoding = bigEndian ? 'utf-16be' : 'utf-16le';
      const encoded = utf16(sourceText, bigEndian, bom), document = parseExp(encoded, { encoding: bom ? 'auto' : encoding }), rows = createDraft(document);
      rows[1].name = '選択した乳酸';
      bytesEqual(writeSelectedExp(document, rows, ['channel-2']), utf16(expectedText.replace('NEG_13C-Lactate-NEG', '選択した乳酸'), bigEndian, bom));
    }
  });

  test('subset output preserves Shift_JIS and Windows-1252 row bytes while encoding edits correctly', () => {
    const [before, after] = selectionFixture.split('NEG_13C-Lactate-NEG');
    const [keptBefore, keptAfter] = secondSelected.split('NEG_13C-Lactate-NEG');
    const japanese = Buffer.from([0x93, 0xfa, 0x96, 0x7b]), editedJapanese = Buffer.from([0x93, 0x8c, 0x8b, 0x9e]);
    const source = Buffer.concat([Buffer.from(before), japanese, Buffer.from(after)]), doc = parseExp(source, { encoding: 'shift_jis' }), rows = createDraft(doc);
    bytesEqual(writeSelectedExp(doc, rows, ['channel-2']), Buffer.concat([Buffer.from(keptBefore), japanese, Buffer.from(keptAfter)]));
    rows[1].name = '東京';
    bytesEqual(writeSelectedExp(doc, rows, ['channel-2']), Buffer.concat([Buffer.from(keptBefore), editedJapanese, Buffer.from(keptAfter)]));
    const western = parseExp(Buffer.from(selectionFixture.replace('NEG_13C-Lactate-NEG', 'Café µ'), 'latin1'), { encoding: 'windows-1252' });
    bytesEqual(writeSelectedExp(western, createDraft(western), ['channel-2']), Buffer.from(secondSelected.replace('NEG_13C-Lactate-NEG', 'Café µ'), 'latin1'));
  });

  console.log(`exp_core_regression: ${checks} test groups passed (synthetic fixtures; instrument compatibility unverified).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
