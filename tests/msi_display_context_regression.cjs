'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm');
const {html,runtime}=require('./viewer-runtime.cjs');
const {defaultPaletteSource}=require('./fixed-colors-runtime.cjs');
function node(){return {value:'',style:{},children:[],classList:{add(){},remove(){},toggle(){}},appendChild(v){this.children.push(v);},addEventListener(){},setAttribute(){}};}
function fixture(projects){
 const nodes=new Map(),document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node};
 const c=runtime({document,structuredClone,ProjectStorage:{getProject:async id=>structuredClone(projects[id])},
  SharePreview:{isOpen:()=>false},_roiRawGridCache:new Map(),parquetReleaseAll(){},backfillLegacyCompoundMeta(){},
  ensureMemoShape:v=>v||{},localStorage:{setItem(){},removeItem(){}},sessionStorage:{getItem(){return null;}},
  COLORMAPS:{},_activeColormapName:'viridis',populateRoiList(){},setupGraphSelector(){},renderMemoForm(){},
  _refreshMethodRowState(){},Toolbar:{refreshRange(){}},showToast(){},ensureAnalysisResizeObserver(){}},['msiSourceReference']);
 const a=html.indexOf('const App = {');
 vm.runInContext(defaultPaletteSource()+'\n'+html.slice(a,html.indexOf('\n};',a)+3)+'\nglobalThis.app=App;',c);
 const app=c.app;app._flushSave=async()=>true;app._stopMasterCollabPoll=()=>{};app.sectionVisibility=()=>({ensure(){}});
 app.rebuildSectionPanels=async()=>{app.panels=new Map(app.project.sections.map(section=>[section.id,{section,project:app.project,imageSources:{},visibleLayers:new Set(),renderComposite(){},markAllThumbsDirty(){}}]));};
 app.refreshProjectPicker=async()=>{};app.refreshShareInfoButton=()=>{};app.renderAnalysis=()=>{};
 return {c,app};
}
function project(id,max){return {id,displayName:id,sections:[{id:id+'-section',meta:{},msiSeries:{MSI_same:{kind:'txt',blobId:'blob-'+id,sourceFileId:'source-'+id,rawRange:[0,max],rawDispMax:max}}}],rois:[],meta:{}};}
async function main(){
 const projects={A:project('A',100),B:project('B',1000)},before=JSON.stringify(projects),{c,app}=fixture(projects);
 await app.openProject('A');
 const callbacks=new Map();
 c.testToolbar={rangeMax:{value:'10',addEventListener:(name,fn)=>callbacks.set(name,fn)},activePanel:()=>({section:app.project.sections[0],effectiveActiveMsiKey:()=> 'MSI_same',applyRangeRaw:c.Panel.prototype.applyRangeRaw})};
 const listener=html.split('\n').find(line=>line.includes("this.rangeMax.addEventListener('change'"));
 vm.runInContext('(function(){'+listener+'}).call(testToolbar)',c);callbacks.get('change')({target:{value:'10'}});
 app.setMsiScaleMode('individual');
 assert.equal(app.getMsiWindow('MSI_same',[0,100],100).max,10);
 c.testToolbar.rangeMax.disabled=true;c.testToolbar.rangeMax.value='22';callbacks.get('change')();
 assert.equal(app.getMsiWindow('MSI_same',[0,100],100).max,10,'disabled loading controls cannot write a range on blur');
 c.testToolbar.rangeMax.disabled=false;
 await app.openProject('B');
 assert.equal(app.getMsiWindow('MSI_same',[0,1000],1000).max,1000);
 assert.equal(app.msiScaleMode,'same');
 await app.openProject('A');
 assert.equal(app.getMsiWindow('MSI_same',[0,100],100).max,10);assert.equal(app.msiScaleMode,'individual');
 // Same measurement reload/clip does not reset; replacing its reader does.
 app.project.sections[0].msiSeries.MSI_same.rawRange=[0,99];
 app.project.sections[0].msiSeries.MSI_same.rawDispMax=99;
 assert.equal(app.getMsiWindow('MSI_same',[0,99],99).max,10);
 app.project.sections[0].msiSeries.MSI_same.v='new measurement';
 assert.equal(app.getMsiWindow('MSI_same',[0,99],99).max,99);
 app.shareMode={slug:'public-a',role:'viewer',token:'not-a-key'};
 assert.equal(app.getMsiWindow('MSI_same',[0,99],99).max,99);
 c.Panel.prototype.applyRangeRaw.call(c.testToolbar.activePanel(),'max','12');
 app.shareMode.role='admin';assert.equal(app.getMsiWindow('MSI_same',[0,99],99).max,99);
 app.shareMode.role='viewer';assert.equal(app.getMsiWindow('MSI_same',[0,99],99).max,12);
 app.shareMode.token='refreshed';assert.equal(app.getMsiWindow('MSI_same',[0,99],99).max,12);
 app.shareMode.slug='other';assert.equal(app.getMsiWindow('MSI_same',[0,99],99).max,99);
 const fresh=fixture(projects);await fresh.app.openProject('A');assert.equal(fresh.app.getMsiWindow('MSI_same',[0,100],100).max,100);
 assert.equal(JSON.stringify(projects),before,'Display-only operations do not persist data');
 assert.ok(!html.includes('data-headerbar-bar'),'No uncalibrated common Preview bar');
 console.log('Project/role display context and original-data preservation: PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
