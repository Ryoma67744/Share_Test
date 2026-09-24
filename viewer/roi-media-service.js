(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RoiMediaService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;
  const DEFAULT_MAX_PIXELS = 64 * 1024 * 1024;
  const DEFAULT_MAX_DIMENSION = 16384;
  const metadataFields = ['title', 'kind', 'magnification', 'capturedAt', 'note', 'umPerPixel', 'order'];
  const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);
  class RoiMediaServiceError extends Error {
    constructor(code, message) { super(message); this.name = 'RoiMediaServiceError'; this.code = code; }
  }
  function fail(code, message) { throw new RoiMediaServiceError(code, message); }
  function metadata(value) {
    const result = {};
    for (const key of metadataFields) if (own(value, key) && value[key] !== undefined) {
      result[key] = JSON.parse(JSON.stringify(value[key]));
    }
    return result;
  }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function fileMime(file, maxBytes) {
    if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size) || file.size < 1)
      fail('invalid-file', '画像ファイルを選択してください。');
    if (file.size > maxBytes) fail('file-too-large', '画像の容量が登録上限を超えています。');
    const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.length >= 4 && ((bytes[0] === 73 && bytes[1] === 73 && (bytes[2] === 42 || bytes[2] === 43) && bytes[3] === 0)
      || (bytes[0] === 77 && bytes[1] === 77 && bytes[2] === 0 && (bytes[3] === 42 || bytes[3] === 43)))) return 'image/tiff';
    fail('unsupported-file', 'PNG・JPEG・単一画像のTIFFを選択してください。');
  }

  function create(options) {
    const config = options || {}, model = config.model, storage = config.storage;
    if (!model || !storage || typeof storage.putBlob !== 'function' || typeof config.save !== 'function'
      || typeof config.decode !== 'function') throw new TypeError('ROI image service requires model, storage, save and decode');
    const queues = new WeakMap(), busy = new WeakMap();
    const maxBytes = config.maxBytes || DEFAULT_MAX_BYTES;
    const maxPixels = config.maxPixels || DEFAULT_MAX_PIXELS;
    const maxDimension = config.maxDimension || DEFAULT_MAX_DIMENSION;
    const uid = config.uid || (() => globalThis.crypto.randomUUID());
    const time = () => {
      const value = config.now ? config.now() : new Date();
      return value instanceof Date ? value.toISOString() : String(value);
    };
    const source = (project, roi, section) => {
      const value = config.sourceRef ? config.sourceRef(project, roi, section)
        : ((model.snapshot(roi, section).geometry || {}).sourceRef || '');
      if (typeof value !== 'string') fail('invalid-source', 'ROIの測定ソースを確認できません。');
      return value;
    };
    function validateTarget(project, roi, section) {
      if (!project || typeof project !== 'object' || project.__share || !roi || roi._collab)
        fail('read-only', 'この画面ではROI画像を編集できません。');
      if (!(project.rois || []).includes(roi) || !(project.sections || []).includes(section))
        fail('stale-target', '対象のROIまたは切片が変更されました。開き直してください。');
      if (config.isCurrent && !config.isCurrent(project, roi, section))
        fail('stale-target', '対象が切り替わったため登録を中止しました。');
      return model.snapshot(roi, section); // Also validates finite measurement coordinates.
    }
    function capture(project, roi, section, itemOrId) {
      const snapshot = validateTarget(project, roi, section);
      const context = { project, roi, section, roiKey: model.roiKey(roi), sectionId: model.sectionKey(project, section),
        snapshot, fingerprint: canonical(snapshot), sourceRef: source(project, roi, section) };
      if (itemOrId !== undefined) {
        const id = typeof itemOrId === 'string' ? itemOrId : itemOrId && itemOrId.id;
        const current = model.list(project, roi, section).find(item => item.id === id);
        if (!current) fail('missing-item', 'このROI画像は削除または変更されています。');
        if (typeof itemOrId === 'object' && itemOrId && itemOrId.revision !== current.revision)
          fail('revision-conflict', '画像情報が更新されています。開き直してから操作してください。');
        context.itemId = id;
        context.itemFingerprint = canonical(current);
      }
      return context;
    }
    function assertTarget(context) {
      const { project, roi, section } = context;
      const snapshot = validateTarget(project, roi, section);
      if (canonical(snapshot) !== context.fingerprint || model.roiKey(roi) !== context.roiKey
        || model.sectionKey(project, section) !== context.sectionId || source(project, roi, section) !== context.sourceRef)
        fail('geometry-changed', '処理中にROIまたは測定ソースが変更されました。確認してから再登録してください。');
      if (context.itemId) {
        const current = model.list(project, roi, section).find(item => item.id === context.itemId);
        if (!current || canonical(current) !== context.itemFingerprint)
          fail('revision-conflict', '処理中に画像情報が更新されました。開き直してから操作してください。');
      }
    }
    function enqueue(project, job) {
      busy.set(project, (busy.get(project) || 0) + 1);
      const before = queues.get(project) || Promise.resolve();
      const result = before.then(job);
      const settled = result.then(() => undefined, () => undefined).then(() => {
        busy.set(project, Math.max(0, (busy.get(project) || 1) - 1));
        if (queues.get(project) === settled) queues.delete(project);
      });
      queues.set(project, settled);
      return result;
    }
    async function decodeFile(file) {
      const mime = await fileMime(file, maxBytes);
      let decoded;
      try {
        // The application decoder additionally checks the encoded dimensions
        // before allocating a full bitmap (particularly important for TIFF).
        decoded = await config.decode(file, mime, { maxPixels, maxDimension, maxBytes });
        const width = decoded && decoded.width, height = decoded && decoded.height;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
          fail('invalid-dimensions', '画像の寸法を読み取れませんでした。');
        if (width > maxDimension || height > maxDimension || width * height > maxPixels)
          fail('image-too-large', '画像の寸法が表示可能な上限を超えています。');
        if ((decoded.pages && decoded.pages !== 1) || decoded.multiPage === true)
          fail('multi-page-image', '多ページ画像は、必要な1枚をPNGまたは単一画像のTIFFとして保存して登録してください。');
        const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/tiff' ? 'tif' : 'png';
        return { file, mime, width, height, byteSize: file.size, filename: String(file.name || ('image.' + extension)) };
      } finally {
        if (decoded && typeof decoded.dispose === 'function') decoded.dispose();
        else if (decoded && decoded.image && typeof decoded.image.close === 'function') decoded.image.close();
      }
    }
    async function newBlobId() {
      for (let attempt = 0; attempt < 4; attempt++) {
        const id = 'roi-photo-' + String(uid());
        if (!storage.getBlob || !(await storage.getBlob(id))) return id;
      }
      fail('duplicate-file', '画像の保存先IDが重複しました。再度登録してください。');
    }
    async function storeFile(decoded) {
      const blobId = await newBlobId();
      await storage.putBlob({ id: blobId, blob: decoded.file, mime: decoded.mime, filename: decoded.filename });
      return { blobId, mime: decoded.mime, filename: decoded.filename, width: decoded.width,
        height: decoded.height, byteSize: decoded.byteSize };
    }
    async function commit(context, previous, next) {
      assertTarget(context);
      const project = context.project;
      if (canonical(model.getRegistry(project)) !== canonical(previous))
        fail('registry-conflict', '処理中にROI画像の登録情報が更新されました。再度操作してください。');
      if (!project.meta) project.meta = {};
      const existed = own(project.meta, 'roiMedia'), original = project.meta.roiMedia;
      const nextFingerprint = canonical(next);
      project.meta.roiMedia = next;
      try {
        if (await config.save(project, next) === false)
          fail('save-failed', '画像の登録情報を保存できませんでした。以前の登録を維持しました。');
        if (canonical(model.getRegistry(project)) !== nextFingerprint)
          fail('registry-conflict', '保存中に登録情報が更新されました。表示を開き直して確認してください。');
      } catch (error) {
        // Only roll back our own registry. Preserve unrelated project metadata
        // and any newer registry mutation performed outside this service.
        if (project.meta.roiMedia === next && canonical(project.meta.roiMedia) === nextFingerprint) {
          if (existed) project.meta.roiMedia = original;
          else delete project.meta.roiMedia;
          // A verification read can fail after the database write succeeded.
          // The host must mark this rollback as a new save revision as well;
          // otherwise a later project switch may consider the database clean
          // and resurrect the rejected change on reload. Keep the original
          // failure even if persisting the rollback also fails (e.g. quota).
          if (config.onRollback) {
            try { await config.onRollback(project, model.getRegistry(project), error); }
            catch (_) { /* Host retains its dirty revision for a later retry. */ }
          }
        }
        throw error;
      }
      // Originals are never eagerly deleted: even a failed read-back may have
      // committed them. The existing cross-project orphan collector reclaims
      // unreferenced blobs once persistence is known, preserving old photos.
      if (config.onChange) {
        try { config.onChange(project, next); } catch (_) { /* A committed save remains successful. */ }
      }
      return next;
    }
    async function add(project, roi, section, files, info) {
      const context = capture(project, roi, section);
      const selected = Array.from(files || []), patch = metadata(info);
      if (!selected.length) fail('missing-file', '登録する画像を選択してください。');
      return enqueue(project, async () => {
        assertTarget(context);
        const previous = model.getRegistry(project), ids = [];
        let next = previous;
        // One registry commit for the whole batch. A failure leaves no partial
        // photo list, and never changes scientific ROI geometry or statistics.
        for (const file of selected) {
          const decoded = await decodeFile(file);
          assertTarget(context);
          const record = await storeFile(decoded), stamp = time(), id = 'roi-media-' + String(uid());
          next = model.add(next, Object.assign({}, patch, record, { id, roiKey: context.roiKey,
            sectionId: context.sectionId, sourceRef: context.sourceRef, roiSnapshot: context.snapshot,
            title: own(patch, 'title') ? patch.title : decoded.filename,
            createdAt: stamp, updatedAt: stamp, revision: 1 }));
          ids.push(id);
        }
        await commit(context, previous, next);
        return ids.map(id => next.items.find(item => item.id === id));
      });
    }
    async function replace(project, roi, section, itemOrId, file, info) {
      const context = capture(project, roi, section, itemOrId), patch = metadata(info);
      return enqueue(project, async () => {
        assertTarget(context);
        const previous = model.getRegistry(project), decoded = await decodeFile(file);
        assertTarget(context);
        const record = await storeFile(decoded);
        const next = model.replace(previous, context.itemId, Object.assign({}, patch, record,
          { sourceRef: context.sourceRef, roiSnapshot: context.snapshot, updatedAt: time() }));
        await commit(context, previous, next);
        return next.items.find(item => item.id === context.itemId);
      });
    }
    async function edit(operation, project, roi, section, itemOrId, info) {
      const context = capture(project, roi, section, itemOrId), patch = metadata(info);
      return enqueue(project, async () => {
        assertTarget(context);
        const previous = model.getRegistry(project), current = previous.items.find(item => item.id === context.itemId);
        const next = operation === 'update' ? model.update(previous, context.itemId, Object.assign({}, patch, { updatedAt: time() }))
          : model[operation](previous, context.itemId);
        await commit(context, previous, next);
        return next.items.find(item => item.id === context.itemId) || current;
      });
    }
    return Object.freeze({ add, replace,
      update: (project, roi, section, item, patch) => edit('update', project, roi, section, item, patch),
      remove: (project, roi, section, item) => edit('remove', project, roi, section, item),
      makePrimary: (project, roi, section, item) => edit('makePrimary', project, roi, section, item),
      isBusy: project => !!(busy.get(project) || 0),
      idle: project => queues.get(project) || Promise.resolve(),
    });
  }
  return Object.freeze({ create, RoiMediaServiceError, DEFAULT_MAX_BYTES, DEFAULT_MAX_PIXELS, DEFAULT_MAX_DIMENSION });
});
