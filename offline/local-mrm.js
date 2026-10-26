/* Local MRM backend. Enabled only by the packaged loopback server. */
(function (root) {
    'use strict';
    if (root.DESI_OFFLINE !== true) return;
    const KEY = 'desi:offlineMrm:v1';
    const copy = value => JSON.parse(JSON.stringify(value));
    const now = () => new Date().toISOString();
    const uuid = () => root.crypto.randomUUID();
    const empty = () => ({ format: 'desi-offline-mrm', version: 1, compounds: [], sets: [], template: null, ignored: [] });
    function validate(doc) {
        if (!doc || doc.format !== 'desi-offline-mrm' || doc.version !== 1 || !Array.isArray(doc.compounds)
            || !Array.isArray(doc.sets) || !Array.isArray(doc.ignored) || (doc.template != null && typeof doc.template !== 'string')) {
            throw new Error('MRM バックアップの形式が違います');
        }
        const cids = new Set(), tids = new Set(), names = new Set(), sids = new Set();
        for (const c of doc.compounds) {
            if (!c || typeof c.id !== 'string' || !c.id || cids.has(c.id) || typeof c.name !== 'string' || !c.name.trim()
                || names.has(c.name) || !Array.isArray(c.tags) || c.tags.some(tag => typeof tag !== 'string') || !Array.isArray(c.transitions)) throw new Error('化合物データが不正です');
            cids.add(c.id); names.add(c.name);
            for (const t of c.transitions) {
                if (!t || typeof t.id !== 'string' || !t.id || tids.has(t.id) || t.compound_id !== c.id || !Array.isArray(t.usages)) throw new Error('トランジションデータが不正です');
                for (const k of ['precursor', 'product', 'ce', 'cv']) if (t[k] != null && (typeof t[k] !== 'number' || !Number.isFinite(t[k]))) throw new Error('MRM 数値が不正です');
                for (const u of t.usages) if (!u || typeof u.id !== 'string' || !Array.isArray(u.sample_types) || u.sample_types.some(s => typeof s !== 'string')) throw new Error('使用履歴が不正です');
                tids.add(t.id);
            }
        }
        for (const s of doc.sets) {
            if (!s || typeof s.id !== 'string' || !s.id || sids.has(s.id) || typeof s.name !== 'string' || !s.name.trim() || !Array.isArray(s.items)) throw new Error('メソッドセットが不正です');
            if (s.items.some(i => !i || typeof i !== 'object')) throw new Error('メソッド項目が不正です');
            sids.add(s.id);
        }
        return doc;
    }
    function read() { const raw = root.localStorage.getItem(KEY); return raw ? validate(JSON.parse(raw)) : empty(); }
    function save(doc) { root.localStorage.setItem(KEY, JSON.stringify(validate(doc))); }
    function number(value) {
        if (value === '' || value == null) return null;
        const n = Number(value); if (!Number.isFinite(n)) throw new Error('MRM 数値が不正です'); return n;
    }
    function compound(doc, a, update, merge) {
        const name = String(a._name || '').trim(); if (!name) throw new Error('化合物名が必要です');
        let c = update ? doc.compounds.find(c => c.id === a._id) : doc.compounds.find(c => c.name === name);
        if (update && !c) throw new Error('化合物が見つかりません');
        if (doc.compounds.some(x => x !== c && x.name === name)) throw new Error('同名の化合物が存在します');
        const existed = !!c;
        if (!c) {
            c = { id: uuid(), name, tags: [], polarity: null, note: null, serial_no: Math.max(0, ...doc.compounds.map(x => Number(x.serial_no) || 0)) + 1,
                check_level: 'unchecked', shelf: 'main', transitions: [], created_at: now() };
            doc.compounds.push(c);
        }
        c.name = name;
        c.tags = merge ? [...new Set(c.tags.concat(a._tags || []))] : (a._tags || []).slice();
        c.polarity = merge ? (c.polarity || a._polarity || null) : (a._polarity || null);
        if (!merge) c.note = a._note || null;
        if (a._serial_no != null && (update || !existed)) c.serial_no = number(a._serial_no);
        if (['std', 'lit', 'unchecked'].includes(a._check_level)) c.check_level = a._check_level;
        if (['main', 'archive'].includes(a._shelf)) c.shelf = a._shelf;
        c.updated_at = now(); return c;
    }
    function findTransition(doc, id) {
        for (const c of doc.compounds) { const t = c.transitions.find(t => t.id === id); if (t) return { c, t }; }
        throw new Error('トランジションが見つかりません');
    }
    function transition(doc, a, update, preserve) {
        const values = {}; for (const k of ['precursor', 'product', 'ce', 'cv']) values[k] = number(a['_' + k]);
        let c, t;
        if (update) ({ c, t } = findTransition(doc, a._id));
        else {
            c = doc.compounds.find(c => c.id === a._compound_id); if (!c) throw new Error('化合物が見つかりません');
            t = c.transitions.find(t => Object.keys(values).every(k => t[k] === values[k]));
        }
        if (c.transitions.some(x => x !== t && Object.keys(values).every(k => x[k] === values[k]))) throw new Error('同じトランジションが存在します');
        if (!t) { t = { id: uuid(), compound_id: c.id, usages: [], created_at: now(), is_recommended: false }; c.transitions.push(t); }
        Object.assign(t, values);
        t.role = preserve ? (t.role || a._role || null) : (a._role || null);
        if (!preserve) { t.is_recommended = !!a._is_recommended; t.intensity_note = a._intensity_note || null; t.note = a._note || null; }
        t.updated_at = now(); return t;
    }
    function usage(doc, a) {
        const { t } = findTransition(doc, a._transition_id);
        const u = { id: uuid(), transition_id: t.id, project_slug: null, project_local_id: a._project_local_id || null,
            project_name: a._project_name || null, sample_name: a._sample_name || null, sample_types: a._sample_types || [], source: a._source || 'manual', created_at: now() };
        t.usages.push(u); return u;
    }
    function register(doc, a) {
        const c = compound(doc, a, false, true);
        const t = transition(doc, Object.assign({}, a, { _compound_id: c.id }), false, true);
        const u = usage(doc, Object.assign({}, a, { _transition_id: t.id, _source: 'from-result' }));
        return { ok: true, name: c.name, compound_id: c.id, transition_id: t.id, usage_id: u.id };
    }
    function dispatch(doc, name, a) {
        switch (name) {
        case 'verify_master_pw': return true;
        case 'list_mrm_library': return doc.compounds;
        case 'upsert_compound': return compound(doc, a, false, false).id;
        case 'update_compound': compound(doc, a, true, false); return null;
        case 'delete_compound': doc.compounds = doc.compounds.filter(c => c.id !== a._id); return null;
        case 'upsert_transition': return transition(doc, a, false, false).id;
        case 'update_transition': transition(doc, a, true, false); return null;
        case 'delete_transition': for (const c of doc.compounds) c.transitions = c.transitions.filter(t => t.id !== a._id); return null;
        case 'record_usage': return usage(doc, a).id;
        case 'register_from_result': return register(doc, a);
        case 'register_from_result_batch': {
            if (!Array.isArray(a._rows)) throw new Error('MRM rows が不正です');
            const results = [];
            for (const row of a._rows) {
                const args = {}; for (const [k, v] of Object.entries(row)) args['_' + k] = v;
                const before = copy(doc);
                try { results.push(register(doc, args)); }
                catch (e) { Object.assign(doc, before); results.push({ ok: false, name: row.name || '', error: e.message, sqlstate: '22023' }); }
            }
            return { ok_count: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length, results };
        }
        case 'register_measured_compound': {
            const existing = doc.compounds.find(c => c.name === String(a._name || '').trim());
            const values = Object.assign({}, a, { _shelf: existing ? existing.shelf : (a._shelf || 'archive') });
            const c = compound(doc, values, false, true);
            const hasMz = ['precursor', 'product', 'ce', 'cv'].some(k => number(a['_' + k]) != null);
            const t = hasMz ? transition(doc, Object.assign({}, a, { _compound_id: c.id }), false, true) : null;
            return { ok: true, compound_id: c.id, transition_id: t ? t.id : null };
        }
        case 'get_exp_template': return doc.template;
        case 'set_exp_template': doc.template = a._content || null; return null;
        case 'list_mrm_sets': return doc.sets;
        case 'upsert_mrm_set': {
            const name = String(a._name || '').trim(); if (!name) throw new Error('セット名が必要です');
            let s = a._id ? doc.sets.find(s => s.id === a._id) : null;
            if (a._id && !s) throw new Error('セットが見つかりません');
            if (!s) { s = { id: uuid(), created_at: now() }; doc.sets.push(s); }
            Object.assign(s, { name, owner: a._owner || null, description: a._description || null, source_project_slug: null, updated_at: now(),
                items: (a._items || []).map((item, i) => Object.assign({}, item, { id: uuid(), position: i + 1 })) });
            return s.id;
        }
        case 'delete_mrm_set': doc.sets = doc.sets.filter(s => s.id !== a._id); return null;
        case 'search_projects_by_compound_master': {
            const hits = new Map();
            for (const c of doc.compounds.filter(c => c.name === a._query)) for (const t of c.transitions) for (const u of t.usages) {
                const id = u.project_local_id || u.project_name;
                if (id) hits.set(id, { slug: u.project_local_id || null, display_name: u.project_name || id, is_public: false });
            }
            return [...hits.values()];
        }
        default: throw new Error('ローカル MRM 未対応操作: ' + name);
        }
    }
    const reads = new Set(['verify_master_pw', 'list_mrm_library', 'get_exp_template', 'list_mrm_sets', 'search_projects_by_compound_master']);
    async function rpc(name, args) {
        const operation = () => { const doc = read(); const result = dispatch(doc, name, args || {}); if (!reads.has(name)) save(doc); return result === undefined ? null : copy(result); };
        if (root.navigator && root.navigator.locks) return root.navigator.locks.request(KEY, operation);
        return operation();
    }
    async function importDocument(doc) {
        const clean = copy(validate(doc));
        const operation = () => save(clean);
        if (root.navigator && root.navigator.locks) return root.navigator.locks.request(KEY, operation);
        return operation();
    }
    root.DesiLocalMrm = root.DesiOfflineMrm = { rpc, exportDocument: () => copy(read()), importDocument, validate, storageKey: KEY };
})(window);
