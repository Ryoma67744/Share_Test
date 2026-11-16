/* Explicit UI translations. Project values, form values and unmarked DOM are never translated. */
(function (global) {
  'use strict';
  const STORAGE_KEY = 'desi:ui:lang';
  const LEGACY_KEYS = ['desi:help:lang', 'desi:helpLang'];
  const catalogs = new Map(), translations = new Map(), missing = new Set(), conflicts = new Map();
  const listeners = new Set(), bindings = new Set(), nodeBindings = new WeakMap();
  // The iterable index must not retain parameter closures. The node-keyed
  // WeakMap owns records; the index and finalizer hold only weak references.
  const bindingFinalizer = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(handle => bindings.delete(handle)) : null;
  const attributes = ['title', 'placeholder', 'aria-label', 'alt'];
  const selector = ['[data-i18n]', '[data-i18n-switch]', ...attributes.map(name => '[data-i18n-' + name + ']')].join(',');
  let started = false;
  function valid(value) { return value === 'ja' || value === 'en'; }
  function readLocale() {
    try { for (const key of [STORAGE_KEY, ...LEGACY_KEYS]) { const value = global.localStorage.getItem(key); if (valid(value)) return value; } } catch (_) {}
    return 'ja';
  }
  let locale = readLocale();
  function scopedText(namespace,source){const catalog=namespace&&catalogs.get(namespace);return catalog&&Object.prototype.hasOwnProperty.call(catalog,source)?catalog[source]:undefined;}
  function paramsText(source, params) {
    if (typeof params === 'function') params = params();
    if (params == null) return source;
    return source.replace(/\{([\w]+)\}/g, (token, key) => Object.prototype.hasOwnProperty.call(params, key) ? String(params[key] == null ? '' : params[key]) : token);
  }
  function translate(language, source, params, trackMissing, namespace) {
    source = String(source == null ? '' : source);
    const scoped = scopedText(namespace,source);
    const translated = scoped ? {text:scoped} : translations.get(source);
    if (trackMissing && language === 'en' && !translated && /[\u3040-\u30ff\u3400-\u9fff]/.test(source)) missing.add(source);
    return paramsText(language === 'en' && translated ? translated.text : source, params);
  }
  function t(source, params, namespace) { return translate(locale, source, params, true, namespace); }
  function tFor(language, source, params, namespace) { return translate(valid(language) ? language : 'ja', source, params, false, namespace); }
  function escape(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character])); }
  function html(source, params, namespace) {
    return '<span data-i18n="' + escape(source) + '"' + (namespace ? ' data-i18n-namespace="'+escape(namespace)+'"' : '') + (params == null ? '' : ' data-i18n-params="' + escape(JSON.stringify(params)) + '"') + '>' + escape(t(source, params, namespace)) + '</span>';
  }
  function attr(name, source, params, namespace) {
    if (!attributes.includes(name)) throw new TypeError('Only UI text attributes can be translated');
    return name + '="' + escape(t(source, params, namespace)) + '" data-i18n-' + name + '="' + escape(source) + '"' + (namespace ? ' data-i18n-'+name+'-namespace="'+escape(namespace)+'"' : '')
      + (params == null ? '' : ' data-i18n-' + name + '-params="' + escape(JSON.stringify(params)) + '"');
  }
  function register(namespace, entries, options) {
    if (typeof namespace !== 'string' || !namespace || !entries || typeof entries !== 'object' || Array.isArray(entries)) throw new TypeError('Invalid UI translation catalog');
    for (const [source, text] of Object.entries(entries)) {
      if (typeof text !== 'string' || !text.trim()) throw new TypeError('Invalid UI translation: ' + source);
      if(options?.scoped)continue;
      const previous = translations.get(source);
      if (previous && previous.text !== text) conflicts.set(source, {source, previous:previous.text, next:text, namespaces:[previous.namespace, namespace]});
      // Page-specific wording takes precedence over the shared fallback catalog.
      if (!previous || namespace !== 'common' || previous.namespace === 'common') translations.set(source, {text, namespace});
      missing.delete(source);
    }
    catalogs.set(namespace, Object.freeze({...entries}));
    if (started) refresh();
  }
  function applyBinding(binding) {
    const node = binding.ref.deref();
    if (!node) { releaseBinding(binding); return; }
    const current = binding.attribute ? node.getAttribute(binding.attribute) : node.textContent;
    // Imperative bindings stop owning a field after unrelated code replaces it.
    // A later language switch must never resurrect an old status or user value.
    if (!binding.declarative && binding.lastValue !== undefined && current !== binding.lastValue) {
      releaseBinding(binding);nodeBindings.get(node)?.delete(binding.attribute || '#text');return;
    }
    const value = t(binding.source, binding.params, binding.namespace);
    if (binding.attribute) { if (node.getAttribute(binding.attribute) !== value) node.setAttribute(binding.attribute, value); }
    else if (node.textContent !== value) node.textContent = value;
    binding.lastValue = value;
  }
  function releaseBinding(binding){bindings.delete(binding.handle);bindingFinalizer?.unregister(binding);}
  function bind(node, attribute, source, params, declarative, namespace) {
    if (!node || (attribute ? typeof node.setAttribute !== 'function' : !('textContent' in node))) throw new TypeError('A DOM node is required for UI translation');
    if (!declarative && node.removeAttribute) { const marker=attribute?'data-i18n-'+attribute:'data-i18n';node.removeAttribute(marker);node.removeAttribute(marker+'-params'); }
    let records = nodeBindings.get(node);
    if (!records) { records = new Map(); nodeBindings.set(node, records); }
    const key = attribute || '#text';
    let binding = records.get(key);
    if (!binding) { binding = {ref:new WeakRef(node), attribute};binding.handle=new WeakRef(binding);records.set(key, binding);bindings.add(binding.handle);bindingFinalizer?.register(node,binding.handle,binding); }
    binding.source = String(source == null ? '' : source); binding.params = params;binding.namespace=namespace;
    binding.declarative = !!declarative;binding.lastValue = undefined;
    applyBinding(binding);
    return node;
  }
  function setText(node, source, params, namespace) { return bind(node, null, source, params, false, namespace); }
  function clearBinding(node, attribute) {
    const records = nodeBindings.get(node);if(!records)return;
    const keys = attribute === undefined ? [...records.keys()] : [attribute || '#text'];
    for(const key of keys){const binding=records.get(key);if(!binding)continue;releaseBinding(binding);records.delete(key);
      if(node.removeAttribute){const marker=key==='#text'?'data-i18n':'data-i18n-'+key;node.removeAttribute(marker);node.removeAttribute(marker+'-params');}}
  }
  function setAttribute(node, name, source, params, namespace) {
    if (!attributes.includes(name)) throw new TypeError('Only UI text attributes can be translated');
    return bind(node, name, source, params, false, namespace);
  }
  function readParams(node, attribute) {
    const value = (attribute && node.getAttribute('data-i18n-' + attribute + '-params')) || node.getAttribute('data-i18n-params');
    if (!value) return undefined;
    try { const params = JSON.parse(value); return params && typeof params === 'object' ? params : undefined; } catch (_) { return undefined; }
  }
  function applyElement(node) {
    const records=nodeBindings.get(node);
    if(records)for(const [key,binding] of records)if(binding.declarative&&!node.hasAttribute(key==='#text'?'data-i18n':'data-i18n-'+key)){releaseBinding(binding);records.delete(key);}
    const params = readParams(node);
    const namespace=node.closest?.('[data-i18n-namespace]')?.getAttribute('data-i18n-namespace');
    if (node.hasAttribute('data-i18n')) bind(node, null, node.getAttribute('data-i18n'), params, true, namespace);
    for (const attribute of attributes) if (node.hasAttribute('data-i18n-' + attribute)) bind(node, attribute, node.getAttribute('data-i18n-' + attribute), readParams(node, attribute), true, node.getAttribute('data-i18n-'+attribute+'-namespace')||namespace);
    if (node.hasAttribute('data-i18n-switch')) {
      if (node.tagName === 'SELECT') {
        node.value = locale;
        if (!node.__appI18nConnected) { node.__appI18nConnected = true; node.addEventListener('change', () => setLocale(node.value)); }
      } else {
        node.textContent = locale === 'ja' ? 'English' : '日本語';
        node.setAttribute('aria-label', locale === 'ja' ? 'Switch to English' : '日本語に切り替え');
        if (!node.__appI18nConnected) { node.__appI18nConnected = true; node.addEventListener('click', () => setLocale(locale === 'ja' ? 'en' : 'ja')); }
      }
    }
  }
  function refresh(root) {
    const target = root || global.document;
    if (!target) return;
    if (target.nodeType === 1 && target.matches(selector)) applyElement(target);
    if (target.querySelectorAll) for (const node of target.querySelectorAll(selector)) applyElement(node);
    if (!root) for (const handle of bindings) {const binding=handle.deref();if(binding)applyBinding(binding);else bindings.delete(handle);}
  }
  function setLocale(value, options) {
    if (!valid(value)) return false;
    const changed = value !== locale; locale = value;
    if (!options || options.persist !== false) { try { for (const key of [STORAGE_KEY, ...LEGACY_KEYS]) global.localStorage.setItem(key, locale); } catch (_) {} }
    if (global.document && global.document.documentElement) global.document.documentElement.lang = locale;
    refresh();
    if (changed) {
      for (const listener of [...listeners]) { try { listener(locale); } catch (error) { if (global.console) global.console.error(error); } }
      if (global.dispatchEvent && typeof global.CustomEvent === 'function') global.dispatchEvent(new global.CustomEvent('app-language-change', {detail:{locale}}));
    }
    return true;
  }
  function onChange(listener) { if (typeof listener !== 'function') throw new TypeError('A language listener is required'); listeners.add(listener); return () => listeners.delete(listener); }
  function createSwitcher(container) {
    const select = global.document.createElement('select');
    select.setAttribute('data-i18n-switch', ''); select.setAttribute('aria-label', 'Language / 言語');
    select.className = 'app-language-switch';
    for (const [value, label] of [['ja','日本語'],['en','English']]) { const option = global.document.createElement('option'); option.value = value; option.textContent = label; select.append(option); }
    applyElement(select); if (container) container.append(select); return select;
  }
  function start() {
    if (started || !global.document) return; started = true;
    global.document.documentElement.lang = locale; refresh();
    if (global.MutationObserver) new global.MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') { applyElement(record.target);if(record.attributeName==='data-i18n-namespace')refresh(record.target); }
        else for (const node of record.addedNodes) if (node.nodeType === 1) refresh(node);
      }
    }).observe(global.document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:['data-i18n', 'data-i18n-params', 'data-i18n-switch', 'data-i18n-namespace', ...attributes.flatMap(name => ['data-i18n-' + name, 'data-i18n-' + name + '-params', 'data-i18n-'+name+'-namespace'])]});
  }
  global.AppI18n = Object.freeze({register, t, tFor, html, span:html, attr, setText, setAttribute, clearBinding, getLocale:() => locale, setLocale, onChange, refresh, createSwitcher,
    hasTranslation:(source,namespace) => !!scopedText(namespace,source)||translations.has(source), getMissingKeys:() => [...missing].sort(), clearMissingKeys:() => missing.clear(),
    getConflicts:() => [...conflicts.values()], getCatalogNames:() => [...catalogs.keys()]});
  if (global.document) { if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start, {once:true}); else start(); }
  if (global.addEventListener) global.addEventListener('storage', event => { if (event.key === STORAGE_KEY && valid(event.newValue)) setLocale(event.newValue, {persist:false}); });
})(typeof window !== 'undefined' ? window : globalThis);
