// Synthetic structure-only fixture: no user method names, acquisition values,
// paths, timestamps, or coordinates. This is not an instrument acceptance test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseExp, createDraft, validateSelectedExport, writeSelectedExp,
} from '../mrm/exp-core.mjs';

const source = fs.readFileSync(new URL('./fixtures/exp/masslynx-mrm-synthetic.exp', import.meta.url));
const fixture = source.toString('utf8');
const utf8 = text => Buffer.from(text, 'utf8');
const bytesEqual = (actual, expected) => assert.deepEqual(Buffer.from(actual), Buffer.from(expected));
const prefixes = [
  'SIRMass', 'SIRMass_2_', 'SIRAutoDwell', 'SIRDwellTime', 'SIRDelay',
  'UseAsLockMass', 'UseSampleList', 'UseSampleList_2', 'UseSLMassesP_',
  'UseSLMassesD_', 'Mass(amu)_', 'Mass2(amu)_', 'AutoDwell_', 'Dwell(s)_',
  'ConeVoltage(V)_', 'CollisionEnergy(eV)_', 'InterChannelDelay(s)_',
  'CompoundName_', 'CompoundFormula_', 'CompoundComment_',
];
// Deliberately independent of the core parser and its indexed-key patterns.
// Longest prefix first disambiguates UseSampleList_21 from UseSampleList1.
const channelKeys = new Map();
for (let channel = 1; channel <= 3; channel++) {
  for (const prefix of prefixes) channelKeys.set(prefix + channel, { prefix, channel });
}
const records = text => [...text.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)]
  .filter(match => match[0].length).map(match => ({ text: match[1], eol: match[2] }));
function referenceSubset(text, selected, replacements = {}) {
  const selectedInSourceOrder = [1, 2, 3].filter(channel => selected.includes(channel));
  return records(text).map(record => {
    const comma = record.text.indexOf(',');
    if (comma < 0) return record.text + record.eol;
    const key = record.text.slice(0, comma), value = record.text.slice(comma + 1);
    const indexed = channelKeys.get(key);
    if (indexed) {
      const index = selectedInSourceOrder.indexOf(indexed.channel);
      if (index < 0) return '';
      return indexed.prefix + (index + 1) + ',' + (replacements[key] ?? value) + record.eol;
    }
    if (key === 'NoOfChannels' || key === 'NumSIRMasses') return key + ',' + selected.length + record.eol;
    return record.text + record.eol;
  }).join('');
}
function unrelatedBytes(text) {
  return records(text).filter(record => {
    const key = record.text.split(',', 1)[0];
    return !channelKeys.has(key) && key !== 'NoOfChannels' && key !== 'NumSIRMasses';
  }).map(record => record.text + record.eol).join('');
}
function subset(text = fixture, channels = [2], edit) {
  const doc = parseExp(utf8(text)), rows = createDraft(doc);
  if (edit) edit(rows);
  const selected = channels.map(channel => doc.rows[channel - 1].id);
  assert.equal(validateSelectedExport(doc, rows, selected).valid, true);
  return writeSelectedExp(doc, rows, selected);
}
function partialBlocked(text) {
  let doc;
  try { doc = parseExp(utf8(text)); } catch (error) {
    assert.equal(error.name, 'ExpError');
    return;
  }
  const rows = createDraft(doc), selected = [rows[1].id];
  assert.equal(validateSelectedExport(doc, rows, selected).valid, false);
  assert.throws(() => writeSelectedExp(doc, rows, selected), error => error.name === 'ExpError');
}
let checks = 0;
function test(name, run) { run(); checks++; console.log('ok ' + name); }

test('MassLynx single MRM exposes explicit FunctionPolarity and three synthetic channels', () => {
  const doc = parseExp(source);
  assert.equal(doc.polarity, 'positive');
  assert.deepEqual(doc.rows.map(row => row.name), ['Synthetic_A', 'Synthetic_B', 'Synthetic_C']);
  assert.equal(doc.rows.length, 3);
  assert.ok(fixture.includes('GENERAL INFORMATION\r\n'));
  assert.ok(fixture.includes('FUNCTION 1\r\n'));
  assert.ok(fixture.includes('CompoundName_1,Synthetic_A\r\r\n'));
  assert.equal(doc.rows[0].details.dwell, '0.0100');
  assert.equal(doc.rows[1].details.dwell, '0.0200');
  assert.equal(doc.rows[2].details.dwell, '0.0300');
});

test('all checked rows preserve the entire source byte for byte', () => {
  const doc = parseExp(source), rows = createDraft(doc);
  bytesEqual(writeSelectedExp(doc, rows, rows.map(row => row.id)), source);
});

test('explicit negative polarity is supported and conflicting polarity flags block partial output', () => {
  const negative = fixture.replace('FunctionPolarity,Positive', 'FunctionPolarity,Negative').replace('PositivePolarity,1', 'PositivePolarity,0');
  assert.equal(parseExp(utf8(negative)).polarity, 'negative');
  bytesEqual(subset(negative, [2]), utf8(referenceSubset(negative, [2])));
  partialBlocked(fixture.replace('FunctionPolarity,Positive', 'FunctionPolarity,Negative'));
  partialBlocked(fixture.replace('FunctionPolarity,Positive', 'FunctionPolarity,unknown'));
});

test('subset removes and renumbers all twenty channel key families, preserving source order', () => {
  for (const channels of [[1], [2], [3], [1, 2], [2, 3], [3, 1]]) {
    const output = subset(fixture, channels);
    bytesEqual(output, utf8(referenceSubset(fixture, channels)));
    const reparsed = parseExp(output);
    assert.deepEqual(reparsed.rows.map(row => row.name), [1, 2, 3].filter(i => channels.includes(i)).map(i => 'Synthetic_' + String.fromCharCode(64 + i)));
    const outputText = Buffer.from(output).toString('utf8');
    for (const prefix of prefixes) {
      const matches = records(outputText).filter(record => {
        const key = record.text.split(',', 1)[0];
        return Array.from({ length: channels.length }, (_, i) => prefix + (i + 1)).includes(key);
      });
      assert.equal(matches.length, channels.length, prefix);
    }
    assert.equal(reparsed.rows.length, channels.length);
  }
});

test('retained edits patch both mass copies and preserve every unrelated original byte', () => {
  const output = subset(fixture, [3], rows => {
    rows[2].name = 'Synthetic edited'; rows[2].precursor = '150.25';
    rows[2].product = '70.125'; rows[2].cv = '30'; rows[2].ce = '15';
  });
  const expected = referenceSubset(fixture, [3], {
    CompoundName_3: 'Synthetic edited', SIRMass3: '150.25', 'Mass(amu)_3': '150.25',
    SIRMass_2_3: '70.125', 'Mass2(amu)_3': '70.125', 'ConeVoltage(V)_3': '30',
    'CollisionEnergy(eV)_3': '15',
  });
  bytesEqual(output, utf8(expected));
  bytesEqual(utf8(unrelatedBytes(Buffer.from(output).toString('utf8'))), utf8(unrelatedBytes(fixture)));
  const row = parseExp(output).rows[0];
  assert.equal(row.details.dwell, '0.0300');
  assert.equal(row.details.delay, '0.0037');
  assert.equal(row.details.formula, 'SyntheticFormula');
  assert.equal(row.details.comment, 'Synthetic comment 3, keep this comma');
});

test('original scan and interscan times remain unchanged even when their sum differs from dwell', () => {
  assert.notEqual(0.0100 + 0.0200 + 0.0300 + 3 * 0.0037, 0.1200);
  for (const channels of [[1], [2, 3], [3, 1]]) {
    const text = Buffer.from(subset(fixture, channels)).toString('utf8');
    assert.ok(text.includes('FunctionScanTime(sec),0.1200\r\n'));
    assert.ok(text.includes('FunctionInterScanTime(sec),0.0050\r\n'));
    for (const key of ['ExperimentDuration', 'FunctionStartTime(min)', 'FunctionEndTime(min)', 'DesiXStart', 'DesiYStart', 'DesiXLength', 'DesiXStep', 'DesiXRate', 'DesiYLength', 'DesiYStep', 'DesiSlot']) {
      assert.equal(records(text).find(record => record.text.startsWith(key + ',')).text,
        records(fixture).find(record => record.text.startsWith(key + ',')).text, key);
    }
  }
});

test('invalid unchecked input does not obstruct a valid subset and is not emitted', () => {
  const output = subset(fixture, [2], rows => { rows[0].ce = 'invalid'; rows[2].precursor = ''; });
  bytesEqual(output, utf8(referenceSubset(fixture, [2])));
});

test('zero checked rows cannot accidentally export the full original', () => {
  const doc = parseExp(source), rows = createDraft(doc);
  assert.equal(validateSelectedExport(doc, rows, []).valid, false);
  assert.throws(() => writeSelectedExp(doc, rows, []));
});

function utf16(text, bigEndian, bom) {
  const body = Buffer.from(text, 'utf16le');
  if (bigEndian) body.swap16();
  return Buffer.concat([bom ? Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]) : Buffer.alloc(0), body]);
}
test('CRCRLF, CRLF, BOM and encoding survive partial export exactly', () => {
  const expected = referenceSubset(fixture, [2, 3]);
  const cases = [
    { bytes: source, expected: utf8(expected), options: {} },
    { bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), source]), expected: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(expected)]), options: {} },
    ...[false, true].flatMap(bigEndian => [false, true].map(bom => ({
      bytes: utf16(fixture, bigEndian, bom), expected: utf16(expected, bigEndian, bom),
      options: { encoding: bom ? 'auto' : bigEndian ? 'utf-16be' : 'utf-16le' },
    }))),
    { bytes: source, expected: utf8(expected), options: { encoding: 'windows-1252' } },
    { bytes: source, expected: utf8(expected), options: { encoding: 'shift_jis' } },
  ];
  for (const item of cases) {
    const doc = parseExp(item.bytes, item.options), rows = createDraft(doc);
    bytesEqual(writeSelectedExp(doc, rows, [rows[1].id, rows[2].id]), item.expected);
  }
});

test('active, missing or uncertain PIC/Fraction/sorting metadata blocks partial output', () => {
  for (const [from, to] of [
    ['PICChannelNum,-1', 'PICChannelNum,0'], ['PICChannelNum,-1', 'PICChannelNum,1'],
    ['PICChannelNum,-1', 'PICChannelNum,unknown'], ['PICChannelNum,-1\r\n', ''],
    ['FractionMode,0', 'FractionMode,1'], ['FractionMode,0\r\n', ''],
    ['MassesVSorted,0', 'MassesVSorted,1'], ['ExperimentVSorted,0', 'ExperimentVSorted,1'],
    ['ReferenceFrequency,0', 'ReferenceFrequency,1'],
    ['FractionLowMassIndex,' + Array(32).fill('0').join(','), 'FractionLowMassIndex,' + ['1', ...Array(31).fill('0')].join(',')],
    ['FractionHighMassIndex,' + Array(32).fill('0').join(','), 'FractionHighMassIndex,' + Array(31).fill('0').join(',')],
  ]) {
    assert.ok(fixture.includes(from), from);
    partialBlocked(fixture.replace(from, to));
  }
});

test('active, malformed or missing timed-event metadata blocks partial output', () => {
  const passive = 'No Change,No Change,No Change,No Change,No Change,LC,5,No Action,No Action,250,20,0,0';
  for (const changed of [passive.replace('No Change', 'Switch'), passive.replace('No Action', 'Activate'), passive.split(',').slice(1).join(','), passive + ',0', passive.replace(/0$/, '1')]) {
    partialBlocked(fixture.replace(passive, changed));
  }
  partialBlocked(fixture.replace('ExperimentExtension,TIMED_EVENTS_EXTENSION', 'ExperimentExtension,UNKNOWN_EXTENSION'));
  partialBlocked(fixture.replace('ExperimentExtensionData,' + passive + '\r\n', ''));
});

test('unknown channel or scalar metadata is retained for all rows but blocks a subset', () => {
  for (const added of ['UnknownVendorSetting,0', 'UnknownChannelReference,2', 'MRMExtraValue_2,0', 'FUNCTION GENERAL INFORMATION']) {
    const text = fixture + added + '\r\n';
    const doc = parseExp(utf8(text)), rows = createDraft(doc);
    bytesEqual(writeSelectedExp(doc, rows, rows.map(row => row.id)), utf8(text));
    partialBlocked(text);
  }
});

test('incomplete channel key families or duplicated global settings block partial output', () => {
  for (const prefix of prefixes) {
    const key = prefix + '2';
    const text = records(fixture).filter(record => !record.text.startsWith(key + ',')).map(record => record.text + record.eol).join('');
    partialBlocked(text);
  }
  partialBlocked(fixture.replace('ReferenceFrequency,0', 'ReferenceFrequency,0\r\nReferenceFrequency,0'));
  partialBlocked(fixture.replace('FunctionPolarity,Positive', 'FunctionPolarity,Positive\r\nFunctionPolarity,Positive'));
});

test('multiple functions, automatic dwell or unrecognized profile never permit a subset', () => {
  for (const text of [
    fixture.replace('NumberOfFunctions,1', 'NumberOfFunctions,2'),
    fixture + 'FUNCTION 2\r\nFunctionType,SCAN\r\n',
    fixture.replace('FunctionTypes,MRM', 'FunctionTypes,MRM,MRM'),
    fixture.replace('VersionNumber,1.0', 'VersionNumber,2.0'),
    fixture.replace('SIRAutoDwell2,0', 'SIRAutoDwell2,1').replace('AutoDwell_2,0', 'AutoDwell_2,1'),
    fixture.replace('SIRAutoDwell2,0\r\n', '').replace('AutoDwell_2,0\r\n', ''),
    fixture.replace('FUNCTION 1\r\n', ''),
    fixture.replace('GENERAL INFORMATION\r\n', ''),
  ]) partialBlocked(text);
});

console.log(`exp_masslynx_regression: ${checks} checks passed`);
