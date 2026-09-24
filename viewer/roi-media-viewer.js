(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RoiMediaViewer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // The window owns display state only. All persistent changes go through the
  // adapter, which validates the project/ROI and commits the image atomically.
  let active = null;
  let nextWindowId = 0;
  const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const text = value => value == null ? '' : String(value);

  function photoFit(width, height, viewportWidth, viewportHeight) {
    if (![width, height, viewportWidth, viewportHeight].every(positive)) return null;
    const scale = Math.min(viewportWidth / width, viewportHeight / height);
    return {scale, x: (viewportWidth - width * scale) / 2, y: (viewportHeight - height * scale) / 2};
  }

  function photoScaleBar(scale, calibration, viewportWidth) {
    if (!positive(scale) || !calibration || !positive(calibration.x) || !positive(calibration.y) || viewportWidth < 120) return null;
    const umPerScreenPixel = Number(calibration.x) / scale;
    if (!positive(umPerScreenPixel)) return null;
    const limit = Math.min(110, viewportWidth * 0.25), order = Math.pow(10, Math.floor(Math.log10(limit * umPerScreenPixel)));
    if (!positive(order)) return null;
    let length = order;
    for (const factor of [1, 2, 5, 10]) if (factor * order / umPerScreenPixel <= limit) length = factor * order;
    const value = length >= 1000 ? length / 1000 : length;
    return {pixels: length / umPerScreenPixel, label: Number(value.toPrecision(3)) + (length >= 1000 ? ' mm' : ' µm')};
  }

  function metadataPatch(fields) {
    const x = text(fields.umX).trim(), y = text(fields.umY).trim();
    if ((x || y) && (!positive(x) || !positive(y))) throw new Error('µm/px は X・Y の両方に正の数を入力してください。');
    return {
      title: text(fields.title).trim(), kind: text(fields.kind || 'Other'),
      magnification: text(fields.magnification).trim(), capturedAt: text(fields.capturedAt).trim(),
      note: text(fields.note).trim(), umPerPixel: x || y ? {x: Number(x), y: Number(y)} : null
    };
  }

  function el(tag, className, content) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = text(content);
    return node;
  }
  function button(label, title) {
    const node = el('button', 'roi-media-btn', label);
    node.type = 'button';
    if (title) { node.title = title; node.setAttribute('aria-label', title); }
    return node;
  }
  function option(value, label) {
    const node = el('option', '', label); node.value = text(value); return node;
  }
  function listen(state, node, name, fn, options) {
    node.addEventListener(name, fn, options);
    state.cleanups.push(() => node.removeEventListener(name, fn, options));
  }
  function current(state) {
    if (!state || active !== state || state.closed) return false;
    try { return !state.adapter.validateContext || state.adapter.validateContext(state.project, state.roi) !== false; }
    catch (_) { return false; }
  }
  function setStatus(state, message, error) {
    if (!current(state)) return;
    state.status.textContent = text(message);
    state.status.classList.toggle('is-error', !!error);
  }
  function disposeResult(result) {
    if (result && typeof result.dispose === 'function') {
      try { result.dispose(); } catch (_) { /* an already released resource */ }
    }
  }
  function selected(state) {
    return state.items.find(item => text(item.id) === state.photoId) || null;
  }
  function editable(state) {
    try { return !!state.adapter.editable(state.project, state.roi); }
    catch (_) { return false; }
  }

  function updateControls(state) {
    const canEdit = editable(state), item = selected(state);
    state.add.disabled = !canEdit || state.busy || !state.sectionId;
    state.replace.disabled = !canEdit || state.busy || !item;
    state.remove.disabled = !canEdit || state.busy || !item;
    state.primary.disabled = !canEdit || state.busy || !item || !!item.isPrimary;
    state.primary.textContent = item && item.isPrimary ? '★ 代表画像' : '代表にする';
    state.save.disabled = !canEdit || state.busy || !item || !state.dirty;
    state.sectionSelect.disabled = state.busy || state.sections.length < 2;
    state.form.hidden = !item;
    state.details.hidden = !item;
    state.readOnly.hidden = canEdit;
    Object.values(state.fields).forEach(field => { field.disabled = !canEdit || state.busy || !item; });
    state.thumbnailButtons.forEach(node => { node.disabled = state.busy; });
    state.window.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  }

  function allowDiscard(state) {
    if (!state.dirty) return true;
    return typeof root.confirm === 'function' && root.confirm('写真情報に未保存の変更があります。変更を破棄しますか？');
  }

  function populateFields(state, item) {
    state.fields.title.value = text(item && item.title);
    state.fields.kind.value = item && ['HE', 'IF', 'Other'].includes(item.kind) ? item.kind : 'Other';
    state.fields.magnification.value = text(item && item.magnification);
    state.fields.capturedAt.value = text(item && item.capturedAt).slice(0, 10);
    state.fields.note.value = text(item && item.note);
    state.fields.umX.value = text(item && item.umPerPixel && item.umPerPixel.x);
    state.fields.umY.value = text(item && item.umPerPixel && item.umPerPixel.y);
    state.dirty = false;
    state.filename.textContent = item ? [item.filename, positive(item.width) && positive(item.height) ? `${item.width} × ${item.height} px` : ''].filter(Boolean).join(' · ') : '';
    state.detailsLabel.textContent = item ? `写真情報${item.magnification ? ' · ' + item.magnification : ''}` : '写真情報';
    state.association.textContent = text(item && (item.associationWarning || item.warning));
    state.association.hidden = !state.association.textContent;
    updateControls(state);
  }

  function releasePhoto(state) {
    disposeResult(state.photoResult); state.photoResult = null;
    state.photoImage = null; state.photoView = null;
    if (state.photoPane) state.photoPane.render();
  }

  async function selectPhoto(state, photoId, force) {
    if (!current(state)) return;
    if (!force && state.photoId === text(photoId)) return;
    if (!force && !allowDiscard(state)) return;
    const generation = ++state.photoGeneration;
    releasePhoto(state);
    state.photoId = text(photoId);
    const item = selected(state);
    try { if (state.adapter.selectPhoto) state.adapter.selectPhoto(state.project, state.roi, state.sectionId, item); }
    catch (error) { setStatus(state, error && error.message || '写真の対応先を確認できません。', true); return; }
    ++state.msiGeneration;
    state.msiRenderer.setFrame(null);
    state.msiMessage.hidden = false;
    state.msiMessage.textContent = '対応するMSIを確認しています…';
    // Photo selection establishes the reference source before MSI compatibility
    // is evaluated. Thumbnail decoding must never change this selection.
    refreshCompounds(state, state.compoundsInitialized);
    populateFields(state, item);
    state.thumbnailButtons.forEach(node => node.setAttribute('aria-pressed', node.dataset.photoId === state.photoId ? 'true' : 'false'));
    state.photoMessage.hidden = false;
    state.photoMessage.textContent = item ? '画像を読み込み中…' : 'このROIの写真はまだ登録されていません。';
    state.photoResolution.textContent = '';
    if (!item) return;
    try {
      const result = await state.adapter.loadPhoto(item);
      if (!current(state) || generation !== state.photoGeneration) { disposeResult(result); return; }
      const image = result && result.image;
      const width = image && (image.naturalWidth || image.width), height = image && (image.naturalHeight || image.height);
      if (!positive(width) || !positive(height)) { disposeResult(result); throw new Error('画像を表示できませんでした。'); }
      state.photoResult = result; state.photoImage = image;
      state.photoMessage.hidden = true;
      state.photoResolution.textContent = result.status || `原解像度 ${width} × ${height} px`;
      state.photoPane.fit();
      const thumb = state.thumbnailCanvases.get(text(item.id));
      if (thumb) paintThumbnail(thumb, image);
    } catch (error) {
      if (!current(state) || generation !== state.photoGeneration) return;
      state.photoMessage.textContent = error && error.message || '写真の読み込みに失敗しました。';
      setStatus(state, state.photoMessage.textContent, true);
    }
  }

  function paintThumbnail(canvas, image) {
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    if (!positive(width) || !positive(height)) return;
    const fit = photoFit(width, height, canvas.width, canvas.height);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, fit.x, fit.y, width * fit.scale, height * fit.scale);
  }

  async function loadThumbnails(state, items, generation) {
    // Decode only one thumbnail at a time. Never retain full-size source images
    // for the thumbnail strip; selected-photo loading has a separate generation.
    for (const item of items) {
      if (!current(state) || generation !== state.thumbnailGeneration) return;
      const canvas = state.thumbnailCanvases.get(text(item.id));
      if (!canvas) continue;
      if (state.photoId === text(item.id) && state.photoImage) { paintThumbnail(canvas, state.photoImage); continue; }
      let result;
      try {
        result = await (state.adapter.loadThumbnail ? state.adapter.loadThumbnail(item) : state.adapter.loadPhoto(item));
        if (!current(state) || generation !== state.thumbnailGeneration) return;
        if (result && result.image) paintThumbnail(canvas, result.image);
      } catch (_) { canvas.setAttribute('aria-label', 'プレビューを読み込めません'); }
      finally { disposeResult(result); }
    }
  }

  function renderThumbnails(state) {
    const generation = ++state.thumbnailGeneration;
    state.thumbnails.replaceChildren(); state.thumbnailButtons = []; state.thumbnailCanvases = new Map();
    state.items.forEach(item => {
      const title = item.title || item.filename || '写真';
      const node = button('', title); node.className = 'roi-media-thumbnail';
      node.dataset.photoId = text(item.id); node.setAttribute('aria-pressed', 'false');
      const canvas = el('canvas'); canvas.width = 144; canvas.height = 88; canvas.setAttribute('aria-hidden', 'true');
      node.append(canvas, el('span', '', (item.isPrimary ? '★ ' : '') + title));
      node.addEventListener('click', () => { if (!state.busy) selectPhoto(state, item.id, false); });
      state.thumbnails.appendChild(node); state.thumbnailButtons.push(node); state.thumbnailCanvases.set(text(item.id), canvas);
    });
    state.thumbnails.hidden = !state.items.length;
    // Yield once so that the selected photo request starts before background previews.
    Promise.resolve().then(() => loadThumbnails(state, state.items.slice(), generation));
  }

  async function refreshPhotos(state, preferredId, preserveDirty) {
    const generation = ++state.listGeneration, sectionId = state.sectionId;
    try {
      const items = await state.adapter.list(state.project, state.roi, sectionId);
      if (!current(state) || generation !== state.listGeneration || sectionId !== state.sectionId) return;
      state.items = Array.isArray(items) ? items : [];
      const wanted = text(preferredId == null ? state.photoId : preferredId);
      const item = state.items.find(value => text(value.id) === wanted) || state.items.find(value => value.isPrimary) || state.items[0];
      const sameDirty = preserveDirty && state.dirty && item && text(item.id) === state.photoId;
      renderThumbnails(state);
      if (!sameDirty) await selectPhoto(state, item && item.id, true);
      else {
        state.thumbnailButtons.forEach(node => node.setAttribute('aria-pressed', node.dataset.photoId === state.photoId ? 'true' : 'false'));
        updateControls(state);
        refreshCompounds(state, true);
      }
    } catch (error) {
      if (current(state) && generation === state.listGeneration && sectionId === state.sectionId)
        setStatus(state, error && error.message || '写真一覧の読み込みに失敗しました。', true);
    }
  }

  async function loadMsi(state) {
    const generation = ++state.msiGeneration, sectionId = state.sectionId, key = state.compoundSelect.value;
    state.msiNotice.textContent = '';
    state.msiRenderer.setFrame(null);
    if (!key) {
      state.msiMessage.hidden = false;
      state.msiMessage.textContent = state.compoundNotice || '対応する化合物を選択してください。';
      return;
    }
    state.msiMessage.hidden = false; state.msiMessage.textContent = 'MSIを読み込み中…';
    try {
      const frame = await state.adapter.loadMsi(state.project, state.roi, sectionId, key);
      if (!current(state) || generation !== state.msiGeneration || sectionId !== state.sectionId) { disposeResult(frame); return; }
      disposeResult(state.msiFrame); state.msiFrame = frame;
      if (!frame || !frame.canvas) throw new Error(frame && (frame.notice || frame.message) || '対応するMSI画像を表示できません。');
      const rendered = state.msiRenderer.setFrame(frame);
      if (!rendered) throw new Error(state.msiNotice.textContent || 'ROIとMSIの表示座標を確認できません。');
      state.msiMessage.hidden = true;
      state.msiNotice.textContent = text(frame.notice || frame.warning || frame.status || '全体・ROI周辺で配色と強度範囲は共通です。');
    } catch (error) {
      if (!current(state) || generation !== state.msiGeneration) return;
      state.msiMessage.hidden = false; state.msiMessage.textContent = error && error.message || 'MSIの読み込みに失敗しました。';
      setStatus(state, state.msiMessage.textContent, true);
    }
  }

  async function refreshCompounds(state, preserve) {
    const generation = ++state.compoundGeneration, sectionId = state.sectionId;
    const oldKey = preserve ? state.compoundSelect.value : null;
    try {
      const result = await state.adapter.compounds(state.project, state.roi, sectionId);
      if (!current(state) || generation !== state.compoundGeneration || sectionId !== state.sectionId) return;
      const items = Array.isArray(result) ? result : result && result.items || [];
      state.compoundNotice = text(result && result.notice);
      const preferred = oldKey != null ? oldKey : state.adapter.preferredCompound ? await state.adapter.preferredCompound(state.project, state.roi, sectionId) : null;
      if (!current(state) || generation !== state.compoundGeneration || sectionId !== state.sectionId) return;
      state.compoundSelect.replaceChildren(option('', '化合物を選択'));
      items.forEach(item => {
        const node = option(item.key, item.label || item.key);
        node.disabled = !!item.disabled; if (item.reason) node.title = text(item.reason);
        state.compoundSelect.appendChild(node);
      });
      state.compoundSelect.disabled = !items.some(item => !item.disabled);
      state.compoundSelect.value = items.some(item => !item.disabled && text(item.key) === text(preferred)) ? text(preferred) : '';
      state.compoundsInitialized = true;
      if (!items.length && !state.compoundNotice) state.compoundNotice = 'このROIの測定座標に対応するMSIがありません。写真は閲覧できます。';
      await loadMsi(state);
    } catch (error) {
      if (current(state) && generation === state.compoundGeneration && sectionId === state.sectionId)
        setStatus(state, error && error.message || '化合物一覧の読み込みに失敗しました。', true);
    }
  }

  async function changeSection(state, sectionId, force) {
    if (!current(state) || state.busy && !force) return;
    if (!force && !allowDiscard(state)) { state.sectionSelect.value = state.sectionId; return; }
    state.sectionId = text(sectionId); state.sectionSelect.value = state.sectionId;
    ++state.photoGeneration; ++state.thumbnailGeneration; ++state.msiGeneration; ++state.compoundGeneration;
    state.photoId = ''; state.items = []; state.dirty = false;
    state.compoundsInitialized = false; state.compoundSelect.value = '';
    if (state.adapter.selectPhoto) state.adapter.selectPhoto(state.project, state.roi, state.sectionId, null);
    state.msiRenderer.setFrame(null); state.msiMessage.hidden = false; state.msiMessage.textContent = '対応するMSIを確認しています…';
    releasePhoto(state); renderThumbnails(state); populateFields(state, null);
    await refreshPhotos(state, '', false);
  }

  async function mutate(state, operation, success, preferredId) {
    if (!current(state) || state.busy || !editable(state)) return;
    const sectionId = state.sectionId;
    state.busy = true; updateControls(state); setStatus(state, '保存しています…');
    try {
      const result = await operation();
      if (!current(state) || sectionId !== state.sectionId) return;
      state.dirty = false;
      const item = Array.isArray(result) ? result[0] : result;
      await refreshPhotos(state, preferredId || item && item.id || state.photoId, false);
      setStatus(state, success || '保存しました。');
    } catch (error) {
      if (current(state)) setStatus(state, error && error.message || '保存に失敗しました。登録済み画像は保持されています。', true);
    } finally {
      state.busy = false; if (current(state)) updateControls(state);
    }
  }

  function createPhotoPane(state, host, canvas) {
    let drag = null, autoFit = true;
    function size() { return {width: host.clientWidth || 1, height: host.clientHeight || 1}; }
    function render() {
      const viewSize = size(), dpr = Math.min(3, Number(root.devicePixelRatio) || 1);
      const width = Math.max(1, Math.round(viewSize.width * dpr)), height = Math.max(1, Math.round(viewSize.height * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext('2d'); if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, viewSize.width, viewSize.height);
      const image = state.photoImage; if (!image) return;
      const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
      if (!state.photoView || autoFit) state.photoView = photoFit(iw, ih, viewSize.width, viewSize.height);
      if (!state.photoView) return;
      const view = state.photoView;
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      context.drawImage(image, view.x, view.y, iw * view.scale, ih * view.scale);
      const item = selected(state), scaleBar = photoScaleBar(view.scale, item && item.umPerPixel, viewSize.width);
      if (scaleBar && viewSize.height > 70) {
        const x = 16, y = viewSize.height - 18;
        context.beginPath(); context.moveTo(x, y); context.lineTo(x + scaleBar.pixels, y);
        context.strokeStyle = '#000'; context.lineWidth = 5; context.stroke();
        context.strokeStyle = '#fff'; context.lineWidth = 2; context.stroke();
        context.font = '11px system-ui,sans-serif'; context.textAlign = 'left'; context.textBaseline = 'bottom';
        context.lineWidth = 3; context.strokeStyle = '#000'; context.strokeText(scaleBar.label, x, y - 6);
        context.fillStyle = '#fff'; context.fillText(scaleBar.label, x, y - 6);
      }
      state.photoZoom.textContent = `${Math.round(view.scale * 100)}%`;
    }
    function fit() { autoFit = true; state.photoView = null; render(); }
    function zoomBy(factor, x, y) {
      if (!state.photoView) return;
      const sizeNow = size(), view = state.photoView;
      if (!Number.isFinite(x)) x = sizeNow.width / 2;
      if (!Number.isFinite(y)) y = sizeNow.height / 2;
      const scale = clamp(view.scale * factor, 0.00001, 64), ratio = scale / view.scale;
      state.photoView = {scale, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio};
      autoFit = false; render();
    }
    function actual() { if (state.photoView) zoomBy(1 / state.photoView.scale); }
    listen(state, host, 'wheel', event => {
      if (!state.photoImage) return;
      event.preventDefault(); event.stopPropagation();
      const rect = host.getBoundingClientRect();
      zoomBy(Math.exp(-clamp(event.deltaY, -200, 200) * 0.003), event.clientX - rect.left, event.clientY - rect.top);
    }, {passive: false});
    listen(state, host, 'pointerdown', event => {
      if (event.button !== 0 || !state.photoView) return;
      event.preventDefault(); host.focus({preventScroll: true});
      drag = {id: event.pointerId, x: event.clientX, y: event.clientY, view: {...state.photoView}};
      try { host.setPointerCapture(event.pointerId); } catch (_) { /* capture unsupported */ }
      host.classList.add('is-dragging');
    });
    listen(state, host, 'pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      state.photoView = {...drag.view, x: drag.view.x + event.clientX - drag.x, y: drag.view.y + event.clientY - drag.y};
      autoFit = false; render();
    });
    const endDrag = () => { drag = null; host.classList.remove('is-dragging'); };
    listen(state, host, 'pointerup', endDrag); listen(state, host, 'pointercancel', endDrag); listen(state, host, 'lostpointercapture', endDrag);
    listen(state, host, 'keydown', event => {
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.25); }
      else if (event.key === '-') { event.preventDefault(); zoomBy(0.8); }
      else if (event.key === '0') { event.preventDefault(); fit(); }
      else if (state.photoView && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); autoFit = false;
        state.photoView.x += event.key === 'ArrowLeft' ? 30 : event.key === 'ArrowRight' ? -30 : 0;
        state.photoView.y += event.key === 'ArrowUp' ? 30 : event.key === 'ArrowDown' ? -30 : 0;
        render();
      }
    });
    return {render, fit, zoomBy, actual};
  }

  function boundWindow(state, dimensions) {
    const vw = Math.max(1, root.innerWidth || 1024), vh = Math.max(1, root.innerHeight || 768), gap = Math.min(8, vw / 4, vh / 4);
    const rect = state.window.getBoundingClientRect();
    const width = clamp(dimensions && dimensions.width || rect.width || 1060, Math.min(440, vw - gap * 2), vw - gap * 2);
    const height = clamp(dimensions && dimensions.height || rect.height || 720, Math.min(360, vh - gap * 2), vh - gap * 2);
    const x = clamp(dimensions && Number.isFinite(dimensions.x) ? dimensions.x : rect.left, gap, Math.max(gap, vw - width - gap));
    const y = clamp(dimensions && Number.isFinite(dimensions.y) ? dimensions.y : rect.top, gap, Math.max(gap, vh - height - gap));
    Object.assign(state.window.style, {width: width + 'px', height: height + 'px', left: x + 'px', top: y + 'px'});
  }

  function wireWindowPosition(state, header, handle) {
    let drag = null;
    function start(event, resize) {
      if (event.button !== 0 || !resize && event.target.closest('button,select,input,label')) return;
      const rect = state.window.getBoundingClientRect();
      drag = {id: event.pointerId, resize, x: event.clientX, y: event.clientY, rect};
      event.preventDefault();
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) { /* capture unsupported */ }
    }
    function move(event) {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      boundWindow(state, drag.resize ? {x: drag.rect.left, y: drag.rect.top, width: drag.rect.width + dx, height: drag.rect.height + dy} : {x: drag.rect.left + dx, y: drag.rect.top + dy, width: drag.rect.width, height: drag.rect.height});
    }
    [header, handle].forEach(node => {
      listen(state, node, 'pointerdown', event => start(event, node === handle));
      listen(state, node, 'pointermove', move);
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => listen(state, node, name, () => { drag = null; }));
    });
    listen(state, handle, 'keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const rect = state.window.getBoundingClientRect();
      boundWindow(state, {width: rect.width + (event.key === 'ArrowLeft' ? -24 : event.key === 'ArrowRight' ? 24 : 0), height: rect.height + (event.key === 'ArrowUp' ? -24 : event.key === 'ArrowDown' ? 24 : 0)});
    });
  }

  function createForm(state) {
    const details = el('details', 'roi-media-details'), summary = el('summary', '', '写真情報');
    state.details = details;
    state.detailsLabel = summary; details.appendChild(summary);
    const form = el('form', 'roi-media-form'); state.form = form; state.fields = {};
    const field = (key, label, type, span) => {
      const labelNode = el('label', span ? 'is-wide' : '', label);
      const input = type === 'textarea' ? el('textarea') : el('input');
      if (type !== 'textarea') input.type = type || 'text';
      input.name = key; if (type === 'number') { input.min = '0'; input.step = 'any'; }
      if (type === 'textarea') input.rows = 2;
      if (type === 'text') input.maxLength = key === 'title' ? 200 : 100;
      if (type === 'textarea') input.maxLength = 4000;
      labelNode.appendChild(input); form.appendChild(labelNode); state.fields[key] = input;
    };
    field('title', '写真名', 'text', true);
    const kindLabel = el('label', '', '画像種別'), kind = el('select');
    [['HE', 'HE'], ['IF', '蛍光 / IF'], ['Other', 'その他']].forEach(([value, label]) => kind.appendChild(option(value, label)));
    kindLabel.appendChild(kind); form.appendChild(kindLabel); state.fields.kind = kind;
    field('magnification', '撮影倍率', 'text'); state.fields.magnification.placeholder = '例: 40×';
    field('capturedAt', '撮影日（任意）', 'date');
    field('note', 'メモ', 'textarea', true);
    field('umX', 'X µm/px（任意）', 'number'); field('umY', 'Y µm/px（任意）', 'number');
    form.appendChild(el('p', 'roi-media-calibration-note is-wide', '倍率から実寸や位置合わせは推定しません。µm/px は校正値がある場合に入力してください。'));
    state.filename = el('p', 'roi-media-file-info is-wide'); form.appendChild(state.filename);
    const controls = el('div', 'roi-media-form-actions is-wide');
    state.save = button('情報を保存'); state.save.type = 'submit'; controls.appendChild(state.save);
    state.primary = button('代表にする'); controls.appendChild(state.primary);
    state.replace = button('画像を差し替え'); controls.appendChild(state.replace);
    state.remove = button('写真を削除'); state.remove.classList.add('is-danger'); controls.appendChild(state.remove);
    form.appendChild(controls); details.appendChild(form);
    listen(state, form, 'input', () => { state.dirty = true; updateControls(state); });
    listen(state, form, 'change', () => { state.dirty = true; updateControls(state); });
    listen(state, form, 'submit', event => {
      event.preventDefault(); const item = selected(state); if (!item) return;
      let patch;
      try { patch = metadataPatch(Object.fromEntries(Object.entries(state.fields).map(([key, input]) => [key, input.value]))); }
      catch (error) { setStatus(state, error.message, true); return; }
      const sectionId = state.sectionId;
      mutate(state, () => state.adapter.update(state.project, state.roi, sectionId, item, patch), '写真情報を保存しました。', item.id);
    });
    listen(state, state.primary, 'click', () => {
      const item = selected(state); if (!item || !allowDiscard(state)) return;
      const sectionId = state.sectionId;
      mutate(state, () => state.adapter.makePrimary(state.project, state.roi, sectionId, item), '代表画像を変更しました。', item.id);
    });
    listen(state, state.replace, 'click', () => { if (allowDiscard(state)) state.replaceInput.click(); });
    listen(state, state.remove, 'click', () => {
      const item = selected(state); if (!item) return;
      if (typeof root.confirm !== 'function' || !root.confirm(`「${item.title || item.filename || 'この写真'}」の登録を削除しますか？ ROIの形状は保持されます。`)) return;
      const sectionId = state.sectionId;
      mutate(state, () => state.adapter.remove(state.project, state.roi, sectionId, item), '写真の登録を削除しました。');
    });
    return details;
  }

  function mount(state) {
    const win = el('section', 'roi-media-window'); state.window = win;
    win.setAttribute('role', 'dialog'); win.setAttribute('aria-modal', 'false'); win.tabIndex = -1;
    const id = 'roi-media-title-' + ++nextWindowId;
    win.setAttribute('aria-labelledby', id);
    const header = el('header', 'roi-media-header'), title = el('strong', 'roi-media-title'); title.id = id; state.title = title;
    const sectionLabel = el('label', 'roi-media-section-label', '切片 '); state.sectionSelect = el('select'); state.sectionSelect.setAttribute('aria-label', '対象切片'); sectionLabel.appendChild(state.sectionSelect);
    const closeButton = button('×', '比較ウィンドウを閉じる'); closeButton.classList.add('roi-media-close');
    header.append(title, sectionLabel, closeButton); win.appendChild(header);
    const body = el('div', 'roi-media-body'), photo = el('section', 'roi-media-photo'), msi = el('section', 'roi-media-msi');
    body.append(photo, msi); win.appendChild(body);

    const photoBar = el('div', 'roi-media-toolbar'); photoBar.appendChild(el('strong', '', '顕微鏡写真'));
    state.add = button('＋ 画像を新規登録'); photoBar.appendChild(state.add);
    const photoMinus = button('−', '写真を縮小'), photoPlus = button('＋', '写真を拡大'), photoFitButton = button('全体', '写真を全体表示'), photoActual = button('100%', '写真を原寸表示');
    photoBar.append(photoMinus, photoPlus, photoFitButton, photoActual); state.photoZoom = el('span', 'roi-media-zoom'); photoBar.appendChild(state.photoZoom); photo.appendChild(photoBar);
    const photoViewport = el('div', 'roi-media-image-viewport'); photoViewport.tabIndex = 0; photoViewport.setAttribute('aria-label', '顕微鏡写真。ドラッグで移動、ホイールで拡大縮小');
    const photoCanvas = el('canvas'); photoCanvas.setAttribute('aria-hidden', 'true'); photoViewport.appendChild(photoCanvas);
    state.photoMessage = el('p', 'roi-media-empty', '画像を読み込み中…'); photoViewport.appendChild(state.photoMessage); photo.appendChild(photoViewport);
    state.photoResolution = el('div', 'roi-media-resolution'); photo.appendChild(state.photoResolution);
    state.association = el('p', 'roi-media-warning'); state.association.hidden = true; photo.appendChild(state.association);
    state.thumbnails = el('div', 'roi-media-thumbnails'); state.thumbnails.setAttribute('aria-label', '登録写真'); photo.appendChild(state.thumbnails);
    state.readOnly = el('p', 'roi-media-read-only', '閲覧専用：写真の登録・編集は作成者側で行えます。'); photo.appendChild(state.readOnly);
    photo.appendChild(createForm(state));
    state.photoPane = createPhotoPane(state, photoViewport, photoCanvas);
    listen(state, photoMinus, 'click', () => state.photoPane.zoomBy(0.8)); listen(state, photoPlus, 'click', () => state.photoPane.zoomBy(1.25));
    listen(state, photoFitButton, 'click', () => state.photoPane.fit()); listen(state, photoActual, 'click', () => state.photoPane.actual());

    const msiBar = el('div', 'roi-media-toolbar'); msiBar.appendChild(el('strong', '', 'MSI'));
    state.compoundSelect = el('select'); state.compoundSelect.setAttribute('aria-label', 'MSIの化合物'); state.compoundSelect.appendChild(option('', '化合物を選択')); msiBar.appendChild(state.compoundSelect); msi.appendChild(msiBar);
    const displayBar = el('div', 'roi-media-toolbar');
    const whole = button('全体'), crop = button('ROI周辺'); whole.setAttribute('aria-pressed', 'false'); crop.setAttribute('aria-pressed', 'true'); displayBar.append(whole, crop);
    const marginLabel = el('label', '', '余白 '), margin = el('select'); [2, 4, 8, 16].forEach(value => margin.appendChild(option(value, `${value} px`))); margin.value = '4'; margin.setAttribute('aria-label', 'ROI周辺の余白（MSI画像ピクセル）'); marginLabel.appendChild(margin); displayBar.appendChild(marginLabel);
    const outlineLabel = el('label', '', ''), outline = el('input'); outline.type = 'checkbox'; outline.checked = true; outlineLabel.append(outline, root.document.createTextNode(' ROI輪郭')); displayBar.appendChild(outlineLabel);
    const msiMinus = button('−', 'MSIを縮小'), msiPlus = button('＋', 'MSIを拡大'), msiFit = button('表示リセット'); displayBar.append(msiMinus, msiPlus, msiFit); msi.appendChild(displayBar);
    const msiViewport = el('div', 'roi-media-msi-viewport'); state.msiMessage = el('p', 'roi-media-empty', '化合物を選択してください。');
    msi.appendChild(msiViewport);
    if (!root.RoiMediaMsi || typeof root.RoiMediaMsi.createViewport !== 'function') throw new Error('MSI比較表示のモジュールを読み込めませんでした。ページを再読み込みしてください。');
    state.msiNotice = el('p', 'roi-media-msi-notice');
    state.msiRenderer = root.RoiMediaMsi.createViewport(msiViewport, {onStatus: message => { if (current(state) && message) state.msiNotice.textContent = text(message); }});
    msiViewport.appendChild(state.msiMessage);
    msi.appendChild(state.msiNotice);
    listen(state, whole, 'click', () => { whole.setAttribute('aria-pressed', 'true'); crop.setAttribute('aria-pressed', 'false'); margin.disabled = true; state.msiRenderer.setMode('whole'); });
    listen(state, crop, 'click', () => { whole.setAttribute('aria-pressed', 'false'); crop.setAttribute('aria-pressed', 'true'); margin.disabled = false; state.msiRenderer.setMode('crop'); });
    listen(state, margin, 'change', () => state.msiRenderer.setMargin(Number(margin.value)));
    listen(state, outline, 'change', () => state.msiRenderer.setOutline(outline.checked));
    listen(state, msiMinus, 'click', () => state.msiRenderer.zoomBy(0.8)); listen(state, msiPlus, 'click', () => state.msiRenderer.zoomBy(1.25)); listen(state, msiFit, 'click', () => state.msiRenderer.fit());
    if (state.msiRenderer.canvas) listen(state, state.msiRenderer.canvas, 'keydown', event => {
      if (event.key === '+' || event.key === '=') { event.preventDefault(); state.msiRenderer.zoomBy(1.25); }
      else if (event.key === '-') { event.preventDefault(); state.msiRenderer.zoomBy(0.8); }
      else if (event.key === '0') { event.preventDefault(); state.msiRenderer.fit(); }
      else if (state.msiRenderer.panBy && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        state.msiRenderer.panBy(event.key === 'ArrowLeft' ? 30 : event.key === 'ArrowRight' ? -30 : 0,
          event.key === 'ArrowUp' ? 30 : event.key === 'ArrowDown' ? -30 : 0);
      }
    });
    listen(state, state.compoundSelect, 'change', () => loadMsi(state));

    const footer = el('footer', 'roi-media-footer'); state.status = el('span', 'roi-media-status'); state.status.setAttribute('role', 'status'); state.status.setAttribute('aria-live', 'polite');
    const handle = button('◢', 'ウィンドウのサイズ変更。矢印キーでも変更できます。'); handle.classList.add('roi-media-resize'); footer.append(state.status, handle); win.appendChild(footer);
    const addInput = el('input'), replaceInput = el('input'); state.addInput = addInput; state.replaceInput = replaceInput;
    [addInput, replaceInput].forEach(input => { input.type = 'file'; input.accept = '.png,.jpg,.jpeg,.tif,.tiff,image/png,image/jpeg,image/tiff'; input.hidden = true; win.appendChild(input); }); addInput.multiple = true;
    listen(state, state.add, 'click', () => { if (allowDiscard(state)) addInput.click(); });
    listen(state, addInput, 'change', () => {
      const files = Array.from(addInput.files || []), sectionId = state.sectionId; addInput.value = '';
      if (files.length) mutate(state, () => state.adapter.add(state.project, state.roi, sectionId, files), '画像を登録しました。');
    });
    listen(state, replaceInput, 'change', () => {
      const file = replaceInput.files && replaceInput.files[0], item = selected(state), sectionId = state.sectionId; replaceInput.value = '';
      if (file && item) mutate(state, () => state.adapter.replace(state.project, state.roi, sectionId, item, file), '画像を差し替えました。', item.id);
    });
    listen(state, state.sectionSelect, 'change', () => changeSection(state, state.sectionSelect.value, false));
    listen(state, closeButton, 'click', () => { if (allowDiscard(state)) close(); });
    // Event isolation is scoped to the floating window. The main viewer remains
    // interactive, but Enter/Escape/arrows inside this window cannot edit its ROI.
    ['keydown', 'keyup', 'keypress'].forEach(name => listen(state, win, name, event => {
      event.stopPropagation();
      if (name === 'keydown' && event.key === 'Escape') { event.preventDefault(); if (allowDiscard(state)) close(); }
    }));
    ['pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu', 'wheel'].forEach(name => listen(state, win, name, event => event.stopPropagation()));
    root.document.body.appendChild(win);
    const width = Math.min(1120, (root.innerWidth || 1200) - 32), height = Math.min(760, (root.innerHeight || 800) - 32);
    boundWindow(state, {width, height, x: ((root.innerWidth || 1200) - width) / 2, y: ((root.innerHeight || 800) - height) / 2});
    wireWindowPosition(state, header, handle);
    if (typeof root.ResizeObserver === 'function') {
      const observer = new root.ResizeObserver(() => { if (current(state)) { state.photoPane.render(); state.msiRenderer.resize(); } });
      observer.observe(photoViewport); state.cleanups.push(() => observer.disconnect());
    }
    listen(state, root, 'resize', () => { if (current(state)) { boundWindow(state); state.photoPane.render(); state.msiRenderer.resize(); } });
    win.focus({preventScroll: true});
  }

  async function refresh(options) {
    const state = active;
    if (!state) return;
    if (options && options.project && options.project !== state.project) { close({restoreFocus: false}); return; }
    if (options && options.roi) state.roi = options.roi;
    if (!current(state)) { close({restoreFocus: false}); return; }
    const generation = ++state.contextGeneration;
    try {
      const sections = await state.adapter.sections(state.project, state.roi);
      if (!current(state) || generation !== state.contextGeneration) return;
      state.sections = Array.isArray(sections) ? sections : [];
      state.title.textContent = `${state.roi.name || 'ROI'} · 顕微鏡写真 / MSI`;
      state.sectionSelect.replaceChildren(...state.sections.map(section => option(section.id, section.name || section.id)));
      const keep = state.sections.some(section => text(section.id) === state.sectionId);
      const section = keep ? state.sectionId : state.sections[0] && text(state.sections[0].id) || '';
      state.sectionSelect.value = section;
      if (!section) {
        state.sectionId = ''; ++state.photoGeneration; ++state.msiGeneration; ++state.thumbnailGeneration; ++state.compoundGeneration;
        state.items = []; state.photoId = ''; releasePhoto(state); renderThumbnails(state); populateFields(state, null);
        if (state.adapter.selectPhoto) state.adapter.selectPhoto(state.project, state.roi, '', null);
        state.msiRenderer.setFrame(null); state.photoMessage.hidden = false; state.photoMessage.textContent = '対象切片にROIがありません。';
        state.msiMessage.hidden = false; state.msiMessage.textContent = '対象切片にROIがありません。';
        updateControls(state); return;
      }
      if (!keep) await changeSection(state, section, true);
      else await refreshPhotos(state, null, true);
      updateControls(state);
    } catch (error) { setStatus(state, error && error.message || '比較画面を更新できませんでした。', true); }
  }

  function close(options) {
    const state = active; if (!state) return;
    active = null; state.closed = true;
    ++state.photoGeneration; ++state.thumbnailGeneration; ++state.msiGeneration; ++state.listGeneration; ++state.contextGeneration;
    state.cleanups.splice(0).forEach(cleanup => { try { cleanup(); } catch (_) { /* teardown is best effort */ } });
    releasePhoto(state); disposeResult(state.msiFrame);
    if (state.msiRenderer) state.msiRenderer.destroy();
    if (state.window) state.window.remove();
    if ((!options || options.restoreFocus !== false) && state.focusReturn && state.focusReturn.isConnected && typeof state.focusReturn.focus === 'function') state.focusReturn.focus({preventScroll: true});
  }

  function open(options) {
    if (!options || !options.project || !options.roi || !options.adapter) throw new Error('ROI比較画面の設定が不足しています。');
    if (active && active.project === options.project && active.roi === options.roi) { active.window.focus({preventScroll: true}); refresh(); return true; }
    if (active && !allowDiscard(active)) return false;
    close({restoreFocus: false});
    const state = {
      ...options, focusReturn: root.document.activeElement, cleanups: [], closed: false, busy: false,
      sections: [], items: [], sectionId: '', photoId: '', dirty: false,
      photoGeneration: 0, thumbnailGeneration: 0, msiGeneration: 0, listGeneration: 0, compoundGeneration: 0, contextGeneration: 0,
      thumbnailButtons: [], thumbnailCanvases: new Map()
    };
    active = state;
    try { mount(state); refresh(); }
    catch (error) { close(); throw error; }
    return true;
  }

  function syncContext(project, roi) {
    if (!active) return;
    if (project !== active.project || !current(active)) { close({restoreFocus: false}); return; }
    if (roi && (roi === active.roi || roi.id === active.roi.id)) active.roi = roi;
    refresh();
  }

  function requestClose(options) {
    if (active && !allowDiscard(active)) return false;
    close(options); return true;
  }

  return Object.freeze({open, close, requestClose, refresh, syncContext, isOpen: () => !!active,
    hasUnsavedChanges: () => !!(active && !active.closed && active.dirty), photoFit, photoScaleBar, metadataPatch});
});
