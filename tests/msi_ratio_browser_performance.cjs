'use strict';
// Explicit performance probe; not a timing-sensitive regression assertion.
const {chromium}=require('playwright');
const {fixture,archive,startServer}=require('./msi_ratio_browser_regression.cjs');
async function main(){
  const data=fixture(),server=await startServer(data),browser=await chromium.launch({headless:true,args:['--enable-precise-memory-info']});
  try{
    const measurements=[];
    for(const count of [100000,500000,1000000]){
      const lines=['x,y,X,Y'];for(let i=0;i<count;i++)lines.push([i%1000,Math.floor(i/1000),i%17,i%13+1].join(','));
      data.sources['synthetic/ratio-0.csv']=lines.join('\n')+'\n';
      const context=await browser.newContext(),page=await context.newPage();
      await page.goto(server.origin+'/viewer/?project=ratio-performance');await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
      const bytes=await archive(data);
      await page.evaluate(async encoded=>{await importZipFile(new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))]),{review:()=>true});},bytes.toString('base64'));
      const result=await page.evaluate(async()=>{
        const sec=App.project.sections[0],def={id:'performance',name:'X / Y',revision:1,operation:'divide',calculationVersion:'msi-ratio-v1',denominatorMin:0,numeratorPolicy:'nonnegative',invalidPolicy:'exclude',bindings:{[MsiRatioModel.canonicalSectionId(sec)]:{numerator:MsiRatioModel.makeInputRef(sec.msiSeries.MSI_X,'MSI_X'),denominator:MsiRatioModel.makeInputRef(sec.msiSeries.MSI_Y,'MSI_Y'),coordinateConfirmed:false}}};
        MsiRatioRuntime.store(def);const key=MsiRatioModel.displayKey(def.id);
        const start=performance.now(),heapBefore=performance.memory?.usedJSHeapSize;let previous=start,maxGap=0,ticks=0,heapPeak=heapBefore;
        const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;ticks++;heapPeak=Math.max(heapPeak,performance.memory?.usedJSHeapSize||0);},16);
        const value=await App.resolveRatio(sec,key,{roiStats:false}),elapsed=performance.now()-start;
        await new Promise(r=>setTimeout(r,20));clearInterval(timer);
        const warmStart=performance.now();await App.resolveRatio(sec,key,{roiStats:false});
        return {rows:value.values.length,elapsedMs:Math.round(elapsed),cachedMs:Math.round(performance.now()-warmStart),maxHeartbeatGapMs:Math.round(maxGap),heartbeatTicks:ticks,heapBefore,heapPeak,heapAfter:performance.memory?.usedJSHeapSize,nValid:value.statistics.nValid,mean:value.statistics.mean};
      });
      measurements.push(result);console.log(JSON.stringify(result));await context.close();
    }
    console.log('Browser production resolver probe complete; timings are local observations, not guarantees.');
  }finally{await browser.close();await server.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
