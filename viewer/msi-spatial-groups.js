/* Exact MSI coordinate groups. Source identity is never replaced by geometry. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MsiSpatialGroups = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const VERSION = 1;
    const FRAME = 'msi-exact-coordinate-frame-v1';
    const copy = value => JSON.parse(JSON.stringify(value));
    const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const text = value => typeof value === 'string' && value.length > 0;
    const dimension = value => Number.isSafeInteger(value) && value > 0;
    const sectionKey = section => {
        const value = section && ((section.meta && section.meta.client_id) || section.id);
        return text(value) ? value : null;
    };

    function validAxis(pairs, size) {
        if (!Array.isArray(pairs) || !pairs.length) return false;
        let previousRaw = -Infinity, previousIndex = -Infinity;
        for (const pair of pairs) {
            if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite)
                || pair[0] <= previousRaw || !Number.isSafeInteger(pair[1])
                || pair[1] < previousIndex || pair[1] < 0 || pair[1] >= size) return false;
            previousRaw = pair[0]; previousIndex = pair[1];
        }
        return pairs[0][1] === 0 && pairs[pairs.length - 1][1] === size - 1;
    }

    // Include the complete acquisition-to-legacy-pixel mapping and the display
    // map. A matching pitch/size alone cannot prove that two images coincide.
    // Intensity, row order and missing signal do not define a coordinate frame.
    function geometryKey(geometry) {
        if (!object(geometry)) return null;
        const old = geometry.legacy, display = geometry.displayGeometry;
        if (!object(old) || (old.confirmed !== true && geometry.currentConfirmed !== true)
            || !dimension(old.W) || !dimension(old.H)
            || !validAxis(old.x, old.W) || !validAxis(old.y, old.H)
            || !object(display) || display.version !== 'msi-proportional-v1'
            || !dimension(display.W) || !dimension(display.H)) return null;
        for (const axis of ['x', 'y']) {
            const value = display[axis];
            if (!object(value) || !Number.isFinite(value.origin)
                || !Number.isFinite(value.step) || value.step <= 0
                || value.origin !== old[axis][0][0]) return null;
        }
        return JSON.stringify([FRAME, old.W, old.H, old.x, old.y,
            display.version, display.W, display.H,
            display.x.origin, display.x.step, display.y.origin, display.y.step]);
    }

    function sourceReference(entry) {
        if (!object(entry)) return null;
        if (text(entry.sourceReference)) return entry.sourceReference;
        const identity = entry.sourceFileId || entry.blobId || entry.sourceUrl || '';
        if (!text(identity)) return null;
        return JSON.stringify([identity, entry.kind || '', entry.sheet || '', entry.func || 1,
            entry.annotation || '', entry.sourceHash || entry.sourceRevision || '']);
    }

    // Read current reader settings independently of a frozen transport reference.
    // Molecule/intensity columns are excluded; X/Y, sheet/function and section
    // selectors are included. A source replacement never inherits by size alone.
    function memberKey(entry) {
        const source = sourceReference(entry);
        if (!source) return null;
        const kind = entry.kind || 'xlsx';
        return JSON.stringify(['msi-spatial-member-v1', source, entry.sourceFileId || '',
            entry.sourceHash || entry.sourceRevision || '', kind,
            entry.sheet || '', entry.func || 1,
            entry.col_x || entry.x || '', entry.col_y || entry.y || '', entry.data_start_row || 1,
            entry.dataStartLine == null ? null : entry.dataStartLine,
            kind === 'parquet' ? (entry.annotation == null ? '' : entry.annotation) : null,
            kind === 'raw' ? entry.snap !== false : null,
            kind === 'txt' || kind === 'txt-analyte'
                ? (kind === 'txt-analyte' || Number.isFinite(entry.compound_index) || Number.isFinite(entry.v_index)) : null]);
    }

    function validFrameKey(value) {
        if (!text(value)) return false;
        try {
            const values = JSON.parse(value);
            if (!Array.isArray(values) || values.length !== 12 || values[0] !== FRAME) return false;
            const reconstructed = {legacy: {confirmed: true, W: values[1], H: values[2], x: values[3], y: values[4]},
                displayGeometry: {version: values[5], W: values[6], H: values[7],
                    x: {origin: values[8], step: values[9]}, y: {origin: values[10], step: values[11]}}};
            return geometryKey(reconstructed) === value;
        } catch (_) { return false; }
    }

    function registry(section) {
        const value = section && section.meta && section.meta.spatialGroups;
        if (!object(value) || value.version !== VERSION || !Array.isArray(value.groups)
            || !Number.isSafeInteger(value.nextId) || value.nextId < 1) return null;
        const ids = new Set(), frames = new Set();
        for (const group of value.groups) {
            if (!object(group) || !text(group.id) || ids.has(group.id)
                || group.frameVersion !== VERSION || !validFrameKey(group.frameKey)
                || frames.has(group.frameKey) || !Array.isArray(group.members)) return null;
            ids.add(group.id); frames.add(group.frameKey);
            const members = new Set();
            for (const member of group.members) {
                if (!object(member) || !text(member.key) || !text(member.sourceRef) || members.has(member.key)) return null;
                members.add(member.key);
            }
        }
        return value;
    }

    function descriptor(section, group, key) {
        return {groupId: group.id, frameKey: group.frameKey, frameVersion: group.frameVersion,
            memberKey: key, sectionKey: sectionKey(section), memberCount: group.members.length};
    }

    function input(section, entry, geometry) {
        const frameKey = geometryKey(geometry), key = memberKey(entry), sourceRef = sourceReference(entry);
        if (!sectionKey(section) || !frameKey || !key || !geometry || geometry.sourceRef !== sourceRef) return null;
        return {frameKey, key, sourceRef};
    }

    function ensureGroup(section, entry, geometry) {
        const candidate = input(section, entry, geometry);
        if (!candidate) return null;
        const existing = section.meta && section.meta.spatialGroups;
        let value = registry(section);
        // Unknown or malformed saved state is preserved, never silently reset.
        if (existing != null && !value) return null;
        if (!value) value = {version: VERSION, nextId: 1, groups: []};
        let group = value.groups.find(item => item.frameKey === candidate.frameKey);
        if (!group) {
            if (value.nextId >= Number.MAX_SAFE_INTEGER) return null;
            let id;
            do { id = 'spatial:' + encodeURIComponent(sectionKey(section)) + ':' + value.nextId++; }
            while (value.groups.some(item => item.id === id) && value.nextId < Number.MAX_SAFE_INTEGER);
            if (value.groups.some(item => item.id === id)) return null;
            group = {id, frameVersion: VERSION, frameKey: candidate.frameKey, members: []};
            value.groups.push(group);
        }
        if (!group.members.some(member => member.key === candidate.key)) {
            group.members.push({key: candidate.key, sourceRef: candidate.sourceRef,
                sourceFileId: entry.sourceFileId || null, kind: entry.kind || 'xlsx'});
        }
        section.meta = section.meta || {};
        section.meta.spatialGroups = value;
        return descriptor(section, group, candidate.key);
    }

    function resolveMembership(section, entry, geometry, groupId, frameKey) {
        const candidate = input(section, entry, geometry), value = registry(section);
        if (!candidate || !value || (frameKey != null && frameKey !== candidate.frameKey)) return null;
        const group = value.groups.find(item => item.frameKey === candidate.frameKey
            && (groupId == null || item.id === groupId)
            && item.members.some(member => member.key === candidate.key && member.sourceRef === candidate.sourceRef));
        return group ? descriptor(section, group, candidate.key) : null;
    }

    function roiMeta(section, entry, geometry) {
        const membership = ensureGroup(section, entry, geometry);
        if (!membership) return null;
        return {version: 'msi-group-v1', scope: 'group', groupId: membership.groupId,
            frameKey: membership.frameKey, frameVersion: membership.frameVersion,
            sectionId: membership.sectionKey, sourceRef: geometry.sourceRef,
            displayGeometry: copy(geometry.displayGeometry), createdQuantVersion: 'msi-source-rows-v1'};
    }

    function roiCompatible(meta, geometry, section, entry) {
        if (!object(meta) || meta.version !== 'msi-group-v1' || meta.scope !== 'group'
            || meta.frameVersion !== VERSION || !text(meta.groupId) || !text(meta.sourceRef)
            || !validFrameKey(meta.frameKey)
            || meta.sectionId !== sectionKey(section) || !object(meta.displayGeometry)) return false;
        const resolved = resolveMembership(section, entry, geometry, meta.groupId, meta.frameKey);
        if (!resolved) return false;
        // A valid current group must not give corrupted saved vertices a new map.
        const saved = meta.displayGeometry, current = geometry.displayGeometry;
        return saved.version === current.version && saved.W === current.W && saved.H === current.H
            && object(saved.x) && object(saved.y) && saved.x.origin === current.x.origin
            && saved.x.step === current.x.step && saved.y.origin === current.y.origin && saved.y.step === current.y.step;
    }

    return Object.freeze({VERSION, FRAME, sectionKey, sourceReference, geometryKey, memberKey,
        ensureGroup, resolveMembership, roiMeta, roiCompatible});
});
