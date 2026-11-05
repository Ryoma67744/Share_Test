(function (global) {
  'use strict';
  const script = document.currentScript;
  const base = new URL('.', script && script.src || location.href);
  let manifestPromise, active;
  const words = {
    ja: { title:'操作ガイド', search:'機能を検索', close:'閉じる', operations:'操作手順', statistics:'集計への影響', save:'保存と共有', previous:'前の章', next:'次の章', image:'画像を拡大', detail:'詳しいガイドを読む', empty:'該当する章はありません。', offline:'オフライン', online:'オンライン', master:'作成者', viewer:'共有・閲覧者', admin:'共有・管理者', manage:'プロジェクト管理', role:'表示するガイド', error:'ガイドを読み込めませんでした。ページを再読み込みしてください。', shot:'実際の画面（サンプルデータ）', caption:'画面のボタン名はアプリの表示言語に従います。', print:'印刷 / PDF', all:'全章を印刷', scope:'このガイドで説明する操作権限', local:'表示の調整は元データを書き換えません。', back:'ガイドへ戻る' },
    en: { title:'User guide', search:'Search features', close:'Close', operations:'Steps', statistics:'Effect on results', save:'Save and share', previous:'Previous', next:'Next', image:'Enlarge image', detail:'Read the detailed guide', empty:'No matching chapters.', offline:'Offline', online:'Online', master:'Author', viewer:'Shared viewer', admin:'Shared administrator', manage:'Project manager', role:'Guide audience', error:'The guide could not be loaded. Reload the page and try again.', shot:'Actual application · sample data', caption:'Button labels follow the application interface language.', print:'Print / PDF', all:'Print all chapters', scope:'Permissions described in this guide', local:'Display adjustments do not modify source data.', back:'Back to guide' }
  };
  function asset(relative) {
    if (typeof relative !== 'string' || !/^docs\/help\/[\w./-]+$/.test(relative) || relative.split('/').some(part=>part==='..'||part==='')) throw new Error('Invalid Help asset');
    const url = new URL(relative, base);
    if (url.origin !== base.origin || !url.href.startsWith(base.href)) throw new Error('Help asset outside application');
    return url.href;
  }
  function node(tag, attrs, text) {
    const e=document.createElement(tag);
    for (const [key,value] of Object.entries(attrs||{})) if(key==='class') e.className=value; else e.setAttribute(key,value);
    if(text!=null)e.textContent=text;return e;
  }
  function tx(value,lang) { return typeof value==='string'?value:(value&&value[lang]||value&&value.ja||''); }
  function load() { return manifestPromise || (manifestPromise=fetch(asset('docs/help/manifest.json')).then(r=>{if(!r.ok)throw new Error('Help HTTP '+r.status);return r.json();}).catch(e=>{manifestPromise=null;throw e;})); }
  const libraries=new Map();
  function library(file,ready){if(ready())return Promise.resolve();if(!libraries.has(file))libraries.set(file,new Promise((resolve,reject)=>{const tag=node('script',{src:new URL('vendor/'+file,base).href});tag.onload=()=>ready()?resolve():reject(new Error('Help library unavailable'));tag.onerror=()=>reject(new Error('Help library failed'));document.head.append(tag);}).catch(e=>{libraries.delete(file);throw e;}));return libraries.get(file);}
  function remembered(key,fallback) {try{return localStorage.getItem('desi:help:'+key)||fallback;}catch{return fallback;}}
  function remember(key,value) {try{localStorage.setItem('desi:help:'+key,value);}catch{}}
  function guidePath(role,lang) {return 'USER_GUIDE'+(role==='manage'?'.manage':role==='master'?'.master':'')+(lang==='en'?'.en':'')+'.md';}
  function close() {if(active)active.close();}
  async function open(options={}) {
    close();
    const prior=document.activeElement, standalone=!!options.container;
    let lang=options.lang==='en'?'en':options.lang==='ja'?'ja':remembered('lang','ja');
    if(!['ja','en'].includes(lang))lang='ja';
    let role=['manage','master','viewer','admin'].includes(options.role)?options.role:(options.audience==='manage'?'manage':options.audience==='viewer'?'viewer':'master');
    const locked=role==='viewer'||role==='admin', mode=options.mode==='offline'||(!options.mode&&global.DESI_OFFLINE)?'offline':'online';
    let chapter=options.chapter||'start', tab='operations', search='', data;
    const host=node('div',{class:'guided-help'+(standalone?' gh-standalone':''),...(standalone?{}:{role:'dialog','aria-modal':'true','aria-label':words[lang].title})});
    const shell=node('div',{class:'gh-shell'});host.append(shell);
    const oldOverflow=document.body.style.overflow;
    if(standalone)options.container.replaceChildren(host);else{document.body.append(host);document.body.style.overflow='hidden';}
    const state={close(){document.removeEventListener('keydown',key,true);host.remove();if(!standalone)document.body.style.overflow=oldOverflow;if(prior&&prior.isConnected)prior.focus();if(active===state)active=null;}};active=state;
    function key(e){if(!host.isConnected)return;if(e.key==='Escape'&&!standalone){e.preventDefault();e.stopImmediatePropagation();close();}if(e.key==='Tab'&&!standalone){const items=[...host.querySelectorAll('button,input,select,a[href],[tabindex="0"]')].filter(el=>!el.disabled&&el.getClientRects().length);const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last&&last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first&&first.focus();}}}
    document.addEventListener('keydown',key,true);
    function available(){return data.chapters.filter(c=>!c.roles||c.roles.includes(role));}
    function go(id){chapter=id;tab='operations';render();shell.querySelector('.gh-main')?.focus();}
    async function detailed(main){
      main.replaceChildren(node('p',{},lang==='ja'?'詳しいガイドを読み込み中…':'Loading the detailed guide…'));
      try{
        const [response]=await Promise.all([fetch(new URL(guidePath(role,lang),base)),library('marked.min.js',()=>!!global.marked),library('purify.min.js',()=>!!global.DOMPurify)]);
        if(!response.ok)throw new Error('Guide HTTP '+response.status);
        const source=await response.text();if(!main.isConnected)return;
        const body=node('article',{class:'gh-detailed'});body.innerHTML=global.DOMPurify.sanitize(global.marked.parse(source),{USE_PROFILES:{html:true}});
        // Relative images are rooted at the guide, never at /viewer/. Keep all
        // guide media local and leave the main application's URL hash alone.
        for(const img of body.querySelectorAll('img')){try{img.src=asset(img.getAttribute('src'));}catch{img.remove();}}
        const usedIds=new Set([...body.querySelectorAll('[id]')].map(el=>el.id));let heading=0;for(const h of body.querySelectorAll('h1,h2,h3,h4'))if(!h.id){const stem=h.textContent.trim().toLowerCase().replace(/\s+/g,'-').replace(/[^\p{L}\p{N}_-]/gu,'')||'gh-detail-'+(++heading);let id=stem,n=0;while(usedIds.has(id))id=stem+'-'+(++n);h.id=id;usedIds.add(id);}
        for(const a of body.querySelectorAll('a[href]')){const href=a.getAttribute('href');if(href.startsWith('#')){a.onclick=e=>{e.preventDefault();let id;try{id=decodeURIComponent(href.slice(1));}catch{return;}[...body.querySelectorAll('[id]')].find(el=>el.id===id)?.scrollIntoView();};}else{const url=new URL(href,base);if(!['http:','https:'].includes(url.protocol)){a.removeAttribute('href');continue;}a.href=url.href;a.target='_blank';a.rel='noopener';}}
        const back=node('button',{type:'button'},words[lang].back);back.onclick=render;main.replaceChildren(back,body);main.scrollTop=0;back.focus();
      }catch(e){if(main.isConnected){main.replaceChildren(node('p',{role:'alert'},words[lang].error));const back=node('button',{type:'button'},words[lang].back);back.onclick=render;main.append(back);}console.error(e);}
    }
    function paragraph(parent,text,className){if(text)parent.append(node('p',className?{class:className}:null,tx(text,lang)));}
    function content(c, parent, printAll=false){
      const w=words[lang];
      const header=node('header',{class:'gh-chapter-header'});header.append(node('span',{class:'gh-eyebrow'},'SHARE_TEST / '+String(data.chapters.indexOf(c)+1).padStart(2,'0')),node('h1',{},tx(c.title,lang)));paragraph(header,c.summary);parent.append(header);
      if(c.notes&&c.notes[mode])paragraph(parent,c.notes[mode],'gh-notice');
      if(c.notes&&c.notes[role])paragraph(parent,c.notes[role],'gh-notice');
      if(!printAll){const tabs=node('div',{class:'gh-tabs',role:'tablist','aria-label':tx(c.title,lang)});for(const name of ['operations','statistics','save']){const button=node('button',{type:'button',role:'tab','aria-selected':String(tab===name),class:tab===name?'is-active':''},w[name]);button.onclick=()=>{tab=name;render();shell.querySelector('[role="tab"][aria-selected="true"]')?.focus();};tabs.append(button);}parent.append(tabs);}
      const tabsToShow=printAll?['operations','statistics','save']:[tab];
      for(const name of tabsToShow){const section=node('section',{class:'gh-section',...(printAll?{}:{role:'tabpanel'})});if(printAll)section.append(node('h2',{},w[name]));
        if(name==='operations'){
          const steps=node('ol',{class:'gh-steps'});for(const [index,step] of c.steps.entries()){const li=node('li');li.append(node('span',{class:'gh-step-number','aria-hidden':'true'},String(index+1)));const copy=node('div');copy.append(node('h2',{},tx(step.title,lang)));paragraph(copy,step.body);li.append(copy);steps.append(li);}section.append(steps);
          for(const shotId of c.screenshots||[]){const shot=data.screenshots.find(s=>s.id===shotId);if(!shot)continue;const figure=node('figure',{class:'gh-figure'});const a=node('a',{href:asset(shot.path),target:'_blank',rel:'noopener','aria-label':w.image});const img=node('img',{src:asset(shot.path),alt:tx(shot.alt,lang),loading:printAll?'eager':'lazy',width:String(shot.width||1440),height:String(shot.height||900)});a.append(img);figure.append(a);figure.append(node('figcaption',{},w.shot+' — '+tx(shot.caption,lang)));section.append(figure);}
          paragraph(section,c.result,'gh-result');
          const details=node('details',{class:'gh-coverage'});details.append(node('summary',{},lang==='ja'?'この章で扱う機能':'Features in this chapter'));const list=node('ul');for(const feature of c.features||[])list.append(node('li',{},tx(feature,lang)));details.append(list);section.append(details);
        }else{for(const text of c[name]||[])paragraph(section,text);}
        parent.append(section);
      }
    }
    function render(){
      if(!host.isConnected)return;const w=words[lang], chapters=available();
      if(!chapters.some(c=>c.id===chapter))chapter=chapters[0].id;
      shell.replaceChildren();host.lang=lang;
      const top=node('header',{class:'gh-top'});top.append(node('strong',{},'SHARE_TEST'),node('span',{class:'gh-title'},w.title));
      const badge=node('span',{class:'gh-context'},w[mode]+' · '+w[role]);top.append(badge);
      const select=node('select',{'aria-label':w.role});for(const value of locked?[role]:['manage','master','viewer','admin'])select.append(node('option',{value,...(value===role?{selected:''}:{})},w[value]));select.disabled=locked;select.onchange=()=>{role=select.value;render();};top.append(select);
      const language=node('button',{type:'button',class:'gh-language','aria-label':lang==='ja'?'Switch to English':'日本語に切り替え'},lang==='ja'?'EN':'日本語');language.onclick=()=>{lang=lang==='ja'?'en':'ja';remember('lang',lang);render();};top.append(language);
      const print=node('button',{type:'button'},w.print);print.onclick=()=>{const region=node('div',{class:'gh-print'});for(const c of chapters){const article=node('article');content(c,article,true);region.append(article);}host.append(region);Promise.all([...region.querySelectorAll('img')].map(img=>img.decode().catch(()=>{}))).then(()=>{global.print();region.remove();});};top.append(print);
      if(!standalone){const b=node('button',{type:'button',class:'gh-close','aria-label':w.close},'×');b.onclick=close;top.append(b);}shell.append(top);
      const grid=node('div',{class:'gh-grid'}),aside=node('aside',{class:'gh-sidebar'});const label=node('label',{class:'gh-search-label'},w.search);const input=node('input',{type:'search',value:search,placeholder:w.search,'aria-label':w.search});label.append(input);aside.append(label);
      const nav=node('nav',{'aria-label':w.title});const filtered=chapters.filter(c=>[tx(c.title,lang),tx(c.summary,lang),...(c.features||[]).map(f=>tx(f,lang))].join(' ').toLowerCase().includes(search.toLowerCase()));
      for(const c of filtered){const b=node('button',{type:'button','data-help-chapter':c.id,class:c.id===chapter?'is-active':'',...(c.id===chapter?{'aria-current':'page'}:{})});b.append(node('span',{},String(data.chapters.indexOf(c)+1).padStart(2,'0')),node('span',{},tx(c.title,lang)));b.onclick=()=>go(c.id);nav.append(b);}if(!filtered.length)nav.append(node('p',{},w.empty));aside.append(nav);paragraph(aside,{ja:'いつでも Help に戻れます。操作中のプロジェクトは開いたままです。',en:'Your project stays open while you use Help.'},'gh-sidebar-note');grid.append(aside);
      input.oninput=()=>{search=input.value;const start=input.selectionStart;render();const next=shell.querySelector('input');next.focus();try{next.setSelectionRange(start,start);}catch{}};
      const main=node('main',{class:'gh-main',tabindex:'0'});content(chapters.find(c=>c.id===chapter),main);const footer=node('footer',{class:'gh-footer'});const index=chapters.findIndex(c=>c.id===chapter);for(const [offset,label] of [[-1,w.previous],[1,w.next]]){const b=node('button',{type:'button',...(chapters[index+offset]?{}:{disabled:''})},label);b.onclick=()=>chapters[index+offset]&&go(chapters[index+offset].id);footer.append(b);}const link=node('a',{href:new URL(guidePath(role,lang),base).href},w.detail);link.onclick=e=>{e.preventDefault();void detailed(main);};footer.append(link);main.append(footer);grid.append(main);shell.append(grid);
    }
    shell.append(node('p',{class:'gh-loading'},lang==='ja'?'ガイドを読み込み中…':'Loading guide…'));
    try{data=await load();if(active!==state)return;render();shell.querySelector('input')?.focus();}catch(e){shell.replaceChildren(node('p',{role:'alert'},words[lang].error));const b=node('button',{type:'button'},words[lang].close);b.onclick=close;shell.append(b);console.error(e);}
    return state;
  }
  global.GuidedHelp=Object.freeze({open,close,asset});
  document.addEventListener('DOMContentLoaded',()=>{const container=document.querySelector('[data-guided-help]');if(container){const p=new URLSearchParams(location.search);open({container,chapter:p.get('chapter')||'start',lang:p.get('lang'),role:p.get('role')||'master',mode:p.get('mode')|| (global.DESI_OFFLINE?'offline':'online')});}});
})(window);
