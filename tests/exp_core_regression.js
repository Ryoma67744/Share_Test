'use strict';
// Pure byte-level regression tests. Fixture is synthetic; these checks do not
// substitute for opening representative files in the target MassLynx version.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async function () {
  const core = await import('../mrm/exp-core.mjs');
  const { parseExp, createDraft, validateEdits, writeEditedExp, verifyExport, serializeDocument, restoreDocument, ExpError } = core;
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/exp/flat-mrm-synthetic.exp'), 'utf8');
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

  console.log(`exp_core_regression: ${checks} test groups passed (synthetic fixtures; instrument compatibility unverified).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
