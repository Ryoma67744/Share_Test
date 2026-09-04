import { inflateRawSync } from 'node:zlib';

// =============================================================================
// Waters MassLynx .raw reader — PORTED VERBATIM from the web app
// (viewer/index.html, between the "waters-raw parser" sentinel comments) so the
// connector's numbers match what the app shows.
//
// To re-sync: copy the block between those sentinels, re-apply `export` to the
// functions below, and keep rawInflate on zlib. `npm run selftest` extracts the
// app's block live and diffs this module's output against it, so drift fails
// loudly rather than making the AI quote numbers the app never showed.
// =============================================================================

// Waters MassLynx .raw reader (Xevo TQ Absolute / DESI-MSI, MRM functions).
//
// A .raw is a DIRECTORY, so the app stores it as one ZIP and every re-parse
// reads members out of that ZIP. All of these are pure (no DOM, no canvas) so
// the parse Web Worker can run the exact same code as the main thread.
//
// Layout, reverse-engineered and verified byte-for-byte against a real
// acquisition (73x54 px, 8 MRM channels, 3942 scans). Everything is
// LITTLE-ENDIAN, and every multi-byte read goes through DataView on purpose:
// _FUNC001.STS has an ODD record stride (153), so `new Float32Array(buf, off, 1)`
// throws RangeError on most records.
//
//   _FUNCnnn.IDX   22 bytes per scan; nScans = size / 22
//                    u32 @0  byte offset into .DAT
//                    u32 @4  packed; nPeaks = v & 0x3FFFFF, bit27 = calibrated
//                    f32 @8  TIC (equals the sum of that scan's channels)
//                    f32 @12 retention time, MINUTES
//   _FUNCnnn.DAT   nScans * nPeaks u32 words:
//                    intensity = (w & 0x3FFFFF) * 2 ** ((w >>> 22) - 21)
//   _FUNCnnn.EE    "parameter table" (see parseWatersParamTable) whose records
//                  are CHANNELS: "Cone Voltage" (CV) and "Collision Energy" (CE)
//   _FUNCnnn.STS   the same parameter-table layout whose records are SCANS;
//                  "Aim X Position" / "Aim Y Position" are the DESI stage
//                  coordinates in mm — the authoritative source of the raster
//   _FUNCnnn.CMP   u32 version, u32 count, u32 unknown, then `count` fixed-width
//                  NUL-terminated compound names
//   _FUNCTNS.INF   416 bytes PER FUNCTION; u8 @0 type (9 = MRM),
//                  f32[32] @32 dwell(s), @160 precursor m/z, @288 product m/z
//                  -> at most 32 MRM channels in one function
//   _HEADER.TXT    "$$ Key: Value" lines
//   _extern.inf    method / source / [DESI Experiment Parameters] blocks
//   imaging/*.txt  optional text export; NEVER read here (it is derivable, and
//                  its values are rounded where the binary is exact)
//
// Only IDX + DAT + STS are required. Missing EE loses CV/CE, missing CMP loses
// names, missing _FUNCTNS.INF loses m/z — none of which is fatal.

// Waters writes 8-bit text (e.g. the degree sign in "Source Temperature (°C)"),
// which is windows-1252, not UTF-8. Decoding as UTF-8 corrupts those keys.
export function rawDecodeText(buf) {
    const bytes = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
    return new TextDecoder('windows-1252').decode(bytes);
}

// ★ THE ONLY INTENTIONAL DIVERGENCE from the app's copy. The browser inflates
// with DecompressionStream; Node uses zlib. Everything else in this file is
// byte-identical to the block in viewer/index.html.
async function rawInflate(bytes) {
    return new Uint8Array(inflateRawSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
}

// Index a ZIP from its CENTRAL DIRECTORY, never from local headers: a local
// header may carry a data descriptor with zeroed sizes, which some zip writers
// (including several GUI tools) emit. Returns Map<lowercased name, entry>.
export function rawZipIndex(buf) {
    const dv = new DataView(buf);
    const n = buf.byteLength;
    // End of central directory: scan back over the max comment length (65535).
    let eocd = -1;
    for (let i = n - 22; i >= Math.max(0, n - 22 - 65535); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('raw: not a ZIP (no end-of-central-directory)');
    let count = dv.getUint16(eocd + 10, true);
    let cdOffset = dv.getUint32(eocd + 16, true);
    // Zip64: the 32-bit fields saturate and the real values live in the Zip64
    // end-of-central-directory record found via the locator just before EOCD.
    if (cdOffset === 0xFFFFFFFF || count === 0xFFFF) {
        const loc = eocd - 20;
        if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) {
            throw new Error('raw: ZIP64 locator missing');
        }
        const z64 = Number(dv.getBigUint64(loc + 8, true));
        if (dv.getUint32(z64, true) !== 0x06064b50) throw new Error('raw: ZIP64 EOCD missing');
        count = Number(dv.getBigUint64(z64 + 32, true));
        cdOffset = Number(dv.getBigUint64(z64 + 48, true));
    }
    const entries = new Map();
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('raw: bad ZIP central directory');
        const flag = dv.getUint16(p + 8, true);
        const method = dv.getUint16(p + 10, true);
        let compSize = dv.getUint32(p + 20, true);
        let size = dv.getUint32(p + 24, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        let localOffset = dv.getUint32(p + 42, true);
        const nameBytes = new Uint8Array(buf, p + 46, nameLen);
        // Bit 11 promises UTF-8; otherwise it is CP437, but every name a Waters
        // .raw or our own writer produces is ASCII, where the two agree.
        const name = (flag & 0x800)
            ? new TextDecoder('utf-8').decode(nameBytes)
            : rawDecodeText(nameBytes);
        // Zip64 extra field: only the fields that saturated are present, in this order.
        let ex = p + 46 + nameLen;
        const exEnd = ex + extraLen;
        while (ex + 4 <= exEnd) {
            const id = dv.getUint16(ex, true);
            const len = dv.getUint16(ex + 2, true);
            if (id === 0x0001) {
                let q = ex + 4;
                if (size === 0xFFFFFFFF) { size = Number(dv.getBigUint64(q, true)); q += 8; }
                if (compSize === 0xFFFFFFFF) { compSize = Number(dv.getBigUint64(q, true)); q += 8; }
                if (localOffset === 0xFFFFFFFF) { localOffset = Number(dv.getBigUint64(q, true)); q += 8; }
                break;
            }
            ex += 4 + len;
        }
        if (!name.endsWith('/')) entries.set(name.toLowerCase(), { name, method, compSize, size, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

// Read one member. The local header is consulted ONLY for its variable-length
// field sizes, so the (possibly zeroed) sizes it carries are never trusted.
export async function rawZipRead(buf, entry) {
    const dv = new DataView(buf);
    if (dv.getUint32(entry.localOffset, true) !== 0x04034b50) {
        throw new Error('raw: bad ZIP local header for ' + entry.name);
    }
    const nameLen = dv.getUint16(entry.localOffset + 26, true);
    const extraLen = dv.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    if (entry.method === 0) return new Uint8Array(buf, start, entry.size);
    if (entry.method !== 8) throw new Error('raw: unsupported ZIP compression ' + entry.method);
    const out = await rawInflate(new Uint8Array(buf, start, entry.compSize));
    if (entry.size && out.length !== entry.size) {
        throw new Error('raw: ZIP size mismatch for ' + entry.name);
    }
    return out;
}

// A RawBundle is { rootName, names(): string[], read(name): Promise<ArrayBuffer> }
// where names are relative to the *.raw directory. Registration builds one over
// the loose files the user dropped; every later re-parse builds one over the
// stored ZIP. Everything downstream only sees this contract.
export function rawBundleFromZip(buf) {
    const entries = rawZipIndex(buf);
    // Strip the "<something>.raw/" prefix so member lookup is nesting-agnostic.
    let root = '';
    let rootName = '';
    for (const e of entries.values()) {
        const m = /^(.*?([^/]+)\.raw)\//i.exec(e.name);
        if (m) { root = m[1] + '/'; rootName = m[2]; break; }
    }
    const rel = (name) => (root && name.toLowerCase().startsWith(root.toLowerCase()))
        ? name.slice(root.length) : name;
    const byRel = new Map();
    for (const e of entries.values()) byRel.set(rel(e.name).toLowerCase(), e);
    return {
        rootName: rootName || 'raw',
        names: () => Array.from(byRel.values(), (e) => rel(e.name)),
        async read(name) {
            const e = byRel.get(String(name).toLowerCase());
            if (!e) throw new Error('raw: missing member ' + name);
            const bytes = await rawZipRead(buf, e);
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
    };
}

// Member lookup by SUFFIX so an extra directory level never breaks it.
export function rawFindMember(names, re) {
    for (const n of names) if (re.test(n.toLowerCase())) return n;
    return null;
}

// "$$ Key: Value" lines.
export function parseWatersHeaderTxt(text) {
    const out = {};
    for (const line of String(text).split(/\r?\n/)) {
        const m = /^\$\$\s*([^:]+):\s?(.*)$/.exec(line);
        if (m) out[m[1].trim()] = m[2].trim();
    }
    return out;
}

// _extern.inf is a sectioned text file. We keep the three blocks that carry
// acquisition conditions and index the per-function block by function number.
export function parseWatersExternInf(text) {
    const out = { desi: {}, functions: {}, source: {} };
    let mode = null;
    let fn = 0;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (/^\[DESI Experiment Parameters\]/i.test(line)) { mode = 'desi'; continue; }
        const mf = /^Instrument Parameters\s*-\s*Function\s+(\d+)\s*:/i.exec(line);
        if (mf) { mode = 'fn'; fn = Number(mf[1]); out.functions[fn] = {}; continue; }
        if (/^Source Information\s*:/i.test(line)) { mode = 'src'; continue; }
        // Any other block heading ends the current section.
        if (/^(Engineers Settings|Inter-scan delays|Method Events|Data Processing|Prescan Statistics)\b/i.test(line)) {
            mode = null; continue;
        }
        if (!line.trim()) continue;
        if (mode === 'desi') {
            const m = /^(Desi\w+)\s+(.+)$/i.exec(line);
            if (m) out.desi[m[1]] = m[2].trim();
        } else if (mode === 'fn') {
            // "Cone (V)\t20.00\t77.80" — tab separated, may carry set + readback.
            const parts = line.split('\t').filter((s) => s !== '');
            if (parts.length >= 2) out.functions[fn][parts[0].trim()] = parts.slice(1).map((s) => s.trim());
        } else if (mode === 'src') {
            const m = /^([\w ]+?)\s+-\s+(.+)$/.exec(line);
            if (m) out.source[m[1].trim()] = m[2].trim();
        }
    }
    return out;
}

// Keys carry a windows-1252 degree sign ("Source Temperature (°C)"), so match
// on the ASCII-only skeleton rather than the exact bytes.
function rawExternValue(block, key) {
    if (!block) return null;
    const want = String(key).toLowerCase().replace(/[^a-z0-9]+/g, '');
    for (const k of Object.keys(block)) {
        if (k.toLowerCase().replace(/[^a-z0-9]+/g, '') === want) {
            const v = block[k];
            return Array.isArray(v) ? (v[0] != null ? v[0] : null) : v;
        }
    }
    return null;
}

// _FUNCnnn.EE and _FUNCnnn.STS share ONE layout. Records are channels in the
// former and scans in the latter; only the descriptor table tells them apart.
//   u16 dataOffset, u16 version, u16 stride, u16 nParams
//   descriptors from byte 32, 48 bytes each:
//     u16 paramId, u16 flag, u16 offsetInStride, NUL-padded ASCII name at +6
//     (26 bytes), u16 size at +32 (1/2/4/8 -> u8 / u16 / f32|u32 / f64;
//     flag 3 means float)
export function parseWatersParamTable(buf) {
    const dv = new DataView(buf);
    const dataOffset = dv.getUint16(0, true);
    const version = dv.getUint16(2, true);
    const stride = dv.getUint16(4, true);
    const nParams = dv.getUint16(6, true);
    const params = [];
    for (let i = 0; i < nParams; i++) {
        const b = 32 + i * 48;
        if (b + 48 > buf.byteLength) break;
        // The name field is 26 bytes (b+6 .. b+31); b+32 is the size that
        // follows it. Real tables bear this out — Waters truncates names to fit
        // ("Reflectron Detector Volta"), and reading 32 here would let a long
        // name swallow the size field.
        const nameBytes = new Uint8Array(buf, b + 6, 26);
        let end = nameBytes.indexOf(0);
        if (end < 0) end = 26;
        params.push({
            id: dv.getUint16(b, true),
            flag: dv.getUint16(b + 2, true),
            offset: dv.getUint16(b + 4, true),
            size: dv.getUint16(b + 32, true),
            name: rawDecodeText(nameBytes.subarray(0, end)).trim(),
        });
    }
    const nRecords = stride > 0 ? Math.floor((buf.byteLength - dataOffset) / stride) : 0;
    const get = (record, p) => {
        if (!p) return null;
        const at = dataOffset + record * stride + p.offset;
        if (at + p.size > buf.byteLength) return null;
        if (p.size === 1) return dv.getUint8(at);
        if (p.size === 2) return dv.getUint16(at, true);
        if (p.size === 4) return p.flag === 3 ? dv.getFloat32(at, true) : dv.getUint32(at, true);
        if (p.size === 8) return dv.getFloat64(at, true);
        return null;
    };
    const byName = (name) => {
        const want = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
        return params.find((p) => p.name.toLowerCase().replace(/[^a-z0-9]+/g, '') === want) || null;
    };
    return { dataOffset, version, stride, nParams, params, nRecords, get, byName };
}

const RAW_MAX_CHANNELS = 32;

// _FUNCTNS.INF stores m/z and dwell as float32, so a method entered as 146.1
// reads back as 146.10000610351562. That is representation noise, not measured
// precision, and it is not merely cosmetic: mrm_transitions dedups on
// unique(compound_id, precursor, product, ce, cv), so an unrounded value would
// never match the same transition typed in by hand or read from another .raw.
// float32 carries ~7 significant digits, so rounding to the precision MassLynx
// actually accepts recovers the entered value exactly.
function rawRoundMz(v) { return v > 0 ? Math.round(v * 1e4) / 1e4 : v; }
function rawRoundDwell(v) { return v > 0 ? Math.round(v * 1e6) / 1e6 : v; }

// 416 bytes per function; the file length divides by it to give the count.
export function parseWatersFunctions(buf) {
    const dv = new DataView(buf);
    const REC = 416;
    const out = [];
    for (let f = 0; (f + 1) * REC <= buf.byteLength; f++) {
        const b = f * REC;
        const slots = (off) => {
            const a = [];
            for (let i = 0; i < RAW_MAX_CHANNELS; i++) a.push(dv.getFloat32(b + off + i * 4, true));
            return a;
        };
        const dwell = slots(32).map(rawRoundDwell);
        const precursor = slots(160).map(rawRoundMz);
        const product = slots(288).map(rawRoundMz);
        let nChannels = 0;
        for (let i = 0; i < RAW_MAX_CHANNELS; i++) if (precursor[i] > 0) nChannels = i + 1;
        out.push({
            index: f + 1,
            type: dv.getUint8(b),
            isMrm: dv.getUint8(b) === 9,
            ionModeByte: dv.getUint8(b + 1),
            massStart: dv.getFloat32(b + 2, true),
            massEnd: dv.getFloat32(b + 6, true),
            rtStart: dv.getFloat32(b + 10, true),
            rtEnd: dv.getFloat32(b + 14, true),
            nChannels,
            dwell,
            precursor,
            product,
        });
    }
    return out;
}

// u32 version, u32 count, u32 unknown, then `count` fixed-width records.
// A vendor variant with a different record size would mis-slice silently, so
// the divisibility is checked and a bad table degrades to "no names".
export function parseWatersCmp(buf) {
    if (buf.byteLength < 12) return [];
    const dv = new DataView(buf);
    const count = dv.getUint32(4, true);
    if (!count || count > 4096) return [];
    const body = buf.byteLength - 12;
    if (body % count !== 0) return [];
    const rec = body / count;
    const names = [];
    for (let i = 0; i < count; i++) {
        const bytes = new Uint8Array(buf, 12 + i * rec, rec);
        let end = bytes.indexOf(0);
        if (end < 0) end = rec;
        names.push(rawDecodeText(bytes.subarray(0, end)).replace(/[\r\n\0]+$/g, '').trim());
    }
    return names;
}

export function parseWatersIdx(buf) {
    const dv = new DataView(buf);
    const n = Math.floor(buf.byteLength / 22);
    const offset = new Uint32Array(n);
    const nPeaks = new Uint32Array(n);
    const tic = new Float32Array(n);
    const rt = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const b = i * 22;
        offset[i] = dv.getUint32(b, true);
        nPeaks[i] = dv.getUint32(b + 4, true) & 0x3FFFFF;
        tic[i] = dv.getFloat32(b + 8, true);
        rt[i] = dv.getFloat32(b + 12, true);
    }
    return { n, offset, nPeaks, tic, rt };
}

// 22-bit mantissa + 10-bit base-2 exponent biased by 21. Verified exact against
// the vendor text export for every value of a real acquisition (the export is
// the lossy one: it rounds to integers).
export function decodeWatersIntensity(word) {
    return (word & 0x3FFFFF) * Math.pow(2, (word >>> 22) - 21);
}

// Pixel pitch from the distinct stage coordinates, using the MEDIAN positive
// difference. The minimum is the fragile estimator: one pair closer than the
// true pitch (float32 jitter) under-estimates it, which inflates the grid and
// draws phantom gaps. Same reasoning as buildMsiGrid.
export function rawPitchOf(values) {
    const uniq = Array.from(new Set(values.map((v) => Math.round(v * 1e4) / 1e4))).sort((a, b) => a - b);
    if (uniq.length < 2) return { pitch: null, count: uniq.length, min: uniq[0], max: uniq[0] };
    const gaps = [];
    for (let i = 1; i < uniq.length; i++) {
        const d = uniq[i] - uniq[i - 1];
        if (d > 0) gaps.push(d);
    }
    gaps.sort((a, b) => a - b);
    return {
        pitch: gaps.length ? gaps[gaps.length >> 1] : null,
        count: uniq.length,
        min: uniq[0],
        max: uniq[uniq.length - 1],
    };
}

// A declaration, not a const arrow: _buildParseWorkerSource stringifies these
// with Function.prototype.toString, which drops the binding name for arrows.
function rawFuncTag(n) { return '_func' + String(n).padStart(3, '0'); }

// Decode one function to raster-ready columns. This is the unit the worker
// caches (keyed by blobId + function, NOT by channel) so registering N channels
// from one file costs one decode.
export async function rawDecodeFunction(bundle, funcNo) {
    const names = bundle.names();
    const tag = rawFuncTag(funcNo);
    const pick = (ext) => rawFindMember(names, new RegExp(tag + '\\.' + ext + '$'));
    const idxName = pick('idx');
    const datName = pick('dat');
    const stsName = pick('sts');
    if (!idxName || !datName || !stsName) {
        throw new Error('raw: function ' + funcNo + ' needs .IDX + .DAT + .STS');
    }
    const [idxBuf, datBuf, stsBuf] = await Promise.all([
        bundle.read(idxName), bundle.read(datName), bundle.read(stsName),
    ]);
    const idx = parseWatersIdx(idxBuf);
    const sts = parseWatersParamTable(stsBuf);
    const px = sts.byName('Aim X Position');
    const py = sts.byName('Aim Y Position');
    if (!px || !py) throw new Error('raw: .STS has no Aim X/Y Position (not a DESI imaging run?)');
    if (sts.nRecords < idx.n) throw new Error('raw: .STS has fewer records than .IDX has scans');

    let nCh = 0;
    for (let i = 0; i < idx.n; i++) if (idx.nPeaks[i] > nCh) nCh = idx.nPeaks[i];
    if (!nCh) throw new Error('raw: no channels in .IDX');

    const dat = new DataView(datBuf);
    const xs = new Float64Array(idx.n);
    const ys = new Float64Array(idx.n);
    const chans = [];
    for (let c = 0; c < nCh; c++) chans.push(new Float64Array(idx.n));
    for (let i = 0; i < idx.n; i++) {
        xs[i] = sts.get(i, px);
        ys[i] = sts.get(i, py);
        const base = idx.offset[i];
        const k = idx.nPeaks[i];
        for (let c = 0; c < k && c < nCh; c++) {
            chans[c][i] = decodeWatersIntensity(dat.getUint32(base + c * 4, true));
        }
    }
    const gx = rawPitchOf(Array.from(xs));
    const gy = rawPitchOf(Array.from(ys));
    return { nScans: idx.n, nCh, xs, ys, chans, tic: idx.tic, rt: idx.rt, gridX: gx, gridY: gy };
}

// Everything the registration wizard needs, WITHOUT opening .DAT.
export async function parseRawArchiveMeta(bundle) {
    const names = bundle.names();
    const read = async (re) => {
        const n = rawFindMember(names, re);
        return n ? bundle.read(n) : null;
    };
    const headerBuf = await read(/_header\.txt$/);
    const externBuf = await read(/_extern\.inf$/);
    const fnsBuf = await read(/_functns\.inf$/);
    const header = headerBuf ? parseWatersHeaderTxt(rawDecodeText(headerBuf)) : {};
    const extern = externBuf ? parseWatersExternInf(rawDecodeText(externBuf)) : { desi: {}, functions: {}, source: {} };
    const funcs = fnsBuf ? parseWatersFunctions(fnsBuf) : [];

    // Which _FUNCnnn sets actually exist on disk — _FUNCTNS.INF can describe
    // more functions than were written.
    const present = [];
    for (const n of names) {
        const m = /_func(\d{3})\.idx$/i.exec(n.toLowerCase());
        if (m) present.push(Number(m[1]));
    }
    present.sort((a, b) => a - b);

    const functions = [];
    for (const no of present) {
        const spec = funcs[no - 1] || null;
        const tag = rawFuncTag(no);
        const eeBuf = await read(new RegExp(tag + '\\.ee$'));
        const cmpBuf = await read(new RegExp(tag + '\\.cmp$'));
        const ee = eeBuf ? parseWatersParamTable(eeBuf) : null;
        const pCv = ee && ee.byName('Cone Voltage');
        const pCe = ee && ee.byName('Collision Energy');
        const cmpNames = cmpBuf ? parseWatersCmp(cmpBuf) : [];

        const decoded = await rawDecodeFunction(bundle, no);
        // Three independent channel counts. Disagreement means the layout was
        // misread, and a wrong count yields plausible-but-wrong ion images, so
        // it is surfaced rather than silently resolved.
        const counts = {
            idx: decoded.nCh,
            functns: spec ? spec.nChannels : null,
            cmp: cmpNames.length || null,
            ee: ee ? ee.nRecords : null,
        };
        const disagree = [counts.functns, counts.cmp, counts.ee]
            .filter((v) => v != null && v !== counts.idx).length > 0;

        const channels = [];
        for (let c = 0; c < decoded.nCh; c++) {
            const precursor = spec && spec.precursor[c] > 0 ? spec.precursor[c] : null;
            const product = spec && spec.product[c] > 0 ? spec.product[c] : null;
            const name = (cmpNames[c] || '').trim();
            channels.push({
                index: c,
                ordinal: c + 1,
                name: name || null,
                precursor,
                product,
                cv: ee && pCv && c < ee.nRecords ? ee.get(c, pCv) : null,
                ce: ee && pCe && c < ee.nRecords ? ee.get(c, pCe) : null,
                dwell: spec && spec.dwell[c] > 0 ? spec.dwell[c] : null,
            });
        }
        const fnBlock = extern.functions[no] || null;
        const polarityRaw = rawExternValue(fnBlock, 'Polarity');
        functions.push({
            number: no,
            type: spec ? spec.type : null,
            isMrm: spec ? spec.isMrm : null,
            rtStart: spec ? spec.rtStart : null,
            rtEnd: spec ? spec.rtEnd : null,
            nScans: decoded.nScans,
            nChannels: decoded.nCh,
            channels,
            counts,
            countsDisagree: disagree,
            // Never guess a polarity: an absent block stays null so the caller
            // can fall back to the existing _POS/_NEG name heuristic.
            polarity: /ES\+|^\+$/i.test(String(polarityRaw || '')) ? '+'
                : (/ES-|^-$/i.test(String(polarityRaw || '')) ? '-' : null),
            width: decoded.gridX.count,
            height: decoded.gridY.count,
            pitchX: decoded.gridX.pitch,
            pitchY: decoded.gridY.pitch,
            originX: decoded.gridX.min,
            originY: decoded.gridY.min,
            source: fnBlock ? {
                capillaryKv: rawExternValue(fnBlock, 'Capillary (kV)'),
                coneV: rawExternValue(fnBlock, 'Cone (V)'),
                sourceOffsetV: rawExternValue(fnBlock, 'Source Offset (V)'),
                sourceTempC: rawExternValue(fnBlock, 'Source Temperature (C)'),
                htlTempC: rawExternValue(fnBlock, 'HTL Temperature (C)'),
                nebuliser: rawExternValue(fnBlock, 'Nebuliser Gas Flow (L/Hr)'),
                msCe: rawExternValue(fnBlock, 'MS Mode Collision Energy'),
                msmsCe: rawExternValue(fnBlock, 'MSMS Mode Collision Energy'),
            } : null,
        });
    }

    // DesiXStep is NOT the pixel pitch — it is how far the stage travels during
    // ONE MRM channel, so the X pitch is DesiXStep * nChannels. Reading it as a
    // pitch is wrong by exactly the channel count. The stage coordinates in .STS
    // always win; this only cross-checks them.
    const first = functions[0] || null;
    const declaredX = Number(extern.desi.DesiXStep);
    const declaredY = Number(extern.desi.DesiYStep);
    let pitchWarning = null;
    if (first && first.pitchX != null) {
        const expectX = declaredX * first.nChannels;
        const off = (a, b) => (Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0)
            ? Math.abs(a - b) / b : null;
        const dx = off(expectX, first.pitchX);
        const dy = off(declaredY, first.pitchY);
        if ((dx != null && dx > 0.1) || (dy != null && dy > 0.1)) {
            pitchWarning = 'DesiXStep x ' + first.nChannels + ' = ' + expectX.toFixed(4)
                + ' mm / DesiYStep = ' + declaredY
                + ' mm but the stage coordinates give '
                + first.pitchX.toFixed(4) + ' x ' + first.pitchY.toFixed(4) + ' mm';
        }
    }

    return {
        rootName: bundle.rootName,
        header,
        extern,
        functions,
        members: names,
        hasImaging: names.some((n) => /(^|\/)imaging\//i.test(n)),
        pitchSource: 'sts',
        pitchWarning,
    };
}

// Rows for one channel of an ALREADY-decoded function, shaped exactly like
// parseTxtToRows output so buildMsiGrid and computeRasterPixels need no changes.
// Split out from parseRawToRows so the parse worker can cache the decode per
// (blob, function) and pay for it once however many channels were registered.
//
// Coordinates are snapped to the derived lattice: buildMsiGrid keys a Map on
// the exact float, and float32 stage jitter would inflate the distinct-value
// count past its guard, which falls back to ordinal indexing and SILENTLY
// changes the image geometry by collapsing gaps.
// The snapped coordinates, shared by the raster path and the export / ROI path
// so both land on exactly the same lattice. Returns parallel arrays.
export function rawSnapCoords(decoded, def) {
    const off = (def && def.snap === false);
    const dx = off ? 0 : decoded.gridX.pitch;
    const dy = off ? 0 : decoded.gridY.pitch;
    const x0 = decoded.gridX.min;
    const y0 = decoded.gridY.min;
    const q = (v, base, step) => (step > 0)
        ? Math.round((base + Math.round((v - base) / step) * step) * 1e4) / 1e4
        : v;
    const xs = new Float64Array(decoded.nScans);
    const ys = new Float64Array(decoded.nScans);
    for (let i = 0; i < decoded.nScans; i++) {
        xs[i] = q(decoded.xs[i], x0, dx);
        ys[i] = q(decoded.ys[i], y0, dy);
    }
    return { xs, ys };
}

export function rawRowsFromDecoded(decoded, def) {
    const channel = (def && def.channel) || 0;
    if (channel >= decoded.nCh) throw new Error('raw: channel ' + channel + ' out of range');
    const col = decoded.chans[channel];
    const { xs, ys } = rawSnapCoords(decoded, def);
    const rows = [];
    for (let i = 0; i < decoded.nScans; i++) {
        const x = xs[i], y = ys[i], v = col[i];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(v)) continue;
        rows.push({ x, y, v });
    }
    if (!rows.length) throw new Error('raw: no rows decoded');
    return rows;
}

// Same signature and return shape as parseTxtToRows, except async (ZIP
// inflation is). `buf` may also be a RawBundle, which is how the wizard reads
// the loose files before anything has been zipped.
export async function parseRawToRows(buf, def) {
    const bundle = (buf && typeof buf.names === 'function') ? buf : rawBundleFromZip(buf);
    return rawRowsFromDecoded(await rawDecodeFunction(bundle, (def && def.func) || 1), def);
}

// Bundle over the loose files the user picked/dropped. Registration parses from
// THIS (no zip round-trip), and only zips once the user commits — so an invalid
// folder costs nothing and the wizard opens instantly.
//
// `files` is any iterable of File; the relative path comes from
// webkitRelativePath (directory input) or a _rawPath we set when walking a drop.
function rawBundleFromFileList(files) {
    const list = Array.from(files || []);
    const pathOf = (f) => String(f._rawPath || f.webkitRelativePath || f.name || '');
    const roots = new Map();
    const excluded = [];
    for (const f of list) {
        const p = pathOf(f);
        // macOS resource forks and OS junk would otherwise be archived verbatim.
        if (/(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|\._)/i.test(p)) { excluded.push(p); continue; }
        const m = /^(.*?([^/]+)\.raw)\//i.exec(p);
        const rootPath = m ? m[1] + '/' : '';
        const rootName = m ? m[2] : '';
        const key = rootPath.toLowerCase();
        if (!roots.has(key)) roots.set(key, { rootPath, rootName, files: new Map() });
        roots.get(key).files.set(p.slice(rootPath.length).toLowerCase(), f);
    }
    const mk = (r) => ({
        rootName: r.rootName || 'raw',
        rootPath: r.rootPath,
        names: () => Array.from(r.files.keys()),
        file: (name) => r.files.get(String(name).toLowerCase()) || null,
        files: () => Array.from(r.files.entries()),
        async read(name) {
            const f = r.files.get(String(name).toLowerCase());
            if (!f) throw new Error('raw: missing member ' + name);
            return f.arrayBuffer();
        },
    });
    return { bundles: Array.from(roots.values()).map(mk), excluded };
}
