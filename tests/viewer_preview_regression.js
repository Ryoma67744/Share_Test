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
    App: undefined,   // isShareOverlayMode が素の識別子で読むので、必ず定義しておく
    ...extra,
  });
  // 重ね合わせ一覧の ✎/× の出し分けはアプリ本体の関数がそのまま決める。
  // スタブに置き換えると「テストは通るのに画面では出ない」がすり抜ける。
  vm.runInContext(
    extractTopLevelFunction('isShareOverlayMode') + '\n'
    + extractTopLevelFunction('isViewerOverlay') + '\n'
    + extractTopLevelFunction('canEditOverlay'),
    context);
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
  const context = vm.createContext({ App: {} });
  vm.runInContext(
    extractTopLevelFunction('isShareOverlayMode') + '\n'
    + extractTopLevelFunction('isViewerOverlay') + '\n'
    + extractTopLevelFunction('canEditOverlay') + '\n'
    + extractTopLevelFunction('overlayForEditing')
    + '\nthis.api = { overlayForEditing, canEditOverlay };',
    context,
  );
  const { overlayForEditing, canEditOverlay } = context.api;
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

  // ★ 共有先では master が公開した定義を書き換えさせない。共有先が作った分
  //   (サーバ共有 _server / 端末保存 _local) だけが編集対象。
  //   master 側は従来どおり全部編集できる。
  const mine = { id: 'ov_2', layers: [], _local: true };
  const theirs = { id: 'ov_3', layers: [], _server: true };   // 他の閲覧者が作った分
  const shared = { overlays: [registered, mine, theirs] };
  context.App.shareMode = { slug: 's', token: 't' };
  context.App.project = shared;
  shared.__share = true;
  assert.equal(overlayForEditing(registered, shared), null, '共有先は master の定義を編集できない');
  assert.equal(overlayForEditing(mine, shared), mine, '共有先は自分の定義を編集できる');
  assert.equal(overlayForEditing(theirs, shared), theirs,
    '共有の重ね合わせは誰でも編集できる (作った人が居なくなっても片づけられる)');
  assert.equal(canEditOverlay(registered), false);
  assert.equal(canEditOverlay(mine), true);
  assert.equal(canEditOverlay(theirs), true);
  // master (共有ではない) に戻せば master の定義も編集できる。
  context.App.shareMode = null;
  shared.__share = false;
  assert.equal(overlayForEditing(registered, shared), registered, 'master は自分の定義を編集できる');
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
  assert.doesNotMatch(list.innerHTML, /class="cb-ov-item[^"]*\bon\b/, '表示中が無ければどれも on にしない');

  App.activeOverlay = b;
  preview._renderOverlayPanel(project);
  assert.match(list.innerHTML, /class="cb-ov-item on[^"]*" data-ov-id="ov_2"/, '表示中のセットに印を付ける');
  assert.equal(single.hidden, false, '重ね合わせ表示中は「単一表示へ戻る」を出す');

  // 削除された分は消える
  project.overlays = [a];
  App.activeOverlay = null;
  preview._renderOverlayPanel(project);
  assert.doesNotMatch(list.innerHTML, /セットB/, '削除したセットは一覧から消えること');

  // Method 表には重ね合わせの行を残さない (化合物だけ)
  assert.doesNotMatch(html, /tr data-overlay-id=/, 'Method 表に重ね合わせの行を残さないこと');

  // ★ 共有先: master が公開した定義は読み取り専用 (✎/× を出さない)、
  //   共有先が作った分だけ編集・削除できる。CSS ではなく JS が決める。
  const mine = { id: 'ov_3', name: '共有先のセット', _server: true,
                 layers: [{ key: 'MSI_z', color: '#00ffff' }] };
  project.overlays = [a, mine];
  project.__share = true;
  App.shareMode = { slug: 'proj_x', token: 't' };
  preview._renderOverlayPanel(project);
  assert.match(list.innerHTML, /セットA/, '共有先でも master の重ね合わせは一覧に残す');
  assert.match(list.innerHTML, /共有先のセット/, '共有先で作った重ね合わせも並ぶ');
  assert.doesNotMatch(list.innerHTML, /data-ov-del-row="ov_1"/,
    '共有先は master の重ね合わせを削除できない');
  assert.doesNotMatch(list.innerHTML, /data-ov-edit-row="ov_1"/,
    '共有先は master の重ね合わせを編集できない');
  assert.match(list.innerHTML, /data-ov-del-row="ov_3"/, '共有先の重ね合わせは削除できる');
  assert.match(list.innerHTML, /data-ov-edit-row="ov_3"/, '共有先の重ね合わせは編集できる');
  project.__share = false;
  App.shareMode = null;
}

// 削除は主画面のチップとプレビューの一覧の両方から呼ぶので、確認・後始末を
// 1 か所 (deleteOverlayById) に置く。片方だけ直して食い違うのを防ぐ。
async function testDeleteOverlayIsShared() {
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
  const toasts = [];
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const serverDeletes = [];
  let serverFails = null;      // 投げたい例外
  const SupabaseClient = {
    deleteShareOverlay(token, id) {
      if (serverFails) return Promise.reject(serverFails);
      serverDeletes.push([token, id]);
      return Promise.resolve();
    },
  };
  vm.runInContext(
    'const App = this.App, confirm = this.confirm, SharePreview = this.SharePreview;\n'
    + 'const localStorage = this.localStorage, SupabaseClient = this.SupabaseClient;\n'
    + 'function renderOverlayBar() {}\n'
    + 'function showToast(m) { this.toasts.push(String(m)); }\n'
    // 権限・永続化・サーバ削除はアプリ本体の関数をそのまま持ち込む
    // (スタブにすると「共有先が master の重ね合わせを消せる」を見逃す)。
    + extractTopLevelFunction('_shareOverlayKey') + '\n'
    + extractTopLevelFunction('isShareOverlayMode') + '\n'
    + extractTopLevelFunction('isViewerOverlay') + '\n'
    + extractTopLevelFunction('canEditOverlay') + '\n'
    + extractTopLevelFunction('saveShareOverlays') + '\n'
    + extractTopLevelFunction('_isMissingRpc') + '\n'
    + extractTopLevelFunction('_noteShareOverlayServerMissing') + '\n'
    + extractTopLevelFunction('removeShareOverlay') + '\n'
    + extractTopLevelFunction('deleteOverlayById')
    + '\nthis.api = { deleteOverlayById };',
    Object.assign(context, {
      App, SharePreview, confirm: () => confirmed, localStorage, toasts,
      // 失敗経路もテストするので、警告はここで受け取って出力を汚さない。
      console: { warn() {}, log() {}, info() {} },
      SupabaseClient,
      SHARE_OVERLAY_LS_PREFIX: 'desi:shareOverlays:',
      _shareOverlayServerMissing: false,
      _shareOverlayWriteGen: 0,
    }),
  );
  const { deleteOverlayById } = context.api;

  confirmed = false;
  assert.equal(await deleteOverlayById('ov_1'), false, '確認でキャンセルしたら消さない');
  assert.equal(App.project.overlays.length, 2);

  confirmed = true;
  assert.equal(await deleteOverlayById('nope'), false, '知らない id は何もしない');
  assert.equal(await deleteOverlayById('ov_1'), true);
  assert.deepEqual(App.project.overlays.map(o => o.id), ['ov_2'], '指定したセットだけ消す');
  assert.equal(saves.length, 1, '削除は保存すること');
  assert.equal(cleared.length, 0, '表示中でなければ単一表示へは戻さない');

  assert.equal(SharePreview._overlaySnapshot, null,
    'プレビューの控えが消したセットなら落とすこと (閉じたときに幽霊として復活する)');

  App.activeOverlay = App.project.overlays[0];
  SharePreview._overlaySnapshot = b;   // 別のセットを控えている場合は残す
  assert.equal(await deleteOverlayById('ov_2'), true);
  assert.equal(cleared.length, 1, '表示中のセットを消したら単一表示へ戻すこと');
  assert.equal(SharePreview._overlaySnapshot, null, '控えていたセットを消したら落とすこと');

  // ★ 共有先: master が公開した重ね合わせは消させない。共有先が作った分は
  //   サーバから消してから一覧を書き換える (先に消すと、失敗したときに
  //   「自分の画面からだけ消えて他の人には残る」ことになる)。
  const masterOv = { id: 'ov_m', name: 'master のセット' };
  const sharedOv = { id: 'uuid-1', name: '共有のセット', _server: true, _serverVersion: 1,
                     layers: [{ key: 'MSI_a' }, { key: 'MSI_b' }] };
  App.project = { overlays: [masterOv, sharedOv], __share: true };
  App.activeOverlay = null;
  App.shareMode = { slug: 'proj_x', token: 'tok' };
  const savesBefore = saves.length;
  assert.equal(await deleteOverlayById('ov_m'), false, '共有先は master の重ね合わせを消せない');
  assert.deepEqual(App.project.overlays.map(o => o.id), ['ov_m', 'uuid-1']);
  assert.ok(toasts.some(t => /master/.test(t)), '消せない理由を知らせること');
  assert.equal(saves.length, savesBefore, '共有先で IndexedDB へは書かないこと');

  // サーバが失敗したら画面からも消さない。
  serverFails = new Error('network down');
  assert.equal(await deleteOverlayById('uuid-1'), false, 'サーバで消せなければ false');
  assert.deepEqual(App.project.overlays.map(o => o.id), ['ov_m', 'uuid-1'],
    'サーバから消せていないのに自分の画面からだけ消さないこと');
  serverFails = null;

  assert.equal(await deleteOverlayById('uuid-1'), true, '共有の重ね合わせは誰でも消せる');
  assert.deepEqual(App.project.overlays.map(o => o.id), ['ov_m']);
  assert.deepEqual(serverDeletes, [['tok', 'uuid-1']], 'サーバへ削除を送ること');
  assert.equal(saves.length, savesBefore, '共有先で IndexedDB へは書かないこと');
  assert.ok(toasts.some(t => /他の人の一覧からも消えます/.test(t)) === false,
    '確認文は confirm で出す (toast ではない)');

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

// 相対輝度と「明るさを揃える」倍率。①の根拠そのものなので数値で縛る。
function testOverlayBrightnessMatching() {
  const constOf = (name) => new RegExp('const ' + name + ' = ([0-9.]+);').exec(html)[1];
  const context = vm.createContext({ Math, Number, String, out: {} });
  vm.runInContext(
    'const OVERLAY_MATCH_MIN_SCALE = ' + constOf('OVERLAY_MATCH_MIN_SCALE') + ';\n'
    + ['_hexToRgb', '_srgbLinear', '_srgbEncode', '_srgbLuminance',
       'scaleColorLuminance', 'overlayBrightnessScales'].map(extractTopLevelFunction).join('\n')
    + '\nout.api = { _srgbLuminance, scaleColorLuminance, overlayBrightnessScales };',
    context,
  );
  const api = context.out.api;

  // Rec.709 の端点と、①の動機になっている 2.5 倍差。
  assert.equal(api._srgbLuminance('#ffffff'), 1);
  assert.equal(api._srgbLuminance('#000000'), 0);
  const green = api._srgbLuminance('#00ff00');
  const magenta = api._srgbLuminance('#ff00ff');
  assert.ok(Math.abs(green - 0.7152) < 1e-4, 'green ' + green);
  assert.ok(Math.abs(magenta - 0.2848) < 1e-4, 'magenta ' + magenta);
  assert.ok(Math.abs(green / magenta - 2.51) < 0.01,
    `緑/マゼンタ = ${(green / magenta).toFixed(3)} (期待 ~2.51)`);

  // 既定パレット先頭 2 色。いちばん暗いマゼンタは据え置き、緑を約 0.40 倍に落とす。
  const two = api.overlayBrightnessScales([{ key: 'a', color: '#ff00ff' }, { key: 'b', color: '#00ff00' }]);
  assert.equal(two.scale['#ff00ff'], 1, 'いちばん暗い色は据え置き (上げると白飛びする)');
  assert.ok(Math.abs(two.scale['#00ff00'] - 0.3982) < 1e-3, '緑の倍率 ' + two.scale['#00ff00']);
  assert.equal(two.floored.length, 0);

  // ★ 倍率は線形光でかけること。sRGB のまま掛けるとガンマが乗って輝度が合わない
  //   (実測: 目標 0.2848 に対し 0.0950 = 3 倍暗い)。掛けた後の実効輝度で確かめる。
  const dimmed = api.scaleColorLuminance('#00ff00', two.scale['#00ff00']);
  assert.ok(Math.abs(api._srgbLuminance(dimmed) - magenta) < 0.005,
    `揃えた緑 ${dimmed} の輝度 ${api._srgbLuminance(dimmed).toFixed(4)} がマゼンタ ${magenta.toFixed(4)} と合わない`
    + ' — 線形光を経由していない可能性');
  assert.equal(api.scaleColorLuminance('#00ff00', 1), '#00ff00', '1 倍は素通し');

  // 下限ガード: 濃紺 (輝度 0.0156) を混ぜても他が黒に潰れない。止めはしない。
  const guarded = api.overlayBrightnessScales([
    { key: 'a', color: '#000080' }, { key: 'b', color: '#00ff00' }, { key: 'c', color: '#ff00ff' }]);
  assert.equal(guarded.scale['#00ff00'], 0.25, '下限 OVERLAY_MATCH_MIN_SCALE で止まること');
  assert.equal(guarded.scale['#ff00ff'], 0.25);
  assert.equal(guarded.floored.length, 2, '下限に当たった色を報告すること (モーダルの注意欄が読む)');
}

// LUT キャッシュと署名。どちらも「静かに古い絵を返す」種類の壊れ方をする。
function testOverlayScaleReachesTheBake() {
  const context = vm.createContext({ Math, Number, String, Array, out: {} });
  vm.runInContext(
    ['buildLut', '_hexToRgb', '_srgbLinear', '_srgbEncode', 'scaleColorLuminance', 'monoLut']
      .map(extractTopLevelFunction).join('\n')
    + '\nconst _monoLutCache = {};\nout.api = { monoLut, _monoLutCache };',
    context,
  );
  const { monoLut } = context.out.api;
  const plain = monoLut('#00ff00');
  const scaled = monoLut('#00ff00', 0.3982);
  // ★ hex だけをキーにしていると、ここで plain がそのまま返ってくる。
  assert.notEqual(scaled[255][1], plain[255][1],
    'monoLut のキャッシュキーに倍率が入っていない — 同じ色の揃えあり/なしが衝突している');
  assert.equal(plain[255][1], 255);
  assert.ok(scaled[255][1] > 150 && scaled[255][1] < 190, '揃えた緑の上端 ' + scaled[255][1]);
  assert.equal(monoLut('#00ff00', 1)[255][1], 255, '倍率 1 は従来と同じ');
  assert.equal(monoLut('#00ff00'), monoLut('#00ff00', 1), '倍率省略と 1 は同じキー');

  // renderComposite の焼き済みキャンバス署名。倍率を入れ忘れると、揃えを切り替えても
  // 署名が変わらず古い焼きが返る (絵が変わらないだけでエラーは出ない)。
  const sigAt = html.indexOf('const lutSig = identStamp(img)');
  assert.ok(sigAt > 0, 'lutSig が見つからない');
  const sig = html.slice(sigAt, html.indexOf(';', html.indexOf('identStamp(keepGrid', sigAt)));
  assert.match(sig, /overlay \? \('o' \+ ovColor \+ '@' \+ ovScale\)/,
    'lutSig の重ね合わせ項に解決済みの倍率 ovScale が入っていない');
  // 倍率は定義の参照ではなく解決済みの値であること (モーダルが existing をその場で書き換えるため)。
  assert.match(html, /const ovScale = \(overlay && overlayScale\) \? \(overlayScale\[ovColor\] \|\| 1\) : 1;/);
  assert.match(html, /const lut = overlay \? monoLut\(ovColor, ovScale\) : getActiveColormap\(\);/);
  // 倍率表は matchBrightness が ON のときだけ作る (OFF は従来とビット単位で同じ絵)。
  assert.match(html, /overlay && overlay\.matchBrightness\)\s*\n\s*\? overlayBrightnessScales\(overlay\.layers\)\.scale : null/);
}

// Codex 指摘: 真っ黒 (#000000) は倍率をどうかけても黒のままで、そもそも揃えようが
// ない。基準 (lo) からも外してあるので、黙っていると「揃えました」と言いながらその
// 分子だけ何も出ない。invisible で報告してモーダルが注意を出せるようにしてある。
function testBlackOverlayColorIsReported() {
  const constOf = (name) => new RegExp('const ' + name + ' = ([0-9.]+);').exec(html)[1];
  const context = vm.createContext({ Math, Number, String, out: {} });
  vm.runInContext(
    'const OVERLAY_MATCH_MIN_SCALE = ' + constOf('OVERLAY_MATCH_MIN_SCALE') + ';\n'
    + ['_hexToRgb', '_srgbLinear', '_srgbEncode', '_srgbLuminance',
       'scaleColorLuminance', 'overlayBrightnessScales'].map(extractTopLevelFunction).join('\n')
    + '\nout.api = { overlayBrightnessScales };',
    context,
  );
  const f = context.out.api.overlayBrightnessScales;

  const withBlack = f([{ key: 'a', color: '#000000' }, { key: 'b', color: '#00ff00' },
                       { key: 'c', color: '#ff00ff' }]);
  assert.deepEqual(Array.from(withBlack.invisible), ['#000000'],
    '真っ黒を invisible で報告していない — 注意が出ないまま分子が消える');
  assert.equal(withBlack.scale['#000000'], 1, '黒は倍率をいじっても黒なので 1 のまま');
  // ★ 黒を基準 (lo) にしてはいけない。したら他の色が全部 0 倍 = 真っ暗になる。
  assert.ok(Math.abs(withBlack.scale['#00ff00'] - 0.3982) < 1e-3,
    '黒を基準にしてしまっている: 緑の倍率 ' + withBlack.scale['#00ff00']);
  assert.equal(withBlack.scale['#ff00ff'], 1, '見える色のうちいちばん暗いものは据え置き');
  assert.equal(withBlack.floored.length, 0, '黒は floored ではなく invisible');

  // 全部黒でも例外にせず、全色を invisible として返す。
  const allBlack = f([{ key: 'a', color: '#000000' }, { key: 'b', color: '#000000' }]);
  assert.equal(allBlack.invisible.length, 1, '同じ色は 1 回だけ報告する');
  assert.equal(allBlack.scale['#000000'], 1);
  // 黒が無いときは invisible は空。
  assert.equal(f([{ key: 'a', color: '#ff00ff' }, { key: 'b', color: '#00ff00' }]).invisible.length, 0);
}

// Codex 指摘: 色を揃えても、合成の直前にかかる ctx.globalAlpha がメンバーごとに
// 違うと画面では揃わない。実測で輝度比が 1.00 → 4.62 に開いた。揃えている間は
// メンバー全員を共通の透明度で乗せる。
function testMatchedOverlayUsesOneOpacity() {
  const at = html.indexOf('const overlayCommonAlpha =');
  assert.notEqual(at, -1, '揃えているときの共通透明度を計算していない');
  const calc = html.slice(at, html.indexOf('\n            : null;', at));
  // 実効透明度は「applyOpacity が false なら 1、そうでなければ opacity」。
  assert.match(calc, /st\.applyOpacity === false\) \? 1 : st\.opacity/,
    'レイヤーごとの Apply opacity を実効透明度に織り込んでいない');
  assert.match(calc, /Math\.min\(lo, a\)/,
    'いちばん低い実効透明度に揃えること (どのレイヤーも指定より明るくしない)');
  assert.match(calc, /overlay && overlay\.matchBrightness/, '揃えていないときは従来どおりにすること');

  // ★ 実際に globalAlpha へ流し込んでいること。計算しただけでは絵は変わらない。
  const alphaAt = html.indexOf('ctx.globalAlpha = (overlayCommonAlpha');
  assert.notEqual(alphaAt, -1, '共通透明度を ctx.globalAlpha に渡していない');
  const line = html.slice(alphaAt, html.indexOf(';', html.indexOf('settings.opacity', alphaAt)));
  assert.match(line, /overlayCommonAlpha != null && overlay && isMsiLayer/,
    '重ね合わせメンバーの MSI だけに効かせること (HE/IF 背景は従来どおり)');
  assert.match(line, /settings\.applyOpacity === false\) \? 1\.0 : settings\.opacity/,
    '揃えていないときの従来の式を残すこと');
}

// vm へ渡す輝度ヘルパー一式 (SharePreview から呼ばれるのでコンテキストに要る)。
function luminanceApi() {
  const constOf = (name) => new RegExp('const ' + name + ' = ([0-9.]+);').exec(html)[1];
  const context = vm.createContext({ Math, Number, String, out: {} });
  vm.runInContext(
    'const OVERLAY_MATCH_MIN_SCALE = ' + constOf('OVERLAY_MATCH_MIN_SCALE') + ';\n'
    + ['_hexToRgb', '_srgbLinear', '_srgbEncode', '_srgbLuminance',
       'scaleColorLuminance', 'overlayBrightnessScales'].map(extractTopLevelFunction).join('\n')
    + '\nout.api = { scaleColorLuminance, overlayBrightnessScales };',
    context,
  );
  return context.out.api;
}

// ★ openOverlayModal の編集分岐は「代入する項目を並べる」書き方なので、新しい
//   項目を足したときにここだけ抜けやすい。抜けると保存はできるのに**編集する
//   たびに設定が消える**。エラーも出ないので気づけない。
function testEditKeepsMatchBrightness() {
  const at = html.indexOf('function openOverlayModal(');
  assert.notEqual(at, -1);
  const body = html.slice(at, html.indexOf('\nfunction deleteOverlayById', at));

  // モーダルにチェックがあり、初期値は既存の設定を映すこと。
  assert.match(body, /name="ovmatch"/, '「明るさを揃える」のチェックが無い');
  assert.match(body, /\(ov\.matchBrightness \? ' checked' : ''\)/,
    '編集で開いたときにチェックの状態が復元されていない');
  // 既定は OFF (新規は matchBrightness を持たない → falsy)。
  assert.match(body, /const ov = existing \|\| \{ name: '', layers: \[\], bg: 'black' \};/,
    '新規の既定に matchBrightness を書かないこと (既定 OFF)');

  // 読み出しと、編集分岐への引き回し。
  assert.match(body, /matchBrightness: !!\(matchEl && matchEl\.checked\)/, '_collect が読んでいない');
  assert.match(body, /existing\.matchBrightness = res\.matchBrightness;/,
    '編集分岐で matchBrightness を代入していない — 編集するたび設定が消える');

  // 下限に当たったら注意を出す。止めはしない。
  assert.match(body, /const rep = overlayBrightnessScales\(colors\);/, '下限の判定をしていない');
  assert.match(body, /rep\.floored\.length/, '下限の判定結果を読んでいない');
  assert.match(body, /登録はできます/, '注意は出すが止めない方針');
  // 真っ黒はその分子が丸ごと出なくなるので、揃えの ON/OFF に関わらず先に知らせる。
  assert.match(body, /rep\.invisible\.length/, '真っ黒の判定をしていない');
  assert.match(body, /その分子は画面に出ません/, '真っ黒の注意文が無い');
  assert.match(body, /matchEl\.addEventListener\('change', syncOvNote\)/,
    'チェックを切り替えたときに注意を出し直していない');

  // 保存・公開・取り込みは素通しなので、明示的な whitelist が増えていないこと。
  // ★ 項目を選り分けないこと (o そのものを載せる) が要点。共有先が作った
  //   重ね合わせ (_server / _local) だけは、行ごと落とす。
  assert.match(html, /overlays: \(project\.overlays \|\| \[\]\)\.filter\(o => !isViewerOverlay\(o\)\)/,
    'publish は overlays を (項目を選ばず) verbatim で載せ、共有先の分だけ落とす');
  assert.match(html, /return s \? s\.meta\.overlays : \[\];/, '取り込みも verbatim');
}

// 揃えている間、凡例の色見本は**実際に描かれている色**を出す。生の l.color を
// 出すと画面と食い違い、「凡例のとおりの色が出ていない」と読まれる。
function testLegendFollowsBrightnessMatching() {
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
  const layers = [{ key: 'MSI_Lactate', color: '#ff00ff' }, { key: 'MSI_Citrate', color: '#00ff00' }];
  const App = { activeOverlay: { layers, matchBrightness: true }, project: {} };
  const { preview } = makePreviewContext({
    App,
    findCompoundMeta: () => null,
    formatDisplayName: (k) => String(k).replace(/^MSI_/, ''),
    get2dContext: (c) => c.getContext('2d'),
    getActiveColormap: () => Array.from({ length: 256 }, () => [0, 0, 0]),
    ...luminanceApi(),
  });
  const bySel = { '[data-colorbar]': cv, '[data-cb-legend]': legend, '[data-cb-label]': label,
                  '[data-ov-panel]': ovPanel };
  preview.overlay = {
    querySelector: (sel) => bySel[sel] || null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c),
                 toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } },
  };

  preview._drawColorbar();
  // いちばん暗いマゼンタは据え置き、緑は落とした色 (#00a900) で出る。
  assert.match(legend.innerHTML, /#ff00ff/, 'いちばん暗い色は据え置きなので生の色のまま');
  assert.match(legend.innerHTML, /#00a900/,
    '揃えているのに色見本が生の #00ff00 のまま — 画面の見え方と食い違う');
  assert.doesNotMatch(legend.innerHTML, /background:#00ff00/, '生の緑を出さないこと');
  // 揃えると共局在は純白にならないので、注記も書き換える。
  assert.match(legend.innerHTML, /純白にはなりません/, '注記が「白 = 共局在」のまま');
  assert.doesNotMatch(legend.innerHTML, /白 = 共局在/);

  // OFF なら従来どおり。
  App.activeOverlay = { layers, matchBrightness: false };
  preview._drawColorbar();
  assert.match(legend.innerHTML, /#00ff00/, 'OFF では生の色');
  assert.match(legend.innerHTML, /白 = 共局在/, 'OFF では従来の注記');
}

// ★ 共有先の parquet は blobId を持たない。836 MB を IndexedDB に置かない設計で、
//   在りかは sourceUrl (Storage の URL) だけ (_hydrateSharedProject)。
//   _ensureRoiRawGrid が blobId の有無だけで弾いていたため、共有画面の ROI 統計は
//   必ず unavailable になり、右の棒グラフが全部 0 の高さ =「グラフが出ない」に
//   なっていた。表示ラスタ (loadMsiLayer) と同じ判定に揃えたことを縛る。
async function testRoiStatsReadSharedParquet() {
  const calls = [];
  const ctx = vm.createContext({
    console, Promise, Map, Set, Number, Float64Array,
    App: { project: {} },
    ProjectStorage: { getBlob: async () => { calls.push('getBlob'); return null; } },
    ensureLocalBlob: async () => { calls.push('ensureLocalBlob'); return null; },
    parquetSrcForEnt: async (ent) => {
      calls.push('src:' + (ent.sourceUrl || ent.blobId));
      return { url: ent.sourceUrl };
    },
    parquetRoiGrid: async () => ({ W: 2, H: 1, values: Float64Array.from([1, 3]) }),
  });
  vm.runInContext(
    'const ROI_RAW_GRID_CACHE_MAX = 24;\n'
    + 'const _roiRawGridCache = new Map();\n'
    + `${extractFunction(html, '_roiGridKey')}\n`
    + `${extractFunction(html, '_roiGridCacheGet')}\n`
    + `${extractFunction(html, '_roiGridCacheSet')}\n`
    + `${extractFunction(html, '_ensureRoiRawGrid')}\n`
    + 'this.out = { _ensureRoiRawGrid, _roiGridKey };',
    ctx);
  const { _ensureRoiRawGrid, _roiGridKey } = ctx.out;

  const shareEnt = { kind: 'parquet', blobId: null, sourceUrl: 'https://x/atlases/a.parquet', colIdx: 3 };
  const section = { id: 'sec_1', msiSeries: { MSI_A: shareEnt } };
  const grid = await _ensureRoiRawGrid(section, 'MSI_A');
  assert.ok(grid && grid.W === 2 && grid.H === 1, '共有先の parquet で ROI グリッドが作れていない');
  assert.ok(calls.includes('src:https://x/atlases/a.parquet'), 'Storage の URL を供給元にしていない');

  // 在りかがどちらも無いレイヤーは従来どおり null (無音で HTTP は投げない)。
  assert.equal(await _ensureRoiRawGrid({ id: 's', msiSeries: { MSI_A: { kind: 'parquet' } } }, 'MSI_A'), null);

  // 鍵に sourceUrl も混ぜる。blobId だけだと URL 供給のレイヤーが全部同じ鍵になる。
  assert.notEqual(
    _roiGridKey(section, 'MSI_A', shareEnt),
    _roiGridKey(section, 'MSI_A', { sourceUrl: 'https://x/atlases/b.parquet' }));

  // xlsx/txt は消えたローカル blob を Storage から取り直す経路 (ensureLocalBlob)。
  await _ensureRoiRawGrid({ id: 'sec_2', msiSeries: { MSI_B: { kind: 'xlsx', blobId: 'blob_1' } } }, 'MSI_B');
  assert.ok(calls.includes('ensureLocalBlob'), 'xlsx 経路が ensureLocalBlob を通っていない');
}

// ★ Analysis パネルの既定は背景除去(Otsu)。ROI を描き終えた時点で ROI 強度へ
//   切り替えないと、右側は ROI と無関係のヒストグラムのままで、利用者からは
//   「棒グラフが出ない」と見える (renderAnalysisChart は otsu/kmd で早期 return)。
function testDrawingRoiOpensTheRoiChart() {
  const fn = extractMethod(html, 'finalizeDrawing');
  const switchAt = fn.indexOf("this.analysisMode = 'roi';");
  const renderAt = fn.indexOf('this.renderAnalysis();');
  assert.notEqual(switchAt, -1, 'ROI を描いても Analysis が ROI 強度に切り替わらない');
  assert.ok(renderAt !== -1 && switchAt < renderAt, 'モード切替は renderAnalysis より前でなければ効かない');
  assert.match(fn, /updateAnalysisModeUi\(\)/);   // 選択欄の出し分けも一緒に更新する
  // 切替が要る理由そのもの。早期 return を消すならこのテストも見直すこと。
  assert.match(html, /if \(App\.analysisMode === 'otsu'\) \{ try \{ renderOtsuAnalysis\(\);/);
}

// ★ HE を MSI の格子に載せるときのキャンバス倍率。「MSI 格子 x 8」で固定して
//   いたので、100x100 の切片では canvas が 800px 止まりになり、スキャナで
//   6000px 取った HE を 1/7 に潰してから重ねていた。HE 単独表示は HE の実寸で
//   焼くので、「重ねた瞬間だけ粗くなる」という形で出る。
//   ここでは実装の式をそのまま切り出して評価する (テスト側で書き直さない)。
function testHeStaysSharpUnderMsiOverlay() {
  const capM = /const HE_ON_MSI_CANVAS_LONG_EDGE_MAX = (\d+);/.exec(html);
  assert.ok(capM, 'キャンバス長辺の上限が定数として無い');
  const cap = Number(capM[1]);
  assert.ok(cap >= 2048, 'キャンバス長辺の上限が 2048px を下回っている: ' + cap);

  const at = html.indexOf('    setupCanvasSize() {');
  assert.notEqual(at, -1, 'missing setupCanvasSize');
  const body = html.slice(at, html.indexOf('    // ---- Composite renderer ----', at));
  const snippet = /(const ratio = Math\.max\(heImg\.naturalWidth[\s\S]*?scale = Math\.max\(1,[^\n]*\);)/.exec(body);
  assert.ok(snippet, 'HE 倍率の決め方が読み取れない (式を変えたらこのテストも直すこと)');

  const scaleFor = (msi, heW, heH) => vm.runInNewContext(
    `const refSize = { w: ${msi}, h: ${msi} };\n`
    + `const heImg = { naturalWidth: ${heW}, naturalHeight: ${heH} };\n`
    + 'let scale = 1;\n' + snippet[1] + '\nscale;',
    { Math, HE_ON_MSI_CANVAS_LONG_EDGE_MAX: cap });

  // 格子が細かいほど倍率が上がる。100 格子なら canvas は 2048px 近くまで伸びる
  // (従来は 8 倍 = 800px 止まりだった)。
  assert.ok(scaleFor(100, 6000, 5000) * 100 >= 2000,
    '100 格子 + 6000px の HE で canvas が 2000px に届かない');
  // 格子が粗い側は従来どおり 8 倍のまま (メモリの最悪値を増やさない)。
  assert.equal(scaleFor(300, 6000, 5000), 8, '300 格子は従来どおり 8 倍');
  // HE の実解像度は決して超えない (無駄に大きい canvas を作らない)。
  assert.equal(scaleFor(100, 400, 400), 4, 'HE が小さければその倍率で止まる');
  assert.ok(scaleFor(100, 6000, 5000) * 100 <= cap + 100, '長辺の上限を大きく超えない');

  // 縮小して焼くときは面積平均で落とす。既定の imageSmoothingEnabled=false は
  // MSI の離散値を守る設定で、HE にまで効かせると間引きになりモアレが出る。
  const compAt = html.indexOf('    renderComposite() {');
  assert.notEqual(compAt, -1);
  const comp = html.slice(compAt, html.indexOf('    // ---- MSI scale bar', compAt));
  assert.match(comp, /const eff = Math\.sqrt\(Math\.abs\(detT \* sxT \* syT\)\);/,
    'HE の実効倍率を出していない');
  assert.match(comp, /if \(Number\.isFinite\(eff\) && eff < 1\) \{/,
    '縮小のときだけ補間する形になっていない');
  assert.match(comp, /ctx\.imageSmoothingQuality = 'high'/, '高品質の縮小を指定していない');
}

// ★ share_overlays テーブルがまだ無いデータベース向けの控え経路。
//   共有先が作った重ね合わせを localStorage に共有 slug 単位で残す
//   (正はサーバ。ここは落ちたときだけ使う)。
function testShareOverlaysPersistLocally() {
  const store = new Map();
  const warns = [];
  const ctx = vm.createContext({
    console: { warn: (...a) => warns.push(a.join(' ')), log() {}, info() {} },
    JSON, Array, Object,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    showToast() {},
    App: { shareMode: { slug: 'proj_x' }, project: null },
  });
  vm.runInContext(
    "const SHARE_OVERLAY_LS_PREFIX = 'desi:shareOverlays:';\n"
    + extractTopLevelFunction('_shareOverlayKey') + '\n'
    + extractTopLevelFunction('loadShareOverlays') + '\n'
    + extractTopLevelFunction('saveShareOverlays')
    + '\nthis.api = { loadShareOverlays, saveShareOverlays };',
    ctx);
  const { loadShareOverlays, saveShareOverlays } = ctx.api;

  const master = { id: 'ov_m', name: 'master', layers: [{ key: 'a' }, { key: 'b' }] };
  const mine = { id: 'ov_me', name: '自分', _local: true, layers: [{ key: 'c' }, { key: 'd' }] };
  const project = { overlays: [master, mine] };

  saveShareOverlays(project);
  const raw = store.get('desi:shareOverlays:proj_x');
  assert.ok(raw, '端末保存の重ね合わせが書かれていない');
  assert.deepEqual(JSON.parse(raw).map(o => o.id), ['ov_me'],
    'master の重ね合わせまで端末に保存しないこと');

  assert.deepEqual(loadShareOverlays(null).map(o => o.id), ['ov_me'], '読み戻せること');
  assert.equal(loadShareOverlays(null)[0]._local, true, '読み戻したものにも _local が付くこと');

  // 壊れた記録で一覧を壊さない (握りつぶさずに 1 行残す)。
  store.set('desi:shareOverlays:proj_x', '{{not json');
  assert.equal(loadShareOverlays(null).length, 0);
  assert.ok(warns.some(w => /share overlay/.test(w)), '読めなかったことを残すこと');
  store.set('desi:shareOverlays:proj_x', JSON.stringify([{ id: 'x', layers: [{ key: 'a' }] }]));
  assert.equal(loadShareOverlays(null).length, 0, '2 分子未満の記録は捨てる');

  // slug が無ければ何もしない (master モードで誤って書かない)。
  ctx.App.shareMode = null;
  saveShareOverlays({ overlays: [mine] });
  assert.equal(store.size, 1, 'slug が無いときに新しい鍵を作らないこと');
  assert.equal(loadShareOverlays(null).length, 0);

  // 共有先の hydrate は master の分と自分の分をつないで並べる。
  assert.match(html, /overlays: _overlaysFromSections\(doc\.sections\)\.concat\(loadShareOverlays\(null\)\)/,
    '共有 hydrate が端末保存の重ね合わせを読み込んでいない');
}

// ★ 共有先の ROI 削除は「訊く前にロックを取る」。逆順だと、消してよいと答えた
//   あとに「他の人が編集中です」で止まり、消えたのかどうかが分からない。
//   確認文には、ロックを持っていることと「全員から見えなくなる」ことを出す。
function testShareRoiDeleteAsksUnderTheLock() {
  const fn = extractMethod(html, 'deleteRoi');
  const lockAt = fn.indexOf('await this._tryAcquireRoiLock()');
  const confirmAt = fn.indexOf('if (!confirm(msg))');
  assert.notEqual(lockAt, -1, 'ロックを取っていない');
  assert.notEqual(confirmAt, -1, '共有先向けの確認が無い');
  assert.ok(lockAt < confirmAt, '確認より先にロックを取ること');
  assert.match(fn, /書き込みロックを取得しました/, 'ロックを持っていることを知らせていない');
  assert.match(fn, /他の人からも見えなくなります/, '影響範囲を知らせていない');
  assert.match(fn, /if \(!confirm\(msg\)\) \{ this\._releaseRoiLock\(\); return; \}/,
    'キャンセルしたらロックを返すこと (握ったままだと他の人が編集できなくなる)');
  // master 側は従来どおり (ロックの話は出さない)。
  assert.match(fn, /\} else if \(!confirm\('ROI 「' \+ label \+ '」 を削除しますか\?'\)\) \{/,
    'master 側の確認が消えている');
}

// ★ 共有先の重ね合わせは **共有 URL を開いた全員**で共有する。
//   正はサーバの share_overlays で、localStorage はテーブルがまだ無い
//   データベース向けの控え。ここでは
//     ・作ると id がサーバの uuid に差し替わること
//     ・ポーリングで同じ id のオブジェクトを使い回すこと
//       (App.activeOverlay / overlayForEditing が同一性で見ているため)
//     ・RPC が無いデータベースでは端末保存へ落ちること
//   を見る。
async function testShareOverlaysAreSharedWithEveryone() {
  const store = new Map();
  const toasts = [];
  const calls = [];
  let createResult = { id: 'uuid-new', version: 1 };
  let createThrows = null;
  const App = { shareMode: { slug: 'proj_x', token: 'tok' }, project: null, activeOverlay: null,
                clearActiveOverlay() { this.activeOverlay = null; } };
  const SupabaseClient = {
    listShareOverlays(token) { calls.push(['list', token]); return Promise.resolve(listRows); },
    createShareOverlay(token, payload) {
      calls.push(['create', token, payload]);
      if (createThrows) return Promise.reject(createThrows);
      return Promise.resolve(createResult);
    },
    updateShareOverlay(token, id, ver, payload) {
      calls.push(['update', token, id, ver, payload]);
      return Promise.resolve({ id, version: ver + 1 });
    },
  };
  let listRows = [];
  const ctx = vm.createContext({
    JSON, Array, Object, Promise, Map, Number,
    console: { warn() {}, log() {}, info() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    showToast: (m) => toasts.push(String(m)),
    App, SupabaseClient,
    SHARE_OVERLAY_LS_PREFIX: 'desi:shareOverlays:',
    _shareOverlayServerMissing: false,
    _shareOverlayWriteGen: 0,
    _isExpiredTokenError: () => false,
    _noteShareTokenExpired() {},
  });
  vm.runInContext(
    extractTopLevelFunction('_shareOverlayKey') + '\n'
    + extractTopLevelFunction('isShareOverlayMode') + '\n'
    + extractTopLevelFunction('isViewerOverlay') + '\n'
    + extractTopLevelFunction('saveShareOverlays') + '\n'
    + extractTopLevelFunction('_isMissingRpc') + '\n'
    + extractTopLevelFunction('_noteShareOverlayServerMissing') + '\n'
    + extractTopLevelFunction('_overlayFromRow') + '\n'
    + extractTopLevelFunction('_overlayToRowPayload') + '\n'
    + extractTopLevelFunction('fetchShareOverlays') + '\n'
    + extractTopLevelFunction('applyServerShareOverlays') + '\n'
    + extractTopLevelFunction('_fallbackShareOverlayToLocal') + '\n'
    + extractTopLevelFunction('_isStaleVersionError') + '\n'
    + extractTopLevelFunction('pushShareOverlay')
    + '\nthis.api = { fetchShareOverlays, applyServerShareOverlays, pushShareOverlay };',
    ctx);
  const { fetchShareOverlays, applyServerShareOverlays, pushShareOverlay } = ctx.api;

  // --- 作る: サーバへ送り、id が uuid に差し替わる ---
  const master = { id: 'ov_master', name: 'master', layers: [{ key: 'a' }, { key: 'b' }] };
  const fresh = { id: 'ov_tmp123', name: '新しいセット', bg: 'black', matchBrightness: true,
                  layers: [{ key: 'MSI_a', color: '#f0f' }, { key: 'MSI_b', color: '#0f0' }] };
  App.project = { __share: true, overlays: [master, fresh] };
  assert.equal(await pushShareOverlay(fresh), true);
  assert.equal(fresh.id, 'uuid-new', 'サーバの uuid を正にすること');
  assert.equal(fresh._server, true);
  assert.equal(fresh._local, undefined, 'サーバへ置けたら端末保存の印は落とすこと');
  const createCall = calls.find(c => c[0] === 'create');
  assert.equal(createCall[2].p_match_brightness, true, '「明るさを揃える」も送ること');
  assert.equal(createCall[2].p_layers.length, 2);
  assert.equal(store.size, 0, 'サーバへ置けたなら端末には書かないこと');

  // --- 編集: version つきで update ---
  fresh.name = '直した名前';
  assert.equal(await pushShareOverlay(fresh), true);
  const updateCall = calls.find(c => c[0] === 'update');
  assert.equal(updateCall[2], 'uuid-new');
  assert.equal(updateCall[3], 1, '楽観ロックの version を渡すこと');
  assert.equal(fresh._serverVersion, 2, '返ってきた version を持ち直すこと');

  // --- ポーリング: 同じ id はオブジェクトを使い回す ---
  App.activeOverlay = fresh;
  listRows = [
    { id: 'uuid-new', name: '他の人が直した名前', layers: fresh.layers, bg: 'black',
      match_brightness: true, version: 3 },
    { id: 'uuid-2', name: '他の人のセット', layers: [{ key: 'MSI_c' }, { key: 'MSI_d' }],
      bg: 'he', match_brightness: false, version: 1 },
  ];
  const rows = await fetchShareOverlays();
  assert.equal(rows.length, 2);
  assert.equal(applyServerShareOverlays(rows), true, '変化があったら true');
  assert.ok(App.project.overlays.includes(master), 'master の定義は残す');
  assert.ok(App.project.overlays.includes(fresh),
    '同じ id のオブジェクトを使い回すこと (表示中の重ね合わせが編集できなくなる)');
  assert.equal(fresh.name, '他の人が直した名前', '他の人の変更が入ること');
  assert.equal(App.activeOverlay, fresh, '表示中の参照が切れないこと');
  assert.equal(App.project.overlays.length, 3, '他の人のセットも並ぶこと');
  assert.equal(applyServerShareOverlays(rows), false, '変化が無ければ描き直さない');

  // ★ 件数が変わらない変更 (改名・色替え) も拾うこと。書き換えたあとで
  //   比べていると、同じオブジェクトを見ているせいで「変化なし」に見え、
  //   他の人の改名が画面に出ないまま止まる。
  listRows = [
    { id: 'uuid-new', name: 'さらに直した名前', layers: fresh.layers, bg: 'black',
      match_brightness: true, version: 4 },
    { id: 'uuid-2', name: '他の人のセット', layers: [{ key: 'MSI_c' }, { key: 'MSI_d' }],
      bg: 'he', match_brightness: false, version: 1 },
  ];
  assert.equal(applyServerShareOverlays(await fetchShareOverlays()), true,
    '件数が同じでも中身が変われば描き直すこと');
  assert.equal(fresh.name, 'さらに直した名前');

  // --- 表示中のものがサーバから消えたら単一表示へ戻す ---
  listRows = [listRows[1]];
  assert.equal(applyServerShareOverlays(await fetchShareOverlays()), true);
  assert.equal(App.activeOverlay, null, '消えた重ね合わせを表示したままにしない');

  // --- 他の人が先に直していた (楽観ロックの衝突) ---
  //   黙って上書きすると、あとから開いた人の変更が理由なく消える。
  const stale = new Error('stale_version');
  stale.code = '40001';
  const survivor = { id: 'uuid-2', name: '直したい', _server: true, _serverVersion: 1,
                     layers: [{ key: 'MSI_c' }, { key: 'MSI_d' }] };
  App.project.overlays.push(survivor);
  const realUpdate = SupabaseClient.updateShareOverlay;
  SupabaseClient.updateShareOverlay = () => Promise.reject(stale);
  const refreshed = [];
  App._refreshShareOverlays = () => { refreshed.push(true); return Promise.resolve(); };
  assert.equal(await pushShareOverlay(survivor), false, '衝突したら保存できていないと返すこと');
  assert.ok(toasts.some(t => /他の人が先に更新/.test(t)), '衝突したことを知らせること');
  assert.deepEqual(refreshed, [true], '最新を読み直すこと');
  SupabaseClient.updateShareOverlay = realUpdate;

  // --- RPC がまだ無いデータベース: 端末保存へ落ちる ---
  const missing = new Error('Could not find the function public.create_share_overlay');
  missing.code = 'PGRST202';
  createThrows = missing;
  const solo = { id: 'ov_tmp999', name: '端末だけ', layers: [{ key: 'MSI_x' }, { key: 'MSI_y' }] };
  App.project.overlays.push(solo);
  assert.equal(await pushShareOverlay(solo), true, 'テーブルが無くても使えること');
  assert.equal(solo._local, true, '端末保存へ落ちること');
  assert.equal(solo._server, undefined);
  assert.ok(store.get('desi:shareOverlays:proj_x'), '端末に書かれていること');
  assert.ok(toasts.some(t => /share_locks\.sql/.test(t)), '未適用であることを知らせること');
  // 以後は list もサーバを見に行かない (毎回 404 を投げない)。
  assert.equal(await fetchShareOverlays(), null);
}

// ★ 共有の重ね合わせで使うモジュール変数が宣言されているか。
//   構文ゲートは「未宣言の識別子を読む」を捕まえられない (実行時 ReferenceError)。
//   実際、案内フラグの宣言を消したまま参照だけ残していたことがあり、
//   共有先が最初の重ね合わせを作った瞬間に落ちる状態になっていた。
function testShareOverlayModuleVarsAreDeclared() {
  const used = new Set([...html.matchAll(/\b(_shareOverlay[A-Za-z0-9_]*)\b/g)].map(m => m[1]));
  assert.ok(used.size >= 2, '見張る対象が見つからない (名前を変えたらこのテストも直すこと)');
  for (const name of used) {
    const declared = new RegExp('(?:let|const|var|function)\\s+' + name + '\\b').test(html);
    assert.ok(declared, name + ' が宣言されていない (実行時に ReferenceError で落ちる)');
  }
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
  testOverlayBrightnessMatching();
  testOverlayScaleReachesTheBake();
  testRebakeCellImagesFollowsOverlay();
  testColorbarBecomesLegendInOverlayMode();
  testEditKeepsMatchBrightness();
  testBlackOverlayColorIsReported();
  testMatchedOverlayUsesOneOpacity();
  testLegendFollowsBrightnessMatching();
  testCloseRestoresOverlay();
  testForcedHeBackdropDoesNotPersist();
  testOverlayForEditingIgnoresUnregistered();
  testPreviewAddOverlayAlwaysAdds();
  testOverlayPanelRendersInRightColumn();
  await testDeleteOverlayIsShared();
  testMasterCanOpenPreview();
  testStoragePathRule();
  testImportSectionIdKeying();
  await testRoiStatsReadSharedParquet();
  testDrawingRoiOpensTheRoiChart();
  testHeStaysSharpUnderMsiOverlay();
  testShareOverlaysPersistLocally();
  await testShareOverlaysAreSharedWithEveryone();
  testShareOverlayModuleVarsAreDeclared();
  testShareRoiDeleteAsksUnderTheLock();
  console.log('viewer preview regression tests: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
