'use strict';

// 管理画面 (index.html) のワークスペース・ツリーの回帰テスト。
//
// 捕まえたい壊れ方: 「登録した PC では正しくフォルダの中にあるのに、別 PC で
// master に入るとフォルダが空になり、プロジェクトがルートに出てしまう」。
// 原因はツリーのノードがそのブラウザ内でしか意味を持たない localId しか
// 持たず、publish しても slug が書き戻らないこと。ここでは実際の
// index.html から関数を切り出して、その身元解決と移動後の保存を確かめる。
//
// renderNodes はノードを `rowForNode(n)` が引ければフォルダ内に描き、引けなければ
// 未配置としてルート末尾へ回す。つまり下のテストが見ている「解決できるか」は
// 表示位置そのもの。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function scanBalanced(src, openAt) {
  let depth = 0, quote = null, escaped = false, lineComment = false, blockComment = false;
  for (let i = openAt; i < src.length; i++) {
    const ch = src[i], next = src[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced source block');
}

function extractFunction(name) {
  let marker = `async function ${name}`;
  let markerAt = source.indexOf(marker);
  if (markerAt === -1) { marker = `function ${name}`; markerAt = source.indexOf(marker); }
  assert.notEqual(markerAt, -1, `missing function ${name} in index.html`);
  const openAt = source.indexOf('{', markerAt + marker.length);
  return source.slice(markerAt, scanBalanced(source, openAt) + 1);
}

// index.html から本物の実装を持ち込む。ここでコピーを書くと、実装が変わった
// ときにテストだけが古い挙動に同意し続けてしまう。
function makeContext(tree) {
  const context = vm.createContext({ console, Map, Set, workspaceTree: tree });
  for (const name of ['_rowSlug', '_rowKey', '_indexRows', '_reconcileTree',
                      '_buildProjectResolver', '_buildFolderIndexDoc']) {
    vm.runInContext(extractFunction(name), context);
  }
  return context;
}

// 「登録した PC」= ローカル記録 (IndexedDB) を持ち、publish 済みで slug もある。
const rowsOnRegisteringPc = [
  { kind: 'local+server',
    local: { id: 'proj_k3f9x', displayName: '260908_Medaka_Test', shareInfo: { slug: 'medaka-test-a1b2' } },
    server: { slug: 'medaka-test-a1b2', display_name: '260908_Medaka_Test' } },
];
// 「別 PC」= サーバ一覧にしか無い (Server only)。ローカル記録が無いので
// local が無く、localId も持たない。
const rowsOnOtherPc = [
  { kind: 'server-only',
    server: { slug: 'medaka-test-a1b2', display_name: '260908_Medaka_Test' } },
];

const folderTree = () => ({
  version: 1,
  children: [{ type: 'folder', id: 'f_hokudai', name: 'Hokudai_Medaka',
               children: [{ type: 'project', localId: 'proj_k3f9x' }] }],
});

// ---------------------------------------------------------------------------

// これがバグそのもの。修正後もこの性質自体は変わらない (別 PC に localId を
// slug へ結びつける情報が無いので原理的に解決できない) ため、下の
// testRegisteringPcHealsTheTree が唯一の直し方であることを示す土台になる。
function testLocalIdOnlyNodeIsUnresolvableElsewhere() {
  const tree = folderTree();
  const context = makeContext(tree);
  const idx = vm.runInContext('_indexRows(ROWS)', Object.assign(context, { ROWS: rowsOnOtherPc }));
  const node = tree.children[0].children[0];
  assert.equal(idx.rowForNode(node), null,
    'localId だけのノードは別 PC では解決できない (= フォルダから出る)');
}

// 本命。登録した PC が管理画面を開いた時点でツリーが治り、以後どの PC でも
// フォルダの中に出る。
function testRegisteringPcHealsTheTree() {
  const tree = folderTree();
  const context = makeContext(tree);
  context.ROWS = rowsOnRegisteringPc;

  const fixed = vm.runInContext('_reconcileTree(_indexRows(ROWS).rowForNode)', context);
  assert.equal(fixed.healed, 1, '焼き付けた件数を返して保存させる');
  assert.equal(fixed.folded, 0);

  const node = tree.children[0].children[0];
  assert.equal(node.slug, 'medaka-test-a1b2', 'slug が焼き付いている');
  assert.equal(node.localId, 'proj_k3f9x', 'localId は消さない (元 PC の解決も残す)');

  // 治ったツリーを別 PC で読む。
  context.ROWS = rowsOnOtherPc;
  const idx = vm.runInContext('_indexRows(ROWS)', context);
  assert.ok(idx.rowForNode(node), '別 PC でも slug で解決でき、フォルダの中に出る');

  // 2 回目は何も変わらないので保存しない (描画のたびに書きに行かせない)。
  context.ROWS = rowsOnRegisteringPc;
  const again = vm.runInContext('_reconcileTree(_indexRows(ROWS).rowForNode)', context);
  assert.deepEqual([again.healed, again.folded], [0, 0], '変化が無ければ 0 件');
}

// 別 PC が「移動」で足した {slug} ノードと、元 PC の {localId} ノードが
// 両方残っている状態。畳む基準は**ツリー格納順**でなければならない。
// 表示順 (実験日ソート) で畳むと、ソート設定の違う PC 同士が別々の結果を
// 保存して奪い合う。
function testDuplicateNodesFoldByTreeOrder() {
  const tree = { version: 1, children: [
    { type: 'folder', id: 'f_a', name: 'A', children: [{ type: 'project', localId: 'proj_k3f9x' }] },
    { type: 'folder', id: 'f_b', name: 'B', children: [{ type: 'project', slug: 'medaka-test-a1b2' }] },
  ] };
  const context = makeContext(tree);
  context.ROWS = rowsOnRegisteringPc;
  assert.equal(vm.runInContext('_reconcileTree(_indexRows(ROWS).rowForNode)', context).folded, 1);

  assert.equal(tree.children[0].children.length, 1, '先に格納されている A が残る');
  assert.equal(tree.children[1].children.length, 0, '後の B が畳まれる');
  assert.deepEqual(tree.children[0].children[0],
    { type: 'project', localId: 'proj_k3f9x', slug: 'medaka-test-a1b2' },
    '身元 (slug / localId) は残る方へ寄せる');
}

// 解決できないノードを「未公開」と数えて黙って落とすと、フォルダ共有の一覧から
// 公開済みプロジェクトが消える。改名の自動再共有は警告すら出していなかった。
function testIndexDocReportsWhatItDropped() {
  const tree = { version: 1, children: [] };
  const context = makeContext(tree);
  context.ROWS = rowsOnOtherPc.concat([
    // この PC で作ったがまだ publish していない = 一覧に載らなくて当然。
    { kind: 'local-only', local: { id: 'proj_local_new', displayName: 'draft', shareInfo: null } },
  ]);
  const resolve = vm.runInContext('_buildProjectResolver(ROWS)', context);

  const foreignNode = { type: 'project', localId: 'proj_k3f9x' };      // 別 PC 生まれ = 公開済み
  const unpublishedNode = { type: 'project', localId: 'proj_local_new' };
  assert.equal(resolve.isForeign(foreignNode), true);
  assert.equal(resolve.isForeign(unpublishedNode), false, 'この PC の未公開は foreign ではない');

  const folder = { name: 'Hokudai_Medaka', children: [foreignNode, unpublishedNode] };
  const stats = { unpublished: 0, foreign: 0 };
  context.FOLDER = folder; context.RESOLVE = resolve; context.STATS = stats;
  const doc = vm.runInContext('_buildFolderIndexDoc(FOLDER, RESOLVE, true, STATS)', context);

  assert.equal(doc.children.length, 0, '解決できないものは一覧に入らない (従来どおり)');
  assert.equal(stats.foreign, 1, '公開済みなのに落とした件数を報告する');
  assert.equal(stats.unpublished, 1, '未公開は分けて数える');
}

// A local rename can be newer than the project title visible to recipients.
function testFolderShareUsesPublishedName() {
  const tree = folderTree();
  const context = makeContext(tree);
  const { local, server } = rowsOnRegisteringPc[0];
  const renamedLocal = { ...local, displayName: 'Unpublished draft title' };
  context.FOLDER = tree.children[0];
  context.FOLDER.children.push({ type: 'project', slug: server.slug });
  for (const [row, expected] of [
    [{ local: renamedLocal, server }, server.display_name],
    [{ local: renamedLocal }, server.slug],
  ]) {
    context.ROWS = [row];
    const doc = vm.runInContext('_buildFolderIndexDoc(FOLDER, _buildProjectResolver(ROWS), true)', context);
    assert.deepEqual(Array.from(doc.children, child => child.displayName), [expected, expected]);
  }
}

// 治ったノードは一覧に載る。
function testHealedNodeSurvivesFolderShare() {
  const tree = folderTree();
  const context = makeContext(tree);
  context.ROWS = rowsOnRegisteringPc;
  vm.runInContext('_reconcileTree(_indexRows(ROWS).rowForNode)', context);

  context.ROWS = rowsOnOtherPc;
  context.FOLDER = tree.children[0];
  const stats = { unpublished: 0, foreign: 0 };
  context.STATS = stats;
  const doc = vm.runInContext('_buildFolderIndexDoc(FOLDER, _buildProjectResolver(ROWS), true, STATS)', context);

  assert.equal(stats.foreign, 0, '治った後は別 PC からの共有でも落ちない');
  // doc は VM 側の realm で作られるので、プロトタイプ同一性を見ない形で比べる。
  assert.deepEqual(JSON.parse(JSON.stringify(doc.children)),
    [{ type: 'project', slug: 'medaka-test-a1b2', displayName: '260908_Medaka_Test' }]);
}

// 自己修復の保存に失敗したとき、その修復が捨てられないこと。
//
// ツリーの取得は in-memory のツリーを丸ごと置き換え、_treeDirty も落とす。
// 保存に失敗した直後に取得が走ると (ブートは 2 回取得し、「サーバから一覧取得」
// でも取得する)、まだ届いていない修復がそこで消える。取得の前に保存を流し切る
// ことで、あらゆる取得が再試行の機会になる。
function testFailedHealIsRetriedOnTheNextFetch() {
  const stale = () => ({ version: 1, children: [
    { type: 'folder', id: 'f_hokudai', name: 'Hokudai_Medaka',
      children: [{ type: 'project', localId: 'proj_k3f9x' }] }] });
  let stored = stale();
  let failNextSet = true;
  const tick = async (n) => { for (let i = 0; i < n; i++) await null; };

  const context = vm.createContext({
    console, Map, Set, Math, JSON,
    uiT: source => source, // This isolated storage test does not load the UI runtime.
    workspaceTree: null,
    _treeLoaded: false, _treeDirty: false, _treePersisting: false,
    _treeSavePromise: null, _treeHealed: 0,
    readCachedMasterPw: () => 'master-pw',
    showToast: () => {},
    SupabaseClient: {
      configured: () => true,
      getWorkspaceTree: async () => { await tick(1); return JSON.parse(JSON.stringify(stored)); },
      setWorkspaceTree: async (pw, tree) => {
        await tick(1);
        if (failNextSet) { failNextSet = false; throw new Error('transient network failure'); }
        stored = JSON.parse(JSON.stringify(tree));
      },
    },
    ROWS: rowsOnRegisteringPc,
  });
  for (const name of ['_emptyTree', '_ensureTree', '_rowSlug', '_rowKey', '_indexRows',
                      '_reconcileTree', 'loadWorkspaceTree', 'saveTreeQuiet']) {
    vm.runInContext(extractFunction(name), context);
  }

  // renderList の該当箇所と同じ手順。実装が変わったら気づけるよう、本物の
  // 呼び出しが index.html に残っていることを確かめてから使う。
  assert.match(source, /const fixed = _reconcileTree\(rowForNode\);/);
  assert.match(source, /if \(fixed\.healed \|\| fixed\.folded\) \{ _treeDirty = true; _treeHealed \+= fixed\.healed; \}/);
  assert.match(source, /if \(_treeDirty\) saveTreeQuiet\(\);/);
  const render = () => vm.runInContext(`(function(){
      const fixed = _reconcileTree(_indexRows(ROWS).rowForNode);
      if (fixed.healed || fixed.folded) { _treeDirty = true; _treeHealed += fixed.healed; }
      if (_treeDirty) saveTreeQuiet();
    })()`, context);

  return (async () => {
    await vm.runInContext('loadWorkspaceTree()', context);
    render();                     // 直す → 保存 → 失敗
    await tick(20);
    assert.equal(vm.runInContext('_treeDirty', context), true,
      '保存に失敗したら、直した印を残して再試行できるようにする');
    assert.equal(stored.children[0].children[0].slug, undefined, '前提: まだ届いていない');

    // 次の取得 (ブート 2 回目 / 「サーバから一覧取得」)。ここで捨ててはいけない。
    await vm.runInContext('loadWorkspaceTree()', context);
    await tick(20);

    assert.equal(stored.children[0].children[0].slug, 'medaka-test-a1b2',
      '取得の前に保存を流し切るので、失敗した修復が次の取得で届く');
    assert.equal(vm.runInContext('_treeDirty', context), false, '届いたら印を下ろす');
    assert.equal(vm.runInContext('workspaceTree.children[0].children[0].slug', context),
      'medaka-test-a1b2', '取得し直したツリーも直っている');
  })();
}

function testSameSlugCopiesKeepIndependentPlacement() {
  const rows=[...rowsOnRegisteringPc,{kind:'local+server',local:{id:'second-copy',displayName:'Copy',shareInfo:{slug:'medaka-test-a1b2'}}}];
  const tree={children:[{type:'project',slug:'medaka-test-a1b2',localId:'proj_k3f9x'},{type:'project',slug:'medaka-test-a1b2',localId:'second-copy'}]};
  const c=makeContext(tree),idx=c._indexRows(rows);
  assert.equal(idx.rowForNode(tree.children[1]).local.id,'second-copy');
  assert.notEqual(c._rowKey(rows[0]),c._rowKey(rows[1]));
  assert.equal(c._reconcileTree(idx.rowForNode).folded,0);
  assert.equal(tree.children.length,2);
}

// Exercise the real move -> render-time reconciliation -> persistence path.
// Only the picker, project list, DOM rendering and external RPC are replaced;
// checking the saved tree catches a move that the reconciler silently undoes.
async function moveAndReadSavedTree(tree, rows, slug, localId, destinationId) {
  const saved = [], alerts = [];
  const context = makeContext(tree);
  Object.assign(context, {
    window: { DESI_OFFLINE: false },
    _treeLoaded: true, _treeDirty: false, _treePersisting: false,
    _treeSavePromise: null, _treeHealed: 0,
    uiT: value => value,
    readCachedMasterPw: () => 'test-master',
    showToast: () => {},
    alert: message => alerts.push(message),
    buildRows: async () => rows,
    pickFolderModal: async () => ({ id: destinationId }),
    SupabaseClient: {
      configured: () => true,
      setWorkspaceTree: async (pw, value) => {
        assert.equal(pw, 'test-master');
        saved.push(JSON.parse(JSON.stringify(value)));
      },
    },
    renderList: async () => {
      const fixed = context._reconcileTree(context._indexRows(rows).rowForNode);
      if (fixed.healed || fixed.folded) {
        context._treeDirty = true;
        context._treeHealed += fixed.healed;
      }
      if (context._treeDirty) await context.saveTreeQuiet();
    },
  });
  for (const name of ['_emptyTree', '_ensureTree', '_ensureMasterPwForTree',
                      '_treeFolderById', '_treeChildrenOf', '_treeRemove',
                      'treeMoveProject', 'persistTreeAndRender',
                      '_persistTreeAndRender', 'saveTreeQuiet']) {
    vm.runInContext(extractFunction(name), context);
  }
  await context.treeMoveProject(slug, localId);
  assert.deepEqual(alerts, [], 'moving must complete without a persistence warning');
  assert.equal(saved.length, 1, 'the explicit move must save exactly once');
  assert.equal(context._treePersisting, false, 'the persistence guard must be released');
  assert.deepEqual(saved[0], JSON.parse(JSON.stringify(context.workspaceTree)));
  return saved[0];
}

function projectPlacements(tree) {
  const placements = [];
  const visit = (nodes, folderId) => {
    for (const node of nodes) {
      if (node.type === 'folder') visit(node.children || [], node.id);
      else if (node.type === 'project') placements.push({ folderId, ...node });
    }
  };
  visit(tree.children, null);
  return placements;
}

async function testMoveForeignLocalIdPersistsRegardlessOfTreeOrder() {
  const slug = 'published-project';
  const row = { local: { id: 'current-local', shareInfo: { slug } }, server: { slug } };
  for (const destination of ['after-source', 'before-source', 'root']) {
    const sourceFolder = { type: 'folder', id: 'source', children: [
      { type: 'project', localId: 'other-pc-local', slug },
    ] };
    const destinationFolder = { type: 'folder', id: 'destination', children: [] };
    const tree = { version: 1, children: destination === 'before-source'
      ? [destinationFolder, sourceFolder] : [sourceFolder, destinationFolder] };
    const destinationId = destination === 'root' ? null : 'destination';
    const saved = await moveAndReadSavedTree(tree, [row], slug, row.local.id, destinationId);
    assert.deepEqual(projectPlacements(saved), [
      { folderId: destinationId, type: 'project', slug, localId: 'current-local' },
    ], `a foreign local ID must not restore the old placement (${destination})`);
  }
}

async function testMoveMatchingLocalIdAndServerOnlyPersist() {
  const slug = 'published-project';
  for (const serverOnly of [false, true]) {
    const row = serverOnly ? { server: { slug } }
      : { local: { id: 'current-local', shareInfo: { slug } }, server: { slug } };
    const localId = serverOnly ? 'other-pc-local' : 'current-local';
    const tree = { version: 1, children: [
      { type: 'folder', id: 'source', children: [{ type: 'project', localId, slug }] },
      { type: 'folder', id: 'destination', children: [] },
    ] };
    const saved = await moveAndReadSavedTree(tree, [row], slug, serverOnly ? '' : localId, 'destination');
    assert.deepEqual(projectPlacements(saved), [
      { folderId: 'destination', type: 'project', slug, localId },
    ], `the existing ${serverOnly ? 'server-only' : 'matching local ID'} move must remain valid`);
  }
}

async function testMoveSameSlugCopiesKeepsOtherCopyInPlace() {
  const slug = 'published-project';
  const rows = ['first-copy', 'second-copy'].map(id => ({ local: { id, shareInfo: { slug } }, server: { slug } }));
  for (const foreignFirstId of [false, true]) {
    for (const movingIndex of [0, 1]) {
      const ids = [foreignFirstId ? 'other-pc-local' : 'first-copy', 'second-copy'];
      const tree = { version: 1, children: [
        { type: 'folder', id: 'first-folder', children: [{ type: 'project', localId: ids[0], slug }] },
        { type: 'folder', id: 'second-folder', children: [{ type: 'project', localId: ids[1], slug }] },
        { type: 'folder', id: 'destination', children: [] },
      ] };
      const moving = rows[movingIndex].local.id;
      const saved = await moveAndReadSavedTree(tree, rows, slug, moving, 'destination');
      const otherIndex = 1 - movingIndex;
      assert.deepEqual(projectPlacements(saved), [
        { folderId: otherIndex === 0 ? 'first-folder' : 'second-folder',
          type: 'project', localId: ids[otherIndex], slug },
        { folderId: 'destination', type: 'project', slug, localId: moving },
      ], `moving ${moving} must preserve the other same-slug copy (foreign alias: ${foreignFirstId})`);
    }
  }
}

async function main() {
  await testMoveForeignLocalIdPersistsRegardlessOfTreeOrder();
  await testMoveMatchingLocalIdAndServerOnlyPersist();
  await testMoveSameSlugCopiesKeepsOtherCopyInPlace();
  testSameSlugCopiesKeepIndependentPlacement();
  testLocalIdOnlyNodeIsUnresolvableElsewhere();
  testRegisteringPcHealsTheTree();
  testDuplicateNodesFoldByTreeOrder();
  testIndexDocReportsWhatItDropped();
  testFolderShareUsesPublishedName();
  testHealedNodeSurvivesFolderShare();
  await testFailedHealIsRetriedOnTheNextFetch();
  console.log('manage tree regression tests: PASS');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
