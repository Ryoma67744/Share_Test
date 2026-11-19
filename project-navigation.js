/* Project links: keep the manager open and isolate shared-view credentials. */
(function(root, factory) {
    const create = factory();
    const api = Object.assign(create(root), {create});
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProjectNavigation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
// UI-only bindings: parameters keep user data separate from translation keys.
function uiT(source, params) { const api=globalThis.AppI18n; if(typeof params==='function')params=params(); return api ? api.t(source, params) : String(source).replace(/\{(\w+)\}/g,(token,k)=>params && Object.prototype.hasOwnProperty.call(params,k) ? String(params[k] ?? '') : token); }

    const UNLOCK = 'desi:masterUnlocked', PASSWORD = 'desi:masterPw';
    const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
        && !/[\u0000-\u001f\u007f]/.test(value);
    return function create(win) {
        const scriptUrl = win.document && win.document.currentScript && win.document.currentScript.src;
        function appBase() {
            const current = new URL(win.location.href);
            const base = new URL(win.DesiRuntime && win.DesiRuntime.baseUrl || (scriptUrl && new URL('./', scriptUrl).href) || './', current);
            if (!/^https?:$/.test(base.protocol) || base.origin !== current.origin || !base.pathname.endsWith('/')) {
                throw new Error('Invalid application base');
            }
            base.search = ''; base.hash = '';
            return base;
        }
        function targetValue(target) {
            if (!target || typeof target !== 'object') throw new Error('Missing project target');
            const keys = Object.keys(target);
            if (keys.length !== 1 || !['projectId','importSlug'].includes(keys[0]) || !identifier(target[keys[0]])) {
                throw new Error('Invalid project target');
            }
            return {key:keys[0], value:target[keys[0]]};
        }
        const refreshModes = {refreshShare:'share', reviewChanges:'changes'};
        function refreshMode(key, options = {}) {
            if (!options || typeof options !== 'object' || Array.isArray(options))
                throw new Error('Invalid project navigation options');
            let mode;
            for (const [name, enabled] of Object.entries(options)) {
                if (!Object.hasOwn(refreshModes, name) || typeof enabled !== 'boolean')
                    throw new Error('Invalid project navigation options');
                if (!enabled) continue;
                if (mode || key !== 'projectId') throw new Error('Invalid project navigation options');
                mode = refreshModes[name];
            }
            return mode;
        }
        function optionsFromRefresh(values, localProject) {
            if (!values.length) return {};
            if (localProject && values.length === 1) {
                for (const [key, mode] of Object.entries(refreshModes))
                    if (values[0] === mode) return {[key]:true};
            }
            throw new Error('Invalid refresh destination');
        }
        function masterUrl(target, options) {
            const {key,value} = targetValue(target), url = new URL('viewer/index.html', appBase());
            url.searchParams.set(key === 'projectId' ? 'project' : 'import', value);
            const mode = refreshMode(key, options);
            if (mode) url.searchParams.set('refresh', mode);
            return url.href;
        }
        function masterLoginUrl(target, options) {
            const {key,value} = targetValue(target), url = new URL('index.html', appBase());
            url.searchParams.set(key === 'projectId' ? 'openProject' : 'importProject', value);
            const mode = refreshMode(key, options);
            if (mode) url.searchParams.set('refresh', mode);
            return url.href;
        }
        function masterLoginUrlFromViewer(href) {
            const base = appBase(), fallback = new URL('index.html', base).href;
            try {
                const url = new URL(href, base);
                if (url.origin !== base.origin || !['viewer/','viewer/index.html'].some(p => url.pathname === new URL(p, base).pathname)) return fallback;
                const projects = url.searchParams.getAll('project'), imports = url.searchParams.getAll('import');
                if (projects.length + imports.length !== 1) return fallback;
                const refresh = url.searchParams.getAll('refresh');
                const options = optionsFromRefresh(refresh, projects.length === 1);
                return masterLoginUrl(projects.length ? {projectId:projects[0]} : {importSlug:imports[0]}, options);
            } catch (_) { return fallback; }
        }
        function shareUrl(slug) {
            if (!identifier(slug)) throw new Error('Invalid shared project');
            const url = new URL('viewer/index.html', appBase());
            url.hash = 'share=' + encodeURIComponent(slug);
            return url.href;
        }
        function masterAuth() {
            try {
                const now = Date.now(), gate = JSON.parse(win.sessionStorage.getItem(UNLOCK) || 'null');
                if (!gate || !Number.isFinite(gate.expiresAt) || gate.expiresAt <= now) return null;
                const auth = {[UNLOCK]:JSON.stringify({unlockedAt:gate.unlockedAt, expiresAt:gate.expiresAt})};
                let pw = null;
                try { pw = JSON.parse(win.sessionStorage.getItem(PASSWORD) || 'null'); } catch (_) {}
                if (pw && typeof pw.pw === 'string' && pw.pw && Number.isFinite(pw.expiresAt) && pw.expiresAt > now) {
                    auth[PASSWORD] = JSON.stringify({pw:pw.pw, expiresAt:pw.expiresAt});
                }
                return auth;
            } catch (_) { return null; }
        }
        function notify(message) {
            if (typeof win.showToast === 'function') win.showToast(message, 7000);
            else if (typeof win.alert === 'function') win.alert(message);
        }
        function openMaster(target, options) {
            let child = null, opened = false;
            try {
                const destination = masterUrl(target, options);
                const offline = win.DESI_OFFLINE === true;
                const auth = offline ? null : masterAuth();
                // Open only a new, empty, same-origin context. No application
                // script runs before copied share/Admin sessions are cleared.
                // noopener here would discard the handle needed for this step.
                child = win.open('about:blank', '_blank');
                if (!child || child.closed) {
                    notify(uiT("新しいタブを開けませんでした。このサイトのポップアップ設定を確認して、もう一度押してください。"));
                    return false;
                }
                opened = true;
                child.sessionStorage.clear();
                if (auth) for (const [key,value] of Object.entries(auth)) child.sessionStorage.setItem(key, value);
                child.opener = null;
                if (child.opener !== null) throw new Error('Could not detach the new tab');
                child.location.replace(offline || auth ? destination : masterLoginUrl(target, options));
                return true;
            } catch (_) {
                if (opened) { try { child.close(); } catch (_) {} }
                notify(uiT("新しいタブへの認証引き継ぎに失敗しました。元の画面はそのままです。ブラウザーの保存設定を確認して再試行してください。"));
                return false;
            }
        }
        function resumeMasterDestination() {
            try {
                const base = appBase(), current = new URL(win.location.href);
                if (current.origin !== base.origin || ![base.pathname,new URL('index.html',base).pathname].includes(current.pathname)) return false;
                const entries = [...current.searchParams.entries()];
                const targets = entries.filter(([key]) => key === 'openProject' || key === 'importProject');
                const refresh = current.searchParams.getAll('refresh');
                if (targets.length !== 1 || entries.length !== 1 + refresh.length) return false;
                const options = optionsFromRefresh(refresh, targets[0][0] === 'openProject');
                const [key,value] = targets[0];
                const target = key === 'openProject' ? {projectId:value} : {importSlug:value};
                const destination = masterUrl(target, options);
                if (win.DESI_OFFLINE !== true && !masterAuth()) return false;
                win.location.replace(destination);
                return true;
            } catch (_) { return false; }
        }
        return {masterUrl,shareUrl,masterLoginUrlFromViewer,resumeMasterDestination,openMaster};
    };
});
