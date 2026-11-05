/* Versioned, JSON-only ratio definitions. Display names are never input identity. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MsiRatioModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    const SCHEMA_VERSION = 1, CALCULATION_VERSION = 'msi-ratio-v1', PREFIX = 'MSI_RATIO_';
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
    // Keep the full canonical representation: hashing it could admit collisions
    // between scientific inputs. Arrays retain order; object key order is ignored.
    function fingerprint(value) {
        if (value === undefined) return 'null';
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(fingerprint).join(',') + ']';
        return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort()
            .map(k => JSON.stringify(k) + ':' + fingerprint(value[k])).join(',') + '}';
    }
    function canonicalSectionId(section) {
        if (typeof section === 'string' || typeof section === 'number') return String(section);
        return String(section && ((section.meta && section.meta.client_id) || section.client_id || section.id) || '');
    }
    function displayKey(id) { return PREFIX + String(id); }
    function isRatioKey(key, registry) {
        if (typeof key !== 'string' || !key.startsWith(PREFIX) || key.length === PREFIX.length) return false;
        return registry == null || (registry.schemaVersion === SCHEMA_VERSION && Array.isArray(registry.definitions)
            && registry.definitions.some(def => def.id === key.slice(PREFIX.length)));
    }
    function sourceReference(entry) {
        return entry.sourceReference || JSON.stringify([entry.sourceFileId || entry.blobId || entry.sourceUrl || entry.storagePath || entry.path || '',
            entry.kind || '', entry.sheet || '', entry.func || 1, entry.annotation || '', entry.sourceHash || entry.sourceRevision || '']);
    }
    function sourceRevision(entry) {
        if (entry.sourceHash != null && entry.sourceHash !== '') return String(entry.sourceHash);
        if (entry.sourceRevision != null && entry.sourceRevision !== '') return String(entry.sourceRevision);
        try {
            const frozen = JSON.parse(entry.sourceReference || 'null');
            if (Array.isArray(frozen) && frozen.length >= 6 && frozen[5] != null) return String(frozen[5]);
        } catch (_) {}
        return '';
    }
    function makeInputRef(entry, layerKey) {
        if (!plain(entry)) throw new TypeError('Ratio input must be a measured MSI entry');
        if (!entry.sourceReference && !entry.sourceFileId && !entry.blobId && !entry.sourceUrl && !entry.storagePath && !entry.path)
            throw new TypeError('Ratio input requires an original source reference');
        const kind = entry.kind || 'xlsx';
        const reader = {kind};
        let feature;
        if (kind === 'raw') {
            reader.func = entry.func || 1;
            feature = {channel:entry.channel == null ? 0 : entry.channel};
        } else if (kind === 'parquet') {
            reader.annotation = entry.annotation == null ? '' : entry.annotation;
            feature = {columnIndex:entry.colIdx};
        } else if (kind === 'txt' || kind === 'txt-analyte') {
            const analyte = kind === 'txt-analyte' || Number.isFinite(entry.compound_index) || Number.isFinite(entry.v_index);
            reader.analyte = analyte;
            if (analyte) {
                reader.dataStartLine = Number.isFinite(entry.dataStartLine) ? entry.dataStartLine : 4;
                feature = {analyteIndex:Number.isFinite(entry.compound_index) ? entry.compound_index : Number.isFinite(entry.v_index) ? entry.v_index : 0};
            } else {
                reader.x = entry.x || 'x'; reader.y = entry.y || 'y';
                feature = entry.v ? {columnName:entry.v} : {columnIndex:2};
            }
        } else if (kind === 'xlsx') {
            reader.sheet = entry.sheet || '';
            reader.dataStartRow = Math.max(1, entry.data_start_row || 1);
            reader.x = entry.col_x || ''; reader.y = entry.col_y || '';
            feature = {columnName:entry.col_v || ''};
        } else throw new TypeError('Unsupported ratio source kind: ' + kind);
        const ref = {schemaVersion:1, source:{reference:sourceReference(entry), revision:sourceRevision(entry)},
            reader, feature, layerKeyHint:layerKey || '', labelHint:entry.name || entry.compoundName || layerKey || ''};
        if (entry.id != null) ref.entryIdHint = String(entry.id);
        const checked = validateInputRef(ref);
        if (!checked.valid) throw new TypeError(checked.errors.join('; '));
        return ref;
    }
    function validateInputRef(ref) {
        const errors = [];
        if (!plain(ref) || ref.schemaVersion !== 1) return {valid:false, errors:['unsupported-input-reference']};
        if (!plain(ref.source) || typeof ref.source.reference !== 'string' || !ref.source.reference
            || typeof ref.source.revision !== 'string') errors.push('invalid-source-reference');
        if (!plain(ref.reader) || !['xlsx', 'raw', 'parquet', 'txt', 'txt-analyte'].includes(ref.reader.kind)) errors.push('invalid-reader');
        if (!plain(ref.feature) || Object.keys(ref.feature).length !== 1) errors.push('invalid-feature-selector');
        else {
            const selector = Object.keys(ref.feature)[0], value = ref.feature[selector];
            if (selector === 'columnName') {
                if (typeof value !== 'string' || !value) errors.push('invalid-feature-selector');
            } else if (['columnIndex', 'analyteIndex', 'channel'].includes(selector)) {
                if (!Number.isInteger(value) || value < 0) errors.push('invalid-feature-selector');
            } else errors.push('invalid-feature-selector');
            const kind = ref.reader && ref.reader.kind;
            if ((kind === 'raw' && selector !== 'channel') || (kind === 'parquet' && selector !== 'columnIndex')
                || (kind === 'xlsx' && selector !== 'columnName') || (kind === 'txt-analyte' && selector !== 'analyteIndex'))
                errors.push('feature-reader-mismatch');
        }
        return {valid:errors.length === 0, errors};
    }
    function inputIdentity(ref, includeRevision) {
        const source = clone(ref.source);
        if (!includeRevision) {
            delete source.revision;
            // Standard frozen references include a revision in element five.
            try {
                const parsed = JSON.parse(source.reference);
                if (Array.isArray(parsed) && parsed.length >= 6) { parsed[5] = ''; source.reference = JSON.stringify(parsed); }
            } catch (_) {}
        }
        return fingerprint({source, reader:ref.reader, feature:ref.feature});
    }
    function resolveInput(section, ref) {
        const check = validateInputRef(ref);
        if (!check.valid) return {status:'invalid', reason:check.errors.join('; '), candidates:[]};
        const exact = [], changed = [], want = inputIdentity(ref, true), old = inputIdentity(ref, false);
        for (const [key, entry] of Object.entries(section && section.msiSeries || {})) {
            if (!/^MSI_/i.test(key) || !entry) continue;
            let candidate;
            try { candidate = makeInputRef(entry, key); } catch (_) { continue; }
            if (inputIdentity(candidate, true) === want) exact.push({key, entry});
            else if (inputIdentity(candidate, false) === old) changed.push(key);
        }
        if (exact.length === 1) return {status:'ready', key:exact[0].key, entry:exact[0].entry};
        if (exact.length > 1) return {status:'ambiguous', reason:'input-reference-ambiguous', candidates:exact.map(item => item.key)};
        return changed.length ? {status:'source-changed', reason:'input-source-revision-changed', candidates:changed}
            : {status:'missing', reason:'input-reference-missing', candidates:[]};
    }
    function validateDefinition(def) {
        const errors = [];
        if (!plain(def)) return {valid:false, errors:['invalid-ratio-definition']};
        if (typeof def.id !== 'string' || !def.id.trim()) errors.push('invalid-ratio-id');
        if (typeof def.name !== 'string' || !def.name.trim()) errors.push('invalid-ratio-name');
        if (!Number.isInteger(def.revision) || def.revision < 1) errors.push('invalid-ratio-revision');
        if (def.operation !== 'divide' || def.calculationVersion !== CALCULATION_VERSION
            || def.numeratorPolicy !== 'nonnegative' || def.invalidPolicy !== 'exclude') errors.push('unsupported-ratio-calculation');
        if (!Number.isFinite(def.denominatorMin) || def.denominatorMin < 0) errors.push('invalid-denominator-min');
        if (def.display != null && !plain(def.display)) errors.push('invalid-ratio-display');
        if (!plain(def.bindings) || !Object.keys(def.bindings).length) errors.push('ratio-bindings-missing');
        else for (const [sectionId, binding] of Object.entries(def.bindings)) {
            if (!sectionId || !plain(binding)) { errors.push('invalid-ratio-binding'); continue; }
            for (const role of ['numerator', 'denominator']) {
                for (const error of validateInputRef(binding[role]).errors) errors.push(sectionId + ':' + role + ':' + error);
            }
            if (typeof binding.coordinateConfirmed !== 'boolean') errors.push(sectionId + ':invalid-coordinate-confirmation');
            if (binding.coordinateEvidence != null && typeof binding.coordinateEvidence !== 'string') errors.push(sectionId + ':invalid-coordinate-evidence');
        }
        return {valid:errors.length === 0, errors};
    }
    function validateRegistry(registry) {
        if (registry == null) return {valid:true, supported:true, errors:[]};
        if (!plain(registry) || !Number.isInteger(registry.schemaVersion) || registry.schemaVersion < 1)
            return {valid:false, supported:false, errors:['invalid-ratio-registry']};
        if (registry.schemaVersion !== SCHEMA_VERSION) return {valid:true, supported:false, errors:[]};
        const errors = [], ids = new Set();
        if (!Array.isArray(registry.definitions)) errors.push('ratio-definitions-missing');
        else for (const def of registry.definitions) {
            errors.push(...validateDefinition(def).errors);
            if (def && ids.has(def.id)) errors.push('duplicate-ratio-id');
            if (def) ids.add(def.id);
        }
        return {valid:errors.length === 0, supported:true, errors};
    }
    function normalizeRegistry(registry) {
        if (registry == null) return {schemaVersion:SCHEMA_VERSION, definitions:[]};
        const check = validateRegistry(registry);
        if (!check.valid) throw new TypeError('Invalid ratio registry: ' + check.errors.join('; '));
        return clone(registry);
    }
    function validateProjectReferences(project, registry) {
        const value = registry === undefined ? project && project.meta && project.meta.msiRatios : registry;
        const check = validateRegistry(value);
        if (!check.valid || !check.supported || value == null) return check;
        const sections = new Map(), errors = [];
        for (const section of project && project.sections || []) {
            const id = canonicalSectionId(section);
            const matches = sections.get(id) || [];
            matches.push(section); sections.set(id, matches);
        }
        for (const def of value.definitions) for (const [sectionId, binding] of Object.entries(def.bindings)) {
            const matches = sections.get(sectionId) || [];
            if (matches.length !== 1) {
                errors.push(def.id + ':' + sectionId + ':' + (matches.length ? 'section-reference-ambiguous' : 'section-reference-missing'));
                continue;
            }
            for (const role of ['numerator', 'denominator']) {
                const result = resolveInput(matches[0], binding[role]);
                if (result.status !== 'ready') errors.push(def.id + ':' + sectionId + ':' + role + ':' + result.reason);
            }
        }
        return {valid:errors.length === 0, supported:true, errors};
    }
    function remapSections(registry, mapping) {
        const out = normalizeRegistry(registry);
        if (out.schemaVersion !== SCHEMA_VERSION) return out;
        const lookup = key => mapping instanceof Map ? mapping.get(key) : mapping && own(mapping, key) ? mapping[key] : undefined;
        for (const def of out.definitions) {
            const bindings = Object.create(null);
            for (const [id, binding] of Object.entries(def.bindings)) {
                const mapped = lookup(id), next = mapped == null ? id : String(mapped);
                if (!next) throw new TypeError('Empty ratio section remap');
                if (own(bindings, next)) {
                    if (fingerprint(bindings[next]) !== fingerprint(binding)) throw new TypeError('Conflicting ratio section remap: ' + next);
                } else bindings[next] = binding;
            }
            def.bindings = bindings;
            for (const scope of ['whole', 'roi']) {
                const source = def.display && def.display.ranges && def.display.ranges[scope];
                if (!plain(source)) continue;
                const ranges = Object.create(null);
                for (const [id, window] of Object.entries(source)) {
                    const mapped = id === 'same' || id === 'version' ? undefined : lookup(id);
                    const next = mapped == null ? id : String(mapped);
                    if (!next) throw new TypeError('Empty ratio range section remap');
                    if (own(ranges, next) && fingerprint(ranges[next]) !== fingerprint(window))
                        throw new TypeError('Conflicting ratio range section remap: ' + next);
                    ranges[next] = window;
                }
                def.display.ranges[scope] = ranges;
            }
        }
        return out;
    }
    function definitionFingerprint(def, sectionId) {
        const data = {id:def.id, operation:def.operation, calculationVersion:def.calculationVersion,
            denominatorMin:def.denominatorMin, numeratorPolicy:def.numeratorPolicy, invalidPolicy:def.invalidPolicy};
        const refs = {};
        const bindings = sectionId == null ? def.bindings : {[canonicalSectionId(sectionId)]:def.bindings[canonicalSectionId(sectionId)]};
        for (const [id, binding] of Object.entries(bindings || {})) {
            refs[id] = binding ? {numerator:inputIdentity(binding.numerator, true), denominator:inputIdentity(binding.denominator, true),
                coordinateConfirmed:binding.coordinateConfirmed, coordinateEvidence:binding.coordinateEvidence || ''} : null;
        }
        data.bindings = refs;
        return fingerprint(data);
    }
    return {SCHEMA_VERSION, CALCULATION_VERSION, PREFIX, canonicalSectionId, displayKey, isRatioKey,
        makeInputRef, validateInputRef, resolveInput, validateDefinition, validateRegistry, normalizeRegistry, validateProjectReferences,
        remapSections, fingerprint, definitionFingerprint};
});
