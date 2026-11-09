'use strict';
// Developer-only PDF refresh; regular web/offline builds just copy the PDF.
// The same manifest and actual screenshots drive HTML Help and this document.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const {chromium}=createRequire(path.resolve(__dirname,'../tests/package.json'))('playwright');
const {renderStandalone,introduction}=require('./help-docs.cjs');
const root=path.resolve(__dirname,'..');
function buildPdfHtml(body,version){
  return '<!doctype html><html lang="ja"><meta charset="utf-8"><title>SHARE_TEST 閲覧者ガイド</title><style>'+`
    @page{size:A4;margin:14mm 16mm 17mm}
    body{font:9pt/1.5 "Yu Gothic","Meiryo",sans-serif;color:#24303c}
    h1{font-size:24pt}h2{font-size:16pt;color:#087b74;margin:0 0 10px}
    h3{font-size:11pt;margin-top:16px}h4{font-size:9.5pt;margin:10px 0 5px}
    h2,h3,h4{break-after:avoid}article{break-before:page}
    li{margin:0 0 6px;break-inside:avoid}li p{margin:2px 0 0}ol{padding-left:23px}
    p{margin:6px 0;orphans:3;widows:3}figure{margin:10px 0;break-inside:avoid}
    img{width:100%;height:auto;max-height:76mm;object-fit:contain;border:1px solid #dfe5e9}
    figcaption{font-size:7.5pt;color:#647181}.guided-example{margin:14px 0 22px}
    .example-panels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .example-comparisons{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;break-inside:avoid}
    .example-comparisons img{height:47mm;object-fit:contain}
    .example-heading{break-inside:avoid;break-after:avoid}.example-choice-body{font-size:8pt}
    .example-panels:has(>.example-panel:only-child){display:block}
    .example-panel,.example-choice{min-width:0;break-inside:avoid}
    .example-figure img{max-height:67mm;border:0;background:#000}
    .example-panels:has(>.example-panel:only-child) img{max-height:88mm}
    .example-scale{font-size:8pt;font-weight:bold}.example-footnote,.example-source{font-size:8pt;color:#526170}
    .example-table{border-collapse:collapse;width:100%;margin:12px 0;font-size:8.5pt;break-inside:avoid}
    .example-table caption{text-align:left;font-weight:bold;margin-bottom:6px}
    .example-table th,.example-table td{padding:7px;border:1px solid #dfe5e9;text-align:left}
    .example-table th{background:#edf5f4}.context-screenshot img{max-height:74mm}
    .help-screenshot img{max-height:62mm}
    article:has(>.help-screenshot+.help-screenshot)>.help-screenshot img{max-height:52mm}
    .note{padding:9px 12px;background:#eff7f5;border-left:3px solid #087b74;break-inside:avoid}
    .cover{padding-top:32mm}.muted{color:#647181}.cover p{max-width:145mm}
  `+'</style><body><section class="cover"><p>SHARE_TEST / USER GUIDE</p><h1>閲覧者ガイド</h1><p class="muted">'+version+'</p><p>実際の MSI の例と番号付き手順で、表示・比・ROI・共有の操作を説明します。</p><p>'+introduction('ja')+'</p><p>共有画面の権限に沿った内容を掲載しています。プロジェクト管理・データ登録・MRM 管理は、アプリの Help で作成者・プロジェクト管理ガイドを開いてください。</p><p>オンライン / オフライン、言語や権限に合わせた最新の説明は、アプリの Help から参照できます。</p></section>'+body+'</body></html>';
}
async function main(){
  const version=(await fs.readFile(path.join(root,'version.js'),'utf8')).match(/v\d{4}-\d{2}-\d{2}\.\d+/)?.[0]||'';
  const body=renderStandalone(root,'viewer','ja','online');
  const html=buildPdfHtml(body,version);
  let browser;try{browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});const page=await browser.newPage();await page.route('**/*',r=>/^(data|about):/.test(r.request().url())?r.continue():r.abort());await page.setContent(html,{waitUntil:'load'});await page.evaluate(()=>Promise.all([...document.images].map(img=>img.decode())));await page.pdf({path:path.join(root,'USER_GUIDE.pdf'),format:'A4',printBackground:true,displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:'<div style="font-size:8px;width:100%;text-align:center;color:#647181">SHARE_TEST · '+version+' · <span class="pageNumber"></span> / <span class="totalPages"></span></div>'});
    const sourceHash=crypto.createHash('sha256').update(body).digest('hex');console.log('Updated USER_GUIDE.pdf; source SHA-256 '+sourceHash);
  }finally{if(browser)await browser.close();}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={main,buildPdfHtml};
