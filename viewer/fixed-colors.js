(function(root){
  'use strict';

  // Seaborn's colorblind palette; fixed values require no runtime library.
  // https://github.com/mwaskom/seaborn/blob/v0.13.2/seaborn/palettes.py
  const colors = Object.freeze([
    {name:'青', hex:'#0173B2'}, {name:'黄橙', hex:'#DE8F05'},
    {name:'緑', hex:'#029E73'}, {name:'朱', hex:'#D55E00'},
    {name:'紫', hex:'#CC78BC'}, {name:'茶', hex:'#CA9161'},
    {name:'桃', hex:'#FBAFE4'}, {name:'灰', hex:'#949494'},
    {name:'黄', hex:'#ECE133'}, {name:'水色', hex:'#56B4E9'}
  ].map(Object.freeze));

  function normalizedHex(value){
    if(typeof value !== 'string') return null;
    const hex = value.trim();
    if(/^#[0-9a-f]{6}$/i.test(hex)) return hex.toUpperCase();
    if(/^#[0-9a-f]{3}$/i.test(hex)) return ('#' + [...hex.slice(1)].map(c=>c+c).join('')).toUpperCase();
    return null;
  }
  function isPreset(value){
    const hex = normalizedHex(value);
    return hex !== null && colors.some(color=>color.hex === hex);
  }
  function toRgba(value){
    const hex = normalizedHex(value);
    if(hex === null) return null;
    return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16), 255];
  }

  let panel = null;
  let parts = null;
  let active = null;
  let cleanup = [];

  const css = `
    .fixed-colors-picker { position:fixed; z-index:200000; width:270px; max-width:calc(100vw - 16px); box-sizing:border-box; padding:10px; border:1px solid #cbd5e1; border-radius:8px; background:#fff; color:#172033; box-shadow:0 7px 28px #0003; font:12px/1.4 system-ui,sans-serif; }
    .fixed-colors-picker[hidden] { display:none !important; }
    .fixed-colors-header { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; }
    .fixed-colors-title { font-weight:600; }
    .fixed-colors-picker button { font:inherit; cursor:pointer; touch-action:manipulation; box-sizing:border-box; }
    .fixed-colors-close { width:24px; height:24px; padding:0; border:1px solid transparent; border-radius:4px; background:transparent; color:#475569; font-size:18px !important; line-height:20px; }
    .fixed-colors-close:hover { background:#f1f5f9; }
    .fixed-colors-current { display:flex; align-items:center; gap:6px; margin:4px 0 9px; overflow-wrap:anywhere; }
    .fixed-colors-current-swatch { flex:0 0 14px; width:14px; height:14px; border:1px solid #64748b; border-radius:3px; box-sizing:border-box; }
    .fixed-colors-current-swatch.is-clear { background:linear-gradient(135deg,#fff 45%,#64748b 46%,#64748b 54%,#fff 55%); }
    .fixed-colors-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:6px; }
    .fixed-colors-option { display:flex; flex-direction:column; align-items:center; gap:3px; min-width:0; padding:5px 1px 3px; border:2px solid transparent; border-radius:5px; background:#fff; color:#172033; }
    .fixed-colors-option:hover { background:#f1f5f9; }
    .fixed-colors-option[aria-pressed="true"] { border-color:#334155; background:#f1f5f9; }
    .fixed-colors-swatch { display:flex; align-items:center; justify-content:center; width:26px; height:26px; border:1px solid #64748b; border-radius:4px; box-sizing:border-box; }
    .fixed-colors-check { color:#fff; text-shadow:0 1px 2px #000,1px 0 2px #000,-1px 0 2px #000; font-size:18px; font-weight:700; line-height:1; visibility:hidden; }
    .fixed-colors-option[aria-pressed="true"] .fixed-colors-check { visibility:visible; }
    .fixed-colors-picker button:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
    .fixed-colors-clear { width:100%; margin-top:8px; padding:5px; border:1px dashed #94a3b8; border-radius:4px; background:#fff; color:#334155; }
    .fixed-colors-clear[aria-pressed="true"] { border:2px solid #334155; }
    .fixed-colors-note { margin-top:8px; color:#64748b; font-size:11px; }
    .fixed-colors-note[hidden], .fixed-colors-clear[hidden] { display:none !important; }
  `;

  function element(tag, className, text){
    const el = root.document.createElement(tag);
    if(className) el.className = className;
    if(text !== undefined) el.textContent = text;
    return el;
  }
  function listen(target, type, handler, options){
    target.addEventListener(type, handler, options);
    cleanup.push(()=>target.removeEventListener(type, handler, options));
  }
  function validTarget(state = active){
    if(!state || !state.anchor || !state.anchor.isConnected) return false;
    try { return typeof state.isValid !== 'function' || state.isValid() !== false; }
    catch(_) { return false; }
  }
  function close({restoreFocus = true} = {}){
    const previous = active;
    active = null;
    cleanup.splice(0).forEach(remove=>remove());
    if(panel) panel.hidden = true;
    if(previous){
      const {anchor, originalExpanded, originalControls} = previous;
      if(originalExpanded === null) anchor.removeAttribute('aria-expanded');
      else anchor.setAttribute('aria-expanded', originalExpanded);
      if(originalControls === null) anchor.removeAttribute('aria-controls');
      else anchor.setAttribute('aria-controls', originalControls);
      if(restoreFocus && anchor.isConnected && typeof anchor.focus === 'function') anchor.focus({preventScroll:true});
    }
  }
  function select(value, event){
    if(event){ event.preventDefault(); event.stopPropagation(); }
    const state = active;
    if(!validTarget(state)){ close({restoreFocus:false}); return; }
    if(value === null && !state.allowClear) return;
    close();
    if(typeof state.onSelect === 'function') state.onSelect(value);
  }
  function focusColor(index){
    const selected = (index + colors.length) % colors.length;
    parts.options.forEach((button,i)=>{ button.tabIndex = i === selected ? 0 : -1; });
    parts.options[selected].focus({preventScroll:true});
  }
  function ensurePanel(){
    const doc = root.document;
    if(!doc.getElementById('fixed-colors-style')){
      const style = element('style');
      style.id = 'fixed-colors-style';
      style.textContent = css;
      (doc.head || doc.documentElement).appendChild(style);
    }
    if(panel){
      if(!panel.isConnected) doc.body.appendChild(panel);
      return;
    }
    panel = element('div', 'fixed-colors-picker');
    panel.id = 'fixed-colors-picker';
    panel.hidden = true;
    panel.setAttribute('role','dialog');
    panel.setAttribute('aria-labelledby','fixed-colors-title');
    const header = element('div','fixed-colors-header');
    const title = element('span','fixed-colors-title');
    title.id = 'fixed-colors-title';
    const dismiss = element('button','fixed-colors-close','×');
    dismiss.type = 'button';
    dismiss.title = '閉じる';
    dismiss.setAttribute('aria-label','色選択を閉じる');
    dismiss.addEventListener('click', event=>{ event.preventDefault(); event.stopPropagation(); close(); });
    header.append(title,dismiss);
    const current = element('div','fixed-colors-current');
    const swatch = element('span','fixed-colors-current-swatch');
    swatch.setAttribute('aria-hidden','true');
    const currentText = element('span');
    current.append(swatch,currentText);
    const grid = element('div','fixed-colors-grid');
    grid.setAttribute('role','group');
    grid.setAttribute('aria-label','固定10色');
    const options = colors.map((color,index)=>{
      const button = element('button','fixed-colors-option');
      button.type = 'button';
      button.title = `${color.name} (${color.hex})`;
      button.setAttribute('aria-label',`${color.name} ${color.hex}`);
      const chip = element('span','fixed-colors-swatch');
      chip.style.backgroundColor = color.hex;
      chip.setAttribute('aria-hidden','true');
      chip.appendChild(element('span','fixed-colors-check','✓'));
      button.append(chip,element('span','fixed-colors-name',color.name));
      button.addEventListener('click',event=>select(color.hex,event));
      button.addEventListener('keydown',event=>{
        const delta = {ArrowLeft:-1,ArrowRight:1,ArrowUp:-5,ArrowDown:5}[event.key];
        if(delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault(); event.stopPropagation();
        if(!validTarget()){ close({restoreFocus:false}); return; }
        focusColor(event.key === 'Home' ? 0 : event.key === 'End' ? colors.length-1 : index+delta);
      });
      grid.appendChild(button);
      return button;
    });
    const clear = element('button','fixed-colors-clear','色なし');
    clear.type = 'button';
    clear.setAttribute('aria-label','色なし（色の設定を解除）');
    clear.addEventListener('click',event=>select(null,event));
    const note = element('div','fixed-colors-note');
    panel.append(header,current,grid,clear,note);
    // Selecting a color must not also activate an underlying compound/ROI row.
    panel.addEventListener('pointerdown',event=>event.stopPropagation());
    panel.addEventListener('click',event=>event.stopPropagation());
    parts = {title,dismiss,currentText,swatch,options,clear,note};
    doc.body.appendChild(panel);
  }
  function position(anchor){
    const rect = anchor.getBoundingClientRect();
    const viewWidth = root.innerWidth || root.document.documentElement.clientWidth;
    const viewHeight = root.innerHeight || root.document.documentElement.clientHeight;
    panel.style.maxHeight = `${Math.max(80,viewHeight-16)}px`;
    panel.style.overflowY = 'auto';
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, viewWidth-width-8));
    const below = rect.bottom+6;
    const top = Math.max(8, Math.min(below+height <= viewHeight-8 ? below : rect.top-height-6, viewHeight-height-8));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }
  function open(options = {}){
    close({restoreFocus:false});
    if(!root.document || !root.document.body || !validTarget(options)) return false;
    ensurePanel();
    active = {...options,
      originalExpanded:options.anchor.getAttribute('aria-expanded'),
      originalControls:options.anchor.getAttribute('aria-controls')
    };
    active.anchor.setAttribute('aria-expanded','true');
    active.anchor.setAttribute('aria-controls',panel.id);
    const hex = normalizedHex(options.value);
    const selected = colors.findIndex(color=>color.hex === hex);
    const currentName = selected >= 0 ? `${colors[selected].name} (${hex})` : hex ? `カスタム (${hex})` : options.value ? 'カスタム（現在の色を保持）' : '色なし';
    parts.title.textContent = options.title || '色を選択';
    parts.currentText.textContent = `現在の色：${currentName}`;
    parts.swatch.classList.toggle('is-clear', !options.value);
    parts.swatch.style.backgroundColor = hex || '';
    parts.clear.hidden = !options.allowClear;
    parts.clear.setAttribute('aria-pressed',String(!options.value));
    parts.note.textContent = options.note || '';
    parts.note.hidden = !options.note;
    parts.options.forEach((button,i)=>{
      button.setAttribute('aria-pressed',String(i === selected));
      button.tabIndex = i === (selected >= 0 ? selected : 0) ? 0 : -1;
    });
    panel.hidden = false;
    position(active.anchor);
    const doc = root.document;
    listen(doc,'pointerdown',event=>{
      if(!validTarget()){ close({restoreFocus:false}); return; }
      if(!panel.contains(event.target) && !active.anchor.contains(event.target)) close({restoreFocus:false});
    },true);
    listen(doc,'keydown',event=>{
      if(!active) return;
      if(!validTarget()){ close({restoreFocus:false}); return; }
      if(event.key === 'Escape'){
        event.preventDefault(); event.stopPropagation(); close();
      }
    },true);
    listen(doc,'focusin',event=>{
      if(active && !panel.contains(event.target) && !active.anchor.contains(event.target)) close({restoreFocus:false});
    });
    listen(doc,'scroll',event=>{
      if(panel.contains(event.target)) return;
      close({restoreFocus:false});
    },true);
    listen(root,'resize',()=>close({restoreFocus:false}));
    if(typeof root.MutationObserver === 'function'){
      const observer = new root.MutationObserver(()=>{
        if(active && (!validTarget() || !panel.isConnected)) close({restoreFocus:false});
      });
      observer.observe(doc.documentElement,{childList:true,subtree:true});
      cleanup.push(()=>observer.disconnect());
    }
    if(options.allowClear && !options.value) parts.clear.focus({preventScroll:true});
    else focusColor(selected >= 0 ? selected : 0);
    return true;
  }

  const api = Object.freeze({colors,isPreset,toRgba,open,close});
  root.FixedColors = api;
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
