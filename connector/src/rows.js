import { fetchStorageObject } from './supabase.js';
import { parseMsiRows } from './msi.js';

// =============================================================================
// Row loading + caching for one published compound (`def`).
//
// ★ Why this module exists — the bug it fixes
//
// getRoiStats used to cache parsed rows keyed by `def.path` ALONE:
//
//     if (cache.has(path)) return cache.get(path);
//     const rows = parseMsiRows(await fetchStorageObject(path), def);
//     cache.set(path, rows);
//
// but parseMsiRows' output depends on `def` too, and MULTIPLE COMPOUNDS SHARE
// ONE PATH in both formats we publish:
//
//   * DESI Analyte txt — the registration wizard registers many compounds from a
//     single .txt; each one is a different `compound_index` into the same file.
//   * TIMS parquet     — one 836 MB file holds 1390 compounds × 4 sections; each
//     compound is a different `colIdx`, each section a different `annotation`.
//     Publishing keys the Storage path by blobId, so all 5560 defs share it.
//
// So asking for compounds A, B, C returned A's numbers three times — with no
// exception and no log. Silently wrong numbers are worse than a failure, since
// the AI then reasons over them as if they were measured.
//
// The cache is therefore TWO-TIER:
//   bytes : keyed by `path`      → one download per file (what the old key got right)
//   rows  : keyed by path + def  → one parse per compound (what it got wrong)
//
// Keying `rows` on the WHOLE def rather than on a hand-listed subset is
// deliberate: a hand-listed subset silently under-keys again the moment
// msi.js starts reading a new field. Over-keying only costs a re-parse, and in
// practice never fires — two defs that share a path always differ in the field
// that selects the compound.
// =============================================================================

// Order-independent stringify, so two defs that differ only in key order (the
// server returns plain JSON, but nothing guarantees ordering) share a cache slot.
export function stableKey(v) {
  if (v === null || v === undefined || typeof v !== 'object') {
    return JSON.stringify(v === undefined ? null : v);
  }
  if (Array.isArray(v)) return '[' + v.map(stableKey).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableKey(v[k])).join(',') + '}';
}

// The path is repeated up front only to keep the key readable when debugging —
// stableKey(def) already contains it, JSON-quoted, so no separator can collide.
export function parseCacheKey(def) {
  return String((def && def.path) || '') + ' ' + stableKey(def);
}

// `opts.fetchBytes` (whole-object GET, xlsx/txt) and `opts.fetchImpl` (Range
// requests, parquet) exist so selftest.js can drive this module with no network.
// Production leaves both unset and uses the real read-only fetchers.
export function newRowCache(opts) {
  return {
    bytes: new Map(),   // path -> Promise<ArrayBuffer>
    rows: new Map(),    // parseCacheKey(def) -> Promise<rows>
    fetchBytes: (opts && opts.fetchBytes) || fetchStorageObject,
    fetchImpl: (opts && opts.fetchImpl) || null,
    fetchCount: 0,      // whole-object downloads issued (asserted by selftest)
  };
}

function bytesFor(path, cache) {
  const hit = cache.bytes.get(path);
  if (hit) return hit;
  cache.fetchCount++;
  const p = Promise.resolve(cache.fetchBytes(path));
  cache.bytes.set(path, p);
  // Don't cache a failure: a transient network error would otherwise poison the
  // path for the rest of the call.
  p.catch(() => { if (cache.bytes.get(path) === p) cache.bytes.delete(path); });
  return p;
}

// def → [{x, y, v}], the same shape buildMsiGrid / extractRoiValues consume for
// every format, so the numbers stay identical to the app's.
export async function loadRowsForDef(def, cache) {
  const path = def && def.path;
  if (!path) throw new Error('this compound has no storage path on the server (not published?)');
  const key = parseCacheKey(def);
  const hit = cache.rows.get(key);
  if (hit) return hit;
  const p = (async () => {
    // parquet is loaded on demand: only TIMS projects pull in hyparquet, and
    // it never goes through bytesFor — the file is read a column at a time over
    // HTTP Range rather than downloaded (see parquet.js).
    if (def.kind === 'parquet') {
      const { parquetRowsForDef } = await import('./parquet.js');
      return parquetRowsForDef(def, cache);
    }
    return parseMsiRows(await bytesFor(path, cache), def);
  })();
  cache.rows.set(key, p);
  p.catch(() => { if (cache.rows.get(key) === p) cache.rows.delete(key); });
  return p;
}
