import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Tiny .env loader (avoids a dotenv dependency). Only sets keys that are not
// already present in the real environment, so `KEY=... node ...` still wins.
function loadDotEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, '..', '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

export const config = {
  supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  anonKey: process.env.SUPABASE_ANON_KEY || '',
  ownerAdminPassword: process.env.OWNER_ADMIN_PASSWORD || '',
  // Read-ONLY password for the MRM library (SEPARATE from the master password;
  // the connector must never hold the write-capable master pw). Gates the
  // list_mrm_library_ro / get_exp_template_ro RPCs. Empty → /mrm and /exp are
  // disabled with a clear error.
  mrmReadPw: process.env.MRM_READ_PW || '',
  // HTTP (ChatGPT / hosted) settings — unused by the local MCP server.
  apiKey: process.env.CONNECTOR_API_KEY || '',
  port: parseInt(process.env.PORT || '3000', 10) || 3000,
  // Safety valve for the hosted (public-internet) version: when true, private
  // projects are NEVER unlocked, so the endpoint only ever exposes public data.
  // Defaults OFF so the local MCP server keeps reading private projects when a
  // password is configured; the hosted deployment (render.yaml) turns it ON.
  publicOnly: /^(1|true|yes)$/i.test(process.env.PUBLIC_ONLY || 'false'),
};

// Password to try for a private project: a per-project override if present,
// else the shared owner/admin password. Returns '' ("public only") when
// PUBLIC_ONLY is on, or when nothing is configured for the slug.
export function projectPassword(slug) {
  if (config.publicOnly) return '';
  return process.env['PROJECT_PW__' + slug] || config.ownerAdminPassword || '';
}

export function assertConfigured() {
  if (!config.supabaseUrl || !config.anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set (see .env.example)');
  }
}
