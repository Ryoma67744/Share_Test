#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { assertConfigured } from './config.js';
import * as tools from './tools.js';

// =============================================================================
// DESI Data Share — READ-ONLY MCP connector.
// Exposes read-only tools so an AI can browse projects and analyze MSI numbers.
// It NEVER exposes a write/delete tool and never holds the master password, so
// the AI cannot register, edit, or delete anything.
// =============================================================================

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List DESI/MSI projects you can read (public ones, plus private ones whose password is configured locally). Returns slug, name, is_public, updated_at, readable.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_project',
    description: 'Summary of one project (no heavy parsing): memo (experiment date/machine/notes), sections, compounds (name/precursor/product m-z and precomputed mean/max), and ROIs (name + vertex count).',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'project slug (from list_projects)' } },
      required: ['slug'],
    },
  },
  {
    name: 'list_compounds',
    description: 'List the compounds (MRM layers) of a project with precursor/product m-z, per section.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'get_roi_stats',
    description: 'Compute RAW MSI intensity statistics (mean/median/min/max/quartiles/n/sd) inside ROIs. Optional filters narrow which section/ROI/compound are computed. Output is compact.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        section: { type: 'string', description: 'optional: section name or id' },
        roi: { type: 'string', description: 'optional: ROI name (substring match)' },
        compound: { type: 'string', description: 'optional: compound name or key (substring match)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_matrix',
    description: 'Return the RAW {x,y,value} numbers for one compound in one section (optionally clipped to an ROI), for quantitative analysis. Large data is capped; use downsample/max_rows, or to_file:true to write the full CSV to a local file (kept OUT of the conversation) and load it with your code/analysis tool.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        compound: { type: 'string', description: 'compound name or key (required)' },
        section: { type: 'string', description: 'section name or id (required if the compound exists in multiple sections)' },
        roi: { type: 'string', description: 'optional: clip to this ROI (name)' },
        max_rows: { type: 'number', description: 'optional: inline row cap (default 50000)' },
        downsample: { type: 'number', description: 'optional: keep every Nth row' },
        to_file: { type: 'boolean', description: 'optional: write full CSV to a local temp file instead of inline' },
      },
      required: ['slug', 'compound'],
    },
  },
  {
    name: 'search_mrm',
    description: 'Search the lab-wide REGISTERED MRM library (compounds + transitions with precursor/product/CE/CV, tags, polarity, and usage history). This is the MRM management registry from the app — NOT the per-project MSI layers. Optional filters: q (name or tag substring), tag, polarity. Call with no arguments to list the whole library.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'optional: compound name or tag (substring)' },
        tag: { type: 'string', description: 'optional: tag/category (substring)' },
        polarity: { type: 'string', description: 'optional: polarity (e.g. + / -)' },
      },
    },
  },
  {
    name: 'build_exp',
    description: 'Assemble a Waters MassLynx .exp measurement file from registered MRMs. Pass `names` (ordered array of compound names); each resolves to its export transition (recommended > quant(定量) > first) and CE/CV are taken from the registry, never guessed. Returns exp_text plus channels/missing/ambiguous. Unregistered names are reported in `missing`, not fabricated.',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'ordered compound names to include as .exp channels' },
      },
      required: ['names'],
    },
  },
  {
    name: 'find_projects_by_compound',
    description: 'Reverse lookup: given a molecule/compound name, list the DESI/MSI projects that measured it (e.g. "which projects measured Acetylcholine?"). Searches the always-persisted per-project compound list. Name matching tolerates case/separator/polarity drift (NEG/POS) and is widened with registered-library serial_no aliases; distinct compounds stay distinct (PGD2 != PGE2). Returns slug / name / is_public / matched_compounds only. Private projects are included unless the server runs in PUBLIC_ONLY mode.',
    inputSchema: {
      type: 'object',
      properties: {
        compound: { type: 'string', description: 'molecule/compound name to look up (e.g. "Acetylcholine")' },
        include_private: { type: 'boolean', description: 'optional: include private projects (default true; ignored when the server is PUBLIC_ONLY)' },
      },
      required: ['compound'],
    },
  },
];

const server = new Server({ name: 'desi-share', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result;
    switch (name) {
      case 'list_projects': result = await tools.listProjects(); break;
      case 'get_project': result = await tools.getProject(args.slug); break;
      case 'list_compounds': result = await tools.listCompounds(args.slug); break;
      case 'get_roi_stats': result = await tools.getRoiStats(args.slug, args); break;
      case 'get_matrix': result = await tools.getMatrix(args.slug, args); break;
      case 'search_mrm': result = await tools.searchMrm(args); break;
      case 'build_exp': result = await tools.buildExpForNames(args); break;
      case 'find_projects_by_compound': result = await tools.findProjectsByCompound(args); break;
      default: throw new Error('unknown tool: ' + name);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERROR: ' + ((e && e.message) || String(e)) }], isError: true };
  }
});

async function main() {
  assertConfigured();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; log to stderr only.
  console.error('desi-share MCP connector (read-only) started');
}

main().catch((e) => { console.error(e); process.exit(1); });
