'use strict';

// 管理画面 (index.html) のワークスペース・ツリーの回帰テスト。
//
// 捕まえたい壊れ方: 「登録した PC では正しくフォルダの中にあるのに、別 PC で
// master に入るとフォルダが空になり、プロジェクトがルートに出てしまう」。
// 原因はツリーのノードがそのブラウザ内でしか意味を持たない localId しか
// 持たず、publish しても slug が書き戻らないこと。ここでは実際の
// index.html から関数を切り出して、その身元解決だけを動かして確かめる。
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

  const dirty = vm.runInContext('_reconcileTree(_indexRows(ROWS).rowForNode)', context);
  assert.equal(dirty, true, '書き換えたら true を返して保存させる');

  const node = tree.children[0].children[0];
  assert.equal(node.slug, 'medaka-test-a1b2', 'slug が焼き付いている');
  assert.equal(node.localId, 'proj_k3f9x', 'localId は消さない (元 PC の解決も残す)');

  // 治ったツリーを別 PC で読む。
  context.ROWS = rowsOnOtherPc;
  const idx = vm.runInContext('_indexRows(ROWS)', context);
  assert.ok(idx.rowForNode(node), '別 PC でも slug で解決でき、フォルダの中に出る');

  // 2 回目は何も変わらないので保存しない (描画のたびに書きに行かせない)。
  context.ROWS = rowsOnRegisteringPc;
  assert.equal(vm.runInContext('_reconcileTree(_indexRows(ROWS).rowForNode)', context), false,
    '変化が無ければ false');
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
  assert.equal(vm.runInContext('_reconcileTree(_indexRows(ROWS).rowForNode)', context), true);

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

function main() {
  testLocalIdOnlyNodeIsUnresolvableElsewhere();
  testRegisteringPcHealsTheTree();
  testDuplicateNodesFoldByTreeOrder();
  testIndexDocReportsWhatItDropped();
  testHealedNodeSurvivesFolderShare();
  console.log('manage tree regression tests: PASS');
}

main();
