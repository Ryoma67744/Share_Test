(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RoiMediaModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Coordinates are snapshots of the ROI's measurement frame. None of the
  // operations below edits the ROI or interprets a microscope objective as a
  // pixel calibration. A registry is always returned as a detached JSON value.
  const VERSION = 1;
  const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);
  const get = (value, key) => own(value, key) ? value[key] : undefined;
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const metadataFields = ['title', 'kind', 'magnification', 'capturedAt', 'note', 'umPerPixel', 'order'];
  const fileFields = ['blobId', 'storagePath', 'mime', 'filename', 'width', 'height', 'byteSize'];

  class RoiMediaError extends Error {
    constructor(code, message) { super(message); this.name = 'RoiMediaError'; this.code = code; }
  }
  function fail(code, message) { throw new RoiMediaError(code, message); }
  function text(value, label, required = false, limit = 32768) {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string' || value.length > limit || /\u0000/.test(value)
      || (required && !value.trim())) fail('invalid-item', label + ' is invalid');
    return value;
  }
  function integer(value, label, minimum, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < minimum) fail('invalid-item', label + ' is invalid');
    return value;
  }
  // Clone only own JSON fields. Defining properties explicitly means even a
  // malicious __proto__ key can never invoke Object.prototype's setter.
  function clone(value, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value)) fail('invalid-item', 'Invalid JSON metadata');
    ancestors.add(value);
    let result;
    if (Array.isArray(value)) result = value.map(entry => clone(entry, ancestors));
    else {
      result = {};
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) continue;
        Object.defineProperty(result, key, { value: clone(value[key], ancestors), enumerable: true,
          configurable: true, writable: true });
      }
    }
    ancestors.delete(value);
    return result;
  }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  function normalizeSnapshot(value) {
    if (!plain(value) || !Array.isArray(get(value, 'vertices')) || value.vertices.length < 3)
      fail('invalid-item', 'An ROI snapshot with at least three vertices is required');
    const vertices = Array.from(value.vertices, point => {
      if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))
        fail('invalid-item', 'ROI snapshot coordinates are invalid');
      return [point[0], point[1]];
    });
    const geometry = get(value, 'geometry');
    if (geometry !== undefined && geometry !== null && !plain(geometry)) fail('invalid-item', 'ROI geometry is invalid');
    return { vertices, geometry: geometry == null ? null : clone(geometry) };
  }
  function normalizeCalibration(value) {
    if (value === undefined || value === null) return null;
    if (!plain(value) || !Number.isFinite(get(value, 'x')) || !(value.x > 0)
      || !Number.isFinite(get(value, 'y')) || !(value.y > 0)) fail('invalid-item', 'Image calibration must contain positive x and y values');
    return { x: value.x, y: value.y };
  }
  function validStoragePath(value) {
    if (/[:?#\\\u0000-\u001f\u007f]/.test(value) || value.startsWith('/')) return false;
    return value.split('/').every(segment => {
      let decoded;
      try { decoded = decodeURIComponent(segment); } catch (_) { return false; }
      return decoded !== '.' && decoded !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(decoded);
    });
  }
  function normalizeItem(value) {
    if (!plain(value)) fail('invalid-item', 'ROI image metadata is invalid');
    const roiSnapshot = normalizeSnapshot(get(value, 'roiSnapshot'));
    const sourceRef = text(get(value, 'sourceRef'), 'sourceRef');
    const geometrySource = roiSnapshot.geometry && get(roiSnapshot.geometry, 'sourceRef');
    if (geometrySource && geometrySource !== sourceRef) fail('invalid-item', 'ROI image and snapshot source references differ');
    let mime = text(get(value, 'mime'), 'mime', true, 128).toLowerCase();
    if (mime === 'image/jpg') mime = 'image/jpeg';
    if (mime === 'image/tif' || mime === 'image/x-tiff') mime = 'image/tiff';
    if (!['image/png', 'image/jpeg', 'image/tiff'].includes(mime)) fail('invalid-item', 'Unsupported ROI image format');
    const item = {
      id: text(get(value, 'id'), 'id', true, 512),
      roiKey: text(get(value, 'roiKey'), 'roiKey', true, 1024),
      sectionId: text(get(value, 'sectionId'), 'sectionId', true, 512),
      sourceRef, roiSnapshot,
      mime,
      filename: text(get(value, 'filename'), 'filename', true, 1024),
      width: integer(get(value, 'width'), 'width', 1), height: integer(get(value, 'height'), 'height', 1),
      title: text(get(value, 'title'), 'title', false, 1024),
      kind: text(get(value, 'kind'), 'kind', false, 128),
      magnification: text(get(value, 'magnification'), 'magnification', false, 128),
      capturedAt: text(get(value, 'capturedAt'), 'capturedAt', false, 128),
      note: text(get(value, 'note'), 'note', false, 32768),
      umPerPixel: normalizeCalibration(get(value, 'umPerPixel')),
      order: integer(get(value, 'order'), 'order', 0, 0), isPrimary: get(value, 'isPrimary') === true,
      createdAt: text(get(value, 'createdAt'), 'createdAt', false, 128),
      updatedAt: text(get(value, 'updatedAt'), 'updatedAt', false, 128),
      revision: integer(get(value, 'revision'), 'revision', 1, 1),
    };
    if (get(value, 'byteSize') !== undefined) item.byteSize = integer(value.byteSize, 'byteSize', 1);
    const blobId = text(get(value, 'blobId'), 'blobId', false, 1024);
    const storagePath = text(get(value, 'storagePath'), 'storagePath', false, 4096);
    if (blobId) item.blobId = blobId;
    if (storagePath) {
      if (!validStoragePath(storagePath))
        fail('invalid-item', 'ROI image storage path is invalid');
      item.storagePath = storagePath;
    }
    if (!item.blobId && !item.storagePath) fail('invalid-item', 'ROI image has no stored file reference');
    return item;
  }
  const targetKey = (key, sectionId) => JSON.stringify([key, sectionId]);
  const sameTarget = (a, b) => a.roiKey === b.roiKey && a.sectionId === b.sectionId;
  const orderCompare = (a, b) => a.order - b.order || a.id.localeCompare(b.id);
  function ensurePrimaries(items) {
    const groups = new Map();
    for (const item of items) {
      const key = targetKey(item.roiKey, item.sectionId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const group of groups.values()) {
      const ordered = group.slice().sort(orderCompare);
      const primary = ordered.find(item => item.isPrimary) || ordered[0];
      for (const item of group) item.isPrimary = item === primary;
    }
    return items;
  }
  function normalizeRegistry(value) {
    if (value === undefined || value === null) return { version: VERSION, items: [] };
    if (!plain(value)) fail('invalid-registry', 'ROI image registry is invalid');
    if (get(value, 'version') !== VERSION) fail('unsupported-version', 'This ROI image registry version is not supported');
    if (!Array.isArray(get(value, 'items'))) fail('invalid-registry', 'ROI image items must be an array');
    const ids = new Set();
    const items = Array.from(value.items, item => {
      const normalized = normalizeItem(item);
      if (ids.has(normalized.id)) fail('invalid-registry', 'Duplicate ROI image ID');
      ids.add(normalized.id);
      return normalized;
    });
    return { version: VERSION, items: ensurePrimaries(items) };
  }
  function getRegistry(project) { return normalizeRegistry(get(get(project, 'meta'), 'roiMedia')); }
  function allItems(project) { return getRegistry(project).items; }
  function roiKey(roi) { return text(typeof roi === 'string' ? roi : get(roi, 'colorKey'), 'roiKey', true, 1024); }
  function sectionKey(project, section) {
    if (typeof section === 'string') return text(section, 'sectionId', true, 512);
    const clientId = get(get(section, 'meta'), 'client_id');
    const shared = !!get(project, '__share');
    return text(shared && clientId ? clientId : get(section, 'id'), 'sectionId', true, 512);
  }
  function list(project, roi, section) {
    const key = roiKey(roi), sectionId = section == null ? null : sectionKey(project, section);
    return allItems(project).filter(item => item.roiKey === key && (sectionId === null || item.sectionId === sectionId))
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || orderCompare(a, b));
  }
  function collectBlobIds(project) { return new Set(allItems(project).map(item => item.blobId).filter(Boolean)); }
  function snapshot(roi, section) {
    const id = typeof section === 'string' ? section : get(section, 'id');
    const vertices = get(get(roi, 'polysBySection'), id);
    const geometry = get(get(roi, 'geometryBySection'), id)
      || get(get(get(section, 'meta'), 'roiGeometryByColorKey'), roiKey(roi)) || null;
    return normalizeSnapshot({ vertices, geometry });
  }
  function snapshotMatches(item, roi, section) {
    try {
      const sectionIds = typeof section === 'string' ? [section] : [get(section, 'id'), get(get(section, 'meta'), 'client_id')];
      if (item.roiKey !== roiKey(roi) || !sectionIds.includes(item.sectionId)) return false;
      return canonical(normalizeSnapshot(item.roiSnapshot)) === canonical(snapshot(roi, section));
    } catch (_) { return false; }
  }
  function findItem(registry, id) {
    const item = registry.items.find(entry => entry.id === id);
    if (!item) fail('missing-item', 'The ROI image no longer exists');
    return item;
  }
  function add(value, input) {
    const registry = normalizeRegistry(value), item = normalizeItem(input);
    if (registry.items.some(entry => entry.id === item.id)) fail('duplicate-item', 'The ROI image ID already exists');
    if (!own(input, 'order')) item.order = registry.items.filter(entry => sameTarget(entry, item)).reduce((max, entry) => Math.max(max, entry.order + 1), 0);
    if (item.isPrimary) for (const entry of registry.items) if (sameTarget(entry, item)) entry.isPrimary = false;
    registry.items.push(item);
    ensurePrimaries(registry.items);
    return registry;
  }
  function applyPatch(value, id, patch, replacement) {
    const registry = normalizeRegistry(value), previous = findItem(registry, id);
    if (!plain(patch)) fail('invalid-item', 'ROI image changes are invalid');
    const next = clone(previous);
    if (replacement) {
      // References identify a binary revision. Never accidentally retain the
      // former remote file alongside a newly uploaded local replacement.
      delete next.blobId;
      delete next.storagePath;
      delete next.byteSize;
    }
    for (const key of metadataFields.concat(replacement ? fileFields.concat(['sourceRef', 'roiSnapshot']) : []))
      if (own(patch, key) && patch[key] !== undefined) next[key] = clone(patch[key]);
    if (own(patch, 'updatedAt')) next.updatedAt = patch.updatedAt;
    next.revision = previous.revision + 1;
    const normalized = normalizeItem(next);
    registry.items[registry.items.indexOf(previous)] = normalized;
    ensurePrimaries(registry.items);
    return registry;
  }
  const update = (value, id, patch) => applyPatch(value, id, patch, false);
  const replace = (value, id, patch) => applyPatch(value, id, patch, true);
  function remove(value, id) {
    const registry = normalizeRegistry(value);
    findItem(registry, id);
    registry.items = registry.items.filter(item => item.id !== id);
    ensurePrimaries(registry.items);
    return registry;
  }
  function makePrimary(value, id) {
    const registry = normalizeRegistry(value), primary = findItem(registry, id);
    for (const item of registry.items) if (sameTarget(primary, item)) item.isPrimary = item.id === id;
    return registry;
  }
  function removeRoi(value, key) {
    const registry = normalizeRegistry(value), logicalKey = roiKey(key);
    registry.items = registry.items.filter(item => item.roiKey !== logicalKey);
    return registry;
  }
  function removeSection(value, sectionId) {
    const registry = normalizeRegistry(value);
    registry.items = registry.items.filter(item => item.sectionId !== sectionId);
    return registry;
  }
  function remapSections(value, idMap) {
    const registry = normalizeRegistry(value);
    for (const item of registry.items) {
      const mapped = idMap instanceof Map ? idMap.get(item.sectionId) : get(idMap, item.sectionId);
      if (mapped === undefined || mapped === null) fail('unmapped-section', 'No destination for ROI image section: ' + item.sectionId);
      item.sectionId = text(mapped, 'sectionId', true, 512);
    }
    ensurePrimaries(registry.items);
    return registry;
  }
  return Object.freeze({ VERSION, RoiMediaError, normalizeRegistry, normalizeItem, getRegistry, allItems,
    roiKey, sectionKey, targetKey, list, collectBlobIds, snapshot, snapshotMatches,
    add, replace, update, remove, makePrimary, removeRoi, removeSection, remapSections });
});
