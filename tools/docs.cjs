'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {marked}=require('../vendor/marked.min.js');
const helpDocs=require('./help-docs.cjs');

function renderGuide(root) {
  const markdown=fs.readFileSync(path.join(root,'OFFLINE_GUIDE.md'),'utf8')+'\n\n## English guide\n\n'+helpDocs.markdown(root,'master','en','offline');
  let body=marked.parse(markdown).replace(/<h1>[\s\S]*?<\/h1>/,'');
  body=body.replace(/src="(docs\/help\/images\/[\w.-]+\.png)"/g,(_,file)=>'src="data:image/png;base64,'+fs.readFileSync(path.join(root,file)).toString('base64')+'"');
  body=body.replace(/href="help\.html/g,'href="http://127.0.0.1:8765/help.html');
  const toc=[];
  body=body.replace(/<h([23])>([\s\S]*?)<\/h[23]>/g,(_,level,title)=>{
    const id='section-'+(toc.length+1);
    toc.push('<li'+(level==='3'?' class="sub"':'')+'><a href="#'+id+'">'+title+'</a></li>');
    return '<h'+level+' id="'+id+'">'+title+'</h'+level+'>';
  });
  const version=fs.readFileSync(path.join(root,'version.js'),'utf8').match(/v\d{4}-\d{2}-\d{2}\.\d+/)?.[0]||'';
  const template=fs.readFileSync(path.join(root,'docs/guide-template.html'),'utf8');
  for(const marker of ['{{GUIDE_CONTENT}}','{{GUIDE_TOC}}']) {
    if(template.split(marker).length!==2) throw new Error('Guide template requires one '+marker);
  }
  return template.replace('{{GUIDE_CONTENT}}',()=>body).replace('{{GUIDE_TOC}}',()=>toc.join('')).replaceAll('{{VERSION}}',version);
}
module.exports={renderGuide};
