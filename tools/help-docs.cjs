'use strict';
// The manifest is the common source for interactive Help, the six Markdown
// supplements and the self-contained offline HOW_TO_USE document.
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const START='<!-- GUIDED_HELP_START -->',END='<!-- GUIDED_HELP_END -->';
const t=(value,lang)=>typeof value==='string'?value:value[lang];
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const introduction=lang=>lang==='ja'
  ?'MSI の説明には、同じ実測マウス脳データを使った再描画図と実アプリ画面を掲載しています。そのほかの操作画面は説明用の合成データで撮影しています。各図の出典・表示条件を確認してください。'
  :'The MSI examples use one measured mouse-brain dataset, shown as rendered figures and actual application screenshots. Other interface screenshots use synthetic demonstration data. See the source and display settings beside each figure.';
function manifest(root){return JSON.parse(fs.readFileSync(path.join(root,'docs/help/manifest.json'),'utf8'));}
function chapters(data,role){return data.chapters.filter(c=>!c.roles||c.roles.includes(role));}
function screenshot(data,id){
  const shot=data.screenshots.find(s=>s.id===id);
  if(!shot)throw new Error('Missing Help screenshot: '+id);
  if(!/^docs\/help\/images\/[\w.-]+\.png$/.test(shot.path))throw new Error('Unsafe screenshot path');
  return shot;
}
function chapterExamples(data,chapter){
  return (chapter.examples||[]).map(id=>{
    const example=(data.examples||[]).find(e=>e.id===id);
    if(!example)throw new Error('Missing Help example: '+id);
    return example;
  });
}
function scaleText(scale,lang){
  if(!scale)return '';
  const number=value=>Number(value).toLocaleString(lang==='ja'?'ja-JP':'en-US',{maximumFractionDigits:3});
  return (lang==='ja'?'表示範囲: ':'Display range: ')+number(scale.min)+' - '+number(scale.max)+' '+t(scale.unit,lang);
}
function contextLabel(data,id,lang){
  return screenshot(data,id).kind==='measured-render'
    ?(lang==='ja'?'拡大した位置を確認':'Locate the enlarged area')
    :(lang==='ja'?'操作画面で確認':'Find it in the application');
}
function markdownPanel(data,panel,lang){
  const shot=screenshot(data,panel.image),lines=['**'+t(panel.title,lang)+'**',''];
  if(panel.subtitle)lines.push(t(panel.subtitle,lang),'');
  lines.push('!['+t(shot.alt,lang)+']('+shot.path+')','',t(shot.caption,lang),'');
  if(panel.scale)lines.push('**'+scaleText(panel.scale,lang)+'**','');
  if(panel.footnote)lines.push(t(panel.footnote,lang),'');
  return lines;
}
function markdownExample(data,example,lang){
  const lines=['#### '+t(example.title,lang),'',t(example.intro,lang),''];
  for(const panel of example.panels||[])lines.push(...markdownPanel(data,panel,lang));
  if(example.choices){
    lines.push('##### '+t(example.choices.label,lang),'');
    for(const option of example.choices.options){
      lines.push('**'+t(option.label,lang)+'**','',t(option.body,lang),'',...markdownPanel(data,option.panel,lang));
    }
  }
  if(example.table){
    const cell=value=>t(value,lang).replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>');
    lines.push('**'+t(example.table.caption,lang)+'**','',
      '| '+example.table.columns.map(cell).join(' | ')+' |',
      '| '+example.table.columns.map(()=>'---').join(' | ')+' |',
      ...example.table.rows.map(row=>'| '+row.map(cell).join(' | ')+' |'),'');
  }
  for(const note of example.notes||[])lines.push('> '+t(note,lang),'');
  if(example.contextImage){
    const shot=screenshot(data,example.contextImage);
    lines.push('**'+contextLabel(data,example.contextImage,lang)+'**','',
      '!['+t(shot.alt,lang)+']('+shot.path+')','',t(shot.caption,lang),'');
  }
  if(example.source)lines.push('**'+(lang==='ja'?'出典・条件':'Source and settings')+'**: '+t(example.source,lang),'');
  return lines;
}
function markdown(root,role,lang,mode='online'){
  const data=manifest(root),lines=[START,'',lang==='ja'?'## 実画面でたどる操作ガイド':'## Step-by-step guide with actual screenshots','',
    lang==='ja'?'[手順型 Help を開く](help.html?role='+role+'&lang=ja&mode='+mode+')':'[Open guided Help](help.html?role='+role+'&lang=en&mode='+mode+')','',
    introduction(lang),''];
  for(const c of chapters(data,role)){
    lines.push('### '+t(c.title,lang),'',t(c.summary,lang),'');
    for(const key of [mode,role])if(c.notes&&c.notes[key])lines.push('> '+t(c.notes[key],lang),'');
    c.steps.forEach((s,i)=>lines.push((i+1)+'. **'+t(s.title,lang)+'** — '+t(s.body,lang)));
    lines.push('');
    for(const example of chapterExamples(data,c))lines.push(...markdownExample(data,example,lang));
    for(const id of c.screenshots){const shot=screenshot(data,id);lines.push('!['+t(shot.alt,lang)+']('+shot.path+')','',t(shot.caption,lang),'');}
    for(const name of ['statistics','save']){lines.push('**'+(name==='statistics'?(lang==='ja'?'集計への影響':'Effect on results'):(lang==='ja'?'保存と共有':'Save and share'))+'**','');for(const p of c[name])lines.push(t(p,lang),'');}
  }
  lines.push(END,'');return lines.join('\n');
}
function htmlFigure(root,data,id,lang,body='',className='help-screenshot'){
  const shot=screenshot(data,id),image=fs.readFileSync(path.join(root,shot.path)).toString('base64');
  return '<figure class="'+className+'"><img alt="'+escape(t(shot.alt,lang))+'" src="data:image/png;base64,'+image+'">'
    +'<figcaption>'+escape(t(shot.caption,lang))+'</figcaption>'+body+'</figure>';
}
function htmlPanel(root,data,panel,lang,option=null){
  const title='<h4>'+escape(t(option?option.label:panel.title,lang))+'</h4>'+(panel.subtitle?'<p class="muted">'+escape(t(panel.subtitle,lang))+'</p>':'');
  const legend=(panel.scale?'<p class="example-scale">'+escape(scaleText(panel.scale,lang))+'</p>':'')
    +(panel.footnote?'<p class="example-footnote">'+escape(t(panel.footnote,lang))+'</p>':'')
    +(option?'<p class="example-choice-body">'+escape(t(option.body,lang))+'</p>':'');
  return '<div class="example-panel">'+title+htmlFigure(root,data,panel.image,lang,legend,'example-figure')+'</div>';
}
function htmlExample(root,data,example,lang){
  const out=['<section class="guided-example" id="example-'+escape(example.id)+'"><header class="example-heading"><h3>'+escape(t(example.title,lang))+'</h3><p>'+escape(t(example.intro,lang))+'</p></header>'];
  if(example.choices){
    out.push('<h4>'+escape(t(example.choices.label,lang))+'</h4><div class="example-comparisons">');
    for(const panel of example.panels||[])out.push(htmlPanel(root,data,panel,lang));
    for(const option of example.choices.options)out.push(htmlPanel(root,data,option.panel,lang,option));
    out.push('</div>');
  }else{
    out.push('<div class="example-panels">');
    for(const panel of example.panels||[])out.push(htmlPanel(root,data,panel,lang));
    out.push('</div>');
  }
  if(example.table){
    out.push('<table class="example-table"><caption>'+escape(t(example.table.caption,lang))+'</caption><thead><tr>'+example.table.columns.map(v=>'<th scope="col">'+escape(t(v,lang))+'</th>').join('')+'</tr></thead><tbody>');
    for(const row of example.table.rows)out.push('<tr>'+row.map(v=>'<td>'+escape(t(v,lang))+'</td>').join('')+'</tr>');
    out.push('</tbody></table>');
  }
  for(const note of example.notes||[])out.push('<p class="note">'+escape(t(note,lang))+'</p>');
  if(example.contextImage)out.push('<h4>'+contextLabel(data,example.contextImage,lang)+'</h4>'+htmlFigure(root,data,example.contextImage,lang,'','context-screenshot'));
  if(example.source)out.push('<p class="example-source"><strong>'+(lang==='ja'?'出典・条件':'Source and settings')+'</strong>: '+escape(t(example.source,lang))+'</p>');
  out.push('</section>');return out.join('\n');
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
    for(const example of chapterExamples(data,c))out.push(htmlExample(root,data,example,lang));
    for(const id of c.screenshots)out.push(htmlFigure(root,data,id,lang));
    for(const key of ['statistics','save']){out.push('<h3>'+(key==='statistics'?(lang==='ja'?'集計への影響':'Effect on results'):(lang==='ja'?'保存と共有':'Save and share'))+'</h3>');for(const p of c[key])out.push('<p>'+escape(t(p,lang))+'</p>');}
    out.push('</article>');
  }
  return out.join('\n');
}
if(require.main===module){update();console.log('Updated six guides and OFFLINE_GUIDE from docs/help/manifest.json');}
module.exports={manifest,markdown,replaceSupplement,renderStandalone,update,introduction,scaleText,chapterExamples};
