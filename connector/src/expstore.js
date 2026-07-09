import { randomUUID } from 'node:crypto';

// =============================================================================
// Ephemeral in-memory store for generated .exp files, so the HTTP connector can
// hand ChatGPT a short-lived DOWNLOAD URL (the user's browser fetches the file
// directly — ChatGPT Actions can't return a file attachment). The id is an
// unguessable random token; entries expire after TTL_MS. No DB/Storage writes,
// so the connector stays read-only w.r.t. the database.
//
// Caveat: on a restart/sleep (e.g. Render free tier) the map is cleared, so a
// link only works while the instance stays up. Good enough for "generate → click
// now"; switch to Supabase Storage if durable links are needed.
// =============================================================================

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ENTRIES = 200;       // backstop against unbounded growth
const store = new Map();        // id -> { text, expires }

function prune() {
  const now = Date.now();
  for (const [k, v] of store) if (v.expires <= now) store.delete(k);
  // If still over the cap, drop oldest (insertion-ordered) entries.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

// Store .exp text, return an unguessable id (hex, no dashes).
export function putExp(text) {
  prune();
  const id = randomUUID().replace(/-/g, '');
  store.set(id, { text: String(text), expires: Date.now() + TTL_MS });
  return id;
}

// Return the stored text or null if missing/expired.
export function getExp(id) {
  const v = store.get(id);
  if (!v) return null;
  if (v.expires <= Date.now()) { store.delete(id); return null; }
  return v.text;
}
