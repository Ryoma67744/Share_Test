/* Isolated HE/IF -> MSI editing drafts. No DOM, storage, source-row or ROI writes. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MsiAlignmentSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
    const ALIGNMENT_FIELDS = ['flip_lr', 'flip_ud', 'scale_pct', 'rotate_deg', 'offx', 'offy',
        'landmarks', 'autoAligned', 'T', 'alignment_raster_basis'];
    const READER_FIELDS = ['kind', 'sheet', 'sheetName', 'sheetIndex', 'func', 'function',
        'x', 'y', 'xColumn', 'yColumn', 'xCol', 'yCol', 'xLabel', 'yLabel', 'coordinateColumns'];

    // Do not JSON-roundtrip scientific or legacy state: undefined, NaN, and
    // typed-array coordinates must survive a draft/cancel roundtrip unchanged.
    function clone(value, seen) {
        if (!value || typeof value !== 'object') return value;
        const visited = seen || new Map();
        if (visited.has(value)) return visited.get(value);
        if (value instanceof Date) return new Date(value.getTime());
        if (value instanceof ArrayBuffer) return value.slice(0);
        if (ArrayBuffer.isView(value)) {
            const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            return value instanceof DataView ? new DataView(bytes) : new value.constructor(bytes);
        }
        const result = Array.isArray(value) ? [] : {};
        visited.set(value, result);
        for (const key of Object.keys(value)) {
            Object.defineProperty(result, key, {value: clone(value[key], visited),
                enumerable: true, configurable: true, writable: true});
        }
        return result;
    }

    function stableKey(value) {
        if (value === undefined) return 'u';
        if (value === null) return 'null';
        if (typeof value === 'number') {
            if (Number.isNaN(value)) return 'n:NaN';
            if (Object.is(value, -0)) return 'n:-0';
            return 'n:' + String(value);
        }
        if (typeof value === 'string') return 's:' + JSON.stringify(value);
        if (typeof value === 'boolean') return 'b:' + String(value);
        if (typeof value === 'bigint') return 'i:' + String(value);
        if (ArrayBuffer.isView(value)) return value.constructor.name + ':' + stableKey(Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
        if (Array.isArray(value)) return '[' + value.map(stableKey).join(',') + ']';
        if (typeof value === 'object') return '{' + Object.keys(value).sort()
            .map(key => JSON.stringify(key) + ':' + stableKey(value[key])).join(',') + '}';
        throw new TypeError('Alignment state must contain data values only.');
    }

    function pick(value, fields) {
        const result = {};
        for (const key of fields) if (own(value, key)) result[key] = clone(value[key]);
        return result;
    }

    function alignmentState(state) {
        return pick(state, ALIGNMENT_FIELDS);
    }

    // msiSourceReference's historical array includes the intensity annotation
    // at index 4. Only that known format may drop it. Unknown opaque references
    // remain opaque; guessing their coordinate meaning could mix measurements.
    function coordinateSourceReference(reference) {
        let parsed = reference;
        if (typeof reference === 'string') {
            try { parsed = JSON.parse(reference); } catch (_) { return reference; }
        }
        if (Array.isArray(parsed) && parsed.length === 6) {
            return {source: parsed[0], kind: parsed[1], sheet: parsed[2], func: parsed[3], revision: parsed[5]};
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const known = pick(parsed, ['source', 'sourceId', 'sourceFileId', 'id', 'kind',
                'revision', 'sourceRevision', 'sourceHash', 'sheet', 'sheetName', 'sheetIndex',
                'func', 'function', 'x', 'y', 'xColumn', 'yColumn', 'xCol', 'yCol',
                'xLabel', 'yLabel', 'coordinateColumns', 'reader', 'coordinateSignature']);
            if (known.reader) known.reader = pick(known.reader, READER_FIELDS);
            return Object.keys(known).length ? known : clone(parsed);
        }
        return clone(parsed);
    }

    function frameDescriptor(frame) {
        if (typeof frame === 'string') return {opaque: frame};
        const input = frame || {};
        // coordinateSignature is computed by the caller from the coordinate
        // arrangement, not from intensities, row count, or image dimensions.
        const descriptor = {
            basis: input.basis || input.alignment_raster_basis || 'legacy-msi-pixel-edges-v1',
            source: coordinateSourceReference(input.sourceRef != null ? input.sourceRef
                : input.sourceReference != null ? input.sourceReference : input.sourceId),
            revision: input.sourceRevision != null ? input.sourceRevision
                : input.revision != null ? input.revision : input.sourceHash,
            reader: Object.assign(pick(input, READER_FIELDS), pick(input.reader, READER_FIELDS))
        };
        if (input.coordinateSignature != null) descriptor.coordinates = clone(input.coordinateSignature);
        else if (input.coordinates != null) descriptor.coordinates = clone(input.coordinates);
        else if (input.legacy != null) descriptor.coordinates = clone(input.legacy);
        else if (input.geometry != null) descriptor.geometry = clone(input.geometry);
        else if (input.displayGeometry != null) descriptor.geometry = clone(input.displayGeometry);
        if (input.unresolvedKey != null) descriptor.unresolvedKey = clone(input.unresolvedKey);
        return descriptor;
    }

    function frameKey(frame) {
        if (frame && frame.version === 'msi-alignment-frame-v1'
            && typeof frame.key === 'string' && frame.key) return frame.key;
        return 'msi-align-frame-v1:' + stableKey(frameDescriptor(frame));
    }

    function sharedFrameKey(frame) {
        if (frame && frame.version === 'msi-alignment-frame-v1' && frame.confirmed === true
            && typeof frame.coordinateKey === 'string' && frame.coordinateKey) {
            return 'msi-align-shared-frame-v1:' + stableKey({
                basis: frame.basis || 'legacy-msi-pixel-edges-v1', coordinates: frame.coordinateKey});
        }
        const descriptor = frameDescriptor(frame);
        // A shared scope must still have a proved coordinate layout. Without
        // it, keep source identities separate even when widths/heights match.
        if (!frame || frame.confirmed !== true || !own(descriptor, 'coordinates')) return frameKey(frame);
        return 'msi-align-shared-frame-v1:' + stableKey({basis: descriptor.basis, coordinates: descriptor.coordinates});
    }

    function contextKey(context, sectionId) {
        const ctx = context || {};
        const scope = ctx.scope === 'shared' ? 'shared' : 'source';
        return 'msi-align-draft-v1:' + stableKey({section: sectionId,
            layer: ctx.layerKey, image: ctx.imageIdentity != null ? ctx.imageIdentity : ctx.layerKey,
            scope, group: scope === 'shared' ? (ctx.sharedId || '__all__') : null,
            frame: scope === 'shared' ? sharedFrameKey(ctx.frame) : frameKey(ctx.frame)});
    }

    // This helper never converts point coordinates. The caller must prove a
    // legacy bySource record belongs to this coordinate frame before opting in.
    function loadLegacy(layerRecord, options) {
        const layer = layerRecord || {}, opts = options || {};
        let record = null;
        if (opts.scope === 'shared') {
            if (opts.allowShared === true) record = layer;
        } else if (opts.sourceId != null && layer.bySource && own(layer.bySource, opts.sourceId)) {
            if (opts.allowSource === true) record = layer.bySource[opts.sourceId];
        } else if (opts.allowShared === true) record = layer;
        if (!record) return {state: null, unresolvedReason: 'legacy-coordinate-unconfirmed'};
        const basis = record.alignment_raster_basis;
        if (basis && basis !== 'legacy-msi-pixel-edges-v1') {
            return {state: null, unresolvedReason: 'unsupported-alignment-coordinate-basis', preserved: clone(record)};
        }
        if (record.frame && frameKey(record.frame) !== frameKey(opts.frame)) {
            return {state: null, unresolvedReason: 'alignment-source-frame-mismatch', preserved: clone(record)};
        }
        return {state: alignmentState(record), unresolvedReason: null};
    }

    class DraftStore {
        constructor(options) {
            const opts = options || {};
            this.sectionId = opts.sectionId;
            this._initial = clone(opts.initialAlignment || {});
            this._drafts = new Map();
            this._baselines = new Map();
            this._observed = new Map();
            this._forced = new Set();
            this._editCounter = 0;
            this._activeKey = null;
            this.closed = false;
        }
        _assertOpen() {
            if (this.closed) throw new Error('Alignment session is closed.');
        }
        _recordEdit(draft, force) {
            if (!draft) return;
            const signature = stableKey(alignmentState(draft.state));
            // Compare with an independent signature: mutable nested point
            // arrays may already be changed before capture() is called.
            if (force || signature !== this._observed.get(draft.key)) {
                draft.editRevision = ++this._editCounter;
                this._observed.set(draft.key, signature);
            }
            if (force) this._forced.add(draft.key);
        }
        activate(context, seedState, view) {
            this._assertOpen();
            this._recordEdit(this.current());
            const key = contextKey(context, this.sectionId);
            let draft = this._drafts.get(key);
            if (!draft) {
                draft = {key, context: clone(context || {}), frameKey: frameKey(context && context.frame),
                    state: clone(seedState || {}), view: clone(view || {}), editRevision: 0};
                this._drafts.set(key, draft);
                const signature = stableKey(alignmentState(draft.state));
                this._baselines.set(key, signature);
                this._observed.set(key, signature);
            }
            this._activeKey = key;
            return draft;
        }
        current() { return this._drafts.get(this._activeKey) || null; }
        peek(context) { return this._drafts.get(contextKey(context, this.sectionId)) || null; }
        capture(state, view) {
            this._assertOpen();
            const draft = this.current();
            if (!draft) throw new Error('Activate an alignment draft before editing.');
            draft.state = clone(state);
            if (view !== undefined) draft.view = clone(view);
            this._recordEdit(draft);
            return draft;
        }
        update(patch) {
            this._assertOpen();
            const draft = this.current();
            if (!draft) throw new Error('Activate an alignment draft before editing.');
            if (typeof patch === 'function') patch(draft.state);
            else Object.assign(draft.state, clone(patch));
            this._recordEdit(draft);
            return draft;
        }
        forceCommit() {
            this._assertOpen();
            const draft = this.current();
            if (!draft) throw new Error('Activate an alignment draft before committing.');
            this._recordEdit(draft, true);
            return draft;
        }
        updateView(patch) {
            this._assertOpen();
            const draft = this.current();
            if (!draft) throw new Error('Activate an alignment draft before editing.');
            Object.assign(draft.view, clone(patch));
            return draft.view;
        }
        isDirty(key) {
            if (key != null) {
                const draft = this._drafts.get(typeof key === 'string' ? key : key.key);
                return !!draft && (this._forced.has(draft.key)
                    || stableKey(alignmentState(draft.state)) !== this._baselines.get(draft.key));
            }
            return Array.from(this._drafts.values()).some(draft => this.isDirty(draft.key));
        }
        entries(options) {
            const opts = options || {};
            return Array.from(this._drafts.values()).filter(draft => !opts.dirtyOnly || this.isDirty(draft.key));
        }
        serialize(options) {
            this._assertOpen();
            const opts = options || {};
            for (const draft of this._drafts.values()) this._recordEdit(draft);
            return {version: 'msi-alignment-drafts-v1', sectionId: this.sectionId,
                entries: this.entries({dirtyOnly: opts.dirtyOnly !== false})
                    .sort((a, b) => a.editRevision - b.editRevision).map(draft => ({key: draft.key,
                    editRevision: draft.editRevision,
                    context: clone(draft.context), frameKey: draft.frameKey, state: alignmentState(draft.state)}))};
        }
        original() { return clone(this._initial); }
        cancel() {
            const initial = this.original();
            this.close();
            return initial;
        }
        close() {
            this.closed = true;
            this._drafts.clear();
            this._baselines.clear();
            this._observed.clear();
            this._forced.clear();
            this._activeKey = null;
        }
    }

    return {create: options => new DraftStore(options), DraftStore, clone, stableKey,
        alignmentState, coordinateSourceReference, frameDescriptor, frameKey, sharedFrameKey,
        contextKey, loadLegacy};
});
