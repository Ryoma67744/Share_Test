'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { deflateRawSync } = require('node:zlib');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'viewer', 'index.html'), 'utf8');

function scanBalanced(source, openAt) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = openAt; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
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

function extractObject(source, marker) {
  const markerAt = source.indexOf(marker);
  assert.notEqual(markerAt, -1, `missing ${marker}`);
  const openAt = source.indexOf('{', markerAt + marker.length);
  // SharePreview is a top-level const and its terminator is the only `};`
  // beginning at column zero inside the declaration. This avoids treating
  // braces in regex literals/template substitutions as structural braces.
  const terminatorAt = source.indexOf('\n};', openAt);
  assert.notEqual(terminatorAt, -1, `missing terminator for ${marker}`);
  return source.slice(openAt, terminatorAt + 2);
}

function extractFunction(source, name) {
  // Accept both `async function <name>` and plain `function <name>` so sync
  // parsers can be lifted out of the HTML the same way the worker handler is.
  let marker = `async function ${name}`;
  let markerAt = source.indexOf(marker);
  if (markerAt === -1) {
    marker = `function ${name}`;
    markerAt = source.indexOf(marker);
  }
  assert.notEqual(markerAt, -1, `missing function ${name}`);
  const openAt = source.indexOf('{', markerAt + marker.length);
  const closeAt = scanBalanced(source, openAt);
  return source.slice(markerAt, closeAt + 1);
}

// 構文ゲート。アプリは 1 ファイル 1 ページの inline script なので、ここが
// 落ちなければ「読み込んだ瞬間に真っ白」だけは避けられる。viewer だけでなく
// 管理画面 (index.html) と MRM 管理 (mrm.html) も見る — どちらも同じ
// IndexedDB / RPC を触るのに、これまで構文の網が掛かっていなかった。
function compileInlineScripts(relPath, minScripts) {
  const source = relPath === 'viewer/index.html'
    ? html
    : fs.readFileSync(path.join(root, relPath), 'utf8');
  const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((s) => s.trim());
  assert.ok(scripts.length >= minScripts, `expected inline scripts in ${relPath}`);
  scripts.forEach((src, index) => new vm.Script(src, {
    filename: `${relPath}#inline-${index + 1}`,
  }));
}

function makePreviewContext(extra = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Map,
    Set,
    ...extra,
  });
  const objectSource = extractObject(html, 'const SharePreview =');
  return { context, preview: vm.runInContext(`(${objectSource})`, context) };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function testFocusLoadAndRaceGuard() {
  const waits = { MSI_A: deferred(), MSI_B: deferred() };
  const panel = {
    imageSources: {},
    ensureMsiLayerLoaded(key) {
      return waits[key].promise.then((ok) => {
        if (ok) this.imageSources[key] = { loaded: true };
        return ok;
      });
    },
    setupCanvasSize() { return false; },
    renderComposite() {},
  };
  const project = {
    sections: [{ id: 's1', msiSeries: {
      MSI_A: { blobId: 'blob-a' },
      MSI_B: { blobId: 'blob-a' },
    } }],
  };
  const App = {
    project,
    panels: new Map([['s1', panel]]),
    focusCompoundKey: null,
    activeOverlay: null,
    setFocusCompoundKey(key) { this.focusCompoundKey = key; this.activeOverlay = null; },
  };
  const { preview } = makePreviewContext({ App });
  const refreshes = [];
  const prefetched = [];
  const progressive = [];
  preview.isOpen = () => true;
  preview.refresh = () => refreshes.push({
    key: App.focusCompoundKey,
    loading: preview._loadingFocusKey,
  });
  preview._showLoadedPreviewCell = (projectArg, key, sectionId) => progressive.push([key, sectionId]);
  preview._cancelAdjacentPrefetch = () => {};
  preview._scheduleAdjacentPrefetch = (key) => prefetched.push(key);

  const loadA = preview._selectCompound('MSI_A');
  assert.deepEqual(refreshes.at(-1), { key: 'MSI_A', loading: 'MSI_A' });
  const loadB = preview._selectCompound('MSI_B');
  assert.deepEqual(refreshes.at(-1), { key: 'MSI_B', loading: 'MSI_B' });

  waits.MSI_B.resolve(true);
  await loadB;
  assert.deepEqual(refreshes.at(-1), { key: 'MSI_B', loading: null });
  assert.deepEqual(prefetched, ['MSI_B']);
  assert.deepEqual(progressive, [['MSI_B', 's1']]);

  waits.MSI_A.resolve(true);
  await loadA;
  assert.equal(App.focusCompoundKey, 'MSI_B');
  assert.deepEqual(refreshes.at(-1), { key: 'MSI_B', loading: null });
  assert.deepEqual(prefetched, ['MSI_B'], 'late MSI_A completion must not win');
  assert.deepEqual(progressive, [['MSI_B', 's1']], 'late MSI_A must not repaint a cell');
}

async function testFailedLoadStaysExplicit() {
  const panel = {
    imageSources: {},
    async ensureMsiLayerLoaded() { return false; },
    setupCanvasSize() { return false; },
    renderComposite() {},
  };
  const project = { sections: [{ id: 's1', msiSeries: { MSI_A: { blobId: 'bad' } } }] };
  const App = {
    project,
    panels: new Map([['s1', panel]]),
    focusCompoundKey: null,
    activeOverlay: null,
    setFocusCompoundKey(key) { this.focusCompoundKey = key; },
  };
  const { preview } = makePreviewContext({ App });
  preview.isOpen = () => true;
  preview.refresh = () => {};
  preview._cancelAdjacentPrefetch = () => {};
  preview._scheduleAdjacentPrefetch = () => { throw new Error('failed load must not prefetch'); };
  preview._showLoadedPreviewCell = () => {};
  await preview._selectCompound('MSI_A');
  assert.equal(preview._loadingFocusKey, 'MSI_A');
  assert.equal(preview._focusLoadStatus.get('s1'), 'failed');
}

class FakeElement {
  constructor() { this.listeners = new Map(); this.value = ''; this.disabled = false; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  fire(type) { this.listeners.get(type)(); }
}

function testRangeResetAndSingleRepaint() {
  const min = new FakeElement();
  const max = new FakeElement();
  const reset = new FakeElement();
  const bySelector = new Map([
    ['[data-preview-range-min]', min],
    ['[data-preview-range-max]', max],
    ['[data-preview-range-reset]', reset],
  ]);
  const panels = [0, 1].map(() => ({
    renders: 0,
    renderComposite() { this.renders++; },
    msiThumbRefs: new Set(),
  }));
  const raf = [];
  const App = {
    focusCompoundKey: 'MSI_A',
    msiUserWindow: { MSI_A: { min: 2, max: 8 } },
    panels: new Map([['s1', panels[0]], ['s2', panels[1]]]),
    project: {},
  };
  const { preview } = makePreviewContext({
    App,
    Toolbar: { refreshRange() {} },
    requestAnimationFrame(fn) { raf.push(fn); return raf.length; },
    cancelAnimationFrame() {},
  });
  preview.overlay = { querySelector(selector) { return bySelector.get(selector) || null; } };
  preview._refreshRangeInputs = () => {};
  preview._rebakeCellImages = () => {};
  preview._wireRangeInputs();

  reset.fire('click');
  assert.equal(App.msiUserWindow.MSI_A, undefined);
  assert.deepEqual(panels.map((panel) => panel.renders), [1, 1]);
  raf.shift()();

  min.value = '3.5';
  min.fire('change');
  assert.equal(App.msiUserWindow.MSI_A.min, 3.5);
  assert.deepEqual(panels.map((panel) => panel.renders), [2, 2],
    'one Range change should repaint each panel exactly once');
}

// 重ね合わせの既定色。加算合成 (globalCompositeOperation='lighter') なので、
// 先頭 2 色は光の成分が重ならない組でなければ「白 = 共局在」と読めない。
// 旧既定は赤+緑で、最も多い色覚型では区別できなかった。
function testOverlayDefaultPalette() {
  const m = /const OVERLAY_DEFAULT_PALETTE = (\[[^\]]*\]);/.exec(html);
  assert.ok(m, 'missing OVERLAY_DEFAULT_PALETTE');
  const palette = JSON.parse(m[1].replace(/'/g, '"'));
  assert.ok(palette.length >= 3, 'need at least three default channels');

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [c1, c2] = palette.slice(0, 2).map(rgb);
  // 1 色目と 2 色目は成分が排他 (どのチャンネルも両方には現れない)。
  for (let ch = 0; ch < 3; ch++) {
    assert.ok(!(c1[ch] > 0 && c2[ch] > 0),
      '1色目と2色目は光の成分が重なってはいけない (共局在が白として読めなくなる): ' + palette.slice(0, 2));
  }
  // 赤+緑 (最も多い色覚型で区別できない組) を既定の隣り合わせにしない。
  const isRedish = (c) => c[0] > 150 && c[1] < 100 && c[2] < 100;
  const isGreenish = (c) => c[1] > 150 && c[0] < 100 && c[2] < 100;
  for (let i = 1; i < palette.length; i++) {
    const a = rgb(palette[i - 1]); const b = rgb(palette[i]);
    assert.ok(!((isRedish(a) && isGreenish(b)) || (isGreenish(a) && isRedish(b))),
      '赤と緑を既定で隣り合わせにしない: ' + palette[i - 1] + ' / ' + palette[i]);
  }

  const limit = /const OVERLAY_ADDITIVE_LIMIT = (\d+);/.exec(html);
  assert.ok(limit && Number(limit[1]) >= 2, 'missing OVERLAY_ADDITIVE_LIMIT');
}

// _rebakeCellImages は「中身があるか」を focusKey だけで見ていたので、重ね合わせ中に
// その切片へ focusKey の化合物が無いと黙って早期 return し、Otsu の切り替えも
// Range の変更もセルへ反映されなかった。_renderImageGrid と同じ判定に揃える。
function testRebakeCellImagesFollowsOverlay() {
  const img = { src: 'OLD', decode() { return Promise.resolve(); } };
  const wrap = { querySelector: (sel) => (sel === '[data-cell-img]' ? img : null) };
  const grid = { querySelector: (sel) => (/cell-img-wrap/.test(sel) ? wrap : null) };
  const section = { id: 's1', msiSeries: { MSI_OVERLAY_MEMBER: {} } };   // focusKey の層は無い
  const panel = { dom: { cdisp: { width: 10, height: 10 } } };
  const App = {
    activeOverlay: { layers: [{ key: 'MSI_OVERLAY_MEMBER', color: '#ff00ff' }] },
    panels: new Map([['s1', panel]]),
    project: { sections: [section] },
  };
  const { preview } = makePreviewContext({ App });
  preview.overlay = { querySelector: (sel) => (sel === '[data-image-grid]' ? grid : null) };
  preview._sectionsForGrid = () => [section];
  preview._sectionRotations = [0];
  preview._bakeRotatedCanvas = () => ({ toDataURL: () => 'NEW' });

  // 重ね合わせ中 + focusKey がこの切片に無い = 判定が食い違う条件
  preview._rebakeCellImages(App.project, 'MSI_NOT_IN_THIS_SECTION');
  assert.equal(img.src, 'NEW',
    '重ね合わせ中は focusKey がその切片に無くてもセルを焼き直すこと');

  // 重ね合わせが無いときは従来どおり focusKey で判断する
  img.src = 'OLD';
  App.activeOverlay = null;
  preview._rebakeCellImages(App.project, 'MSI_NOT_IN_THIS_SECTION');
  assert.equal(img.src, 'OLD', '単一表示では存在しない focusKey を焼かない');
  preview._rebakeCellImages(App.project, 'MSI_OVERLAY_MEMBER');
  assert.equal(img.src, 'NEW', '単一表示でも存在する focusKey なら焼く');
}

// カラーバーは単一化合物の強度目盛り。重ね合わせ中に出し続けると、画面の色
// (分子ごとの単色 LUT の加算) と対応しない目盛りを見せることになる。
function testColorbarBecomesLegendInOverlayMode() {
  const mkEl = () => ({
    hidden: false, innerHTML: '', width: 0, height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
  });
  const cv = mkEl(); const legend = mkEl(); const label = mkEl();
  const ovPanel = mkEl(); ovPanel.hidden = true;
  const classes = new Set();
  const App = {
    activeOverlay: { layers: [{ key: 'MSI_Lactate', color: '#ff00ff' }, { key: 'MSI_Citrate', color: '#00ff00' }] },
    project: {},
  };
  const { preview } = makePreviewContext({
    App,
    findCompoundMeta: () => null,
    formatDisplayName: (k) => String(k).replace(/^MSI_/, ''),
    get2dContext: (c) => c.getContext('2d'),
    getActiveColormap: () => Array.from({ length: 256 }, () => [0, 0, 0]),
  });
  const bySel = { '[data-colorbar]': cv, '[data-cb-legend]': legend, '[data-cb-label]': label,
                  '[data-ov-panel]': ovPanel };
  preview.overlay = {
    querySelector: (sel) => bySel[sel] || null,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
  };

  preview._drawColorbar();
  assert.equal(cv.hidden, true, '重ね合わせ中はグラデーションを出さない');
  assert.equal(legend.hidden, false);
  assert.ok(classes.has('ov-wide'), '凡例のぶん右端の列を広げるクラスが付くこと');
  assert.match(legend.innerHTML, /#ff00ff/, '1色目の色見本');
  assert.match(legend.innerHTML, /Lactate/, '分子名');
  assert.match(legend.innerHTML, /共局在/, '白 = 共局在 の説明');

  App.activeOverlay = null;
  preview._drawColorbar();
  assert.equal(cv.hidden, false, '単一表示ではグラデーションへ戻す');
  assert.equal(legend.hidden, true);
  assert.equal(legend.innerHTML, '');
  assert.ok(!classes.has('ov-wide'), '一覧も凡例も無ければ元の幅へ戻す');
}

// close() は opacity / 表示レイヤー / HE グレースケール / 配色 を戻すのに、
// 重ね合わせだけ戻していなかった。プレビューで重ね合わせにして閉じると主画面が
// 重ね合わせのまま残る。master がプレビューを使い始めると必ず踏む。
function testCloseRestoresOverlay() {
  const before = { id: 'ov_before', layers: [] };
  const after = { id: 'ov_after', layers: [] };
  const setCalls = [];
  const modeCalls = [];
  const App = {
    activeOverlay: before,
    setActiveOverlay(def) { setCalls.push(def); this.activeOverlay = def; },
    // open() は Compound へ倒すが setViewMode は localStorage にも書くので、
    // 戻さないと「相手の見え方を確かめただけ」で master の主画面が恒久的に
    // Compound へ変わる。
    viewMode: 'compound',
    setViewMode(m) { modeCalls.push(m); this.viewMode = m; },
    panels: new Map(),
    roiOnlyMode: false,
  };
  const { preview } = makePreviewContext({ App, cancelAnimationFrame() {} });
  // open() が撮る控えだけを再現し、DOM に触る復元は差し替える。
  preview._overlaySnapshot = before;
  preview._savedViewMode = 'free';    // 開く前は Free だった
  preview.overlay = { remove() {} };
  for (const m of ['_restoreGrayscale', '_removeTicBackdrop', '_restoreOpacity',
                   '_restoreVisibility', '_cancelAdjacentPrefetch']) {
    preview[m] = () => {};
  }

  App.activeOverlay = after;          // プレビューの中で別の重ね合わせに切り替えた
  preview.close();
  assert.deepEqual(setCalls, [before], 'close() は開いた時点の重ね合わせへ戻すこと');
  assert.equal(App.activeOverlay, before);
  assert.equal(preview._overlaySnapshot, undefined, '控えは使い切って捨てること');
  assert.deepEqual(modeCalls, ['free'], 'close() は開いた時点の表示モードへ戻すこと');
  assert.equal(preview._savedViewMode, null, '表示モードの控えも使い切ること');

  // 変わっていなければ余計な再描画を起こさない
  setCalls.length = 0;
  modeCalls.length = 0;
  preview._overlaySnapshot = before;
  preview.overlay = { remove() {} };
  preview.close();
  assert.deepEqual(setCalls, [], '変化が無いときは setActiveOverlay を呼ばない');
  assert.deepEqual(modeCalls, [], '控えが無ければ setViewMode も呼ばない');

  // open() 側で控えを取っていなければ close() は何も戻せない
  assert.match(html, /this\._savedViewMode = App\.viewMode;/,
    'open() が表示モードを控えること');
}

// プレビューは開いている間だけ HE/IF を強制表示する。toggleLayer は
// section.meta.visibleLayers を書いて App.queueSave() まで呼ぶので、そのまま
// 使うと「意図的に隠していた histology が、プレビューを開いただけでローカルにも
// 共有先にも表示状態で保存される」。共有プロジェクトは _doSave が __share で
// 弾いていたので無害だったが、master で開けるようにした以上そうはいかない。
function testForcedHeBackdropDoesNotPersist() {
  const calls = [];
  const panel = {
    section: { images: { HE_STAIN_1: {} } },
    imageSources: { HE_STAIN_1: {} },
    visibleLayers: new Set(),
    toggleLayer(key, force, opts) { calls.push({ key, force, opts }); this.visibleLayers.add(key); },
  };
  const App = { panels: new Map([['s1', panel]]) };
  const { preview } = makePreviewContext({ App });

  const touched = preview._forceHeBackdrop();
  assert.equal(touched, 1, '隠れている HE/IF を 1 枚点けること');
  assert.equal(calls.length, 1);
  // vm は別レアルムなので deepEqual はプロトタイプ違いで落ちる。値を直接見る。
  assert.equal(calls[0].opts && calls[0].opts.persist, false,
    'プレビューの強制表示は永続化してはいけない (persist:false を渡すこと)');

  // toggleLayer 側がその指示を実際に見ていること
  assert.match(html, /if \(!opts \|\| opts\.persist !== false\) this\._persistVisibleLayers\(\);/,
    'toggleLayer が persist:false を尊重すること');
}

// KMD の「重ねる」が作る kmd-tmp は project.overlays に載らない一時的な定義。
// それを existing として openOverlayModal に渡すと編集分岐に入り、その場限りの
// オブジェクトを書き換えて登録しないまま終わる。
function testOverlayForEditingIgnoresUnregistered() {
  const context = vm.createContext({});
  vm.runInContext(
    extractTopLevelFunction('overlayForEditing') + '\nthis.api = { overlayForEditing };',
    context,
  );
  const { overlayForEditing } = context.api;
  const registered = { id: 'ov_1', layers: [] };
  const tmp = { id: 'kmd-tmp', layers: [] };
  const project = { overlays: [registered] };

  assert.equal(overlayForEditing(registered, project), registered, '登録済みは編集として開く');
  assert.equal(overlayForEditing(tmp, project), null, 'kmd-tmp は新規登録として開く');
  assert.equal(overlayForEditing(null, project), null);
  assert.equal(overlayForEditing(registered, {}), null, 'overlays が無ければ新規扱い');
  assert.equal(overlayForEditing(registered, null), null);
  // id が同じでも別オブジェクトなら編集対象にしない (同一性で判定する)
  assert.equal(overlayForEditing({ id: 'ov_1', layers: [] }, project), null);
}

// プレビューの ＋重ね合わせ は必ず「新規登録」で開くこと。表示中の重ね合わせを
// existing として渡していたため、1 セット目を登録したあともう一度押すと編集
// モーダルが開き、2 セット目を作ったつもりで 1 セット目を上書きしていた
// (プレビューからは 1 セットしか持てなかった)。主画面の #btn-add-overlay と同じ。
function testPreviewAddOverlayAlwaysAdds() {
  const at = html.indexOf("querySelector('[data-add-overlay]')");
  assert.notEqual(at, -1, 'missing the preview ＋重ね合わせ wiring');
  const end = html.indexOf('openOverlayModal from preview failed', at);
  assert.notEqual(end, -1, 'missing the add-overlay click handler');
  const handler = html.slice(at, end);
  assert.match(handler, /openOverlayModal\(null\)/,
    '＋重ね合わせ は新規登録で開くこと');
  assert.doesNotMatch(handler, /openOverlayModal\(\s*overlayForEditing/,
    '表示中の重ね合わせを編集対象として渡さないこと (2 セット目が作れなくなる)');
  assert.doesNotMatch(handler, /openOverlayModal\(\s*App\.activeOverlay/,
    '表示中の重ね合わせを編集対象として渡さないこと (2 セット目が作れなくなる)');
  // 編集の導線は各行の ✎ に移した
  assert.match(html, /data-ov-edit-row/, '行ごとの編集ボタンがあること');
}

// 重ね合わせの一覧は右端の列にまとめる。Method 表の末尾に混ぜていたときは
// 化合物が数十行ある中に埋もれ、セットが増えるほど探しづらかった。
// 一覧は登録・削除・改名にその場で追随する必要があるので毎回組み直す。
function testOverlayPanelRendersInRightColumn() {
  const mk = () => ({ innerHTML: '', hidden: false, listeners: [],
    addEventListener(t, fn) { this.listeners.push(fn); },
    querySelectorAll() { return items; } });
  let items = [];
  const panel = mk(); const list = mk(); const single = mk();
  const classes = new Set();
  const project = { overlays: [] };
  const App = { activeOverlay: null, project };
  const { preview } = makePreviewContext({ App });
  const bySel = { '[data-ov-panel]': panel, '[data-ov-list]': list, '[data-ov-single]': single,
                  '[data-cb-legend]': { hidden: true } };
  preview.overlay = {
    querySelector: (sel) => bySel[sel] || null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c),
                 toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } },
  };

  // 0 件なら出さないし、列も広げない
  preview._renderOverlayPanel(project);
  assert.equal(panel.hidden, true, '登録が無ければ一覧は出さない');
  assert.ok(!classes.has('ov-wide'), '一覧が無ければ列は広げない');

  const a = { id: 'ov_1', name: 'セットA', layers: [{ key: 'MSI_x', color: '#ff00ff' }] };
  const b = { id: 'ov_2', name: 'セットB', layers: [{ key: 'MSI_y', color: '#00ff00' }] };
  project.overlays.push(a, b);
  preview._renderOverlayPanel(project);
  assert.equal(panel.hidden, false, '登録があれば一覧を出す');
  assert.ok(classes.has('ov-wide'), '一覧のぶん列を広げる');
  assert.match(list.innerHTML, /セットA/);
  assert.match(list.innerHTML, /セットB/, '2 セット目も並ぶこと');
  assert.match(list.innerHTML, /data-ov-edit-row="ov_1"/, '各セットに編集');
  assert.match(list.innerHTML, /data-ov-del-row="ov_1"/, '各セットに削除');
  assert.equal(single.hidden, true, '重ね合わせ表示中でなければ「単一表示へ戻る」は隠す');
  assert.doesNotMatch(list.innerHTML, /class="cb-ov-item on"/, '表示中が無ければどれも on にしない');

  App.activeOverlay = b;
  preview._renderOverlayPanel(project);
  assert.match(list.innerHTML, /cb-ov-item on" data-ov-id="ov_2"/, '表示中のセットに印を付ける');
  assert.equal(single.hidden, false, '重ね合わせ表示中は「単一表示へ戻る」を出す');

  // 削除された分は消える
  project.overlays = [a];
  App.activeOverlay = null;
  preview._renderOverlayPanel(project);
  assert.doesNotMatch(list.innerHTML, /セットB/, '削除したセットは一覧から消えること');

  // Method 表には重ね合わせの行を残さない (化合物だけ)
  assert.doesNotMatch(html, /tr data-overlay-id=/, 'Method 表に重ね合わせの行を残さないこと');
}

// 削除は主画面のチップとプレビューの一覧の両方から呼ぶので、確認・後始末を
// 1 か所 (deleteOverlayById) に置く。片方だけ直して食い違うのを防ぐ。
function testDeleteOverlayIsShared() {
  const context = vm.createContext({});
  let confirmed = true;
  const cleared = [];
  const saves = [];
  const a = { id: 'ov_1', name: 'A' };
  const b = { id: 'ov_2', name: 'B' };
  const App = {
    project: { overlays: [a, b] },
    activeOverlay: null,
    clearActiveOverlay() { cleared.push(true); this.activeOverlay = null; },
    queueSave() { saves.push(true); },
  };
  // プレビューが開いていて、消すセットを「開いた時点の重ね合わせ」として
  // 控えている状態を作る。控えを落とさないと close() で幽霊が復活する。
  const SharePreview = { _overlaySnapshot: a, isOpen: () => true, refresh() {} };
  vm.runInContext(
    'const App = this.App, confirm = this.confirm, SharePreview = this.SharePreview;\n'
    + 'function renderOverlayBar() {}\n'
    + extractTopLevelFunction('deleteOverlayById')
    + '\nthis.api = { deleteOverlayById };',
    Object.assign(context, { App, SharePreview, confirm: () => confirmed, console }),
  );
  const { deleteOverlayById } = context.api;

  confirmed = false;
  assert.equal(deleteOverlayById('ov_1'), false, '確認でキャンセルしたら消さない');
  assert.equal(App.project.overlays.length, 2);

  confirmed = true;
  assert.equal(deleteOverlayById('nope'), false, '知らない id は何もしない');
  assert.equal(deleteOverlayById('ov_1'), true);
  assert.deepEqual(App.project.overlays.map(o => o.id), ['ov_2'], '指定したセットだけ消す');
  assert.equal(saves.length, 1, '削除は保存すること');
  assert.equal(cleared.length, 0, '表示中でなければ単一表示へは戻さない');

  assert.equal(SharePreview._overlaySnapshot, null,
    'プレビューの控えが消したセットなら落とすこと (閉じたときに幽霊として復活する)');

  App.activeOverlay = App.project.overlays[0];
  SharePreview._overlaySnapshot = b;   // 別のセットを控えている場合は残す
  assert.equal(deleteOverlayById('ov_2'), true);
  assert.equal(cleared.length, 1, '表示中のセットを消したら単一表示へ戻すこと');
  assert.equal(SharePreview._overlaySnapshot, null, '控えていたセットを消したら落とすこと');

  // 主画面のチップ側も同じ関数を通ること
  assert.match(html, /deleteOverlayById\(delEl\.getAttribute\('data-ov-del'\)\)/,
    '主画面の × も共通の削除を通すこと');
}

// master でも Preview を開けること。CSS の share 限定表示と JS の早期 return が
// 両方外れていないと「ボタンが出ない / 押しても何も起きない」に戻る。
function testMasterCanOpenPreview() {
  assert.doesNotMatch(html, /body\.share-mode #btn-share-preview \{ display:inline-flex; \}/,
    'Preview ボタンを share 限定で出す CSS が残っている');
  // 日本語コメントを含むので固定長では切り出さない。ハンドラの始点と、その中で
  // 必ず一度だけ現れる SharePreview.open の catch までを本文とする。
  const startAt = html.indexOf("getElementById('btn-share-preview')");
  assert.notEqual(startAt, -1, 'missing #btn-share-preview handler');
  const endAt = html.indexOf("console.warn('SharePreview.open failed'", startAt);
  assert.notEqual(endAt, -1, 'missing SharePreview.open call in the handler');
  const handler = html.slice(startAt, endAt);
  assert.doesNotMatch(handler, /!this\.shareMode\s*\|\|/,
    'ハンドラに share 限定の早期 return が残っている');
  assert.match(handler, /this\.shareMode \? \(this\.shareMode\.role \|\| 'viewer'\) : 'admin'/,
    'master には admin role を渡すこと (CE/CV 列が出なくなる)');
}

async function testWorkerXlsxDecodeCache() {
  let arrayBufferCalls = 0;
  let parseCalls = 0;
  const extractedColumns = [];
  const posts = [];
  const self = { postMessage(message) { posts.push(message); } };
  const context = vm.createContext({
    self,
    parseXlsxSheet() { parseCalls++; return { aoa: [[1, 2, 3]] }; },
    rowsFromParsedXlsx(parsed, def) { extractedColumns.push(def.col_v); return [{ x: 0, y: 0, v: 1 }]; },
    parseTxtToRows() { throw new Error('not used'); },
    computeRasterPixels() {
      return {
        width: 1, height: 1,
        pixels: new Uint8ClampedArray(4), values: new Float32Array([1]),
        rawRange: [0, 1], rawMean: 1, rawTrueMax: 1, rawDispMax: 1, diag: {},
      };
    },
    async _encodePixelsToDataUrl() { return 'data:image/png;base64,test'; },
    decodeTiffArrayBufferToDataUrl() {},
    inspectXlsxColumns() {},
    Map,
  });
  const fnSource = extractFunction(html, '_parseWorkerOnMessage');
  vm.runInContext(`${fnSource}; self.handler = _parseWorkerOnMessage;`, context);
  const blob = { async arrayBuffer() { arrayBufferCalls++; return new ArrayBuffer(1); } };
  await self.handler({ data: { id: 1, op: 'xlsx-raster', payload: {
    blob, cacheKey: 'blob-1|Sheet1', def: { col_v: 'C' },
  } } });
  await self.handler({ data: { id: 2, op: 'xlsx-raster', payload: {
    blob, cacheKey: 'blob-1|Sheet1', def: { col_v: 'D' },
  } } });

  assert.equal(arrayBufferCalls, 1, 'cache hit should skip Blob.arrayBuffer');
  assert.equal(parseCalls, 1, 'cache hit should skip XLSX sheet decoding');
  assert.deepEqual(extractedColumns, ['C', 'D']);
  assert.equal(posts.length, 2);
  assert.ok(posts.every((entry) => entry.ok));
}

// Waters writes .raw/imaging/Analyte N.txt with an all-zero padding row above the
// real m/z rows. Zeros are finite, so the "first pair of consecutive numeric-only
// rows" heuristic used to latch onto the padding, reject every column for
// precursor <= 0, and throw "no compounds detected". Both header shapes must work.
function testAnalyteHeaderShapes() {
  const context = vm.createContext({ TextDecoder, Number, String, Error });
  vm.runInContext(
    `${extractFunction(html, 'splitCeCv')};${extractFunction(html, 'parseAnalyteHeader')};`
    + 'this.parse = (text) => parseAnalyteHeader(text);',
    context,
  );
  // Arrays built inside the vm live in another realm, so compare host-side copies.
  const parse = context.parse;

  // (a) the Waters .raw/imaging shape: blank line, all-zero padding row,
  //     strict channel-index row, precursor row, product row, then data.
  const rawImaging = [
    '',
    '5\t\t\t0\t0\t0\t0\t',
    '\t\t\t1\t2\t3\t4\t',
    '\t\t\t104.0000\t137.1000\t146.1000\t798.5500\t',
    '\t\t\t87.0000\t91.1000\t87.1000\t163.0000\t',
    '1\t9.40746\t-5.78301\t10820.0000\t1186.0000\t6854.0000\t111256.0000\t1\t1',
  ].join('\r\n');
  const rawHeader = parse(rawImaging);
  assert.equal(rawHeader.precIdx, 3, 'padding row must not be taken as precursor');
  assert.equal(rawHeader.prodIdx, 4);
  assert.equal(rawHeader.dataStartLine, 5);
  assert.deepEqual(Array.from(rawHeader.compounds, (c) => c.precursor), [104, 137.1, 146.1, 798.55]);
  assert.deepEqual(Array.from(rawHeader.compounds, (c) => c.product), [87, 91.1, 87.1, 163]);
  // This shape has no name row at all, so every channel is named from its
  // transition and flagged. "Compound3" would say nothing, and the label becomes
  // the compound name in the shared MRM library where the name is UNIQUE.
  assert.deepEqual(Array.from(rawHeader.compounds, (c) => c.name),
    ['mz104_87', 'mz137.1_91.1', 'mz146.1_87.1', 'mz798.55_163']);
  assert.ok(Array.from(rawHeader.compounds).every((c) => c.synthesizedName === true));
  // Exactly one underscore, so splitCeCv can never read the transition back as
  // a _<CE>_<CV> suffix (that is how renaming used to invent voltages).
  assert.deepEqual(Array.from(rawHeader.compounds, (c) => c.ce), [null, null, null, null]);
  assert.deepEqual(Array.from(rawHeader.compounds, (c) => c.cv), [null, null, null, null]);
  assert.deepEqual(Array.from(rawHeader.compounds, (c) => c.base),
    ['mz104_87', 'mz137.1_91.1', 'mz146.1_87.1', 'mz798.55_163']);

  // (b) the HDI-converted shape with a compound-name row still parses unchanged,
  //     including the _<CE>_<CV> suffix split.
  const converted = [
    'Analyte (converted from imzML)',
    '\t\t\tGABA_10_10\tDopamine_18_50\tACh_10_15',
    '\t\t\t104.0000\t137.1000\t146.1000',
    '\t\t\t87.0000\t91.1000\t87.1000',
    '1\t0\t0\t1\t2\t3',
  ].join('\n');
  const convHeader = parse(converted);
  assert.equal(convHeader.nameIdx, 1);
  assert.equal(convHeader.dataStartLine, 4);
  assert.deepEqual(Array.from(convHeader.compounds, (c) => c.base), ['GABA', 'Dopamine', 'ACh']);
  assert.deepEqual(Array.from(convHeader.compounds, (c) => c.ce), [10, 18, 10]);
  assert.deepEqual(Array.from(convHeader.compounds, (c) => c.cv), [10, 50, 15]);
  assert.ok(Array.from(convHeader.compounds).every((c) => c.synthesizedName === false),
    'a real name row must not be reported as synthesised');

  // (c) a name row with a hole: only the blank entry is synthesised.
  const partial = [
    'Analyte (converted from imzML)',
    '\t\t\tGABA\t\tACh',
    '\t\t\t104.0000\t137.1000\t146.1000',
    '\t\t\t87.0000\t91.1000\t87.1000',
    '1\t0\t0\t1\t2\t3',
  ].join('\n');
  const partialHeader = parse(partial);
  assert.deepEqual(Array.from(partialHeader.compounds, (c) => c.name), ['GABA', 'mz137.1_91.1', 'ACh']);
  assert.deepEqual(Array.from(partialHeader.compounds, (c) => c.synthesizedName), [false, true, false]);
}

// ---------------------------------------------------------------------------
// Synthetic Waters .raw, written byte by byte so this doubles as executable
// documentation of the layout the viewer reads. 3x2 pixels, 2 MRM channels.
// ---------------------------------------------------------------------------
const RAW_FX = {
  xs: [1.0, 1.1, 1.2, 1.0, 1.1, 1.2],
  ys: [5.0, 5.0, 5.0, 5.2, 5.2, 5.2],
  chan: [[100, 200, 300, 400, 500, 600], [7, 8, 9, 10, 11, 12]],
  names: ['Alpha', 'Beta'],
  precursor: [104, 146.1],
  product: [87, 87.1],
  cv: [10, 15],
  ce: [22, 35],
  dwell: 0.0098889,
  // .STS deliberately gets an ODD stride so the fixture exercises the
  // unaligned reads that make DataView (not typed-array views) mandatory.
  stsStride: 9,
};

// intensity = (w & 0x3FFFFF) * 2 ** ((w >>> 22) - 21); exponent 21 stores an
// integer mantissa verbatim.
function rawWord(v) { return (((21 << 22) >>> 0) | v) >>> 0; }

function putParamTable({ stride, params, records, write }) {
  const dataOffset = 32 + params.length * 48;
  const buf = new ArrayBuffer(dataOffset + records * stride);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint16(0, dataOffset, true);
  dv.setUint16(2, 1, true);
  dv.setUint16(4, stride, true);
  dv.setUint16(6, params.length, true);
  params.forEach((p, i) => {
    const b = 32 + i * 48;
    dv.setUint16(b, p.id, true);
    dv.setUint16(b + 2, p.flag, true);
    dv.setUint16(b + 4, p.offset, true);
    for (let k = 0; k < p.name.length && k < 26; k++) u8[b + 6 + k] = p.name.charCodeAt(k);
    dv.setUint16(b + 32, p.size, true);
  });
  for (let r = 0; r < records; r++) write(dv, dataOffset + r * stride, r);
  return buf;
}

function buildSyntheticRawMembers() {
  const n = RAW_FX.xs.length;
  const nCh = RAW_FX.chan.length;

  const dat = new ArrayBuffer(n * nCh * 4);
  const datDv = new DataView(dat);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) datDv.setUint32((i * nCh + c) * 4, rawWord(RAW_FX.chan[c][i]), true);
  }

  const idx = new ArrayBuffer(n * 22);
  const idxDv = new DataView(idx);
  for (let i = 0; i < n; i++) {
    idxDv.setUint32(i * 22, i * nCh * 4, true);          // offset into .DAT
    idxDv.setUint32(i * 22 + 4, (0x08000000 | nCh) >>> 0, true); // nPeaks + calibrated bit
    idxDv.setFloat32(i * 22 + 8, RAW_FX.chan.reduce((a, c) => a + c[i], 0), true); // TIC
    idxDv.setFloat32(i * 22 + 12, (i + 1) * 0.00185, true);      // retention time, minutes
  }

  const sts = putParamTable({
    stride: RAW_FX.stsStride,
    params: [
      { id: 9, flag: 3, offset: 1, size: 4, name: 'Aim X Position' },
      { id: 10, flag: 3, offset: 5, size: 4, name: 'Aim Y Position' },
    ],
    records: n,
    write: (dv, at, r) => { dv.setFloat32(at + 1, RAW_FX.xs[r], true); dv.setFloat32(at + 5, RAW_FX.ys[r], true); },
  });

  const ee = putParamTable({
    stride: 4,
    params: [
      { id: 110, flag: 1, offset: 0, size: 2, name: 'Cone Voltage' },
      { id: 111, flag: 1, offset: 2, size: 2, name: 'Collision Energy' },
    ],
    records: nCh,
    write: (dv, at, c) => { dv.setUint16(at, RAW_FX.cv[c], true); dv.setUint16(at + 2, RAW_FX.ce[c], true); },
  });

  const REC = 16;
  const cmp = new ArrayBuffer(12 + nCh * REC);
  const cmpDv = new DataView(cmp);
  const cmpU8 = new Uint8Array(cmp);
  cmpDv.setUint32(0, 1, true);
  cmpDv.setUint32(4, nCh, true);
  RAW_FX.names.forEach((nm, c) => {
    for (let k = 0; k < nm.length; k++) cmpU8[12 + c * REC + k] = nm.charCodeAt(k);
  });

  const fns = new ArrayBuffer(416);
  const fnsDv = new DataView(fns);
  fnsDv.setUint8(0, 9);              // function type 9 = MRM
  fnsDv.setFloat32(10, 0, true);     // rt start
  fnsDv.setFloat32(14, 3000, true);  // rt end
  for (let c = 0; c < nCh; c++) {
    fnsDv.setFloat32(32 + c * 4, RAW_FX.dwell, true);
    fnsDv.setFloat32(160 + c * 4, RAW_FX.precursor[c], true);
    fnsDv.setFloat32(288 + c * 4, RAW_FX.product[c], true);
  }

  const enc = (t) => new TextEncoder().encode(t);
  return [
    ['SYNTH.raw/_HEADER.TXT', enc('$$ Instrument: SYNTH-TQ\r\n$$ Acquired Date: 04-Sep-2026\r\n')],
    // windows-1252 degree sign (0xB0) - decoding this as UTF-8 corrupts the key.
    ['SYNTH.raw/_extern.inf', Uint8Array.from([
      ...enc('[DESI Experiment Parameters]\r\nDesiXStep\t0.05\r\nDesiYStep\t0.2\r\n\r\n'),
      ...enc('Instrument Parameters - Function 1:\r\nPolarity\tES+\r\nSource Temperature ('), 0xB0,
      ...enc('C)\t150\t150\r\n'),
    ])],
    ['SYNTH.raw/_FUNCTNS.INF', new Uint8Array(fns)],
    ['SYNTH.raw/_FUNC001.IDX', new Uint8Array(idx)],
    ['SYNTH.raw/_FUNC001.DAT', new Uint8Array(dat)],
    ['SYNTH.raw/_FUNC001.STS', new Uint8Array(sts)],
    ['SYNTH.raw/_FUNC001.EE', new Uint8Array(ee)],
    ['SYNTH.raw/_FUNC001.CMP', new Uint8Array(cmp)],
  ];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Members whose name matches this are DEFLATEd rather than STOREd. The app's own
// archives are deflated, so leaving the fixture STORE-only would never execute
// the inflate path at all — the one place the app (DecompressionStream) and the
// connector (zlib) legitimately differ.
const ZIP_DEFLATE = /_FUNC001\.(STS|DAT)$/;

function buildZip(members) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, bytes] of members) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(bytes);
    const deflate = ZIP_DEFLATE.test(name);
    const stored = deflate ? new Uint8Array(deflateRawSync(bytes)) : bytes;
    const method = deflate ? 8 : 0;
    const local = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(8, method, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, stored.length, true);
    ldv.setUint32(22, bytes.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(10, method, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, stored.length, true);
    cdv.setUint32(24, bytes.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    parts.push(local, stored);
    offset += local.length + stored.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const cd of central) { parts.push(cd); cdSize += cd.length; }
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, central.length, true);
  edv.setUint16(10, central.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, cdStart, true);
  parts.push(eocd);
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out.buffer;
}

// Anchored so a mention of the name in a comment can never be mistaken for the
// declaration.
function extractTopLevelFunction(name) {
  const re = new RegExp(`(^|\\n)(async )?function ${name}\\s*\\(`);
  const m = re.exec(html);
  assert.ok(m, `missing top-level function ${name}`);
  const startAt = m.index + (m[1] ? m[1].length : 0);
  const openAt = html.indexOf('{', m.index + m[0].length - 1);
  return html.slice(startAt, scanBalanced(html, openAt) + 1);
}

// The parse worker is assembled by stringifying the functions named in the
// `fns` array. A name missing from that array does NOT fail node --check: the
// worker throws ReferenceError at run time and every caller silently falls back
// to the main thread, so the picture still appears and only the off-main-thread
// benefit dies. This test assembles the SAME list and actually runs the .raw
// path through it, so an omitted helper fails loudly here instead.
// Assemble the worker exactly as _buildParseWorkerSource does — the same `fns`
// list, the same injected constants — and hand back whichever of them the
// caller wants to CALL. Defining a function does not evaluate its body, so the
// xlsx/TIFF entries can be defined without XLSX/UTIF present; only what a test
// actually calls has to resolve.
function assembleWorkerFns(wanted, extraNames) {
  const listMatch = /const fns = \[([\s\S]*?)\n {4}\];/.exec(html);
  assert.ok(listMatch, 'missing parse-worker fns list');
  const names = listMatch[1].split(/[,\s]+/).filter(Boolean);
  const constOf = (name) => {
    const m = new RegExp('const ' + name + ' = ([0-9.]+);').exec(html);
    assert.ok(m, 'missing constant ' + name);
    return m[1];
  };
  const context = vm.createContext({
    console, TextDecoder, TextEncoder, Blob, Response, DecompressionStream, out: {},
  });
  vm.runInContext(
    'const MSI_ROBUST_PERCENTILE = ' + constOf('MSI_ROBUST_PERCENTILE') + ';\n'
    + 'const MSI_DEFAULT_DISPLAY_PERCENTILE = ' + constOf('MSI_DEFAULT_DISPLAY_PERCENTILE') + ';\n'
    // `extraNames` are defined alongside but are NOT part of the worker list —
    // main-thread-only entry points a test wants to call.
    + names.concat(extraNames || []).map(extractTopLevelFunction).join('\n\n')
    + '\nout.api = { ' + wanted.join(', ') + ' };',
    context,
  );
  return { names, api: context.out.api };
}

// The bake chain the worker runs for EVERY MSI layer, whatever the format.
// This is the omission that actually happened once: deriveBakeStats and
// percentileOfSorted were dropped from the list when "sort only once" split them
// out, so the worker threw ReferenceError on every bake and silently fell back
// to the main thread — the picture still appeared, only the off-main-thread
// benefit died. Running the chain here makes that fail loudly instead.
function testWorkerBakePath() {
  const { api } = assembleWorkerFns(['computeRasterPixels', 'parseTxtToRows']);
  const rows = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) rows.push({ x, y, v: y * 5 + x });

  // The txt reader feeds the same chain, and is pure, so cover it here too.
  const tsv = ['x\ty\tv'].concat(rows.map((r) => r.x + '\t' + r.y + '\t' + r.v)).join('\n');
  const parsed = api.parseTxtToRows(new TextEncoder().encode(tsv).buffer, {});
  assert.equal(parsed.length, rows.length);
  assert.deepEqual(Array.from(parsed, (r) => r.v), Array.from(rows, (r) => r.v));

  const px = api.computeRasterPixels(rows, null, 'robust');
  assert.equal(px.width, 5);
  assert.equal(px.height, 4);
  assert.equal(px.values.length, 20);
  assert.equal(px.pixels.length, 20 * 4);
  assert.equal(px.rawTrueMax, 19);
  assert.ok(Array.isArray(px.rawRange) && px.rawRange.length === 2, px.rawRange);
  assert.equal(px.diag.gridFallback, null);
  // 'full' must bake to the true maximum rather than the robust percentile.
  assert.equal(api.computeRasterPixels(rows, null, 'full').rawRange[1], 19);
}

async function testWorkerRawDecodePath() {
  // parseRawToRows is the MAIN-THREAD fallback (loadMsiLayer uses it when the
  // worker is unavailable); the worker itself calls rawDecodeFunction +
  // rawRowsFromDecoded, so it is deliberately not in the fns list.
  const { names, api } = assembleWorkerFns([
    'rawBundleFromZip', 'rawDecodeFunction', 'rawRowsFromDecoded', 'parseRawToRows',
    'parseWatersParamTable', 'buildMsiGrid',
  ], ['parseRawToRows']);
  assert.ok(names.includes('rawDecodeFunction') && names.includes('rawRowsFromDecoded'),
    '.raw decode helpers must be in the parse-worker fns list');

  const zip = buildZip(buildSyntheticRawMembers());
  const bundle = api.rawBundleFromZip(zip);
  assert.equal(bundle.rootName, 'SYNTH', 'the *.raw/ prefix names the bundle');

  // _FUNC001.STS and .DAT are DEFLATEd in the fixture (ZIP_DEFLATE), so every
  // assertion below also proves the inflate path — which is the path the app's
  // own archives take, and the one place the app and the connector differ.
  const decoded = await api.rawDecodeFunction(bundle, 1);
  assert.equal(decoded.nScans, 6);
  assert.equal(decoded.nCh, 2);
  // Odd .STS stride (9) means every record after the first is unaligned; this
  // is the read that a typed-array view would throw RangeError on.
  assert.deepEqual(Array.from(decoded.xs, (v) => +v.toFixed(4)), [1, 1.1, 1.2, 1, 1.1, 1.2]);
  assert.deepEqual(Array.from(decoded.ys, (v) => +v.toFixed(4)), [5, 5, 5, 5.2, 5.2, 5.2]);
  assert.deepEqual(Array.from(decoded.chans[0]), [100, 200, 300, 400, 500, 600]);
  assert.deepEqual(Array.from(decoded.chans[1]), [7, 8, 9, 10, 11, 12]);
  assert.equal(decoded.gridX.count, 3);
  assert.equal(decoded.gridY.count, 2);
  assert.ok(Math.abs(decoded.gridX.pitch - 0.1) < 1e-9, 'X pitch from the stage coordinates');
  assert.ok(Math.abs(decoded.gridY.pitch - 0.2) < 1e-9, 'Y pitch from the stage coordinates');

  const rows = api.rawRowsFromDecoded(decoded, { channel: 1 });
  assert.equal(rows.length, 6);
  assert.deepEqual(Array.from(rows, (r) => r.v), [7, 8, 9, 10, 11, 12]);
  // Snapped coordinates must land buildMsiGrid on the true 3x2 raster rather
  // than tripping its inflation guard and collapsing the geometry.
  const grid = api.buildMsiGrid(rows);
  assert.equal(grid.W, 3);
  assert.equal(grid.H, 2);
  assert.equal(grid.gridFallback && (grid.gridFallback.x || grid.gridFallback.y), null);

  // parseRawToRows must accept a raw ArrayBuffer as well as a bundle.
  const viaBuffer = await api.parseRawToRows(zip, { func: 1, channel: 0 });
  assert.deepEqual(Array.from(viaBuffer, (r) => r.v), [100, 200, 300, 400, 500, 600]);
}

// _FUNCTNS.INF の種別バイトは「下位 5 ビット = MassLynx のファンクション種別、
// 上位 3 ビット = 取得モードのフラグ」。生バイトを 9 と比べると、同じ MRM でも
// フラグが立った取得 (0x29 = 41) を非 MRM と誤判定する。実際にそれが起き、
// 17 ch / 117,449 px の完全な MRM イメージング .raw が
// 「MRM ファンクションがありません」で登録できなくなった — 中身は装置の
// テキスト書き出しと 1,996,633 値すべて一致していたのに、である。
// 直前まで合成データは種別バイトに 9 しか書いておらず、この穴を踏めなかった。
function testFunctionTypeFlagsAreMasked() {
  const maxCh = /const RAW_MAX_CHANNELS = (\d+);/.exec(html);
  assert.ok(maxCh, 'missing RAW_MAX_CHANNELS');

  const context = vm.createContext({ DataView, Math, console });
  vm.runInContext(
    'const RAW_MAX_CHANNELS = ' + maxCh[1] + ';\n'
    + extractTopLevelFunction('rawRoundMz') + '\n'
    + extractTopLevelFunction('rawRoundDwell') + '\n'
    + extractTopLevelFunction('parseWatersFunctions') + '\n'
    + extractTopLevelFunction('rawFunctionIsRegisterable') + '\n'
    + 'this.api = { parseWatersFunctions, rawFunctionIsRegisterable };',
    context,
  );
  const { parseWatersFunctions, rawFunctionIsRegisterable } = context.api;

  // 3 ファンクション: 素の MRM / フラグつき MRM / SIR (MRM ではない)。
  const REC = 416;
  const buf = new ArrayBuffer(REC * 3);
  const dv = new DataView(buf);
  [0x09, 0x29, 0x01].forEach((typeByte, f) => {
    const b = f * REC;
    dv.setUint8(b, typeByte);
    dv.setUint8(b + 1, 0x2d);
    if (typeByte === 0x01) return;          // SIR は precursor/product を持たない
    for (let c = 0; c < 2; c++) {
      dv.setFloat32(b + 32 + c * 4, 0.009889, true);
      dv.setFloat32(b + 160 + c * 4, 104 + c, true);
      dv.setFloat32(b + 288 + c * 4, 87 + c, true);
    }
  });

  const fns = parseWatersFunctions(buf);
  assert.equal(fns.length, 3, '416 バイト刻みでファンクション数が出る');

  assert.equal(fns[0].typeByte, 0x09);
  assert.equal(fns[0].type, 9);
  assert.equal(fns[0].isMrm, true, '素の 0x09 は従来どおり MRM');

  // ★ これが実際に起きた回帰。マスクを外すと type === 41 / isMrm === false に戻る。
  assert.equal(fns[1].typeByte, 0x29, '生バイトは調査用に残す');
  assert.equal(fns[1].type, 9, '下位 5 ビットが種別コード');
  assert.equal(fns[1].isMrm, true, 'フラグが立っていても MRM は MRM');
  assert.notEqual(fns[1].typeByte, fns[1].type, 'マスクが効いていること自体の確認');

  // マスクは「何でも MRM にする」ものではない: 別の種別は別の種別のまま。
  assert.equal(fns[2].type, 1, 'SIR は 1 (0x21 でも 1)');
  assert.equal(fns[2].isMrm, false);

  // byte 1 はイオンモードではない (ES+ と ES- の実サンプルがどちらも 0x2d)。
  assert.equal(fns[0].byte1, 0x2d);

  // ウィザードの採否。種別が未知でも構造が MRM なら通し、通す先が無いときだけ止める。
  assert.equal(rawFunctionIsRegisterable(fns[0]), true);
  assert.equal(rawFunctionIsRegisterable(fns[1]), true);
  assert.equal(rawFunctionIsRegisterable(fns[2]), false, 'SIR は登録対象にしない');
  const chans = (p, q) => ({ channels: [{ precursor: p, product: q }] });
  assert.equal(rawFunctionIsRegisterable(Object.assign({ isMrm: false }, chans(104, 87))), true,
    '未知の種別でも precursor/product が揃っていれば登録できる');
  assert.equal(rawFunctionIsRegisterable(Object.assign({ isMrm: false }, chans(null, null))), false);
  assert.equal(rawFunctionIsRegisterable(Object.assign({ isMrm: null }, chans(null, null))), true,
    '_FUNCTNS.INF ごと欠けている .raw は従来どおり通る');
  assert.equal(rawFunctionIsRegisterable(null), false);
}

// Renaming a compound re-derives CE/CV from a trailing _<CE>_<CV> in the new
// label. That was right while the label WAS the source of those numbers; for a
// .raw layer the instrument is, and re-deriving destroys it — renaming
// POS_Acetylcholine to "ACh_146_87" turned CE=10/CV=15 into 146/87 (the
// transition m/z) and pushed that to the MRM library, silently.
function testRenameKeepsInstrumentCeCv() {
  const context = vm.createContext({});
  vm.runInContext(
    extractTopLevelFunction('splitCeCv') + '\n' + extractTopLevelFunction('ceCvAfterRename')
    + '\nthis.api = { splitCeCv, ceCvAfterRename };',
    context,
  );
  const { splitCeCv, ceCvAfterRename } = context.api;
  // The vm has its own realm, so rebuild the result host-side before comparing.
  const after = (meta, label) => {
    const r = ceCvAfterRename(meta, splitCeCv(label));
    return { ce: r.ce, cv: r.cv };
  };

  // .raw: the instrument's values survive a label that looks like _<CE>_<CV>.
  const raw = { fromRaw: true, ce: 10, cv: 15 };
  assert.deepEqual(after(raw, 'ACh_146_87'), { ce: 10, cv: 15 });
  assert.deepEqual(after(raw, 'Acetylcholine'), { ce: 10, cv: 15 });

  // .raw acquired without _FUNCnnn.EE has no CE/CV, so the label may still fill
  // them in — that is annotation, not destruction.
  assert.deepEqual(after({ fromRaw: true, ce: null, cv: null }, 'ACh_45_14'), { ce: 45, cv: 14 });
  assert.deepEqual(after({ fromRaw: true, ce: 10, cv: null }, 'ACh_45_14'), { ce: 10, cv: 14 });

  // Everything else keeps the old behaviour: the label is the source of truth.
  assert.deepEqual(after({ ce: 1, cv: 2 }, 'Oxylipin_45_14'), { ce: 45, cv: 14 });
  assert.deepEqual(after({ fromRaw: false, ce: 1, cv: 2 }, 'X_45_14'), { ce: 45, cv: 14 });
  assert.deepEqual(after({ ce: 1, cv: 2 }, 'PlainName'), { ce: 1, cv: 2 });
  assert.deepEqual(after(null, 'X_45_14'), { ce: 45, cv: 14 });
}

// Storage のキー規則。blob 復旧 (ensureLocalBlob / parquetSrcForEnt) は
// 「publish が置いたのと同じパス」を組み立て直せることが前提なので、
// storagePathForEnt と publish 側の組み立てが食い違うと復旧が黙って効かなくなる。
function testStoragePathRule() {
  const ctx = vm.createContext({ console });
  vm.runInContext(
    `${extractFunction(html, 'sanitizeStorageKeySegment')}\n`
    + `${extractFunction(html, 'storageExtOf')}\n`
    + `${extractFunction(html, 'storagePathForEnt')}\n`
    + 'this.out = { storageExtOf, storagePathForEnt };',
    ctx);
  const { storageExtOf, storagePathForEnt } = ctx.out;

  assert.equal(storageExtOf('sample.RAW.zip'), '.zip');
  assert.equal(storageExtOf('slide1.tif'), '.tif');
  assert.equal(storageExtOf('noext'), '');

  const project = { shareInfo: { slug: 'proj_x' } };
  // ローカル登録: slug + blobId + 拡張子。日本語のファイル名でもキーは英数字だけ。
  assert.equal(storagePathForEnt({ blobId: 'blob_1', filename: 'データ.xlsx' }, project),
    'proj_x/blobs/blob_1.xlsx');
  // 取り込んだレイヤーは doc が持ってきた storagePath をそのまま使う。
  assert.equal(storagePathForEnt({ blobId: 'blob_1', filename: 'x.parquet', storagePath: 'other/blobs/b.parquet' }, project),
    'other/blobs/b.parquet');
  // 未 publish (slug が無い) なら復旧先も無い。
  assert.equal(storagePathForEnt({ blobId: 'blob_1', filename: 'x.xlsx' }, {}), '');
  assert.equal(storagePathForEnt(null, project), '');

  // publish 側が同じ規則で組み立てていること。
  assert.match(html, /\$\{meta\.slug\}\/blobs\/\$\{ent\.blobId\}\$\{extByBlob\.get\(ent\.blobId\)\}/);
  assert.match(html, /extByBlob\.set\(ent\.blobId, storageExtOf\(filename\)\)/);
}

// オブジェクトのメソッド (async name(...) { ... }) を丸ごと取り出す。
function extractMethod(source, name) {
  const marker = `async ${name}(`;
  const markerAt = source.indexOf(marker);
  assert.notEqual(markerAt, -1, `missing method ${name}`);
  const openAt = source.indexOf('{', markerAt + marker.length);
  return source.slice(markerAt, scanBalanced(source, openAt) + 1);
}

// 切片 ID の付け方は取り込み (master) と共有 (share) で**わざと違う**。
//   取り込み: meta.client_id — 再 publish したとき upsert_project_doc の
//             client_id 照合が当たり、サーバの切片が作り直されない
//             (作り直されると rois の ON DELETE CASCADE で閲覧者の ROI が消える)。
//   共有:     サーバの UUID — list_rois と同じキーで揃える必要がある。
// 片方に寄せるともう片方が壊れるので、両方を縛る。
function testImportSectionIdKeying() {
  const importFn = extractMethod(html, '_buildLocalProjectFromDoc');
  const shareFn = extractMethod(html, '_hydrateSharedProject');

  assert.match(importFn, /id:\s*\(s\.meta && s\.meta\.client_id\) \|\| s\.id/);
  // ROI はサーバの UUID で引いてから client_id へ翻訳する。
  assert.match(importFn, /fetchAllShareRois\(session\.token, doc\.sections/);
  assert.match(importFn, /uuidToClient\[uuid\]/);

  assert.match(shareFn, /id:\s*s\.client_id \|\| s\.id/);
  assert.match(shareFn, /fetchAllShareRois\(session\.token, project\.sections\)/);
}

// ★ 表示分位点とベイク分位点は必ず一緒に動かす。deriveBakeStats の最後が
//   rawDispMax = Math.min(disp, bakeHi) で bakeHi = MSI_ROBUST_PERCENTILE なので、
//   表示側だけ上げても Math.min に頭打ちされて**静かに効かない**。実測でも
//   p99.9 は p99.5 の 1.12〜1.66 倍あり、必ず当たる。片方だけ戻したら落とす。
function testDisplayAndBakePercentilesMoveTogether() {
  const constOf = (name) => {
    const m = new RegExp('const ' + name + ' = ([0-9.]+);').exec(html);
    assert.ok(m, 'missing constant ' + name);
    return Number(m[1]);
  };
  const bake = constOf('MSI_ROBUST_PERCENTILE');
  const disp = constOf('MSI_DEFAULT_DISPLAY_PERCENTILE');
  assert.ok(disp <= bake,
    `MSI_DEFAULT_DISPLAY_PERCENTILE (${disp}) > MSI_ROBUST_PERCENTILE (${bake}): `
    + 'deriveBakeStats は rawDispMax = Math.min(disp, bakeHi) なので表示側だけ上げても効かない');
  assert.equal(bake, 0.999,
    '白飛び率は 1 − 分位点そのもの。0.999 = 0.1% 飽和という前提でコメント・説明書を書いてある');
  assert.equal(disp, 0.999,
    '表示上限も 0.999 に揃えること。片方だけ戻すと Math.min で頭打ちして白飛びが減らない');

  // 同じ 2 値がパース Worker にも注入されている (注入漏れ = Worker とメインで
  // 見え方が食い違う)。
  assert.match(html, /'const MSI_ROBUST_PERCENTILE = ' \+ MSI_ROBUST_PERCENTILE/);
  assert.match(html, /'const MSI_DEFAULT_DISPLAY_PERCENTILE = ' \+ MSI_DEFAULT_DISPLAY_PERCENTILE/);
}

// 定数を読むだけでなく、**実際に飽和する画素の割合**を数える。
// 上限を超えた画素は msiValueEval が n を [0,1] にクランプして全部同じ色に潰れる
// ので、「上限以上の画素の割合」がそのまま白飛び率になる。
// 0.99 に戻すと 1.0% になって落ちる (実測で確認済み)。
function testDefaultWindowClipsOneTenthOfAPercent() {
  const constOf = (name) => Number(new RegExp('const ' + name + ' = ([0-9.]+);').exec(html)[1]);
  const context = vm.createContext({ Number, Math, Float64Array, out: {} });
  vm.runInContext(
    'const MSI_ROBUST_PERCENTILE = ' + constOf('MSI_ROBUST_PERCENTILE') + ';\n'
    + 'const MSI_DEFAULT_DISPLAY_PERCENTILE = ' + constOf('MSI_DEFAULT_DISPLAY_PERCENTILE') + ';\n'
    + extractTopLevelFunction('percentileOfSorted') + '\n'
    + extractTopLevelFunction('deriveBakeStats') + '\n'
    + 'out.api = { deriveBakeStats };',
    context,
  );

  // 既知分布: 0..9999 をちょうど 1 回ずつ。分位点が一意に決まるので
  // 「上限以上が何画素か」を数え上げで検算できる。
  const values = new Array(10000);
  for (let i = 0; i < values.length; i++) values[i] = i;
  const st = context.out.api.deriveBakeStats(values, null, 'robust');

  // percentileOfSorted の添字は round(p*(N-1)) = round(0.999*9999) = 9989。
  assert.equal(st.rawDispMax, 9989, '既定表示上限が p99.9 になっていない');
  // 上限を**超えた**画素が msiValueEval のクランプで上限画素と同じ色に潰れる
  // (上限ちょうどの画素は正当に 1.0 へ写るので飽和ではない)。
  const clipped = values.filter((v) => v > st.rawDispMax).length;
  assert.equal(clipped, 10, `飽和画素 ${clipped}/10000 = ${(clipped / 100).toFixed(2)}% (期待 0.10%)`);
  // ベイク上限に頭打ちされていないこと = 2 定数が揃っている証拠。
  assert.equal(st.rawDispMax, st.bakeHi, 'rawDispMax が bakeHi に切られている = 分位点が食い違っている');
  // 手入力レンジは従来どおり最優先 (この変更で壊していないこと)。
  assert.equal(context.out.api.deriveBakeStats(values, [0, 500], 'robust').rawDispMax, 500);
  // 外れ値クリップ OFF は真の最大値のまま。
  assert.equal(context.out.api.deriveBakeStats(values, null, 'full').rawDispMax, 9999);
}

async function main() {
  compileInlineScripts('viewer/index.html', 2);
  compileInlineScripts('index.html', 1);
  compileInlineScripts('mrm.html', 1);
  assert.match(html, /data-preview-range-reset/);
  assert.match(html, /data-otsu-toggle/);   // プレビューの背景除去(Otsu)
  assert.match(html, /data-add-overlay/);   // プレビューの ＋重ね合わせ
  assert.doesNotMatch(html, /data-organ-select/);
  assert.match(html, /parseXlsxSheet, rowsFromParsedXlsx, parseXlsxToRows/);
  await testFocusLoadAndRaceGuard();
  await testFailedLoadStaysExplicit();
  testRangeResetAndSingleRepaint();
  await testWorkerXlsxDecodeCache();
  testAnalyteHeaderShapes();
  testRenameKeepsInstrumentCeCv();
  testWorkerBakePath();
  await testWorkerRawDecodePath();
  testFunctionTypeFlagsAreMasked();
  testDisplayAndBakePercentilesMoveTogether();
  testDefaultWindowClipsOneTenthOfAPercent();
  testOverlayDefaultPalette();
  testRebakeCellImagesFollowsOverlay();
  testColorbarBecomesLegendInOverlayMode();
  testCloseRestoresOverlay();
  testForcedHeBackdropDoesNotPersist();
  testOverlayForEditingIgnoresUnregistered();
  testPreviewAddOverlayAlwaysAdds();
  testOverlayPanelRendersInRightColumn();
  testDeleteOverlayIsShared();
  testMasterCanOpenPreview();
  testStoragePathRule();
  testImportSectionIdKeying();
  console.log('viewer preview regression tests: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
