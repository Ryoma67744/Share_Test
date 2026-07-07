import { config, projectPassword } from './config.js';

// =============================================================================
// READ-ONLY Supabase access.
// This module ONLY reads: it calls read RPCs and GETs public Storage objects.
// It never calls a write RPC (upsert_project_doc / create_roi / update_roi) and
// never writes to Storage. It never holds or uses the master password, so the
// server rejects any structural write regardless of what an AI asks for.
// =============================================================================

function headers() {
  return {
    apikey: config.anonKey,
    Authorization: 'Bearer ' + config.anonKey,
    'Content-Type': 'application/json',
  };
}

async function rpc(name, args) {
  const res = await fetch(config.supabaseUrl + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('rpc ' + name + ' failed: HTTP ' + res.status + ' ' + t.slice(0, 300));
  }
  return res.json();
}

// Anon can read a catalog of all projects (id, slug, is_public, display_name,
// updated_at) — but nothing else without a token.
export async function listProjectCatalog() {
  const url = config.supabaseUrl +
    '/rest/v1/projects?select=id,slug,is_public,display_name,updated_at&order=updated_at.desc';
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error('catalog read failed: HTTP ' + res.status);
  return res.json();
}

// Obtain a READ token for a project. Public → no password. Private → password
// from the local env (never sent to the AI). Returns { token, role } or null.
export async function getReadToken(slug, isPublic) {
  if (isPublic) {
    const rows = await rpc('unlock_public_project', { _slug: slug });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row && row.token) return { token: row.token, role: row.role || 'viewer' };
  }
  const pw = projectPassword(slug);
  if (!pw) return null; // private + no local password → not readable by design
  const rows = await rpc('unlock_project', { p_slug: slug, p_password: pw });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (row && row.token) return { token: row.token, role: row.role || 'viewer' };
  return null;
}

export async function getProjectDoc(token) {
  return rpc('get_project_doc', { p_token: token });
}

export async function listRois(token, sectionId) {
  return rpc('list_rois', { p_token: token, p_section_id: sectionId });
}

// GET a public Storage object (the 'atlases' bucket is public-read). Path
// segments are already ASCII-sanitized at publish time. Returns an ArrayBuffer.
export async function fetchStorageObject(path) {
  const url = config.supabaseUrl + '/storage/v1/object/public/atlases/' + encodeURI(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error('storage GET failed: HTTP ' + res.status + ' for ' + path);
  return res.arrayBuffer();
}
