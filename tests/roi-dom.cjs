'use strict';
// Minimal DOM geometry for exercising the production ROI renderer in Node.
// Layout is modeled here; pixel rasterization is tested separately.
function element(tagName = 'div') {
  const node = {
    tagName, children: [], dataset: {}, attributes: {}, style: { setProperty(k, v) { this[k] = v; } },
    textContent: '', classList: { add() {}, remove() {}, toggle() {} }, listeners: {},
    addEventListener(name, handler) { this.listeners[name] = handler; },
    removeEventListener(name) { delete this.listeners[name]; },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    append(...children) { children.forEach(child => this.appendChild(child)); },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...(child.tagName === selector ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    },
    _html: '',
  };
  Object.defineProperties(node, {
    innerHTML: { get() { return this._html; }, set(value) { this._html = value; this.children = []; } },
    firstChild: { get() { return this.children[0] || null; } },
  });
  return node;
}

class Matrix {
  constructor(value) {
    const v = value ? (typeof value === 'string' ? value.match(/matrix\(([^)]+)\)/)[1].split(',').map(Number) : value) : [1, 0, 0, 1, 0, 0];
    [this.a, this.b, this.c, this.d, this.e, this.f] = v;
  }
  inverse() {
    const { a, b, c, d, e, f } = this, determinant = a * d - b * c;
    return new Matrix([d / determinant, -b / determinant, -c / determinant, a / determinant,
      (c * f - d * e) / determinant, (b * e - a * f) / determinant]);
  }
  transformPoint({ x, y }) { return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f }; }
}
const geometryGlobals = {
  DOMMatrixReadOnly: Matrix,
  DOMPoint: class { constructor(x, y) { this.x = x; this.y = y; } },
  getComputedStyle: node => ({ transform: node._transform || 'none', transformOrigin: node._transformOrigin || '50% 50%',
    width: node.style.width, height: node.style.height }),
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
};
function roiDom(width = 100, height = 100, options = {}) {
  const host = element(), rot = element(), croi = element('canvas');
  const rect = { left: 0, top: 0, width, height, ...options.rect };
  host.clientWidth = rect.width; host.clientHeight = rect.height;
  host.getBoundingClientRect = () => ({ ...rect });
  rot._transform = options.transform || 'none';
  rot.getBoundingClientRect = host.getBoundingClientRect;
  Object.assign(croi, { width, height, offsetWidth: rect.width, offsetHeight: rect.height });
  Object.assign(croi.style, { left: '0px', top: '0px', width: rect.width + 'px', height: rect.height + 'px', ...options.css });
  const roiSvg = element('svg'), roiSaved = element('g'), roiPreview = element('g');
  roiSvg.append(roiSaved, roiPreview); host.append(rot, roiSvg); rot.append(croi);
  return { host, rot, croi, roiSvg, roiSaved, roiPreview };
}
function svgPoints(node) {
  return (node.getAttribute('points') || '').trim().split(/\s+/).filter(Boolean).map(pair => pair.split(',').map(Number));
}
function svgMarkup(node) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const attrs = Object.entries(node.attributes).map(([name, value]) => ` ${name}="${escape(value)}"`).join('');
  return `<${node.tagName}${attrs}>${node.children.map(svgMarkup).join('')}</${node.tagName}>`;
}
module.exports = { element, geometryGlobals, roiDom, svgPoints, svgMarkup };
