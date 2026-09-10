// Source scalars never coerce missing cells to zero. The token and status are
// retained beside the IEEE 754 calculation value; original file bytes remain
// the authority for lexical decimal precision and workbook cell information.
export function msiSourceCell(raw) {
    const type = raw === null ? 'null' : typeof raw;
    const token = raw === undefined || raw === null ? null : (Object.is(raw, -0) ? '-0' : String(raw));
    let status = 'valid', value = NaN;
    if (raw === null || raw === undefined) status = 'missing';
    else if (typeof raw === 'number') {
        if (Number.isFinite(raw)) value = raw;
        else status = 'nonfinite';
    } else if (typeof raw === 'bigint') {
        if (raw <= BigInt(Number.MAX_SAFE_INTEGER) && raw >= BigInt(Number.MIN_SAFE_INTEGER)) value = Number(raw);
        else status = 'unsafe-integer';
    } else if (typeof raw === 'string') {
        const text = raw.trim();
        if (!text) status = 'blank';
        else if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) status = /^(?:[+-]?Infinity|NaN)$/i.test(text) ? 'nonfinite' : 'invalid';
        else {
            const n = Number(text);
            if (!Number.isFinite(n)) status = 'nonfinite';
            else if (Number.isInteger(n) && !Number.isSafeInteger(n)) status = 'unsafe-integer';
            else value = n;
        }
    } else status = 'unsupported-type';
    return { type, status, token, value };
}

export function msiSourceNumber(raw) {
    return msiSourceCell(raw).value;
}

export function msiSourceRow(xRaw, yRaw, vRaw, rowId) {
    const x = msiSourceCell(xRaw), y = msiSourceCell(yRaw), v = msiSourceCell(vRaw);
    return { x: x.value, y: y.value, v: v.value, rowId,
        sourceCells: { x, y, v }, precisionBlocked: v.status === 'unsafe-integer' || v.status === 'unsupported-type' };
}

// RFC 4180 field handling also accepts TSV. Embedded newlines and escaped
// quotes stay inside a record; an end-of-file newline is not a measurement row.
export function msiDelimitedRecords(text, separator) {
    if (separator === 'ws') {
        const lines = text.split(/\r?\n/);
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        return lines.map(line => line.trim() ? line.trim().split(/\s+/) : ['']);
    }
    const records = [], row = [];
    let field = '', quoted = false, active = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            active = true;
            if (quoted && text[i + 1] === '"') { field += '"'; i++; }
            else if (quoted || !field) quoted = !quoted;
            else field += c;
        } else if (c === separator && !quoted) {
            row.push(field); field = ''; active = true;
        } else if ((c === '\r' || c === '\n') && !quoted) {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); records.push(row.splice(0)); field = ''; active = false;
        } else { field += c; active = true; }
    }
    if (quoted) throw new Error('unterminated quoted field in MSI text');
    if (active || row.length || field.length) { row.push(field); records.push(row); }
    return records;
}

export function msiTextTable(buf, def) {
    const raw = new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, '');
    const firstLine = raw.split(/\r?\n/, 1)[0] || '';
    const analyte = /Analyte\s*\(converted from imzML\)/i.test(firstLine) || def.kind === 'txt-analyte'
        || Number.isFinite(def.compound_index) || Number.isFinite(def.v_index);
    const firstNonempty = raw.split(/\r?\n/).find(line => line.trim()) || '';
    const sep = analyte || firstNonempty.includes('\t') ? '\t' : (firstNonempty.includes(',') ? ',' : 'ws');
    const all = msiDelimitedRecords(raw, sep);
    if (analyte) {
        const start = Number.isFinite(def.dataStartLine) ? def.dataStartLine : 4;
        return { analyte: true, header: [], xi: 1, yi: 2,
            records: all.slice(start).map((cells, i) => ({ cells, rowId: start + i })) };
    }
    const headerIdx = all.findIndex(row => row.some(v => v.trim()));
    if (headerIdx < 0) throw new Error('empty txt');
    const header = all[headerIdx].map(v => v.trim());
    const xi = header.indexOf(def.x || 'x'), yi = header.indexOf(def.y || 'y');
    if (xi < 0 || yi < 0) throw new Error('coordinate column not found in txt');
    return { analyte: false, header, xi, yi,
        records: all.slice(headerIdx + 1).map((cells, i) => ({ cells, rowId: headerIdx + 1 + i })) };
}

export function msiTextValueColumn(table, def) {
    if (table.analyte) return 3 + (Number.isFinite(def.compound_index) ? def.compound_index : (Number.isFinite(def.v_index) ? def.v_index : 0));
    const vi = def.v ? table.header.indexOf(def.v) : (table.header.length > 2 ? 2 : -1);
    if (vi < 0) throw new Error('value column not found in txt');
    return vi;
}

