'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function fn(name, indent = '') {
  let start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  return source.slice(start, source.indexOf('\n' + indent + '}', start) + indent.length + 2);
}
const document = () => ({ meta: { project_slug: 'target', project_meta: { roiMedia: { version: 1, items: [
  { id: 'a', storagePath: 'target/roi-media/a/r1/photo.png' },
  { id: 'b', storagePath: 'target/roi-media/a/r1/photo.png' },
  { id: 'c', storagePath: 'another/roi-media/reference.png' },
] } } }, sections: [{ storage_paths: { images: { HE: { path: 'target/blobs/HE.tif' } },
  msiSeries: { MSI_A: { path: 'target/blobs/data.parquet' }, MSI_B: { path: 'target/blobs/data.parquet' } } } }] });
function context() {
  const calls = [];
  const ctx = vm.createContext({ Set, console: { warn() {} }, calls, doc: document(),
    SupabaseClient: {
      requestPublishSession: async (pw, slug) => { calls.push(['publish-token', pw, slug]); return { token: 'delete-token' }; },
      unlockProjectMaster: async (slug, pw) => { calls.push(['read-token', slug, pw]); return [{ token: 'read-token' }]; },
      fetchProjectDoc: async token => { calls.push(['read', token]); return ctx.doc; },
      deleteProjectDoc: async (pw, slug) => { calls.push(['delete-db', pw, slug]); return { ok: true,
        paths: ['target/blobs/HE.tif', 'target/blobs/HE.tif', 'another/blobs/foreign.tif', 'target/roi-media/a/r1/photo.png'] }; },
      deleteStorageObject: async (bucket, key, token) => { calls.push(['delete-file', bucket, key, token]); },
    },
  });
  for (const name of ['scopedProjectStoragePath', 'collectServerProjectStoragePaths', 'deleteServerProjectWithMedia', 'collectProjectBlobIds']) {
    vm.runInContext(fn(name), ctx);
  }
  return ctx;
}
async function main() {
  const ctx = context();
  const result = await ctx.deleteServerProjectWithMedia('master-pw', 'target');
  assert.deepEqual(copy(result), { deleted: 3, failed: 0, retained: 2 });
  const deletes = ctx.calls.filter(call => call[0] === 'delete-file');
  assert.equal(new Set(deletes.map(call => call[2])).size, 3, 'Duplicate layer/photo refs must delete each original once');
  assert.ok(deletes.every(call => call[1] === 'atlases' && call[2].startsWith('target/') && call[3] === 'delete-token'));
  assert.ok(ctx.calls.findIndex(call => call[0] === 'read') < ctx.calls.findIndex(call => call[0] === 'delete-db'));
  assert.ok(ctx.calls.findIndex(call => call[0] === 'delete-db') < ctx.calls.findIndex(call => call[0] === 'delete-file'));

  for (const bad of ['target/../other.png', 'target/%2e%2e/other.png', 'target/%2fother.png',
    'target/%5cother.png', 'target/%00x.png', '/target/image.png', 'target//image.png',
    'https://remote.test/target/image.png', 'target/image.png?extra', 'target/%XY.png']) {
    const attempt = context();
    attempt.doc.meta.project_meta.roiMedia.items[0].storagePath = bad;
    await assert.rejects(() => attempt.deleteServerProjectWithMedia('pw', 'target'), /削除していません/);
    assert.ok(!attempt.calls.some(call => call[0] === 'delete-db' || call[0] === 'delete-file'), bad);
  }
  assert.equal(ctx.scopedProjectStoragePath('target-other/file.png', 'target'), false, 'Prefix matches must include the slash boundary');
  assert.equal(ctx.scopedProjectStoragePath('TARGET/file.png', 'target'), false);
  const mismatch = context(); mismatch.doc.meta.project_slug = 'another';
  await assert.rejects(() => mismatch.deleteServerProjectWithMedia('pw', 'target'), /一致/);
  assert.ok(!mismatch.calls.some(call => call[0] === 'delete-db'));
  const legacy = context(); legacy.doc = { sections: [] };
  await legacy.deleteServerProjectWithMedia('pw', 'target');
  assert.ok(legacy.calls.some(call => call[0] === 'delete-db'), 'Existing endpoint documents without an optional slug field remain usable');

  for (const endpoint of ['requestPublishSession', 'unlockProjectMaster', 'fetchProjectDoc']) {
    const fail = context();
    fail.SupabaseClient[endpoint] = async () => { throw new Error('missing RPC or offline'); };
    await assert.rejects(() => fail.deleteServerProjectWithMedia('pw', 'target'), /missing RPC or offline/);
    assert.ok(!fail.calls.some(call => call[0] === 'delete-db' || call[0] === 'delete-file'), endpoint);
  }
  const noToken = context(); noToken.SupabaseClient.requestPublishSession = async () => ({});
  await assert.rejects(() => noToken.deleteServerProjectWithMedia('pw', 'target'), /認証/);
  assert.ok(!noToken.calls.some(call => call[0] === 'delete-db'));
  const malformed = context(); malformed.doc.meta.project_meta.roiMedia.version = 999;
  await assert.rejects(() => malformed.deleteServerProjectWithMedia('pw', 'target'), /保存形式/);
  assert.ok(!malformed.calls.some(call => call[0] === 'delete-db'));
  const missingPath = context(); delete missingPath.doc.meta.project_meta.roiMedia.items[0].storagePath;
  await assert.rejects(() => missingPath.deleteServerProjectWithMedia('pw', 'target'), /原本参照/);
  const denied = context(); denied.SupabaseClient.deleteProjectDoc = async () => ({ ok: false });
  await assert.rejects(() => denied.deleteServerProjectWithMedia('pw', 'target'), /削除に失敗/);
  assert.ok(!denied.calls.some(call => call[0] === 'delete-file'));
  const storageFailure = context();
  storageFailure.SupabaseClient.deleteStorageObject = async () => { throw new Error('network failure'); };
  assert.equal((await storageFailure.deleteServerProjectWithMedia('pw', 'target')).failed, 3, 'Cleanup failures must be visible in the completion message');

  // Execute the real minimal Supabase wrapper to verify existing RPC argument names.
  const rpcCalls = [], start = source.indexOf('const SupabaseClient = (() => {');
  const rpcContext = vm.createContext({ console, window: { SUPABASE_URL: 'https://test.invalid', SUPABASE_ANON_KEY: 'anon' },
    supabase: { createClient: () => ({ rpc: async (name, args) => { rpcCalls.push([name, args]); return { data: {} }; } }) } });
  vm.runInContext(source.slice(start, source.indexOf('\n})();', start) + 6) + '\nglobalThis.api = SupabaseClient;', rpcContext);
  await rpcContext.api.unlockProjectMaster('target', 'pw');
  await rpcContext.api.fetchProjectDoc('token');
  assert.deepEqual(copy(rpcCalls), [['unlock_project_master', { _master_pw: 'pw', _slug: 'target' }], ['get_project_doc', { p_token: 'token' }]]);

  const deleted = [], transactions = [];
  const rows = [
    { id: 'remove', sections: [{ images: { HE: { blobId: 'HE-only' } }, msiFiles: { raw: { blobId: 'raw-only' } } }],
      meta: { roiMedia: { version: 1, items: [{ blobId: 'photo-only' }, { blobId: 'photo-shared' }] } } },
    { id: 'keep', sections: [], meta: { roiMedia: { version: 1, items: [{ blobId: 'photo-shared' }] } } },
  ];
  const db = { transaction(names, mode) {
    transactions.push([names, mode]);
    const tx = { objectStore(name) { return {
      delete: id => deleted.push([name, id]),
      openCursor() {
        const request = {}; let index = 0;
        const advance = () => queueMicrotask(() => {
          const record = rows[index++];
          request.onsuccess({ target: { result: record ? { value: record, continue: advance } : null } });
          if (!record) queueMicrotask(() => tx.oncomplete());
        });
        advance(); return request;
      },
    }; } };
    return tx;
  } };
  ctx.open = async () => db;
  vm.runInContext(fn('deleteProject', '    '), ctx);
  await ctx.deleteProject('remove');
  assert.deepEqual(copy(transactions), [[['projects', 'project_index', 'blobs'], 'readwrite']]);
  assert.deepEqual(deleted, [['projects', 'remove'], ['project_index', 'remove'],
    ['blobs', 'HE-only'], ['blobs', 'raw-only'], ['blobs', 'photo-only']]);
  assert.ok(!deleted.some(([, id]) => id === 'photo-shared'), 'Deleting a local project must retain another project’s original');
  console.log('ROI media deletion regression: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
