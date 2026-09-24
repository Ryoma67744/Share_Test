'use strict';
// Small event-capable DOM for the real fixed-color picker. This models event
// dispatch and focus; it does not claim to exercise browser layout/painting.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { html, standalone } = require('./viewer-runtime.cjs');

function sourceFunction(name) {
  const start = html.indexOf('function ' + name + '(');
  return (html.slice(start - 6, start) === 'async ' ? 'async ' : '') + standalone(name);
}
function defaultPaletteSource() {
  const start = html.indexOf('const DEFAULT_ANATOMY_PALETTE = {');
  return html.slice(start, html.indexOf('\n};', start) + 3);
}
function loadFixedColors(context) {
  if (!context.window) context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/fixed-colors.js'), 'utf8'), context);
  context.FixedColors = context.FixedColors || context.window.FixedColors;
  return context.FixedColors;
}
function dom() {
  let document;
  function eventTarget(target) {
    const listeners = new Map();
    target.addEventListener = (type, handler, options) => {
      const entries = listeners.get(type) || [];
      entries.push({ handler, capture: options === true || !!(options && options.capture) });
      listeners.set(type, entries);
    };
    target.removeEventListener = (type, handler) => {
      listeners.set(type, (listeners.get(type) || []).filter(entry => entry.handler !== handler));
    };
    target._fire = (type, event, capture) => {
      for (const entry of [...(listeners.get(type) || [])]) {
        if (capture == null || entry.capture === capture) entry.handler.call(target, event);
      }
    };
    return target;
  }
  function matches(node, selector) {
    if (selector.includes(',')) return selector.split(',').some(part => matches(node, part.trim()));
    const attr = selector.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
    if (attr) return node.hasAttribute(attr[1]) && (attr[2] == null || node.getAttribute(attr[1]) === attr[2]);
    const parsed = selector.match(/^([\w-]+)?(?:\.([\w-]+))?(?:#([\w-]+))?$/);
    if (!parsed) throw new Error('Unsupported test DOM selector: ' + selector);
    return (!parsed[1] || node.tagName === parsed[1].toUpperCase()) &&
      (!parsed[2] || node.classList.contains(parsed[2])) && (!parsed[3] || node.id === parsed[3]);
  }
  function element(tag = 'div') {
    const attributes = {};
    const node = eventTarget({
      tagName: tag.toUpperCase(), children: [], parentNode: null, dataset: {},
      style: { setProperty(key, value) { this[key] = value; } }, hidden: false,
      className: '', textContent: '', tabIndex: -1, disabled: false,
      appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        this.children.push(child); child.parentNode = this; return child;
      },
      append(...children) { children.forEach(child => this.appendChild(child)); },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index < 0) throw new Error('Child not found');
        this.children.splice(index, 1); child.parentNode = null; return child;
      },
      replaceChildren(...children) { [...this.children].forEach(child => this.removeChild(child)); this.append(...children); },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      contains(other) { return this === other || this.children.some(child => child.contains(other)); },
      setAttribute(name, value) {
        attributes[name] = String(value);
        if (name === 'class') this.className = String(value);
        if (name === 'id') this.id = String(value);
        if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      },
      getAttribute(name) { return name === 'class' ? this.className : name === 'id' ? this.id || null : attributes[name] ?? null; },
      hasAttribute(name) { return this.getAttribute(name) != null; },
      removeAttribute(name) { delete attributes[name]; },
      matches(selector) { return matches(this, selector); },
      closest(selector) { return this.matches(selector) ? this : this.parentNode && this.parentNode.closest ? this.parentNode.closest(selector) : null; },
      querySelectorAll(selector) {
        return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      getBoundingClientRect() { return this.rect || { left: 20, top: 20, right: 40, bottom: 40, width: 20, height: 20 }; },
      focus() { document.activeElement = this; },
      click() { if (!this.disabled) dispatch(this, 'click'); },
    });
    node.classList = {
      contains: value => node.className.split(/\s+/).includes(value),
      add(...values) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...values])].join(' '); },
      remove(...values) { node.className = node.className.split(/\s+/).filter(value => !values.includes(value)).join(' '); },
      toggle(value, force) { const on = force == null ? !this.contains(value) : force; if (on) this.add(value); else this.remove(value); return on; },
    };
    Object.defineProperties(node, {
      isConnected: { get: () => !!document && document.documentElement.contains(node) },
      firstChild: { get: () => node.children[0] || null },
      firstElementChild: { get: () => node.children[0] || null },
      innerHTML: { get: () => '', set: () => node.replaceChildren() },
      offsetWidth: { get: () => 250 }, offsetHeight: { get: () => 190 },
    });
    return node;
  }
  document = eventTarget({ createElement: element });
  document.documentElement = element('html');
  document.body = element('body');
  document.documentElement.append(document.body);
  document.documentElement.clientWidth = 1000;
  document.documentElement.clientHeight = 800;
  document.getElementById = id => document.documentElement.querySelector('#' + id);
  document.querySelectorAll = selector => document.documentElement.querySelectorAll(selector);
  document.querySelector = selector => document.documentElement.querySelector(selector);
  const window = eventTarget({ document, innerWidth: 1000, innerHeight: 800 });
  function dispatch(target, type, properties = {}) {
    const event = { target, type, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...properties };
    const path = []; for (let node = target; node; node = node.parentNode) path.push(node);
    if (!path.includes(document)) path.push(document);
    for (const node of [...path].reverse()) {
      node._fire(type, event, true);
      if (event.propagationStopped) return event;
    }
    for (const node of path) {
      node._fire(type, event, false);
      if (event.propagationStopped) break;
    }
    return event;
  }
  return { document, window, element, dispatch };
}

module.exports = { dom, loadFixedColors, sourceFunction, defaultPaletteSource };
