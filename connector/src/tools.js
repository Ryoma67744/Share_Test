import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectPassword } from './config.js';
import {
  listProjectCatalog, getReadToken, getProjectDoc, listRois, fetchStorageObject,
} from './supabase.js';
import {
  parseMsiRows, buildMsiGrid, extractRoiValues, stats, pointInPolygon,
} from './msi.js';

// =============================================================================
// Read-only tools exposed to the AI. Every tool here READS ONLY — none of them
// import or call a write path. See supabase.js for the read-only guarantee.
// =============================================================================

const lc = (v) => String(v == null ? '' : v).toLowerCase();
const matchStr = (query, value) => (query == null || query === '') ? true : lc(value).includes(lc(query));
const safeFile = (v) => String(v || '').replace(/[^\w.\-]+/g, '_').slice(0, 80);

function compoundInfo(key, def) {
  const meta = (def && def.compoundMeta) || {};
  return {
    key,
    name: meta.name || meta.base || String(key).replace(/^MSI_/, ''),
    precursor: meta.precursor != null ? meta.precursor : null,
    product: meta.product != null ? meta.product : null,
    rawMean: (def && Number.isFinite(def.rawMean)) ? def.rawMean : null,
    rawTrueMax: (def && Number.isFinite(def.rawTrueMax)) ? def.rawTrueMax : null,
    rawRange: (def && Array.isArray(def.rawRange)) ? def.rawRange : null,
  };
}

async function findCatalogEntry(slug) {
  const cat = await listProjectCatalog();
  const e = cat.find((p) => p.slug === slug);
  if (!e) throw new Error('project not found: ' + slug);
  return e;
}

// Load doc + ROIs for a project (read-only). Throws a clear error if a private
// project has no local password configured.
async function loadProject(slug) {
  const entry = await findCatalogEntry(slug);
  const tok = await getReadToken(slug, entry.is_public);
  if (!tok) {
    throw new Error(
      "project '" + slug + "' is private and no password is configured for it. " +
      'Set OWNER_ADMIN_PASSWORD or PROJECT_PW__' + slug + ' in .env. ' +
      'Only public projects are readable without a password.'
    );
  }
  const doc = await getProjectDoc(tok.token);
  const docMeta = doc.meta || {};
  const projectMeta = docMeta.project_meta || {};
  const memo = projectMeta.memo || {};
  const sections = [];
  for (const s of (doc.sections || [])) {
    const sp = s.storage_paths || {};
    const msiSeries = sp.msiSeries || {};
    let rois = [];
    try {
      const rows = await listRois(tok.token, s.id);
      rois = (rows || []).map((r) => ({ name: r.name || r.color_key, colorKey: r.color_key, poly: r.poly_msi || [] }));
    } catch (e) { /* skip a section we can't read ROIs for */ }
    sections.push({
      id: s.id,
      name: s.display_name || ('Section ' + (s.ordinal != null ? s.ordinal : '')),
      ordinal: s.ordinal != null ? s.ordinal : 0,
      msiSeries,
      rois,
    });
  }
  return {
    slug, displayName: docMeta.display_name || entry.display_name || slug,
    isPublic: entry.is_public, memo, token: tok.token, sections,
  };
}

async function parseRowsForDef(def, cache) {
  const path = def && def.path;
  if (!path) throw new Error('this compound has no storage path on the server (not published?)');
  if (cache.has(path)) return cache.get(path);
  const buf = await fetchStorageObject(path);
  const rows = parseMsiRows(buf, def);
  cache.set(path, rows);
  return rows;
}

// ---- Tool: list_projects -------------------------------------------------
export async function listProjects() {
  const cat = await listProjectCatalog();
  return {
    projects: cat.map((p) => ({
      slug: p.slug,
      name: p.display_name,
      is_public: p.is_public,
      updated_at: p.updated_at,
      readable: p.is_public || !!projectPassword(p.slug),
    })),
    note: 'Public projects are readable without a password. Private ones need OWNER_ADMIN_PASSWORD or PROJECT_PW__<slug> in the local .env.',
  };
}

// ---- Tool: get_project (summary; no blob parsing) ------------------------
export async function getProject(slug) {
  const p = await loadProject(slug);
  return {
    slug: p.slug,
    name: p.displayName,
    is_public: p.isPublic,
    memo: p.memo,
    sections: p.sections.map((s) => ({
      id: s.id,
      name: s.name,
      ordinal: s.ordinal,
      compounds: Object.entries(s.msiSeries).map(([k, def]) => compoundInfo(k, def)),
      rois: s.rois.map((r) => ({ name: r.name, colorKey: r.colorKey, vertices: (r.poly || []).length })),
    })),
  };
}

// ---- Tool: list_compounds ------------------------------------------------
export async function listCompounds(slug) {
  const p = await loadProject(slug);
  const out = [];
  for (const s of p.sections) {
    for (const [k, def] of Object.entries(s.msiSeries)) {
      out.push(Object.assign({ section: s.name }, compoundInfo(k, def)));
    }
  }
  return { slug: p.slug, compounds: out };
}

// ---- Tool: get_roi_stats (raw-value statistics inside ROIs) --------------
export async function getRoiStats(slug, opts = {}) {
  const { section, roi, compound } = opts;
  const p = await loadProject(slug);
  const cache = new Map();
  const results = [];
  const sections = p.sections.filter((s) => !section || matchStr(section, s.name) || String(section) === String(s.id));
  for (const s of sections) {
    const compEntries = Object.entries(s.msiSeries).filter(([k, def]) =>
      !compound || matchStr(compound, k) || matchStr(compound, compoundInfo(k, def).name));
    const roiList = s.rois.filter((r) => matchStr(roi, r.name));
    if (!compEntries.length || !roiList.length) continue;
    for (const [k, def] of compEntries) {
      let rows;
      try { rows = await parseRowsForDef(def, cache); }
      catch (e) { results.push({ section: s.name, compound: compoundInfo(k, def).name, error: String(e.message || e) }); continue; }
      const grid = buildMsiGrid(rows);
      for (const r of roiList) {
        const vals = extractRoiValues(rows, r.poly, grid);
        results.push({
          section: s.name,
          roi: r.name,
          compound: compoundInfo(k, def).name,
          compound_key: k,
          stats: stats(vals),
        });
      }
    }
  }
  if (!results.length) {
    return { slug: p.slug, results: [], note: 'No matching section/ROI/compound. Call get_project to see available names.' };
  }
  return { slug: p.slug, results };
}

// ---- Tool: get_matrix (raw {x,y,value}; kept out of the conversation) ----
export async function getMatrix(slug, opts = {}) {
  const { compound, section, roi } = opts;
  if (!compound) throw new Error('`compound` is required for get_matrix');
  const cap = Number.isFinite(opts.max_rows) ? Math.max(1, opts.max_rows) : 50000;
  const step = (Number.isFinite(opts.downsample) && opts.downsample > 1) ? Math.floor(opts.downsample) : 1;
  const toFile = !!opts.to_file;

  const p = await loadProject(slug);
  const candidates = [];
  for (const s of p.sections) {
    if (section && !(matchStr(section, s.name) || String(section) === String(s.id))) continue;
    for (const [k, def] of Object.entries(s.msiSeries)) {
      if (matchStr(compound, k) || matchStr(compound, compoundInfo(k, def).name)) candidates.push({ s, k, def });
    }
  }
  if (!candidates.length) throw new Error('no matching compound' + (section ? '/section' : '') + '. Call get_project to see names.');
  if (candidates.length > 1 && !section) {
    return {
      note: 'Multiple sections have this compound; specify `section`.',
      options: candidates.map((c) => ({ section: c.s.name, compound: compoundInfo(c.k, c.def).name })),
    };
  }

  const { s, k, def } = candidates[0];
  const buf = await fetchStorageObject(def.path);
  let rows = parseMsiRows(buf, def);
  let roiName = null;
  if (roi) {
    const r = s.rois.find((rr) => matchStr(roi, rr.name));
    if (!r) throw new Error("ROI '" + roi + "' not found in section '" + s.name + "'");
    roiName = r.name;
    const grid = buildMsiGrid(rows);
    rows = rows.filter((row) => {
      const px = grid.xIndex.get(row.x), py = grid.yIndex.get(row.y);
      return px != null && py != null && pointInPolygon(px, py, r.poly);
    });
  }

  const total = rows.length;
  let selected = step > 1 ? rows.filter((_, i) => i % step === 0) : rows;
  const meta = {
    slug: p.slug, section: s.name, compound: compoundInfo(k, def).name, compound_key: k,
    roi: roiName, total_rows: total, downsample: step,
  };

  if (toFile) {
    const fname = 'desi_' + safeFile(slug) + '_' + safeFile(meta.compound) + '_' + safeFile(s.name) + (roiName ? ('_' + safeFile(roiName)) : '') + '.csv';
    const fpath = join(tmpdir(), fname);
    writeFileSync(fpath, 'x,y,value\n' + selected.map((r) => r.x + ',' + r.y + ',' + r.v).join('\n') + '\n');
    return Object.assign(meta, {
      written_rows: selected.length,
      file_path: fpath,
      note: 'Full CSV written to file_path (kept OUT of the conversation). Load it with your code/analysis tool.',
    });
  }

  const capped = selected.length > cap;
  const returned = selected.slice(0, cap);
  const csv = 'x,y,value\n' + returned.map((r) => r.x + ',' + r.y + ',' + r.v).join('\n') + '\n';
  return Object.assign(meta, {
    returned_rows: returned.length,
    capped,
    note: capped
      ? ('Output capped at ' + cap + ' rows. Narrow with `roi`, raise `downsample`, increase `max_rows`, or pass `to_file:true` to write the full CSV to disk. Analyze the CSV with your code tool.')
      : 'Full data returned. Analyze the CSV with your code tool.',
    csv,
  });
}
