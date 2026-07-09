// =============================================================================
// Waters MassLynx .exp builder — PORTED VERBATIM from the web app (mrm.html
// buildExp + helpers, lines ~1146-1255). Pure string functions, no DOM / no
// Supabase, so the connector produces a byte-identical .exp to the app.
//
// Keep this in lockstep with mrm.html's buildExp: any change to the app's
// substitution logic must be mirrored here (see connector/src/selftest.js for
// the parity check). This mirrors how msi.js ports the app's MSI parse logic.
// =============================================================================

function _expKey(line) { const i = line.indexOf(','); return i < 0 ? line : line.slice(0, i); }
function _expFirstValue(lines, key, dflt) {
  for (const ln of lines) { if (_expKey(ln) === key) { const i = ln.indexOf(','); return i < 0 ? '' : ln.slice(i + 1); } }
  return dflt;
}
function _expReplaceScalar(lines, key, value) {
  return lines.map(ln => (_expKey(ln) === key ? key + ',' + value : ln));
}
function _expFmt(x) {
  if (x == null || x === '') return '';
  const n = Number(x);
  return Number.isFinite(n) ? String(n) : String(x);
}
// Per-entry key membership for THIS fixed instrument's .exp (suffix = index).
function _isSirEntryKey(k) {
  return /^SIRMass\d+$/.test(k) || /^SIRMass_2_\d+$/.test(k) || /^SIRAutoDwell\d+$/.test(k)
    || /^SIRDwellTime\d+$/.test(k) || /^SIRDelay\d+$/.test(k) || /^UseAsLockMass\d+$/.test(k)
    || /^UseSampleList\d+$/.test(k) || /^UseSampleList_2\d+$/.test(k);
}
function _isChannelEntryKey(k) {
  return /^UseSLMassesP_\d+$/.test(k) || /^UseSLMassesD_\d+$/.test(k) || /^Mass\(amu\)_\d+$/.test(k)
    || /^Mass2\(amu\)_\d+$/.test(k) || /^AutoDwell_\d+$/.test(k) || /^Dwell\(s\)_\d+$/.test(k)
    || /^ConeVoltage\(V\)_\d+$/.test(k) || /^CollisionEnergy\(eV\)_\d+$/.test(k) || /^InterChannelDelay\(s\)_\d+$/.test(k)
    || /^CompoundName_\d+$/.test(k) || /^CompoundFormula_\d+$/.test(k) || /^CompoundComment_\d+$/.test(k);
}

// rows: [{ name, precursor, product, cv, ce }] in output order.
export function buildExp(templateText, rows) {
  if (!rows.length) throw new Error('トランジションが選択されていません');
  const crlf = /\r\n/.test(templateText);
  const lines = templateText.replace(/\r\n/g, '\n').split('\n');
  const n = rows.length;
  // Constant per-entry values are taken from the template's first entry.
  const d = {
    SIRAutoDwell: _expFirstValue(lines, 'SIRAutoDwell1', '0'),
    SIRDwellTime: _expFirstValue(lines, 'SIRDwellTime1', '0.0100'),
    SIRDelay: _expFirstValue(lines, 'SIRDelay1', '0.0037'),
    UseAsLockMass: _expFirstValue(lines, 'UseAsLockMass1', '0'),
    UseSampleList: _expFirstValue(lines, 'UseSampleList1', '0'),
    UseSampleList_2: _expFirstValue(lines, 'UseSampleList_21', '0'),
    UseSLMassesP: _expFirstValue(lines, 'UseSLMassesP_1', '0'),
    UseSLMassesD: _expFirstValue(lines, 'UseSLMassesD_1', '0'),
    AutoDwell: _expFirstValue(lines, 'AutoDwell_1', '0'),
    Dwell: _expFirstValue(lines, 'Dwell(s)_1', '0.0100'),
    InterChannelDelay: _expFirstValue(lines, 'InterChannelDelay(s)_1', '0.0037'),
  };
  const sirBlock = [];
  rows.forEach((r, idx) => {
    const i = idx + 1;
    sirBlock.push('SIRMass' + i + ',' + _expFmt(r.precursor));
    sirBlock.push('SIRMass_2_' + i + ',' + _expFmt(r.product));
    sirBlock.push('SIRAutoDwell' + i + ',' + d.SIRAutoDwell);
    sirBlock.push('SIRDwellTime' + i + ',' + d.SIRDwellTime);
    sirBlock.push('SIRDelay' + i + ',' + d.SIRDelay);
    sirBlock.push('UseAsLockMass' + i + ',' + d.UseAsLockMass);
    sirBlock.push('UseSampleList' + i + ',' + d.UseSampleList);
    sirBlock.push('UseSampleList_2' + i + ',' + d.UseSampleList_2);
  });
  const chBlock = [];
  rows.forEach((r, idx) => {
    const i = idx + 1;
    chBlock.push('UseSLMassesP_' + i + ',' + d.UseSLMassesP);
    chBlock.push('UseSLMassesD_' + i + ',' + d.UseSLMassesD);
    chBlock.push('Mass(amu)_' + i + ',' + _expFmt(r.precursor));
    chBlock.push('Mass2(amu)_' + i + ',' + _expFmt(r.product));
    chBlock.push('AutoDwell_' + i + ',' + d.AutoDwell);
    chBlock.push('Dwell(s)_' + i + ',' + d.Dwell);
    chBlock.push('ConeVoltage(V)_' + i + ',' + _expFmt(r.cv));
    chBlock.push('CollisionEnergy(eV)_' + i + ',' + _expFmt(r.ce));
    chBlock.push('InterChannelDelay(s)_' + i + ',' + d.InterChannelDelay);
    chBlock.push('CompoundName_' + i + ',' + (r.name || ('MRM_' + _expFmt(r.precursor) + '_' + _expFmt(r.product))));
    chBlock.push('');  // preserve the blank line after CompoundName
    chBlock.push('CompoundFormula_' + i + ',');
    chBlock.push('CompoundComment_' + i + ',');
  });
  // Span-replace the SIR block (at NumSIRMasses) and the MRM channel block
  // (at the first channel line), preserving file order + all other settings.
  let out = [];
  let i = 0, sirDone = false, chDone = false;
  while (i < lines.length) {
    const ln = lines[i];
    const key = _expKey(ln);
    if (!sirDone && key === 'NumSIRMasses') {
      out.push('NumSIRMasses,' + n);
      i++;
      while (i < lines.length && (_isSirEntryKey(_expKey(lines[i])) || lines[i].trim() === '')) i++;
      for (const b of sirBlock) out.push(b);
      sirDone = true;
      continue;
    }
    if (!chDone && _isChannelEntryKey(key)) {
      while (i < lines.length && (_isChannelEntryKey(_expKey(lines[i])) || lines[i].trim() === '')) i++;
      for (const b of chBlock) out.push(b);
      chDone = true;
      continue;
    }
    out.push(ln);
    i++;
  }
  out = _expReplaceScalar(out, 'NoOfChannels', String(n));
  const dwell = parseFloat(d.Dwell) || 0;
  const delay = parseFloat(d.InterChannelDelay) || 0;
  const tmplScan = _expFirstValue(out, 'FunctionScanTime(sec)', '0.1960');
  const dec = (/\.\d+/.test(tmplScan)) ? tmplScan.split('.')[1].length : 4;
  out = _expReplaceScalar(out, 'FunctionScanTime(sec)', (n * (dwell + delay)).toFixed(dec));

  let text = out.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  if (crlf) text = text.replace(/\n/g, '\r\n');
  return text;
}
