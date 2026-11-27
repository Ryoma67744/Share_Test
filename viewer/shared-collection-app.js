/* Recipient-facing collection downloads. Only reads published project data. */
(function(root) {
    'use strict';
    const dictionary = {
        '一括ZIP': 'Download project ZIPs',
        'すべてZIP': 'Download all as ZIP',
        '選択したプロジェクトをZIP': 'Download selected as ZIP',
        '全選択': 'Select all',
        '選択解除': 'Clear selection',
        '中止': 'Cancel',
        '未取得を再試行': 'Retry unsuccessful projects',
        '再試行は未取得分だけの追加ZIPを作成します。先に取得したZIPも保存してください。': 'Retry creates an additional ZIP containing only unsuccessful projects. Keep the ZIPs already downloaded as well.',
        '結果一覧を保存': 'Save download report',
        '共有プロジェクト {0} 件 / 選択 {1} 件（子フォルダを含む）': '{0} shared projects / {1} selected (including subfolders)',
        '原本・ROI・保存定義を含みます。展開後、各プロジェクトZIPをImport ZIPで復元できます。派生CSV・位置合わせ済みPNGは復元後のExport ZIPで作成できます。': 'Includes original data, ROI and saved definitions. Extract the collection and use Import ZIP for each project. Generate derived CSVs and aligned PNGs with Export ZIP after restoring a project.',
        '256 MiBを目安にプロジェクト単位で分割します。大きな1プロジェクトは分割しません。保存リンクはこのページを閉じるまで有効です。': 'Collections split at project boundaries around 256 MiB; an individual project remains whole. Download links remain available until this page is closed.',
        'ZIPを作成するプロジェクトを選択してください。': 'Select projects to include in the ZIP.',
        '{0} / {1}: {2}': '{0} / {1}: {2}',
        '原本を取得中: {0}': 'Downloading original: {0}',
        'プロジェクトZIPを作成中…': 'Creating project ZIP…',
        '一括ZIP {0} を作成中…': 'Creating collection ZIP {0}…',
        '保存可能 {0} / 対象 {1}、未取得 {2}': '{0} of {1} projects ready to save; {2} unsuccessful',
        '中止しました。保存可能なZIPと未取得の一覧を確認してください。': 'Cancelled. Check the available ZIPs and the list of unsuccessful projects.',
        'ZIPを作成できませんでした: {0}': 'Could not create ZIP: {0}',
        'ダウンロードが始まらない場合は、下のZIPリンクを押してください。': 'If downloading does not start, click a ZIP link below.',
        '{0}（{1}プロジェクト、{2}）': '{0} ({1} projects, {2})',
        '未取得のプロジェクト': 'Unsuccessful projects',
        '閲覧用パスワード: {0}': 'Viewer password: {0}',
        'フォルダと各プロジェクトのパスワードは別です。': 'Folder and project passwords are separate.',
        '取得を続行': 'Continue download',
        'このプロジェクトをスキップ': 'Skip this project',
        '一括ZIPを中止しました。': 'Collection ZIP cancelled.',
        '共有フォルダの階層が深すぎます。': 'The shared folder nesting is too deep.',
        'このプロジェクトの閲覧用パスワードを入力してください。': 'Enter this project’s viewer password.',
        'パスワード入力をスキップしました。': 'Password entry was skipped.',
        '閲覧用パスワードを確認してください。': 'Check the viewer password.',
        '共有プロジェクトの定義を読み取れません。': 'Cannot read the shared project definition.',
        '共有プロジェクトが取得対象と一致しません。': 'The shared project does not match the requested project.',
        '公開された原本参照がありません: {0}': 'A published original reference is missing: {0}',
        'ZIPの保存先名が不正です。': 'Invalid ZIP entry name.',
        'ZIPのファイル数が上限を超えています。プロジェクトを分けてください。': 'The ZIP contains too many files. Split the project.',
        'ZIP内の名前が重複しています: {0}': 'Duplicate ZIP entry name: {0}',
        '1プロジェクトのZIPが4 GiB上限を超えます。プロジェクトを分けてください。': 'One project ZIP exceeds the 4 GiB limit. Split the project.',
        'ZIPが4 GiB上限を超えています。': 'The ZIP exceeds the 4 GiB limit.',
        '公開された比の入力参照を確認してください: {0}': 'Check the published ratio input references: {0}',
        '原本を取得できません: {0}': 'Cannot download an original: {0}',
        '公開された原本とレイヤーの参照が一致しません: {0}': 'Published source and layer references do not match: {0}',
        'ROI写真の対応先が見つかりません: {0}': 'Cannot find the ROI photograph’s target: {0}',
        'ZIPを保存できませんでした。': 'Could not save the ZIP.',
        '原本のサイズが公開情報と一致しません。再公開を確認してください。': 'The original’s size does not match its published metadata. Check the published version.',
        '取得中に公開内容が変更されました。再試行してください。': 'The published project changed during download. Retry this project.',
        'ROIの取得結果を確認できません。': 'Cannot verify the ROI download.',
        'ROIの総件数を確認できません。完全なZIPを作成できません。': 'Cannot verify the total ROI count. A complete ZIP cannot be created.',
        '取得中にROIが変更されました。再試行してください。': 'ROI data changed during download. Retry this project.',
        'ROIを重複なく取得できません。再試行してください。': 'Cannot retrieve ROI data without duplicate rows. Retry this project.',
        'ROIの全件を取得できません。再試行してください。': 'Cannot retrieve every ROI. Retry this project.',
        '同じ切片・色のROIが重複しています。公開元で確認してください。': 'Multiple ROIs share the same section and color. Check them in the source project.',
        '失敗': 'Failed',
        '保存先を選んでZIP': 'Save ZIPs to a folder',
        '大容量では保存先フォルダを選ぶと、完成したZIPを順次保存して解放できます。': 'For large collections, choose a destination folder to save and release each completed ZIP in sequence.',
        '保存済み: {0}': 'Saved: {0}'
    };
    // Reuse existing shared wording; do not replace another page's catalog.
    root.AppI18n?.register('shared-collection', Object.fromEntries(Object.entries(dictionary)
        .filter(([source])=>!root.AppI18n.hasTranslation(source))));
    const text = (node, source, params) => {
        if (root.AppI18n) root.AppI18n.setText(node, source, params);
        else node.textContent = source.replace(/\{(\w+)\}/g, (_, key) => params?.[key] ?? '');
        return node;
    };
    const t = (source, params) => root.AppI18n ? root.AppI18n.t(source, params)
        : source.replace(/\{(\w+)\}/g, (_, key) => params?.[key] ?? '');
    const bytes = value => value >= 1024 * 1024 ? (value / (1024 * 1024)).toFixed(1) + ' MiB'
        : (value / 1024).toFixed(1) + ' KiB';
    const aborted = () => Object.assign(new Error(t('一括ZIPを中止しました。')), {name:'AbortError'});
    function mount(host, options) {
        const Collection = root.SharedCollection, doc = host.ownerDocument;
        const entries = Collection.collect(options.payload.index_doc);
        const container = host.querySelector('[data-collection-controls]');
        if (!container) throw new Error('Missing collection controls');
        const element = (tag, source, parent = container, params) => {
            const node = doc.createElement(tag);
            if (source) {
                if(tag==='label'){const span=doc.createElement('span');node.appendChild(span);text(span,source,params);}
                else text(node, source, params);
            }
            parent.appendChild(node);return node;
        };
        const title = element('h2','一括ZIP');title.style.cssText='font-size:15px;font-weight:700;margin:14px 0 4px;';
        const summary = element('p');summary.style.cssText='font-size:13px;margin:4px 0;';
        const note = element('p','原本・ROI・保存定義を含みます。展開後、各プロジェクトZIPをImport ZIPで復元できます。派生CSV・位置合わせ済みPNGは復元後のExport ZIPで作成できます。');
        note.style.cssText='font-size:12px;color:#475569;margin:4px 0;';
        const limits = element('p','256 MiBを目安にプロジェクト単位で分割します。大きな1プロジェクトは分割しません。保存リンクはこのページを閉じるまで有効です。');
        limits.style.cssText=note.style.cssText;
        const actions = element('div');actions.style.cssText='display:flex;gap:6px;flex-wrap:wrap;margin:10px 0;';
        function button(source, action) {
            const node = element('button',source,actions);node.type='button';node.className='btn';
            node.addEventListener('click',action);return node;
        }
        const checks = () => [...host.querySelectorAll('input[data-collection-project]')];
        const selected = () => new Set(checks().filter(node=>node.checked).map(node=>node.dataset.collectionProject));
        let running = false, controller = null, last = null, removePrompt = null, destination = null;
        const urls = new Set();
        function count() { text(summary,'共有プロジェクト {0} 件 / 選択 {1} 件（子フォルダを含む）',[entries.length,selected().size]); }
        const chooseAll = button('全選択',()=>{checks().forEach(node=>{node.checked=true;});count();});
        const clear = button('選択解除',()=>{checks().forEach(node=>{node.checked=false;});count();});
        const all = button('すべてZIP',()=>start(entries));all.dataset.collectionAction='all';
        const chosen = button('選択したプロジェクトをZIP',()=>start(entries.filter(entry=>selected().has(entry.slug))));
        chosen.dataset.collectionAction='selected';
        const cancel = button('中止',()=>controller?.abort());cancel.hidden=true;cancel.dataset.collectionAction='cancel';
        const retry = button('未取得を再試行',()=>{
            const slugs = new Set((last?.results || []).filter(row=>row.status!=='ready').map(row=>row.slug));
            return start(entries.filter(entry=>slugs.has(entry.slug)));
        });retry.hidden=true;retry.dataset.collectionAction='retry';
        const report = button('結果一覧を保存',()=>{
            if (last) offer(new Blob([JSON.stringify(last,null,2)],{type:'application/json'}),
                Collection.safeName(options.payload.name) + '_download-results.json', 0, false);
        });report.hidden=true;
        let folderButton = null;
        if (typeof root.showDirectoryPicker === 'function') {
            folderButton = button('保存先を選んでZIP',async()=>{
                try { destination=await root.showDirectoryPicker({mode:'readwrite'});await start(entries.filter(entry=>selected().has(entry.slug))); }
                catch (error) { if(error?.name!=='AbortError')text(status,'ZIPを作成できませんでした: {0}',[error.message]); }
                finally { destination=null; }
            });
            const diskNote = element('p','大容量では保存先フォルダを選ぶと、完成したZIPを順次保存して解放できます。');
            diskNote.style.cssText=note.style.cssText;
        }
        const status = element('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
        status.style.cssText='font-size:13px;margin:4px 0;';status.dataset.collectionStatus='';
        const meter = element('progress');meter.hidden=true;meter.style.cssText='width:100%;height:12px;';meter.max=entries.length || 1;
        const detail = element('p');detail.style.cssText='font-size:12px;color:#475569;overflow-wrap:anywhere;';
        const retryNote=element('p','再試行は未取得分だけの追加ZIPを作成します。先に取得したZIPも保存してください。');
        retryNote.hidden=true;retryNote.style.cssText=note.style.cssText;
        const passwordHost = element('div');
        const downloads = element('div');downloads.dataset.collectionDownloads='';downloads.style.cssText='overflow-wrap:anywhere;';
        const failed = element('div');failed.dataset.collectionFailures='';
        for (const input of checks()) input.addEventListener('change',()=>{
            checks().filter(node=>node.dataset.collectionProject===input.dataset.collectionProject).forEach(node=>{node.checked=input.checked;});count();
        });
        count();

        function askPassword(entry, {signal,error}) {
            return new Promise((resolve,reject)=>{
                if (signal?.aborted) {reject(aborted());return;}
                passwordHost.replaceChildren();
                const form=element('form',null,passwordHost);form.dataset.collectionPassword=entry.slug;
                form.style.cssText='border:1px solid #cbd5e1;border-radius:8px;padding:12px;margin:8px 0;';
                const label=element('label','閲覧用パスワード: {0}',form,[entry.name]);
                label.style.cssText='display:block;font-size:13px;font-weight:600;';
                const input=element('input',null,label);input.type='password';input.autocomplete='current-password';input.required=true;
                input.style.cssText='display:block;width:100%;max-width:360px;padding:6px;margin:6px 0;border:1px solid #cbd5e1;border-radius:4px;';
                element('p','フォルダと各プロジェクトのパスワードは別です。',form).style.fontSize='12px';
                if(error)element('p',null,form).textContent=error;
                const submit=element('button','取得を続行',form);submit.type='submit';submit.className='btn';
                const skip=element('button','このプロジェクトをスキップ',form);skip.type='button';skip.className='btn';skip.style.marginLeft='6px';
                const cleanup=()=>{signal?.removeEventListener('abort',abort);input.value='';passwordHost.replaceChildren();removePrompt=null;};
                const done=value=>{cleanup();resolve(value);};
                const abort=()=>{cleanup();reject(aborted());};removePrompt=abort;
                signal?.addEventListener('abort',abort,{once:true});
                form.addEventListener('submit',event=>{event.preventDefault();done(input.value);});
                skip.addEventListener('click',()=>done(null));input.focus();
            });
        }
        let sessionStore=null;try{sessionStore=root.sessionStorage;}catch(_){}
        const sessions=Collection.createSessions({api:options.api,storage:sessionStore,askPassword});
        async function loadProject(entry,{signal}) {
            return sessions.run(entry,async session=>{
                const remote=await options.api.fetchProjectDoc(session.token,{signal});
                const sections=remote?.sections || [];
                const rows=await Collection.readRois(options.api,session.token,sections,{signal});
                const project=Collection.projectFromDoc(remote,entry.slug,{
                    rois:options.groupRois(rows,remote.anatomy_palette || remote.anatomyPalette || {}),
                    roiMedia:options.roiRegistry(remote),ratios:options.ratioRegistry(remote),
                    memo:options.memo(remote.meta?.project_meta?.memo || remote.memo)});
                const identity=value=>JSON.stringify([value?.publish_revision,value?.meta,value?.sections,value?.anatomy_palette]);
                const signature=identity(remote);
                const roiSignature=Collection.roiSignature(rows);
                return {project,revision:remote.publish_revision,publishedAt:remote.updated_at,
                    validate:()=>sessions.run(entry,async current=>{
                        const latest=await options.api.fetchProjectDoc(current.token,{signal});
                        if(identity(latest)!==signature)throw new Error(t('取得中に公開内容が変更されました。再試行してください。'));
                        const latestRows=await Collection.readRois(options.api,current.token,sections,{signal});
                        if(Collection.roiSignature(latestRows)!==roiSignature)
                            throw new Error(t('取得中にROIが変更されました。再試行してください。'));
                    },{signal})};
            },{signal});
        }
        function offer(blob,filename,projectCount,auto=true) {
            const url=URL.createObjectURL(blob);urls.add(url);
            const line=element('p',null,downloads),link=element('a',null,line);
            link.href=url;link.download=filename;link.style.cssText='color:#1d4ed8;text-decoration:underline;';
            text(link,'{0}（{1}プロジェクト、{2}）',[filename,projectCount,bytes(blob.size)]);
            if(auto)link.click();
        }
        async function savePart(part) {
            if(!destination) {offer(part.blob,part.filename,part.count);return;}
            // Pick an unused name; never overwrite a prior completed backup.
            let filename=part.filename,serial=1;
            for(;;) {
                try{await destination.getFileHandle(filename);filename=part.filename.replace(/\.zip$/i,'__'+(++serial)+'.zip');}
                catch(error){if(error.name==='NotFoundError')break;throw error;}
            }
            const file=await destination.getFileHandle(filename,{create:true});
            let stream;
            try {
                stream=await file.createWritable();
                await part.blob.stream().pipeTo(stream,{signal:controller.signal});
                element('p','保存済み: {0}',downloads,[filename]);
            } catch(error) {
                try{await stream?.abort();}catch(_){}
                try{await destination.removeEntry(filename);}catch(_){}
                throw error;
            }
        }
        function setRunning(value) {
            running=value;
            for(const button of [chooseAll,clear,all,chosen,retry,folderButton].filter(Boolean))button.disabled=value;
            checks().forEach(input=>{input.disabled=value;});cancel.hidden=!value;meter.hidden=!value;
        }
        function failureList(results) {
            failed.replaceChildren();
            const missing=results.filter(row=>row.status!=='ready');
            if(!missing.length)return;
            element('h3','未取得のプロジェクト',failed).style.cssText='font-size:13px;font-weight:600;margin:12px 0 4px;';
            const list=element('ul',null,failed);list.style.cssText='font-size:12px;color:#9f1239;padding-left:20px;';
            for(const row of missing)element('li',null,list).textContent=row.name+' — '+(row.error || t('失敗'));
        }
        async function start(targets) {
            if(running)return;
            if(!targets.length){text(status,'ZIPを作成するプロジェクトを選択してください。');return;}
            controller=new AbortController();setRunning(true);failed.replaceChildren();retry.hidden=true;report.hidden=true;
            detail.textContent='';meter.value=0;meter.max=targets.length;
            const unload=event=>{event.preventDefault();event.returnValue='';};root.addEventListener('beforeunload',unload);
            try {
                last=await Collection.run(targets,{
                    name:options.payload.name || options.payload.index_doc?.name || 'Shared projects',signal:controller.signal,
                    loadProject,freezeReferences:options.freezeReferences,imageIdentity:options.imageIdentity,
                    resolveSource:entry=>{const path=entry.storagePath || entry.path;return {path,
                        url:path?options.api.publicUrl('atlases',path):entry.sourceUrl,mime:entry.mime,filename:entry.filename};},
                    fetchBlob:(url,settings)=>options.fetchBlob(url,settings),onPart:savePart,
                    onProgress:event=>{
                        meter.value=event.results.filter(row=>['ready','prepared','failed'].includes(row.status)).length;
                        if(event.entry)text(status,'{0} / {1}: {2}',[event.index+1,targets.length,event.entry.name]);
                        if(event.stage==='source') {
                            text(detail,'原本を取得中: {0}',[event.file || '']);
                            if(event.loaded!=null)detail.appendChild(doc.createTextNode(' '+bytes(event.loaded)+(event.total?' / '+bytes(event.total):'')));
                        } else if(event.stage==='archive')text(detail,'プロジェクトZIPを作成中…');
                        else if(event.stage==='collection')text(detail,'一括ZIP {0} を作成中…',[event.part]);
                    }
                });
                const ready=last.results.filter(row=>row.status==='ready').length;
                text(status,'保存可能 {0} / 対象 {1}、未取得 {2}',[ready,last.results.length,last.results.length-ready]);
                if(last.cancelled)text(detail,'中止しました。保存可能なZIPと未取得の一覧を確認してください。');
                else if(ready && !destination)text(detail,'ダウンロードが始まらない場合は、下のZIPリンクを押してください。');
                else detail.textContent='';
                failureList(last.results);retry.hidden=ready===last.results.length;
                if(ready!==last.results.length)retryNote.hidden=false;
                report.hidden=false;
            } catch(error) {text(status,'ZIPを作成できませんでした: {0}',[error.message || String(error)]);}
            finally {removePrompt?.();setRunning(false);root.removeEventListener('beforeunload',unload);}
        }
        const cleanup=()=>{controller?.abort();removePrompt?.();for(const url of urls)URL.revokeObjectURL(url);urls.clear();};
        root.addEventListener('pagehide',cleanup,{once:true});
        return {start,destroy:cleanup};
    }
    root.SharedCollectionApp={mount};
})(typeof globalThis!=='undefined'?globalThis:this);
