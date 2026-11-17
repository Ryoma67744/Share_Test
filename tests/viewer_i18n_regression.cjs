'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const JSZip=require('../vendor/jszip.min.js');
async function main(){
 const sandbox={JSZip,console,setTimeout,clearTimeout,Blob,Buffer,Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,atob,btoa};
 vm.createContext(sandbox);
 for(const file of ['app-i18n.js','app-i18n-viewer-modules.js','vendor/pptxgen.min.js','viewer/project-report-deck.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),sandbox,{filename:file});
 sandbox.AppI18n.setLocale('en');
 const report={locale:'en',projectName:'日本語 project name',sections:[{id:'S1',name:'日本語 section name'}],
  outputPlan:{version:1,groups:[{id:'independent-1',kind:'independent',name:'独立',sectionIds:['S1']}]},
  molecules:[{key:'m1',name:'User molecule',sections:[{sectionId:'S1',name:'日本語 section name',max:3,mean:2}]}]};
 const before=JSON.stringify(report);
 const output=await sandbox.ProjectReportDeck.create(report,{type:'nodebuffer',onProgress:()=>sandbox.AppI18n.setLocale('ja')});
 const zip=await JSZip.loadAsync(output);
 const slides=await Promise.all(Object.keys(zip.files).filter(p=>/^ppt\/slides\/slide\d+\.xml$/.test(p)).map(p=>zip.file(p).async('string')));
 const xml=slides.join('\n');
 assert.match(xml,/Independent · automatic Range for this section/,'report text retains the language selected when export began');
 assert.doesNotMatch(xml,/独立・この切片の自動Range/);
 assert.match(xml,/lang="en-US"/);assert.doesNotMatch(xml,/lang="ja-JP"/,'all report slide text uses the captured output language');
 assert.match(xml,/日本語 section name/,'user section names are not translated');
 assert.equal(JSON.stringify(report),before,'language handling does not alter report data or group identity');
 console.log('Viewer i18n regression: PASS (PPT locale snapshot, native text language and user data preservation)');
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
