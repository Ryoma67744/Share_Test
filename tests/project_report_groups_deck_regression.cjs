'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const JSZip=require('../vendor/jszip.min.js');
const {createCanvas}=require('@napi-rs/canvas');
const root=path.resolve(__dirname,'..');
const sandbox={JSZip,console,setTimeout,clearTimeout,Blob,Buffer,Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,atob,btoa};
vm.createContext(sandbox);
for(const file of ['vendor/pptxgen.min.js','viewer/project-report-deck.js'])
  vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),sandbox,{filename:file});
const deck=sandbox.ProjectReportDeck;
function fixture() {
  const canvas=createCanvas(16,8),context=canvas.getContext('2d');
  context.fillStyle='#009900';context.fillRect(0,0,16,8);
  const image={data:canvas.toDataURL('image/png'),width:16,height:8,physicalWidthUm:800,physicalHeightUm:400};
  const sections=Array.from({length:9},(_,i)=>({id:'s'+i,name:i===8?'EXCLUDED_SECTION':'SECTION_'+i,
    referenceImage:image,referenceLabel:i===8?'EXCLUDED_REFERENCE':'Optical'}));
  const groups=[
    {id:'independent-2',name:'OWN_SECOND',kind:'independent',sectionIds:['s7']},
    {id:'compare-one',name:'ONE_MEMBER',kind:'compare',sectionIds:['s5']},
    {id:'compare-five',name:'FIVE_MEMBERS',kind:'compare',sectionIds:['s0','s1','s2','s3','s4']},
    {id:'independent-1',name:'OWN_FIRST',kind:'independent',sectionIds:['s6']}
  ];
  const upper={'compare-five':1000,'compare-one':50,'independent-1':100,'independent-2':100};
  const scales=Object.fromEntries(groups.map(group=>[group.id,{min:0,max:upper[group.id],upperBasis:'percentile',
    policy:'pooled-p99.8',sampleCount:20,percentileValue:upper[group.id],available:true}]));
  const entry=(section,index)=>{
    const group=groups.find(group=>group.sectionIds.includes(section.id));
    return {sectionId:section.id,name:section.name,max:index?1000+index:0,mean:index?200+index:0,n:8,
      image:index===2?null:image,missingReason:index===2?'REGISTERED_LOAD_FAILURE':'',
      registeredPixelPitch:{x:50,y:50},displayWindow:{min:0,max:group?upper[group.id]:999999},
      outputGroupId:group?.id,metadata:{private:'EXCLUDED_METADATA'}};
  };
  const all={key:'all',name:'ALL_MRM',subtitle:'100 → 50',upper:999999,outputScales:scales,
    sections:sections.map(entry)};
  const sparse={...all,key:'sparse',name:'SPARSE_MRM',sections:sections.slice(0,2).map(entry)};
  const ratio={...all,key:'ratio',name:'RATIO_MRM',kind:'ratio',subtitle:'X / Y',ratio:{formula:'X / Y'},
    sections:[0,6,8].map(index=>({...entry(sections[index],index),
      ratioStatistics:{totalRatio:2,mean:3,median:4,nValid:5,nCandidate:8},
      ratioRois:[{name:index===8?'EXCLUDED_ROI':'ROI_SECTION_'+index,status:'ready',
        statistics:{totalRatio:2,mean:3,median:4,nValid:5,nCandidate:8}}]}))};
  const excluded={...all,key:'excluded',name:'EXCLUDED_MOLECULE',sections:[entry(sections[8],8)]};
  return {projectName:'Explicit comparison plan',sections,molecules:[all,sparse,ratio,excluded],
    outputPlan:{version:1,groups},metadata:{private:'EXCLUDED_METADATA'}};
}
async function unpack(report) {
  const bytes=await deck.create(report,{type:'nodebuffer'}),zip=await JSZip.loadAsync(bytes);
  const files=Object.keys(zip.files).filter(file=>/^ppt\/slides\/slide\d+\.xml$/.test(file))
    .sort((a,b)=>Number(a.match(/slide(\d+)/)[1])-Number(b.match(/slide(\d+)/)[1]));
  const slides=await Promise.all(files.map(file=>zip.file(file).async('string')));
  const all=(await Promise.all(Object.keys(zip.files).filter(file=>/\.(xml|rels)$/.test(file))
    .map(file=>zip.file(file).async('string')))).join('\n');
  return {bytes,slides,all};
}
function shapeBounds(shape) {
  const offset=shape.match(/<a:off x="(-?\d+)" y="(-?\d+)"/),extent=shape.match(/<a:ext cx="(\d+)" cy="(\d+)"/);
  return offset&&extent?{x:Number(offset[1]),y:Number(offset[2]),w:Number(extent[1]),h:Number(extent[2])}:null;
}
async function main() {
  const report=fixture(),before=JSON.stringify(report),result=await unpack(report);
  assert.equal(JSON.stringify(report),before,'Grouping and legend generation never mutate the prepared data');
  for(const excluded of ['EXCLUDED_SECTION','EXCLUDED_REFERENCE','EXCLUDED_METADATA','EXCLUDED_ROI','EXCLUDED_MOLECULE'])
    assert.ok(!result.all.includes(excluded),'Excluded data/global scale cannot reappear: '+excluded);
  assert.doesNotMatch(result.all,/<a:t>999999<\/a:t>|Range 0 – 999999/,'Legacy molecule-wide upper cannot replace group scales');
  const groupNames=['ONE_MEMBER','FIVE_MEMBERS','OWN_SECOND','OWN_FIRST'];
  const memberships={ONE_MEMBER:[5],FIVE_MEMBERS:[0,1,2,3,4],OWN_SECOND:[7],OWN_FIRST:[6]};
  const order=result.slides.map(slide=>{
    const matches=groupNames.filter(name=>slide.includes(name));
    assert.equal(matches.length,1,'Every slide belongs to exactly one explicit output group');
    const group=matches[0];
    for(let i=0;i<8;i++)if(!memberships[group].includes(i))
      assert.ok(!slide.includes('SECTION_'+i),'A slide never mixes sections from another group');
    return groupNames.indexOf(group);
  });
  assert.deepEqual(order,order.slice().sort((a,b)=>a-b),'Comparison groups retain plan order, then independent sections retain theirs');
  const five=result.slides.filter(slide=>slide.includes('FIVE_MEMBERS'));
  const mainDetails=five.filter(slide=>slide.includes('ALL_MRM (')&&slide.includes('<a:tbl>'));
  assert.equal(mainDetails.length,3,'Five members require three detail pages of at most two sections');
  mainDetails.forEach(slide=>{
    assert.match(slide,/<a:t>1000<\/a:t>/,'Every detail page retains the group-wide raw legend upper');
    assert.match(slide,/Range 0 – 1000/);
    assert.match(slide,/共通自動Range/);
    assert.doesNotMatch(slide,/100%|Colour level|Same \(all sections\)/);
  });
  const mainMatrices=five.filter(slide=>slide.includes('MSI matrix ')&&slide.includes('ALL_MRM'));
  assert.equal(mainMatrices.length,2,'Five members require two matrix pages of at most four sections');
  assert.ok(mainMatrices[0].includes('SECTION_3')&&!mainMatrices[0].includes('SECTION_4'));
  assert.ok(mainMatrices[1].includes('SECTION_4')&&!mainMatrices[1].includes('SECTION_3'));
  mainMatrices.forEach(slide=>assert.match(slide,/Range 0 – 1000/,'Matrix records the same raw Range across pagination'));
  assert.ok(five.some(slide=>slide.includes('SPARSE_MRM')&&slide.includes('共通自動Range')),
    'Missing registrations do not convert a comparison group into independent output');
  assert.match(five.join('\n'),/REGISTERED_LOAD_FAILURE/,'Registered unavailable images retain their diagnostics');
  assert.match(mainDetails[0],/<a:t>0<\/a:t>/,'Valid zero source statistics are preserved');
  for(const name of ['OWN_FIRST','OWN_SECOND']) {
    const independent=result.slides.filter(slide=>slide.includes(name));
    independent.forEach(slide=>assert.match(slide,/独立・この切片の自動Range/));
    const detail=independent.find(slide=>slide.includes('ALL_MRM')&&slide.includes('<a:tbl>'));
    assert.match(detail,/Range 0 – 100/);assert.match(detail,/<a:t>100<\/a:t>/);
    assert.doesNotMatch(detail,/100%|Colour level/,'Equal independent ranges never imply shared group semantics');
  }
  const one=result.slides.filter(slide=>slide.includes('ONE_MEMBER'));
  one.forEach(slide=>assert.match(slide,/共通自動Range/,'A one-member comparison group keeps its declared mode'));
  const roiSlides=result.slides.filter(slide=>slide.includes('Total signal ratio ='));
  assert.equal(roiSlides.length,2);assert.ok(roiSlides.some(slide=>slide.includes('ROI_SECTION_0')));
  assert.ok(roiSlides.some(slide=>slide.includes('ROI_SECTION_6')));
  // Compact matrix Range rows and the new scope header must not overlap images.
  for(const slide of result.slides) {
    const ids=[...slide.matchAll(/<p:cNvPr\s+id="(\d+)"/g)].map(match=>match[1]);
    assert.equal(new Set(ids).size,ids.length,'Slide shape IDs stay unique');
    const pictures=[...slide.matchAll(/<p:pic>.*?<\/p:pic>/gs)].map(match=>shapeBounds(match[0])).filter(Boolean);
    const ranges=[...slide.matchAll(/<p:sp>.*?<\/p:sp>/gs)].filter(match=>/<a:t>Range /.test(match[0]))
      .map(match=>shapeBounds(match[0])).filter(Boolean);
    for(const range of ranges)for(const picture of pictures) {
      const overlapX=range.x<picture.x+picture.w&&picture.x<range.x+range.w;
      const overlapY=range.y<picture.y+picture.h&&picture.y<range.y+range.h;
      assert.ok(!(overlapX&&overlapY),'Range labels do not overlap scientific images');
    }
    for(const match of slide.matchAll(/<(?:a|p):xfrm[^>]*>.*?<\/(?:a|p):xfrm>/gs)) {
      const box=shapeBounds(match[0]);if(!box)continue;
      assert.ok(box.x>=0&&box.y>=0&&box.x+box.w<=12192010&&box.y+box.h<=6858010,'Objects fit inside the slide');
    }
  }
  const styled=fixture();styled.displayStyle={mode:'individual',colormap:'green',smoothing:'none',
    lut:Array.from({length:256},(_,i)=>[0,i,0])};
  const styleResult=await unpack(styled);
  assert.match(styleResult.all,/Display style: green/);assert.doesNotMatch(styleResult.all,/100%|Colour level|Same \(all sections\)/);
  const invalid=fixture();invalid.molecules[0].sections[0].displayWindow.max=999;
  await assert.rejects(deck.create(invalid,{type:'nodebuffer'}),/Range is inconsistent/,'Different precomputed bounds inside a comparison group cannot share one legend');
  const duplicate=fixture();duplicate.outputPlan.groups[0].sectionIds=['s0'];
  await assert.rejects(deck.create(duplicate,{type:'nodebuffer'}),/section assignment/);
  if(process.argv.includes('--sample')) {
    const target=path.resolve(root,'../report-comparison-groups-sample.pptx');fs.writeFileSync(target,result.bytes);console.log('Sample PPTX: '+target);
  }
  console.log('Project report groups deck: PASS (explicit scope, 5-section pagination, own raw Range, excluded data, sparse/zero/failed entries, Ratio ROI and geometry)');
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
