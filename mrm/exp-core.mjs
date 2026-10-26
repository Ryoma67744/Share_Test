/**
 * Lossless editor for the single, flat MRM layout emitted by mrm.html.
 * This is deliberately not a general MassLynx method converter. No real vendor
 * .exp fixture has been supplied: multiple functions and arbitrary structural
 * edits are rejected. Selecting fewer channels requires a strict, known layout
 * with manual dwell and an exactly verifiable scan-time relationship.
 * Unknown bytes are retained, and edited values are patched into original bytes.
 */
export const MAX_EXP_BYTES = 1024 * 1024;
export const MAX_EXP_CHANNELS = 2048; // Resource bound, not an instrument limit.
const MAX_EXP_LINES = 50000;
export const PARSER_VERSION = '1';
export const SUPPORTED_ENCODINGS = Object.freeze(['auto', 'utf-8', 'utf-16le', 'utf-16be', 'windows-1252', 'shift_jis']);

export class ExpError extends Error {
  constructor(code, message, errors = []) {
    super(message);
    this.name = 'ExpError';
    this.code = code;
    this.errors = errors;
  }
}

const originals = new WeakMap();
const codecMaps = new Map();
const fields = Object.freeze(['name', 'precursor', 'product', 'cv', 'ce']);
const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const forbiddenText = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const indexedPatterns = [
  /^(SIRMass)(\d+)$/, /^(SIRMass_2_)(\d+)$/, /^(SIRAutoDwell)(\d+)$/,
  /^(SIRDwellTime)(\d+)$/, /^(SIRDelay)(\d+)$/, /^(UseAsLockMass)(\d+)$/,
  /^(UseSampleList_2)(\d+)$/, /^(UseSampleList)(\d+)$/,
  /^(UseSLMassesP_)(\d+)$/, /^(UseSLMassesD_)(\d+)$/, /^(Mass\(amu\)_)(\d+)$/,
  /^(Mass2\(amu\)_)(\d+)$/, /^(AutoDwell_)(\d+)$/, /^(Dwell\(s\)_)(\d+)$/,
  /^(ConeVoltage\(V\)_)(\d+)$/, /^(CollisionEnergy\(eV\)_)(\d+)$/,
  /^(InterChannelDelay\(s\)_)(\d+)$/, /^(CompoundName_)(\d+)$/,
  /^(CompoundFormula_)(\d+)$/, /^(CompoundComment_)(\d+)$/,
];
const fieldKeys = {
  name: i => ['CompoundName_' + i],
  precursor: i => ['Mass(amu)_' + i, 'SIRMass' + i],
  product: i => ['Mass2(amu)_' + i, 'SIRMass_2_' + i],
  cv: i => ['ConeVoltage(V)_' + i],
  ce: i => ['CollisionEnergy(eV)_' + i],
};

function fail(code, message) { throw new ExpError(code, message); }
function originalOf(doc) {
  const original = originals.get(doc);
  if (!original) fail('DOCUMENT', 'この文書は parseExp で読み込まれた文書ではありません。');
  return original;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function copyBytes(input) {
  const bytes = input instanceof Uint8Array ? new Uint8Array(input) :
    input instanceof ArrayBuffer ? new Uint8Array(input.slice(0)) : null;
  if (!bytes) fail('INPUT', '.exp は ArrayBuffer または Uint8Array で指定してください。');
  if (!bytes.length) fail('EMPTY', 'ファイルが空です。');
  if (bytes.length > MAX_EXP_BYTES) fail('SIZE', '.exp の上限は 1 MiB です。');
  return bytes;
}
function detectEncoding(bytes, requested) {
  if (!SUPPORTED_ENCODINGS.includes(requested)) fail('ENCODING', '未対応の文字コードです。');
  let bomEncoding = null, bomLength = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { bomEncoding = 'utf-8'; bomLength = 3; }
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { bomEncoding = 'utf-16le'; bomLength = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { bomEncoding = 'utf-16be'; bomLength = 2; }
  if (bomEncoding && requested !== 'auto' && requested !== bomEncoding) fail('ENCODING', 'BOM と指定した文字コードが一致しません。');
  const encoding = bomEncoding || (requested === 'auto' ? 'utf-8' : requested);
  if (encoding.startsWith('utf-16') && (bytes.length - bomLength) % 2) fail('ENCODING', 'UTF-16 のバイト数が不正です。');
  let decoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
    decoder.decode(bytes.subarray(bomLength));
  } catch {
    fail('ENCODING', requested === 'auto'
      ? 'UTF-8 として読み取れません。文字コードを Shift_JIS または Windows-1252 などに指定してください。'
      : '指定した文字コードで読み取れません。');
  }
  return { encoding, bomLength, decoder };
}

// CR/LF/comma cannot occur as a trailing byte of Shift_JIS characters. UTF-16
// is scanned in 16-bit units; this avoids false delimiters inside other glyphs.
function readLines(bytes, encoding, bomLength, decoder) {
  const wide = encoding.startsWith('utf-16'), step = wide ? 2 : 1;
  const unit = pos => wide ? (encoding === 'utf-16le' ? bytes[pos] + bytes[pos + 1] * 256 : bytes[pos] * 256 + bytes[pos + 1]) : bytes[pos];
  const lines = [];
  let start = bomLength;
  while (start < bytes.length) {
    if (lines.length >= MAX_EXP_LINES) fail('SIZE', '.exp の行数が上限 50,000 行を超えています。');
    let end = start;
    while (end < bytes.length && unit(end) !== 10 && unit(end) !== 13) end += step;
    let eolEnd = end;
    if (end < bytes.length) {
      eolEnd += step;
      if (unit(end) === 13 && eolEnd < bytes.length && unit(eolEnd) === 10) eolEnd += step;
    }
    let comma = start;
    while (comma < end && unit(comma) !== 44) comma += step;
    const text = decoder.decode(bytes.subarray(start, end));
    if (text.includes('\0')) fail('BINARY', 'NUL を含むファイルは対応していません。文字コードを確認してください。');
    const hasComma = comma < end;
    const key = hasComma ? decoder.decode(bytes.subarray(start, comma)).trim() : text.trim();
    lines.push({ start, end, eolEnd, key, text, keyEnd: comma, valueStart: hasComma ? comma + step : end,
      value: hasComma ? decoder.decode(bytes.subarray(comma + step, end)) : null });
    start = eolEnd;
  }
  return lines;
}

function finiteNumber(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const text = String(raw).trim();
  if (text.length > 128 || !numberPattern.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
// Compare decimals without IEEE-754 rounding. Source numeric tokens remain
// strings, including values with more significant digits than a JS Number.
function canonicalNumber(value) {
  if (finiteNumber(value) === null) return null;
  const raw = String(value).trim();
  const match = raw.match(/^([+-]?)(\d*(?:\.\d*)?)(?:[eE]([+-]?\d+))?$/);
  const parts = match[2].split('.');
  let digits = (parts[0] + (parts[1] || '')).replace(/^0+/, '');
  if (!digits) return '0';
  const trailing = digits.match(/0*$/)[0].length;
  digits = digits.slice(0, digits.length - trailing);
  const exponent = BigInt(match[3] || '0') - BigInt((parts[1] || '').length) + BigInt(trailing);
  return (match[1] === '-' ? '-' : '') + digits + 'e' + exponent;
}
function requireNumber(line, key, positive = false) {
  const value = finiteNumber(line.value);
  if (value === null || (positive && value <= 0)) fail('VALUE', `${key} の数値が不正です。`);
  return value;
}
function requireLine(map, key) {
  const line = map.get(key);
  if (!line || line.value === null) fail('MISSING_KEY', `必須項目 ${key} がありません。`);
  return line;
}
function sameValue(a, b, field) { return field === 'name' ? a === b : canonicalNumber(a) === canonicalNumber(b); }

function findPolarity(lines, warnings) {
  const found = new Set();
  for (const line of lines) {
    if (!/^(?:Polarity|IonMode|IonPolarity|IonizationMode)$/i.test(line.key) || line.value === null) continue;
    const raw = line.value.trim().toLowerCase();
    if (['+', 'positive', 'pos', 'es+', 'esi+'].includes(raw)) found.add('positive');
    else if (['-', 'negative', 'neg', 'es-', 'esi-'].includes(raw)) found.add('negative');
    else warnings.push(`極性の値「${line.value}」を判定できません。`);
  }
  if (found.size > 1) fail('POLARITY', '複数の異なる極性があり、単一 Function として扱えません。');
  if (!found.size) warnings.push('極性はファイルから確定できません。ライブラリとの照合時に確認してください。');
  return [...found][0] || null;
}

export function parseExp(input, options = {}) {
  const bytes = copyBytes(input);
  const filename = typeof options.filename === 'string' ? options.filename : '';
  const { encoding, bomLength, decoder } = detectEncoding(bytes, options.encoding || 'auto');
  const lines = readLines(bytes, encoding, bomLength, decoder);
  const map = new Map(), warnings = [];
  for (const line of lines) {
    const isKnown = ['NumSIRMasses', 'NoOfChannels', 'FunctionScanTime(sec)'].includes(line.key)
      || /^(?:NumFunctions|NoOfFunctions|NumberOfFunctions|FunctionCount|FunctionType|ScanType|FunctionNumber|FunctionIndex)$/i.test(line.key)
      || indexedPatterns.some(pattern => pattern.test(line.key));
    if (isKnown && map.has(line.key)) fail('DUPLICATE_KEY', `${line.key} が複数あります。複数 Function または重複した項目は未対応です。`);
    if (isKnown) map.set(line.key, line);
    if (/^(?:NumFunctions|NoOfFunctions|NumberOfFunctions|FunctionCount)$/i.test(line.key)) {
      if (finiteNumber(line.value) !== 1) fail('FUNCTIONS', '複数 Function または不明な Function 数は未対応です。');
    }
    // Reject explicit function boundaries beyond 1 even if another function
    // contains a scan instead of MRM and therefore has no duplicate MRM keys.
    const fn = line.text.match(/^\s*\[?Function[\s_]*(\d+)(?:\]|:|,|\s|$)/i);
    if (fn && Number(fn[1]) !== 1) fail('FUNCTIONS', '複数 Function の .exp は未対応です。');
    if (/^(?:FunctionNumber|FunctionIndex)$/i.test(line.key) && finiteNumber(line.value) !== 1) fail('FUNCTIONS', '単一の Function 1 のみ対応しています。');
    if (/^(?:FunctionType|ScanType)$/i.test(line.key) && !/^(?:MRM|SRM)$/i.test((line.value || '').trim())) {
      fail('FUNCTION_TYPE', 'この Function 種別は未対応です。MRM/SRM と明示された形式のみ編集できます。');
    }
    if (/(?:UseSampleList|UseSLMasses|SLAuto|UseAsLockMass)/i.test(line.key)) {
      if (line.value === null || !/^(?:0+(?:\.0*)?|false|no|off)$/i.test(line.value.trim())) {
        fail('DEPENDENT_VALUE', `${line.key} が有効または不明です。サンプルリスト参照・LockMass の値は安全に編集できません。`);
      }
    }
  }
  const count = requireNumber(requireLine(map, 'NoOfChannels'), 'NoOfChannels', true);
  const sirCount = requireNumber(requireLine(map, 'NumSIRMasses'), 'NumSIRMasses', true);
  if (!Number.isInteger(count) || count !== sirCount || count > MAX_EXP_CHANNELS) fail('COUNT', 'チャンネル数が不正または NumSIRMasses と一致しません。');
  for (const line of lines) {
    for (const pattern of indexedPatterns) {
      const match = line.key.match(pattern);
      if (!match) continue;
      const index = Number(match[2]);
      if (!Number.isInteger(index) || index < 1 || index > count || String(index) !== match[2]) {
        fail('CHANNEL_INDEX', `${line.key} の番号がチャンネル数と整合しません。`);
      }
      break;
    }
  }
  const rows = [];
  for (let i = 1; i <= count; i++) {
    const row = { id: `channel-${i}`, channel: i };
    for (const field of fields) {
      const keys = fieldKeys[field](i);
      const values = keys.map(key => {
        const line = requireLine(map, key);
        if (field === 'name') {
          if (forbiddenText.test(line.value) || line.value.length > 1024) fail('VALUE', `${key} が長すぎるか、制御文字が含まれています。`);
          return line.value;
        }
        requireNumber(line, key, field === 'precursor' || field === 'product');
        return line.value.trim();
      });
      if (values.some(value => !sameValue(value, values[0], field))) fail('MASS_MISMATCH', `${keys.join(' / ')} の値が一致しません。`);
      row[field] = values[0];
    }
    const optional = key => map.get(key)?.value ?? null;
    row.details = {
      dwell: optional(`Dwell(s)_${i}`), delay: optional(`InterChannelDelay(s)_${i}`),
      autoDwell: optional(`AutoDwell_${i}`), formula: optional(`CompoundFormula_${i}`),
      comment: optional(`CompoundComment_${i}`),
      sirDwell: optional(`SIRDwellTime${i}`), sirDelay: optional(`SIRDelay${i}`), sirAutoDwell: optional(`SIRAutoDwell${i}`),
    };
    for (const [sir, mrm] of [['sirDwell', 'dwell'], ['sirDelay', 'delay'], ['sirAutoDwell', 'autoDwell']]) {
      if (row.details[sir] !== null && row.details[mrm] !== null && row.details[sir].trim() !== row.details[mrm].trim()
          && (finiteNumber(row.details[sir]) === null || canonicalNumber(row.details[sir]) !== canonicalNumber(row.details[mrm]))) {
        fail('SETTING_MISMATCH', `チャンネル ${i} の SIR と MRM の ${mrm} が一致しません。`);
      }
    }
    rows.push(row);
  }
  const polarity = findPolarity(lines, warnings);
  warnings.push('実ファイル・対象 MassLynx での互換性確認が必要です。任意の行追加・削除・並べ替えには対応していません。チェックした行だけの出力は、既知の項目と固定Dwellの時間設定を検証できる形式に限ります。');
  const doc = freeze({ version: 1, parserVersion: PARSER_VERSION, profile: 'flat-mrm-v1', filename, encoding,
    bom: bomLength > 0, byteLength: bytes.length, rows, polarity, warnings,
    capabilities: { editValues: true, structural: false, selectedExport: 'validated-profile', reason: '任意の行追加・削除・並べ替えは未対応です。選択した行だけの出力は、既知の項目・固定Dwell・チャンネルごとの時間合計を検証できる場合に利用できます。' },
  });
  originals.set(doc, { bytes, encoding, bomLength, map, lines });
  return doc;
}

export function createDraft(doc) {
  originalOf(doc);
  return doc.rows.map(row => ({ ...row, details: { ...row.details } }));
}

function hasUnpairedSurrogate(text) {
  for (let i = 0; i < text.length; i++) {
    const n = text.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (n >= 0xdc00 && n <= 0xdfff) return true;
  }
  return false;
}

function legacyCodec(encoding) {
  if (codecMaps.has(encoding)) return codecMaps.get(encoding);
  const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
  const map = new Map();
  const add = bytes => {
    try {
      const decoded = decoder.decode(Uint8Array.from(bytes));
      if ([...decoded].length === 1 && !map.has(decoded)) map.set(decoded, Uint8Array.from(bytes));
    } catch { /* An invalid sequence is not an encoding candidate. */ }
  };
  for (let i = 0; i <= 255; i++) add([i]);
  if (encoding === 'shift_jis') {
    for (let lead = 0x81; lead <= 0xfc; lead++) {
      if (lead > 0x9f && lead < 0xe0) continue;
      for (let trail = 0x40; trail <= 0xfc; trail++) if (trail !== 0x7f) add([lead, trail]);
    }
  }
  codecMaps.set(encoding, map);
  return map;
}

function encodeValue(text, encoding) {
  if (hasUnpairedSurrogate(text)) fail('ENCODING_VALUE', '不正な Unicode 文字が含まれています。');
  if (encoding === 'utf-8') return new TextEncoder().encode(text);
  if (encoding.startsWith('utf-16')) {
    const out = new Uint8Array(text.length * 2), little = encoding === 'utf-16le';
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      out[i * 2 + (little ? 0 : 1)] = code & 255;
      out[i * 2 + (little ? 1 : 0)] = code >> 8;
    }
    return out;
  }
  const codec = legacyCodec(encoding), chunks = [];
  let length = 0;
  for (const char of text) {
    const chunk = codec.get(char);
    if (!chunk) fail('ENCODING_VALUE', `文字「${char}」は元の文字コード ${encoding} で保存できません。`);
    chunks.push(chunk); length += chunk.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

export function validateEdits(doc, rows) {
  const original = originalOf(doc), errors = [];
  let changedCells = 0;
  if (!Array.isArray(rows) || rows.length !== doc.rows.length) {
    return { valid: false, errors: [{ rowId: null, field: null, message: '行の追加・削除は未対応です。' }], changedCells };
  }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const base = doc.rows[index];
    if (!row || typeof row !== 'object' || row.id !== base.id) {
      errors.push({ rowId: base.id, field: null, message: '行の入れ替えまたは識別子の変更は未対応です。' });
      continue;
    }
    for (const field of fields) {
      const value = row[field];
      let message = null;
      if (field === 'name') {
        if (typeof value !== 'string') message = '化合物名は文字列で指定してください。';
        else if (value.length > 1024) message = '化合物名は 1,024 文字以内で指定してください。';
        else if (forbiddenText.test(value)) message = '化合物名に改行・制御文字は使用できません。';
        else if (hasUnpairedSurrogate(value)) message = '化合物名に不正な Unicode 文字が含まれています。';
      } else {
        const number = finiteNumber(value);
        if (number === null) message = '有限の数値を入力してください。空欄は使用できません。';
        else if ((field === 'precursor' || field === 'product') && number <= 0) message = '質量は 0 より大きい数値を入力してください。';
      }
      if (!message && !sameValue(value, base[field], field)) {
        try { encodeValue(field === 'name' ? value : String(value).trim(), original.encoding); }
        catch (error) { message = error.message; }
        if (!message) changedCells++;
      }
      if (message) errors.push({ rowId: row.id, field, message });
    }
  }
  return { valid: !errors.length, errors, changedCells };
}

function patchesFor(doc, rows) {
  const original = originalOf(doc), patches = [];
  rows.forEach((row, index) => {
    const base = doc.rows[index];
    for (const field of fields) {
      if (sameValue(row[field], base[field], field)) continue;
      for (const key of fieldKeys[field](index + 1)) {
        const line = original.map.get(key);
        // Preserve whitespace around numeric tokens; names own their entire value.
        const leading = field === 'name' ? '' : line.value.match(/^\s*/)[0];
        const trailing = field === 'name' ? '' : line.value.match(/\s*$/)[0];
        const replacement = field === 'name' ? row[field] : String(row[field]).trim();
        const bytes = encodeValue(leading + replacement + trailing, original.encoding);
        patches.push({ start: line.valueStart, end: line.end, bytes });
      }
    }
  });
  return patches.sort((a, b) => a.start - b.start);
}
function applyPatches(bytes, patches) {
  const length = patches.reduce((n, patch) => n + patch.bytes.length - (patch.end - patch.start), bytes.length);
  if (length > MAX_EXP_BYTES) fail('SIZE', '編集後の .exp が 1 MiB を超えます。');
  const out = new Uint8Array(length);
  let inputOffset = 0, outputOffset = 0;
  for (const patch of patches) {
    if (patch.start < inputOffset || patch.end < patch.start) fail('PATCH', '編集位置が重複しています。');
    out.set(bytes.subarray(inputOffset, patch.start), outputOffset);
    outputOffset += patch.start - inputOffset;
    out.set(patch.bytes, outputOffset);
    outputOffset += patch.bytes.length;
    inputOffset = patch.end;
  }
  out.set(bytes.subarray(inputOffset), outputOffset);
  return out;
}

export function verifyExport(doc, output, rows) {
  const original = originalOf(doc), validation = validateEdits(doc, rows);
  if (!validation.valid) throw new ExpError('EDITS', '入力内容を修正してください。', validation.errors);
  const bytes = copyBytes(output), expected = applyPatches(original.bytes, patchesFor(doc, rows));
  if (bytes.length !== expected.length || bytes.some((value, i) => value !== expected[i])) {
    fail('EXPORT_CHANGED', '編集対象以外のバイト列が変更されています。');
  }
  const parsed = parseExp(bytes, { filename: doc.filename, encoding: doc.encoding });
  for (let i = 0; i < rows.length; i++) {
    for (const field of fields) if (!sameValue(parsed.rows[i][field], rows[i][field], field)) {
      fail('EXPORT_VALUE', `出力したチャンネル ${i + 1} の ${field} が編集内容と一致しません。`);
    }
  }
  return { valid: true, changedCells: validation.changedCells };
}

export function writeEditedExp(doc, rows) {
  const original = originalOf(doc), validation = validateEdits(doc, rows);
  if (!validation.valid) throw new ExpError('EDITS', '入力内容を修正してください。', validation.errors);
  const output = applyPatches(original.bytes, patchesFor(doc, rows));
  verifyExport(doc, output, rows);
  return output;
}

// Structural export is deliberately stricter than value editing: an unknown
// scalar can depend on channel numbers too (for example ChannelOrder,2,1).
const selectionScalars = /^(?:NumFunctions|NoOfFunctions|NumberOfFunctions|FunctionCount|FunctionType|ScanType|FunctionNumber|FunctionIndex|Polarity|IonMode|IonPolarity|IonizationMode)$/i;
const selectionFunctionMarker = /^(?:\[Function[ _]*1\]|Function[ _]*1:?)$/i;
// A section title has no channel-dependent value. Recognize this reported
// header explicitly; it does not exempt the records following it from checks.
const selectionGeneralHeader = /^(?:GENERAL INFORMATION|\[GENERAL INFORMATION\])$/i;
const MAX_TIMING_SCALE = 128;
function indexedKey(key) {
  for (const pattern of indexedPatterns) {
    const match = key.match(pattern);
    if (match) return { prefix: match[1], index: Number(match[2]) };
  }
  return null;
}
function timingDecimal(raw, key, positive = false) {
  const number = finiteNumber(raw);
  if (number === null || number < 0 || (positive && number <= 0)) {
    fail('SELECTION_TIMING', `${key} は${positive ? '正の' : '0以上の'}固定時間である必要があります。`);
  }
  const match = String(raw).trim().match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  const exponent = BigInt(match[4] || '0');
  if (exponent > BigInt(MAX_TIMING_SCALE) || exponent < -BigInt(MAX_TIMING_SCALE)) {
    fail('SELECTION_TIMING', `${key} の時間表記が検証可能な精度を超えています。`);
  }
  let scale = (match[3] || '').length - Number(exponent);
  if (Math.abs(scale) > MAX_TIMING_SCALE) fail('SELECTION_TIMING', `${key} の時間表記が検証可能な精度を超えています。`);
  let units = BigInt((match[2] || '') + (match[3] || ''));
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
  while (scale && units % 10n === 0n) { units /= 10n; scale--; }
  return { units, scale };
}
function addTimings(values) {
  const scale = Math.max(0, ...values.map(value => value.scale));
  const units = values.reduce((sum, value) => sum + value.units * 10n ** BigInt(scale - value.scale), 0n);
  return { units, scale };
}
function equalTimings(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return a.units * 10n ** BigInt(scale - a.scale) === b.units * 10n ** BigInt(scale - b.scale);
}
function formatTiming(value) {
  if (!value.scale) return String(value.units);
  const digits = String(value.units).padStart(value.scale + 1, '0');
  return (digits.slice(0, -value.scale) + '.' + digits.slice(-value.scale)).replace(/0+$/, '').replace(/\.$/, '');
}
function selectionTiming(doc) {
  const original = originalOf(doc), seen = new Set();
  for (const line of original.lines) {
    if (!line.text.trim() || /^\s*(?:;|#|\/\/)/.test(line.text)) continue;
    if (line.value === null && selectionFunctionMarker.test(line.text.trim())) continue;
    if (selectionGeneralHeader.test(line.key) && (line.value === null || !line.value.trim())) {
      if (seen.has('general information')) fail('SELECTION_PROFILE', 'GENERAL INFORMATION が複数あるため、選択行だけの出力には対応していません。');
      seen.add('general information');
      continue;
    }
    if (indexedKey(line.key)) continue;
    if (line.value === null || (!['NumSIRMasses', 'NoOfChannels', 'FunctionScanTime(sec)'].includes(line.key) && !selectionScalars.test(line.key))) {
      fail('SELECTION_PROFILE', `項目「${line.key}」のチャンネル依存を確認できないため、選択行だけの出力には対応していません。`);
    }
    const identity = line.key.toLowerCase();
    if (seen.has(identity)) fail('SELECTION_PROFILE', `項目「${line.key}」が重複しているため、選択行だけの出力には対応していません。`);
    seen.add(identity);
  }
  const timings = doc.rows.map(row => {
    const i = row.channel;
    for (const key of [`SIRAutoDwell${i}`, `AutoDwell_${i}`]) {
      if (canonicalNumber(requireLine(original.map, key).value) !== '0') {
        fail('SELECTION_TIMING', `${key} が明示的な0ではありません。選択行だけの出力は固定Dwellに限ります。`);
      }
    }
    const dwell = timingDecimal(requireLine(original.map, `Dwell(s)_${i}`).value, `Dwell(s)_${i}`, true);
    const sirDwell = timingDecimal(requireLine(original.map, `SIRDwellTime${i}`).value, `SIRDwellTime${i}`, true);
    const delay = timingDecimal(requireLine(original.map, `InterChannelDelay(s)_${i}`).value, `InterChannelDelay(s)_${i}`);
    const sirDelay = timingDecimal(requireLine(original.map, `SIRDelay${i}`).value, `SIRDelay${i}`);
    if (!equalTimings(dwell, sirDwell) || !equalTimings(delay, sirDelay)) fail('SELECTION_TIMING', `チャンネル ${i} のSIRとMRMの時間設定が一致しません。`);
    return addTimings([dwell, delay]);
  });
  const scan = timingDecimal(requireLine(original.map, 'FunctionScanTime(sec)').value, 'FunctionScanTime(sec)', true);
  if (!equalTimings(scan, addTimings(timings))) {
    fail('SELECTION_TIMING', 'FunctionScanTime(sec) が全チャンネルのDwellとDelayの合計に一致しません。時間設定の意味を確定できないため、選択行だけの出力には対応していません。');
  }
  return timings;
}
function selectedContext(doc, rows, selectedIds) {
  originalOf(doc);
  const errors = [], known = new Set(doc.rows.map(row => row.id)), selected = new Set();
  const error = message => errors.push({ rowId: null, field: null, message });
  if (!Array.isArray(selectedIds)) error('選択行の識別子は配列で指定してください。');
  else for (const id of selectedIds) {
    if (typeof id !== 'string' || !known.has(id)) error('不明な行が選択されています。ファイルを読み直してください。');
    else if (selected.has(id)) error('同じ行が重複して選択されています。');
    else selected.add(id);
  }
  if (!selected.size) error('出力するMRMを1行以上チェックしてください。');
  const selectedCount = selected.size, excludedCount = doc.rows.length - selectedCount;
  let effectiveRows = [], changedCells = 0, timings = null;
  if (!Array.isArray(rows) || rows.length !== doc.rows.length) error('行の追加・削除は未対応です。チェックで出力対象を選択してください。');
  else {
    effectiveRows = doc.rows.map((base, index) => {
      const row = rows[index];
      if (!row || typeof row !== 'object' || row.id !== base.id) {
        errors.push({ rowId: base.id, field: null, message: '行の入れ替えまたは識別子の変更は未対応です。' });
        return base;
      }
      return selected.has(base.id) ? row : base;
    });
    const validation = validateEdits(doc, effectiveRows);
    errors.push(...validation.errors); changedCells = validation.changedCells;
  }
  if (!errors.length && excludedCount) {
    try { timings = selectionTiming(doc); }
    catch (issue) {
      if (!(issue instanceof ExpError)) throw issue;
      error(issue.message);
    }
  }
  return { valid: !errors.length, errors, selectedCount, excludedCount, changedCells, selected, effectiveRows, timings };
}

/** Validate selected values, plus the strict structural profile for a subset. */
export function validateSelectedExport(doc, rows, selectedIds) {
  const { valid, errors, selectedCount, excludedCount, changedCells } = selectedContext(doc, rows, selectedIds);
  return { valid, errors, selectedCount, excludedCount, changedCells };
}
function numericPatch(line, value, encoding) {
  const leading = line.value.match(/^\s*/)[0], trailing = line.value.match(/\s*$/)[0];
  return { start: line.valueStart, end: line.end, bytes: encodeValue(leading + value + trailing, encoding) };
}
function channelSuffixSpan(original, line, index) {
  const wide = original.encoding.startsWith('utf-16'), step = wide ? 2 : 1;
  const unit = pos => wide ? (original.encoding === 'utf-16le'
    ? original.bytes[pos] + original.bytes[pos + 1] * 256
    : original.bytes[pos] * 256 + original.bytes[pos + 1]) : original.bytes[pos];
  const digit = pos => pos >= line.start && unit(pos) >= 48 && unit(pos) <= 57;
  let end = line.keyEnd;
  while (end > line.start && !digit(end - step)) end -= step;
  // UseSampleList_2<index> contains a literal digit in its prefix.
  return { start: end - String(index).length * step, end };
}
function selectedPatches(doc, context) {
  const original = originalOf(doc), patches = patchesFor(doc, context.effectiveRows), numbers = new Map();
  const kept = doc.rows.filter(row => context.selected.has(row.id));
  kept.forEach((row, index) => numbers.set(row.channel, index + 1));
  for (const line of original.lines) {
    const entry = indexedKey(line.key);
    if (!entry) continue;
    if (!numbers.has(entry.index)) patches.push({ start: line.start, end: line.eolEnd, bytes: new Uint8Array() });
    else if (numbers.get(entry.index) !== entry.index) patches.push({ ...channelSuffixSpan(original, line, entry.index), bytes: encodeValue(String(numbers.get(entry.index)), original.encoding) });
  }
  for (const key of ['NumSIRMasses', 'NoOfChannels']) patches.push(numericPatch(original.map.get(key), String(kept.length), original.encoding));
  const selectedTime = addTimings(kept.map(row => context.timings[row.channel - 1]));
  patches.push(numericPatch(original.map.get('FunctionScanTime(sec)'), formatTiming(selectedTime), original.encoding));
  return patches.sort((a, b) => a.start - b.start);
}
function verifySelectedOutput(doc, output, context) {
  const original = originalOf(doc), expected = applyPatches(original.bytes, selectedPatches(doc, context));
  if (output.length !== expected.length || output.some((value, i) => value !== expected[i])) fail('EXPORT_CHANGED', '選択出力の対象以外のバイト列が変更されています。');
  const parsed = parseExp(output, { filename: doc.filename, encoding: doc.encoding });
  const kept = context.effectiveRows.filter(row => context.selected.has(row.id));
  if (parsed.rows.length !== kept.length) fail('EXPORT_VALUE', '出力したチャンネル数が選択数と一致しません。');
  kept.forEach((row, index) => {
    for (const field of fields) if (!sameValue(parsed.rows[index][field], row[field], field)) fail('EXPORT_VALUE', `出力したチャンネル ${index + 1} の ${field} が選択内容と一致しません。`);
    const base = doc.rows.find(item => item.id === row.id);
    for (const key of Object.keys(base.details)) if (parsed.rows[index].details[key] !== base.details[key]) fail('EXPORT_VALUE', `出力したチャンネル ${index + 1} の ${key} が原本と一致しません。`);
  });
  // A generated subset must also satisfy the same timing/profile invariant.
  selectionTiming(parsed);
}

/** Export checked rows in source order; leave the original and draft intact. */
export function writeSelectedExp(doc, rows, selectedIds) {
  const context = selectedContext(doc, rows, selectedIds);
  if (!context.valid) throw new ExpError('SELECTION', '選択したMRMを出力できません。', context.errors);
  if (!context.excludedCount) return writeEditedExp(doc, rows);
  const output = applyPatches(originalOf(doc).bytes, selectedPatches(doc, context));
  verifySelectedOutput(doc, output, context);
  return output;
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function fromBase64(value) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(MAX_EXP_BYTES / 3)
      || !value.length || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) {
    fail('SNAPSHOT', '保存データの原本が不正または上限を超えています。');
  }
  const padding = value.indexOf('=');
  if (padding !== -1 && !/^={1,2}$/.test(value.slice(padding))) fail('SNAPSHOT', '保存データの Base64 が不正です。');
  let binary;
  try { binary = atob(value); } catch { fail('SNAPSHOT', '保存データの原本が不正です。'); }
  if (btoa(binary) !== value) fail('SNAPSHOT', '保存データの Base64 が不正です。');
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function snapshotRows(rows) {
  return rows.map(row => Object.fromEntries(['id', ...fields].map(key => [key, row[key]])));
}
export function serializeDocument(doc, rows) {
  const original = originalOf(doc), validation = validateEdits(doc, rows);
  if (!validation.valid) throw new ExpError('EDITS', '入力内容を修正してから保存してください。', validation.errors);
  return { version: 1, parserVersion: PARSER_VERSION, profile: doc.profile,
    filename: doc.filename, encoding: doc.encoding, originalBase64: toBase64(original.bytes), rows: snapshotRows(rows) };
}
export function restoreDocument(payload) {
  if (!payload || typeof payload !== 'object' || payload.version !== 1 || payload.parserVersion !== PARSER_VERSION
      || payload.profile !== 'flat-mrm-v1' || typeof payload.filename !== 'string' || payload.filename.length > 4096
      || !SUPPORTED_ENCODINGS.includes(payload.encoding) || payload.encoding === 'auto'
      || !Array.isArray(payload.rows) || payload.rows.length > MAX_EXP_CHANNELS) {
    fail('SNAPSHOT', '保存データの形式またはバージョンが未対応です。');
  }
  const doc = parseExp(fromBase64(payload.originalBase64), { filename: payload.filename, encoding: payload.encoding });
  const validation = validateEdits(doc, payload.rows);
  if (!validation.valid) throw new ExpError('SNAPSHOT', '保存データの編集内容が不正です。', validation.errors);
  const rows = createDraft(doc);
  rows.forEach((row, index) => { for (const field of fields) row[field] = payload.rows[index][field]; });
  return { document: doc, rows };
}
