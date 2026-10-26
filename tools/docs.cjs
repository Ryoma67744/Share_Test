'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {marked}=require('../vendor/marked.min.js');

function renderGuide(root) {
  const markdown=fs.readFileSync(path.join(root,'OFFLINE_GUIDE.md'),'utf8');
  let body=marked.parse(markdown).replace(/<h1>[\s\S]*?<\/h1>/,'');
  const toc=[];
  body=body.replace(/<h2>([\s\S]*?)<\/h2>/g,(_,title)=>{
    const id='section-'+(toc.length+1);
    toc.push('<li><a href="#'+id+'">'+title+'</a></li>');
    return '<h2 id="'+id+'">'+title+'</h2>';
  });
  const image=fs.readFileSync(path.join(root,'docs/offline-preview.jpg')).toString('base64');
  const template=fs.readFileSync(path.join(root,'docs/guide-template.html'),'utf8');
  for(const marker of ['{{GUIDE_CONTENT}}','{{GUIDE_TOC}}','{{PREVIEW_IMAGE}}']) {
    if(template.split(marker).length!==2) throw new Error('Guide template requires one '+marker);
  }
  return template.replace('{{GUIDE_CONTENT}}',()=>body).replace('{{GUIDE_TOC}}',()=>toc.join('')).replace('{{PREVIEW_IMAGE}}',()=>image);
}
module.exports={renderGuide};
