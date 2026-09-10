/* Session-local section visibility. This module never writes project data. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SectionVisibility = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const strings = values => new Set(Array.from(values || [], String));
    function reconcileSelection(previous, sections) {
        const ids = (sections || []).map(s => String(s.id));
        const known = strings(previous && previous.known);
        const chosen = strings(previous && previous.selected);
        const selected = new Set(ids.filter(id => !previous || !known.has(id) || chosen.has(id)));
        if (!selected.size && ids.length) selected.add(ids[0]);
        return { known: new Set(ids), selected };
    }
    function changeSelection(state, ids, checked, drawingId) {
        const selected = new Set(state.selected);
        const deferred = new Set();
        for (const id of strings(ids)) {
            if (!state.known.has(id)) continue;
            if (checked) selected.add(id);
            else if (drawingId != null && id === String(drawingId)) deferred.add(id);
            else selected.delete(id);
        }
        // A rejected final deselection leaves the previous selection intact.
        if (!selected.size && state.known.size) return { selected: new Set(state.selected), deferred: new Set(), rejected: true };
        return { selected, deferred, rejected: false };
    }
    function captureViewport(transform, width, height, fit) {
        if (!(width > 0 && height > 0 && fit > 0)) return null;
        const pixelScale = fit * (transform.scale || 1);
        return { centerX: 0.5 - (transform.tx || 0) / (width * pixelScale),
            centerY: 0.5 - (transform.ty || 0) / (height * pixelScale), pixelScale };
    }
    function restoreViewport(view, width, height, fit) {
        if (!view || !(width > 0 && height > 0 && fit > 0 && view.pixelScale > 0)) return null;
        return { tx: (0.5 - view.centerX) * width * view.pixelScale,
            ty: (0.5 - view.centerY) * height * view.pixelScale, scale: view.pixelScale / fit };
    }
    function contextKey(project, share) {
        return 'desi:section-view:v1:' + JSON.stringify([String(project && project.id || ''),
            share ? String(share.slug || '') : 'master', share ? String(share.role || 'viewer') : 'master']);
    }
    function createController(hooks) {
        const doc = hooks.document || document;
        const storage = hooks.storage;
        const controller = {
            key: null, state: null, revision: 0, pendingHidden: new Set(), panel: null,
            previewTransforms: Object.create(null), previewRotations: Object.create(null),
            ensure() {
                const project = hooks.project();
                const key = contextKey(project, hooks.share());
                if (key !== this.key) {
                    this.close(false);
                    this.key = key; this.pendingHidden.clear();
                    let saved = null;
                    try { saved = JSON.parse(storage && storage.getItem(key) || 'null'); } catch (e) {}
                    this.state = saved;
                    this.previewTransforms = Object.assign(Object.create(null), saved && saved.previewTransforms);
                    this.previewRotations = Object.assign(Object.create(null), saved && saved.previewRotations);
                }
                const before = this.state && Array.from(this.state.selected || []).join('\0');
                this.state = reconcileSelection(this.state, project && project.sections);
                for (const map of [this.previewTransforms, this.previewRotations]) {
                    for (const id of Object.keys(map)) if (!this.state.known.has(id)) delete map[id];
                }
                if (before !== Array.from(this.state.selected).join('\0')) this.revision++;
                hooks.scope(this.state.selected);
                this.save();
                return this.state.selected;
            },
            save() {
                if (!this.state || !this.key) return;
                try { if (storage) storage.setItem(this.key, JSON.stringify({
                    known: Array.from(this.state.known), selected: Array.from(this.state.selected),
                    previewTransforms: this.previewTransforms, previewRotations: this.previewRotations
                })); } catch (e) { /* Private browsing / storage quota: memory remains usable. */ }
            },
            change(ids, checked) {
                this.ensure();
                const result = changeSelection(this.state, ids, checked, hooks.drawingId());
                for (const id of strings(ids)) this.pendingHidden.delete(id);
                for (const id of result.deferred) this.pendingHidden.add(id);
                this.state.selected = result.selected;
                this.revision++; hooks.scope(this.state.selected); this.save();
                const message = result.rejected ? '最低1切片を表示してください。'
                    : result.deferred.size ? '描画中の切片は、ROIの完了・中止後に非表示になります。' : '';
                hooks.changed(); this.refresh(message);
            },
            flushDeferred() {
                if (!this.pendingHidden.size || hooks.drawingId() != null) return;
                const ids = Array.from(this.pendingHidden); this.pendingHidden.clear(); this.change(ids, false);
            },
            refresh(message) {
                this.ensure();
                const total = this.state.known.size, count = this.state.selected.size;
                doc.querySelectorAll('[data-section-visibility]').forEach(button => {
                    if (!button._sectionVisibilityBound) {
                        button._sectionVisibilityBound = true;
                        button.addEventListener('click', () => this.toggle(button));
                        button.addEventListener('keydown', e => {
                            if (e.key === 'ArrowDown') { e.preventDefault(); this.open(button); }
                        });
                    }
                    button.textContent = `表示切片 ${count}/${total}`;
                    button.disabled = !total;
                    button.setAttribute('aria-haspopup', 'dialog');
                    button.setAttribute('aria-expanded', String(!!this.panel && this.anchor === button));
                });
                if (this.panel) { this.renderList(); if (message) this.status.textContent = message; }
                else if (message && hooks.notify) hooks.notify(message);
            },
            toggle(anchor) { if (this.panel && this.anchor === anchor) this.close(); else this.open(anchor); },
            open(anchor) {
                this.close(false); this.ensure(); this.anchor = anchor;
                const panel = doc.createElement('div');
                panel.className = 'section-visibility-panel'; panel.setAttribute('role', 'dialog');
                panel.setAttribute('aria-label', '表示切片');
                panel.innerHTML = '<div class="section-visibility-head"><strong>表示切片</strong><button type="button" data-close aria-label="閉じる">×</button></div>'
                    + '<input type="search" data-search placeholder="切片名・臓器で検索" aria-label="切片名・臓器で検索">'
                    + '<div class="section-visibility-actions"><button type="button" data-all>すべて表示</button><span data-count></span></div>'
                    + '<p class="section-visibility-help">臓器のチェックは検索結果に関係なく、その臓器の全切片に適用します。分類は表示用です。</p>'
                    + '<div data-list class="section-visibility-list"></div><div data-status role="status" aria-live="polite"></div>';
                this.panel = panel; this.search = panel.querySelector('[data-search]');
                this.status = panel.querySelector('[data-status]'); doc.body.appendChild(panel);
                panel.querySelector('[data-close]').addEventListener('click', () => this.close());
                panel.querySelector('[data-all]').addEventListener('click', () => this.change(this.state.known, true));
                this.search.addEventListener('input', () => this.renderList());
                this._outside = e => { if (!panel.contains(e.target) && !anchor.contains(e.target)) this.close(false); };
                this._key = e => {
                    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
                };
                this._position = () => {
                    const box = anchor.getBoundingClientRect();
                    panel.style.left = Math.max(8, Math.min(box.left, (doc.defaultView.innerWidth || 1024) - panel.offsetWidth - 8)) + 'px';
                    panel.style.top = Math.max(8, Math.min(box.bottom + 6, (doc.defaultView.innerHeight || 768) - panel.offsetHeight - 8)) + 'px';
                };
                doc.addEventListener('pointerdown', this._outside, true);
                doc.addEventListener('keydown', this._key, true);
                doc.defaultView.addEventListener('resize', this._position);
                this.refresh(); this._position(); this.search.focus();
            },
            close(restoreFocus = true) {
                if (!this.panel) return;
                doc.removeEventListener('pointerdown', this._outside, true);
                doc.removeEventListener('keydown', this._key, true);
                doc.defaultView.removeEventListener('resize', this._position);
                this.panel.remove(); this.panel = null;
                if (this.anchor) { this.anchor.setAttribute('aria-expanded', 'false'); if (restoreFocus && this.anchor.isConnected) this.anchor.focus(); }
            },
            renderList() {
                const list = this.panel.querySelector('[data-list]');
                const query = this.search.value.trim().toLocaleLowerCase();
                const focusKey = doc.activeElement && doc.activeElement.dataset && doc.activeElement.dataset.focusKey;
                list.replaceChildren();
                const groups = new Map();
                for (const sec of (hooks.project() && hooks.project().sections) || []) {
                    const group = hooks.organ(sec) || '未分類';
                    if (!groups.has(group)) groups.set(group, []); groups.get(group).push(sec);
                }
                let matched = 0;
                const checkbox = (labelText, key, checked, action, partial) => {
                    const label = doc.createElement('label'), input = doc.createElement('input'), text = doc.createElement('span');
                    input.type = 'checkbox'; input.checked = checked; input.indeterminate = !!partial; input.dataset.focusKey = key;
                    input.addEventListener('change', () => action(input.checked)); text.textContent = labelText;
                    label.append(input, text); return label;
                };
                for (const [group, sections] of groups) {
                    const matches = sections.filter(s => `${s.displayName || s.id} ${group}`.toLocaleLowerCase().includes(query));
                    if (!matches.length) continue;
                    matched += matches.length;
                    const shown = sections.filter(s => this.state.selected.has(String(s.id))).length;
                    const block = doc.createElement('div'); block.className = 'section-visibility-group';
                    const head = checkbox(`${group} (${shown}/${sections.length})`, 'group:' + group, shown === sections.length,
                        checked => this.change(sections.map(s => s.id), checked), shown > 0 && shown < sections.length);
                    head.className = 'section-visibility-group-head'; block.appendChild(head);
                    for (const sec of matches) block.appendChild(checkbox(String(sec.displayName || sec.id), 'section:' + sec.id,
                        this.state.selected.has(String(sec.id)), checked => this.change([sec.id], checked)));
                    list.appendChild(block);
                }
                if (!matched) { const empty = doc.createElement('p'); empty.textContent = '該当する切片がありません。'; list.appendChild(empty); }
                this.panel.querySelector('[data-count]').textContent = `${this.state.selected.size}/${this.state.known.size} 選択中`;
                if (focusKey) list.querySelectorAll('input').forEach(input => { if (input.dataset.focusKey === focusKey) input.focus(); });
            }
        };
        return controller;
    }
    return { reconcileSelection, changeSelection, captureViewport, restoreViewport, contextKey, createController };
});
