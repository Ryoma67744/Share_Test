'use strict';
// The manifest is the common source for interactive Help, the six Markdown
// supplements and the self-contained offline HOW_TO_USE document.
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const START='<!-- GUIDED_HELP_START -->',END='<!-- GUIDED_HELP_END -->';
const t=(value,lang)=>typeof value==='string'?value:value[lang];
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function manifest(root){return JSON.parse(fs.readFileSync(path.join(root,'docs/help/manifest.json'),'utf8'));}
function chapters(data,role){return data.chapters.filter(c=>!c.roles||c.roles.includes(role));}
function markdown(root,role,lang,mode='online'){
  const data=manifest(root),lines=[START,'',lang==='ja'?'## 実画面でたどる操作ガイド':'## Step-by-step guide with actual screenshots','',
    lang==='ja'?'[手順型 Help を開く](help.html?role='+role+'&lang=ja&mode='+mode+')':'[Open guided Help](help.html?role='+role+'&lang=en&mode='+mode+')','',
    lang==='ja'?'以下の画像は合成データを使って実アプリから撮影しています。画像内のボタン名はアプリの表示言語に従います。':'Screenshots were captured from the actual application with synthetic data. Button labels follow the application interface language.',''];
  for(const c of chapters(data,role)){
    lines.push('### '+t(c.title,lang),'',t(c.summary,lang),'');
    for(const key of [mode,role])if(c.notes&&c.notes[key])lines.push('> '+t(c.notes[key],lang),'');
    c.steps.forEach((s,i)=>lines.push((i+1)+'. **'+t(s.title,lang)+'** — '+t(s.body,lang)));
    lines.push('');
    for(const id of c.screenshots){const shot=data.screenshots.find(s=>s.id===id);lines.push('!['+t(shot.alt,lang)+']('+shot.path+')','');}
    for(const name of ['statistics','save']){lines.push('**'+(name==='statistics'?(lang==='ja'?'集計への影響':'Effect on results'):(lang==='ja'?'保存と共有':'Save and share'))+'**','');for(const p of c[name])lines.push(t(p,lang),'');}
  }
  lines.push(END,'');return lines.join('\n');
}
function replaceSupplement(source,extra){
  const start=source.indexOf(START),end=source.indexOf(END);
  if((start<0)!==(end<0)||end>=0&&end<start)throw new Error('Invalid generated guide markers');
  return (start<0?source.trimEnd():source.slice(0,start).trimEnd())+'\n\n'+extra+(end<0?'':source.slice(end+END.length).trimStart());
}
function update(root=ROOT){
  for(const role of ['manage','master','viewer'])for(const lang of ['ja','en']){
    const file='USER_GUIDE'+(role==='viewer'?'':'.'+role)+(lang==='ja'?'':'.en')+'.md';
    const filename=path.join(root,file),source=fs.readFileSync(filename,'utf8');
    fs.writeFileSync(filename,replaceSupplement(source,markdown(root,role,lang)));
  }
  const filename=path.join(root,'OFFLINE_GUIDE.md');
  fs.writeFileSync(filename,replaceSupplement(fs.readFileSync(filename,'utf8'),markdown(root,'master','ja','offline')));
}
function renderStandalone(root=ROOT,role='master',lang='ja',mode='offline'){
  const data=manifest(root),out=[];
  for(const c of chapters(data,role)){
    out.push('<article id="help-'+c.id+'"><h2>'+escape(t(c.title,lang))+'</h2><p>'+escape(t(c.summary,lang))+'</p>');
    for(const key of [mode,role])if(c.notes&&c.notes[key])out.push('<p class="note">'+escape(t(c.notes[key],lang))+'</p>');
    out.push('<ol>');for(const step of c.steps)out.push('<li><strong>'+escape(t(step.title,lang))+'</strong><p>'+escape(t(step.body,lang))+'</p></li>');out.push('</ol>');
    for(const id of c.screenshots){const shot=data.screenshots.find(s=>s.id===id);if(!/^docs\/help\/images\/[\w.-]+\.png$/.test(shot.path))throw new Error('Unsafe screenshot path');const image=fs.readFileSync(path.join(root,shot.path)).toString('base64');out.push('<figure><img alt="'+escape(t(shot.alt,lang))+'" src="data:image/png;base64,'+image+'"><figcaption>'+escape(t(shot.caption,lang))+'</figcaption></figure>');}
    for(const key of ['statistics','save']){out.push('<h3>'+(key==='statistics'?(lang==='ja'?'集計への影響':'Effect on results'):(lang==='ja'?'保存と共有':'Save and share'))+'</h3>');for(const p of c[key])out.push('<p>'+escape(t(p,lang))+'</p>');}
    out.push('</article>');
  }
  return out.join('\n');
}
if(require.main===module){update();console.log('Updated six guides and OFFLINE_GUIDE from docs/help/manifest.json');}
module.exports={manifest,markdown,replaceSupplement,renderStandalone,update};
