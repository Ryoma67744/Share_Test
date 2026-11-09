'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {markdown,replaceSupplement,renderStandalone,scaleText}=require('../tools/help-docs.cjs');
const {renderGuide}=require('../tools/docs.cjs');
const root=path.resolve(__dirname,'..'),data=JSON.parse(fs.readFileSync(path.join(root,'docs/help/manifest.json'),'utf8'));
const capture=JSON.parse(fs.readFileSync(path.join(root,'docs/help/capture-manifest.json'),'utf8'));
const provenance=JSON.parse(fs.readFileSync(path.join(root,'docs/help/brain-example-provenance.json'),'utf8'));
assert.equal(data.format,1);assert.equal(data.chapters.length,13);assert.equal(new Set(data.chapters.map(c=>c.id)).size,13);
assert.equal(capture.synthetic,true);assert.match(capture.fixtureSha256,/^[a-f0-9]{64}$/);
const shots=new Map(data.screenshots.map(s=>[s.id,s]));assert.equal(shots.size,data.screenshots.length);
const examples=new Map((data.examples||[]).map(e=>[e.id,e]));assert.equal(examples.size,5);
function bilingual(value){assert.equal(typeof value.ja,'string');assert.ok(value.ja.trim());assert.equal(typeof value.en,'string');assert.ok(value.en.trim());}
function panel(value){
  assert.ok(shots.has(value.image),'missing example image '+value.image);bilingual(value.title);
  for(const field of ['subtitle','footnote'])if(value[field])bilingual(value[field]);
  if(value.scale){assert.ok(Number.isFinite(value.scale.min));assert.ok(Number.isFinite(value.scale.max));assert.ok(value.scale.max>value.scale.min);bilingual(value.scale.unit);}
}
for(const example of examples.values()){
  bilingual(example.title);bilingual(example.intro);bilingual(example.source);
  assert.ok(example.panels.length);example.panels.forEach(panel);example.notes.forEach(bilingual);
  if(example.contextImage)assert.ok(shots.has(example.contextImage));
  if(example.choices){
    bilingual(example.choices.label);assert.ok(example.choices.options.length>=2);
    assert.equal(new Set(example.choices.options.map(o=>o.id)).size,example.choices.options.length);
    for(const option of example.choices.options){bilingual(option.label);bilingual(option.body);panel(option.panel);}
  }
  if(example.table){
    bilingual(example.table.caption);example.table.columns.forEach(bilingual);assert.ok(example.table.rows.length);
    for(const row of example.table.rows){assert.equal(row.length,example.table.columns.length);row.forEach(v=>typeof v==='string'?assert.ok(v.trim()):bilingual(v));}
  }
}
for(const c of data.chapters){
  bilingual(c.title);bilingual(c.summary);assert.ok(c.steps.length>=3&&c.steps.length<=5);
  for(const step of c.steps){bilingual(step.title);bilingual(step.body);}
  for(const field of ['statistics','save','features']){assert.ok(c[field].length);c[field].forEach(bilingual);}
  assert.ok(c.screenshots.length||(c.examples||[]).length);for(const id of c.screenshots)assert.ok(shots.has(id),'missing screenshot '+id);
  for(const id of c.examples||[])assert.ok(examples.has(id),'missing example '+id);
}
assert.equal(provenance.format,1);assert.equal(provenance.synthetic,false);
assert.match(provenance.source.sha256,/^[a-f0-9]{64}$/);assert.match(provenance.source.metadataSha256,/^[a-f0-9]{64}$/);
assert.deepEqual(Object.keys(provenance.source).sort(),['metadataSha256','section','sectionId','sha256','slug']);
assert.equal(provenance.source.slug,'261030_hirabayashi_13c_brain');assert.equal(provenance.source.sectionId,'3040f31a-45d2-45b1-aafc-cf2f4c4bc401');
assert.match(provenance.generatorSha256,/^[a-f0-9]{64}$/);assert.ok(provenance.validation);
assert.ok(fs.existsSync(path.join(root,'tools/help-brain-example.mjs')));
const assets=new Map(provenance.assets.map(a=>[a.id,a]));assert.equal(assets.size,provenance.assets.length);
for(const asset of assets.values()){
  assert.match(asset.path,/^docs\/help\/images\/brain-[\w.-]+\.png$/);assert.ok(['measured-render','measured-screenshot','legend'].includes(asset.kind));
  const bytes=fs.readFileSync(path.join(root,asset.path));assert.equal(bytes.subarray(1,4).toString(),'PNG');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),asset.sha256,'stale measured asset '+asset.id);
  assert.equal(bytes.readUInt32BE(16),asset.width);assert.equal(bytes.readUInt32BE(20),asset.height);
}
for(const [file,expected] of Object.entries(provenance.sourceFilesSha256)){
  assert.ok(path.resolve(root,file).startsWith(root+path.sep),'unsafe provenance source path');
  // Source hashes describe the captured revision, just like the synthetic
  // capture manifest. Unrelated future version/UI edits do not invalidate a
  // historical figure or require the non-distributed experimental RAW file.
  assert.match(expected,/^[a-f0-9]{64}$/);assert.ok(fs.existsSync(path.join(root,file)));
}
assert.ok(!fs.readdirSync(path.join(root,'docs/help')).some(file=>/\.(raw|zip)$/i.test(file)),'raw source must not be bundled with Help');
for(const shot of shots.values()){
  assert.match(shot.path,/^docs\/help\/images\/[\w.-]+\.png$/);bilingual(shot.alt);bilingual(shot.caption);
  const bytes=fs.readFileSync(path.join(root,shot.path));assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.ok(bytes.length>1000);
  const measured=shot.kind==='measured-render'||shot.kind==='measured-screenshot';
  if(shot.id.startsWith('brain-'))assert.ok(measured,'measured image kind required');
  const recorded=measured?assets.get(shot.id):capture.captures.find(item=>item.id===shot.id);assert.ok(recorded,'uncaptured screenshot '+shot.id);
  if(measured){assert.equal(recorded.kind,shot.kind);assert.equal(shot.provenance,'docs/help/brain-example-provenance.json');}
  assert.equal(recorded.path,shot.path);assert.equal(recorded.sha256,crypto.createHash('sha256').update(bytes).digest('hex'),'stale capture metadata '+shot.id);
}
for(const role of ['manage','master','viewer'])for(const lang of ['ja','en']){
  const file='USER_GUIDE'+(role==='viewer'?'':'.'+role)+(lang==='ja'?'':'.en')+'.md';
  const body=fs.readFileSync(path.join(root,file),'utf8');assert.ok(body.includes(markdown(root,role,lang).trimEnd()),'generated guide is stale: '+file);
  assert.ok(!body.includes('以下の画像は合成データを使って実アプリから撮影しています。'));
  const html=renderStandalone(root,role,lang,'online');
  for(const chapter of data.chapters.filter(c=>!c.roles||c.roles.includes(role)))for(const id of chapter.examples||[]){
    const example=examples.get(id),panels=[...example.panels,...(example.choices?.options||[]).map(o=>o.panel)];
    assert.ok(body.includes(example.source[lang]));assert.ok(html.includes('id="example-'+id+'"'));
    for(const value of panels){assert.ok(body.includes(shots.get(value.image).path),'missing static comparison '+value.image);if(value.scale)assert.ok(body.includes(scaleText(value.scale,lang)));}
    for(const option of example.choices?.options||[])assert.ok(body.includes(option.body[lang]),'missing static choice explanation');
  }
}
assert.ok(fs.readFileSync(path.join(root,'OFFLINE_GUIDE.md'),'utf8').includes(markdown(root,'master','ja','offline').trimEnd()));
assert.equal(replaceSupplement('original\n','<!-- GUIDED_HELP_START -->\nnew\n<!-- GUIDED_HELP_END -->\n'), 'original\n\n<!-- GUIDED_HELP_START -->\nnew\n<!-- GUIDED_HELP_END -->\n');
assert.throws(()=>replaceSupplement('<!-- GUIDED_HELP_START -->','new'),/Invalid/);
const ratio=data.chapters.find(c=>c.id==='ratio');assert.ok(ratio.save.some(p=>p.ja.includes('個人用')));
const offline=renderGuide(root);assert.ok(offline.includes('data:image/png;base64,'));assert.ok(!/src="docs\/help\/images\//.test(offline));
for(const example of examples.values()){assert.ok(offline.includes(example.title.ja));assert.ok(offline.includes(example.title.en));}
assert.equal(scaleText({min:0,max:448206.855,unit:{ja:'信号強度',en:'Signal intensity'}},'en'),'Display range: 0 - 448,206.855 Signal intensity');
console.log('Guided Help content, generated guides and screenshot provenance regression: PASS');
