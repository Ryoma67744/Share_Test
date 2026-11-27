'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm');
const {html,runtime}=require('./viewer-runtime.cjs');
const {defaultPaletteSource}=require('./fixed-colors-runtime.cjs');
function node(){return {value:'',style:{},children:[],classList:{add(){},remove(){},toggle(){}},appendChild(v){this.children.push(v);},addEventListener(){},setAttribute(){},querySelectorAll(){return [];}};}
function fixture(projects){
 const nodes=new Map(),document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node};
 const c=runtime({document,structuredClone,ProjectStorage:{getProject:async id=>structuredClone(projects[id])},
  SharePreview:{isOpen:()=>false,requestDisplayRefresh(){}},_roiRawGridCache:new Map(),parquetReleaseAll(){},backfillLegacyCompoundMeta(){},
  ensureMemoShape:v=>v||{},localStorage:{setItem(){},removeItem(){}},sessionStorage:{getItem(){return null;},removeItem(){}},
  MsiDisplaySettings:require('../viewer/msi-display-settings.js'),findCompoundMeta:()=>({}),formatDisplayName:key=>key,
  COLORMAPS:{},_activeColormapName:'viridis',populateRoiList(){},setupGraphSelector(){},renderMemoForm(){},
  _refreshMethodRowState(){},Toolbar:{refreshRange(){}},showToast(){},ensureAnalysisResizeObserver(){}},
  ['msiSourceReference','sortMethodKeys','_sortValueFrom','filterMethodKeys','projectHasNonTargetSection']);
 const a=html.indexOf('const App = {');
 vm.runInContext(defaultPaletteSource()+'\n'+html.slice(a,html.indexOf('\n};',a)+3)+'\nglobalThis.app=App;',c);
 const app=c.app;app._flushSave=async()=>true;app._stopMasterCollabPoll=()=>{};
 const visibility={previewTransforms:{old:{scale:3}},previewRotations:{kept:90},ensure:()=>new Set(app.project.sections.map(s=>s.id)),save(){}};
 app.sectionVisibility=()=>visibility;
 app.rebuildSectionPanels=async()=>{app._resolveInitialLayerFocus();app.panels=new Map(app.project.sections.map(section=>[section.id,{section,project:app.project,imageSources:{},visibleLayers:new Set(),renderComposite(){},markAllThumbsDirty(){}}]));};
 app.refreshProjectPicker=async()=>{};app.refreshShareInfoButton=()=>{};app.renderAnalysis=()=>{};
 return {c,app};
}
function project(id,max){return {id,displayName:id,sections:[{id:id+'-section',meta:{viewerTransform:{tx:17,ty:-9,scale:3,rot:37,rotHE:12,rotMSI:90},flip:{lr:true}},
 msiSeries:{MSI_same:{kind:'txt',blobId:'blob-'+id,sourceFileId:'source-'+id,rawRange:[0,max/2],rawDispMax:max/2,rawTrueMax:max}}}],rois:[],
 meta:{colormap:'viridis',msiSmoothing:'linear',msiDisplay:{version:2,preset:'custom',rangePolicy:'legacy',aspectMode:'physical',smoothingStrength:2,linearStrength:4}}};}
async function main(){
 const projects={A:project('A',100),B:project('B',1000)},before=JSON.stringify(projects),{c,app}=fixture(projects);
 await app.openProject('A');
 assert.equal(app.getMsiDisplaySettings().rangePolicy,'maximum');
 assert.equal(app.getMsiDisplaySettings().colormap,'viridis');assert.equal(app.getMsiDisplaySettings().linearStrength,4);
 assert.equal(app.getMsiWindow('MSI_same',[0,50],50,100).max,100,'Opening uses the measured maximum without a saved style migration');
 assert.equal(app.project.meta.msiDisplay.rangePolicy,'legacy');
 assert.deepEqual(JSON.parse(JSON.stringify(app.project.sections[0]._viewerLocalTransform)),{tx:0,ty:0,scale:1,rot:37,rotHE:12,rotMSI:90});
 assert.deepEqual(Object.keys(app.sectionVisibility().previewTransforms),[]);
 assert.equal(app.sectionVisibility().previewRotations.kept,90);
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
 assert.equal(app.getMsiWindow('MSI_same',[0,100],100).max,100);assert.equal(app.msiScaleMode,'same');
 c.Panel.prototype.applyRangeRaw.call(c.testToolbar.activePanel(),'max','10');
 // Same measurement reload/clip does not reset; replacing its reader does.
 app.project.sections[0].msiSeries.MSI_same.rawRange=[0,99];
 app.project.sections[0].msiSeries.MSI_same.rawDispMax=99;
 app.project.sections[0].msiSeries.MSI_same.rawTrueMax=99;
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
 // Reopening the same project is also a new display session, including ROI windows.
 fresh.app.msiRoiUserWindow.MSI_same={max:4};fresh.app.roiOnlyMode=true;
 fresh.app.msiUserWindow.MSI_same={min:2,max:7};fresh.app.msiScaleMode='individual';
 await fresh.app.openProject('A');
 assert.equal(fresh.app.roiOnlyMode,false);assert.deepEqual(Object.keys(fresh.app.msiRoiUserWindow),[]);
 assert.equal(fresh.app.getMsiWindow('MSI_same',[0,100],100).max,100);assert.equal(fresh.app.msiScaleMode,'same');
 // Initial selection follows the visible Method order rather than old focus or insertion order.
 const ordered=project('ordered',100),ent=ordered.sections[0].msiSeries.MSI_same;
 ordered.sections[0].msiSeries={MSI_Z:{...ent,compoundMeta:{base:'Zulu'}},MSI_0:{},MSI_A:{...ent,compoundMeta:{base:'Alpha'}}};
 const selection=fixture({ordered});selection.app.focusCompoundKey='MSI_Z';await selection.app.openProject('ordered');
 assert.equal(selection.app.focusCompoundKey,'MSI_A');
 selection.app.focusCompoundKey='MSI_Z';selection.app._resolveInitialLayerFocus();assert.equal(selection.app.focusCompoundKey,'MSI_Z','Rebuilding panels does not reset a user selection');
 selection.app.methodSort={key:'compound',dir:'desc'};await selection.app.openProject('ordered');assert.equal(selection.app.focusCompoundKey,'MSI_Z');
 selection.app.methodSort={key:null,dir:'asc'};selection.app._focusParam='Z';await selection.app.openProject('ordered');assert.equal(selection.app.focusCompoundKey,'MSI_Z','An explicit deep link wins over the first Method row');
 assert.equal(JSON.stringify(projects),before,'Display-only operations do not persist data');
 assert.ok(!html.includes('data-headerbar-bar'),'No uncalibrated common Preview bar');
 console.log('Project/role display context and original-data preservation: PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
