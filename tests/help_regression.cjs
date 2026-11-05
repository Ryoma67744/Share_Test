'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {markdown,replaceSupplement}=require('../tools/help-docs.cjs');
const root=path.resolve(__dirname,'..'),data=JSON.parse(fs.readFileSync(path.join(root,'docs/help/manifest.json'),'utf8'));
const capture=JSON.parse(fs.readFileSync(path.join(root,'docs/help/capture-manifest.json'),'utf8'));
assert.equal(data.format,1);assert.equal(data.chapters.length,13);assert.equal(new Set(data.chapters.map(c=>c.id)).size,13);
assert.equal(capture.synthetic,true);assert.match(capture.fixtureSha256,/^[a-f0-9]{64}$/);
const shots=new Map(data.screenshots.map(s=>[s.id,s]));assert.equal(shots.size,data.screenshots.length);
function bilingual(value){assert.equal(typeof value.ja,'string');assert.ok(value.ja.trim());assert.equal(typeof value.en,'string');assert.ok(value.en.trim());}
for(const c of data.chapters){
  bilingual(c.title);bilingual(c.summary);assert.ok(c.steps.length>=3&&c.steps.length<=5);
  for(const step of c.steps){bilingual(step.title);bilingual(step.body);}
  for(const field of ['statistics','save','features']){assert.ok(c[field].length);c[field].forEach(bilingual);}
  assert.ok(c.screenshots.length);for(const id of c.screenshots)assert.ok(shots.has(id),'missing screenshot '+id);
}
for(const shot of shots.values()){
  assert.match(shot.path,/^docs\/help\/images\/[\w.-]+\.png$/);bilingual(shot.alt);bilingual(shot.caption);
  const bytes=fs.readFileSync(path.join(root,shot.path));assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.ok(bytes.length>1000);
  const recorded=capture.captures.find(item=>item.id===shot.id);assert.ok(recorded,'uncaptured screenshot '+shot.id);
  assert.equal(recorded.path,shot.path);assert.equal(recorded.sha256,crypto.createHash('sha256').update(bytes).digest('hex'),'stale capture metadata '+shot.id);
}
for(const role of ['manage','master','viewer'])for(const lang of ['ja','en']){
  const file='USER_GUIDE'+(role==='viewer'?'':'.'+role)+(lang==='ja'?'':'.en')+'.md';
  const body=fs.readFileSync(path.join(root,file),'utf8');assert.ok(body.includes(markdown(root,role,lang).trimEnd()),'generated guide is stale: '+file);
}
assert.ok(fs.readFileSync(path.join(root,'OFFLINE_GUIDE.md'),'utf8').includes(markdown(root,'master','ja','offline').trimEnd()));
assert.equal(replaceSupplement('original\n','<!-- GUIDED_HELP_START -->\nnew\n<!-- GUIDED_HELP_END -->\n'), 'original\n\n<!-- GUIDED_HELP_START -->\nnew\n<!-- GUIDED_HELP_END -->\n');
assert.throws(()=>replaceSupplement('<!-- GUIDED_HELP_START -->','new'),/Invalid/);
const ratio=data.chapters.find(c=>c.id==='ratio');assert.ok(ratio.statistics.some(p=>p.ja.includes('10 / 3')));assert.ok(ratio.save.some(p=>p.ja.includes('個人用')));
console.log('Guided Help content, generated guides and screenshot provenance regression: PASS');
