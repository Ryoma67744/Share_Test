/* Connect ROI photographs to the viewer without changing its display state. */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.RoiMediaApp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';
    const MAX_BYTES = 500 * 1024 * 1024;
    const MAX_PIXELS = 64 * 1024 * 1024;
    const MAX_DIMENSION = 16384;
    let active = null, service = null;
    const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

    function checkDimensions(width, height) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
            throw new Error('画像の寸法を確認できませんでした。PNG・JPEG・単一画像のTIFFを選択してください。');
        if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS)
            throw new Error('画像が大きすぎます。長辺16,384 px以下、約6,710万画素以下の対象視野を別ファイルとして用意してください。原本は変更しません。');
    }

    // Read dimensions before allocating a full decoded image. In particular,
    // a tiny compressed TIFF can otherwise allocate gigabytes of RGBA memory.
    async function inspectImage(blob) {
        if (!blob || typeof blob.slice !== 'function' || !(blob.size > 0)) throw new Error('空の画像ファイルです。');
        if (blob.size > MAX_BYTES) throw new Error('画像ファイルは500 MiB以下にしてください。');
        const header = new Uint8Array(await blob.slice(0, Math.min(blob.size, 2 * 1024 * 1024)).arrayBuffer());
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        let width, height, mime;
        if (header.length >= 24 && [137,80,78,71,13,10,26,10].every((v,i) => header[i] === v)) {
            width = view.getUint32(16); height = view.getUint32(20); mime = 'image/png';
        } else if (header.length >= 4 && header[0] === 255 && header[1] === 216) {
            let offset = 2;
            while (offset + 4 <= header.length) {
                if (header[offset++] !== 255) break;
                while (header[offset] === 255) offset++;
                const marker = header[offset++];
                if (marker === 217 || marker === 218) break;
                if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
                if (offset + 2 > header.length) break;
                const length = view.getUint16(offset);
                if (length < 2 || offset + length > header.length) break;
                if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) {
                    height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
                }
                offset += length;
            }
            mime = 'image/jpeg';
        } else if (header.length >= 8 && ((header[0] === 73 && header[1] === 73) || (header[0] === 77 && header[1] === 77))) {
            const little = header[0] === 73;
            if (view.getUint16(2, little) !== 42) throw new Error('このTIFF形式には対応していません。単一画像のPNG・JPEG・標準TIFFを用意してください。');
            const offset = view.getUint32(4, little);
            if (offset < 8 || offset + 2 > blob.size) throw new Error('TIFFの画像情報が壊れています。');
            const countView = new DataView(await blob.slice(offset, offset + 2).arrayBuffer());
            const count = countView.getUint16(0, little);
            const end = offset + 2 + count * 12 + 4;
            if (!count || count > 4096 || end > blob.size) throw new Error('TIFFの画像情報を読み取れません。');
            const entries = new DataView(await blob.slice(offset + 2, end).arrayBuffer());
            if (entries.getUint32(count * 12, little) !== 0)
                throw new Error('複数ページのTIFFです。登録する視野・チャンネルを単一画像として書き出してください。');
            for (let i = 0; i < count; i++) {
                const at = i * 12, tag = entries.getUint16(at, little), type = entries.getUint16(at + 2, little);
                const n = entries.getUint32(at + 4, little);
                if (tag === 330 && n > 0) throw new Error('階層・複数画像を含むTIFFです。対象視野を単一画像として書き出してください。');
                if ((tag === 256 || tag === 257) && n === 1 && (type === 3 || type === 4)) {
                    const value = type === 3 ? entries.getUint16(at + 8, little) : entries.getUint32(at + 8, little);
                    if (tag === 256) width = value; else height = value;
                }
            }
            mime = 'image/tiff';
        } else throw new Error('PNG・JPEG・単一画像のTIFFを選択してください。');
        checkDimensions(width, height);
        return { width, height, mime, byteSize:blob.size };
    }

    async function decodePhoto(blob) {
        const info = await inspectImage(blob);
        if (info.mime !== 'image/tiff' && typeof root.createImageBitmap === 'function') {
            const image = await root.createImageBitmap(blob);
            try { checkDimensions(image.width, image.height); }
            catch (error) { image.close(); throw error; }
            return { image, width:image.width, height:image.height, mime:info.mime, dispose:() => image.close(), status:'原解像度の画像' };
        }
        let url, isObjectUrl = false;
        if (info.mime === 'image/tiff') url = await decodeImageBlobToDataUrl(blob, info.mime);
        else { url = URL.createObjectURL(blob); isObjectUrl = true; }
        try {
            const image = await new Promise((resolve,reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('画像を表示できません。ファイルの形式を確認してください。'));
                img.src = url;
            });
            checkDimensions(image.naturalWidth, image.naturalHeight);
            return { image, width:image.naturalWidth, height:image.naturalHeight, mime:info.mime,
                status:info.mime === 'image/tiff' ? '原解像度・8bit RGB表示（TIFF原本を保持）' : '原解像度の画像',
                dispose:() => { image.src = ''; if (isObjectUrl) URL.revokeObjectURL(url); } };
        } catch (error) { if (isObjectUrl) URL.revokeObjectURL(url); throw error; }
    }

    function current(project, roi, section) {
        return typeof App !== 'undefined' && App.project === project
            && (project.rois || []).includes(roi) && (!section || (project.sections || []).includes(section));
    }
    function sectionFor(project, sectionId) {
        const section = (project.sections || []).find(s => s.id === sectionId);
        if (!section) throw new Error('対象の切片が見つかりません。');
        return section;
    }
    function getService() {
        if (service) return service;
        service = RoiMediaService.create({ model:RoiMediaModel, storage:ProjectStorage,
            maxBytes:MAX_BYTES, maxPixels:MAX_PIXELS, maxDimension:MAX_DIMENSION,
            uid:prefix => uid(prefix || 'roi_photo'), now:() => new Date().toISOString(),
            isCurrent:current, decode:decodePhoto,
            sourceRef:(project,roi,section) => {
                const meta = msiRoiGeometryMeta(roi,section);
                if (meta) return meta.sourceRef || '';
                const refs = new Set(Object.values(section.msiSeries || {}).map(msiSourceReference));
                return refs.size === 1 ? [...refs][0] : '';
            },
            save:async (project,registry) => {
                if (App.project !== project) throw new Error('プロジェクトが切り替わったため保存を中止しました。');
                App.queueSave(0);
                if (await App._flushSave() === false) return false;
                const saved = await ProjectStorage.getProject(project.id);
                if (!saved || JSON.stringify(RoiMediaModel.getRegistry(saved)) !== JSON.stringify(registry))
                    throw new Error('画像の登録情報を保存先から確認できませんでした。');
                return true;
            },
            onRollback:async project => {
                if (App.project !== project) return;
                App.queueSave(0);
                if (await App._flushSave() === false) throw new Error('画像情報の復元を保存できませんでした。保存を再試行してください。');
            },
            onChange:() => { if (typeof populateRoiList === 'function') populateRoiList(); },
        });
        return service;
    }

    function compatibility(roi, section, key) {
        const ent = (section.msiSeries || {})[key];
        if (!ent) return 'この切片には対象のMSIがありません。';
        const meta = msiRoiGeometryMeta(roi,section);
        if (meta && !msiValidRoiGeometry(meta)) return 'ROIの座標情報を確認できません。';
        if (meta && meta.sourceRef !== msiSourceReference(ent)) return 'ROIを作成した測定ソースと異なります。';
        if (!meta && new Set(Object.values(section.msiSeries || {}).map(msiSourceReference)).size > 1)
            return '旧ROIの測定ソースを一意に確認できません。';
        return '';
    }

    function createAdapter(project, roi) {
        const frameCache = new Map(), windows = new Map(), masks = new Map(), orientations = new Map();
        const thumbnails = new Map();
        let selectedPhoto = null;
        const focus = App.focusCompoundKey || '';
        const lut = getActiveColormap().map(c => c.slice()), background = getColormapBackground().slice();
        const colormapName = typeof _activeColormapName === 'string' ? _activeColormapName : '';
        const otsuOn = !!App.otsuBgRemove;
        const absolute = new Map();
        for (const section of project.sections || []) {
            if (!App._organInScope(section)) continue;
            for (const [key,ent] of Object.entries(section.msiSeries || {})) {
                const value = Number.isFinite(ent.rawDispMax) ? ent.rawDispMax : (ent.rawRange || [])[1];
                if (Number.isFinite(value)) absolute.set(key, Math.max(absolute.get(key) || 0,value));
            }
        }
        const windowContext = { msiScaleMode:App.msiScaleMode, msiUserWindow:copy(App.msiUserWindow || {}),
            getMsiAbsMax:key => absolute.get(key) || 0 };
        for (const section of project.sections || []) {
            orientations.set(section.id, sectionLayerViewLinear(section,'msi'));
            if (otsuOn) masks.set(section.id, copy(section.meta && section.meta.otsu));
        }
        const valid = () => current(project,roi);
        const assertValid = () => { if (!valid()) throw new Error('対象のROIまたはプロジェクトが変更されました。'); };
        const photoCompatibility = (r,section,key) => {
            const reason = compatibility(r,section,key);
            if (reason || !selectedPhoto) return reason;
            if (!selectedPhoto.sourceRef) return '写真登録時のMSI測定ソースを確認できません。写真を再登録すると現在の対応先を記録できます。';
            if (selectedPhoto.sourceRef !== msiSourceReference(section.msiSeries[key]))
                return '写真登録時とはMSI測定ソースが異なります。対応を確認してから写真を再登録してください。';
            return '';
        };
        const photo = async item => {
            assertValid();
            let rec = item.blobId ? await ProjectStorage.getBlob(item.blobId) : null;
            let blob = rec && rec.blob;
            if (!blob && item.storagePath) {
                const url = SupabaseClient.publicUrl('atlases',item.storagePath);
                if (!url) throw new Error('写真の保存先に接続できません。');
                const response = await fetch(url);
                if (!response.ok) throw new Error('写真を取得できませんでした（HTTP '+response.status+'）。');
                const size = Number(response.headers.get('content-length'));
                if (size > MAX_BYTES) throw new Error('共有写真の容量が上限を超えています。');
                blob = await response.blob();
            }
            if (!blob) throw new Error('写真の原本が見つかりません。再登録するか、写真を含むZIPを読み込んでください。');
            assertValid();
            const decoded = await decodePhoto(blob);
            if (!valid()) { decoded.dispose(); throw new Error('画像の表示対象が変更されました。'); }
            const section = (project.sections || []).find(s => RoiMediaModel.sectionKey(project,s) === item.sectionId);
            if (section && !RoiMediaModel.snapshotMatches(item,roi,section))
                decoded.status += ' ／ 写真登録後にROI形状・座標が変更されています';
            if (section) {
                const sources = new Set(Object.values(section.msiSeries || {}).map(msiSourceReference));
                if (!item.sourceRef || !sources.has(item.sourceRef))
                    decoded.status += ' ／ 写真と現在のMSI測定ソースの対応を確認できません';
            }
            return decoded;
        };
        return {
            validateContext:valid,
            editable:(p,r) => current(p,r) && !p.__share && !App.shareMode && !r._collab,
            sections:(p,r) => (p.sections || []).filter(s => Array.isArray((r.polysBySection || {})[s.id])
                && r.polysBySection[s.id].length >= 3).map(s => ({id:s.id,name:s.displayName || 'Section '+s.ordinal})),
            list:(p,r,id) => RoiMediaModel.list(p,r,sectionFor(p,id)),
            selectPhoto:(p,r,id,item) => { selectedPhoto = item || null; },
            compounds:(p,r,id) => {
                const section = sectionFor(p,id);
                const items = Object.keys(section.msiSeries || {}).filter(key => /^MSI_/i.test(key)).map(key => {
                    const reason = photoCompatibility(r,section,key);
                    return {key,label:formatDisplayName(key),disabled:!!reason,reason};
                });
                return { items, notice:items.some(x => !x.disabled) ? '' : (items[0] && items[0].reason || 'このROIの座標に対応するMSIがありません。写真は閲覧できます。') };
            },
            preferredCompound:(p,r,id) => !photoCompatibility(r,sectionFor(p,id),focus) ? focus : null,
            loadPhoto:photo,
            loadThumbnail:async item => {
                const key = item.id+'|'+item.revision+'|'+(item.blobId || item.storagePath);
                if (!thumbnails.has(key)) {
                    const job = (async () => {
                        const decoded = await photo(item);
                        try {
                            const canvas = document.createElement('canvas'); canvas.width=144; canvas.height=88;
                            const context = canvas.getContext('2d'); context.imageSmoothingEnabled=true;
                            const scale = Math.min(144/decoded.width,88/decoded.height);
                            const w=decoded.width*scale,h=decoded.height*scale;
                            context.drawImage(decoded.image,(144-w)/2,(88-h)/2,w,h);
                            return canvas;
                        } finally { decoded.dispose(); }
                    })();
                    thumbnails.set(key,job);
                    job.catch(() => thumbnails.delete(key));
                    if (thumbnails.size > 64) thumbnails.delete(thumbnails.keys().next().value);
                }
                const image = await thumbnails.get(key);
                return {image,width:144,height:88,status:'プレビュー'};
            },
            loadMsi:async (p,r,id,key) => {
                assertValid();
                const section = sectionFor(p,id), panel = App.panels.get(id);
                const reason = photoCompatibility(r,section,key);
                if (reason) throw new Error(reason);
                if (!panel || panel._destroyed) throw new Error('切片のMSIを読み込めません。');
                const ent = section.msiSeries[key], identity = panel._msiLoadIdentity(key);
                if (!await panel.ensureMsiLayerLoaded(key)) throw new Error('MSIの元データを読み込めませんでした。');
                assertValid();
                const changedPhotoReason = photoCompatibility(r,section,key);
                if (changedPhotoReason) throw new Error(changedPhotoReason);
                if (section.msiSeries[key] !== ent || identity !== panel._msiLoadIdentity(key))
                    throw new Error('MSIの測定ソースが変更されました。比較画面を開き直してください。');
                const polygon = roiPolygonForDisplay(r,section,key,(r.polysBySection || {})[id]);
                if (!polygon || polygon.length < 3) throw new Error('ROIとMSIの対応座標を確認できません。');
                const cacheKey = id+'|'+key;
                if (!windows.has(cacheKey)) windows.set(cacheKey,App.getMsiWindow.call(windowContext,key,ent.rawRange,ent.rawDispMax));
                const win = windows.get(cacheKey);
                const signature = identity+'|'+JSON.stringify(win);
                let cached = frameCache.get(cacheKey);
                if (!cached || cached.signature !== signature) {
                    const maskSection = { ...section,meta:{...section.meta,otsu:masks.get(id)} };
                    const keepGrid = otsuOn ? _otsuKeepGridRaw(maskSection,key) : null;
                    const canvas = RoiMediaMsi.colorize(panel.imageSources[key], {
                        valueRaster:panel.msiValueRasters.get(key), keepGrid,lut,background,
                        rawRange:ent.rawRange,window:win,fallbackMax:msiRawFallbackMax(ent.rawRange),
                        evaluateValue:msiValueEval,evaluateLuminance:msiWindowEval,
                    });
                    cached = {signature,canvas};
                    // Only retain the current colored frame, not every molecule visited.
                    frameCache.clear(); frameCache.set(cacheKey,cached);
                }
                const pitch = msiDisplayPhysicalPitch(section,key);
                const aspect = pitch ? [[pitch.x/Math.min(pitch.x,pitch.y),0,0],[0,pitch.y/Math.min(pitch.x,pitch.y),0],[0,0,1]]
                    : [[1,0,0],[0,1,0],[0,0,1]];
                const c = r.rgba || [200,200,200,255];
                return { canvas:cached.canvas,polygon,transform:displayAffineMultiply(orientations.get(id),aspect),
                    roiColor:'rgb('+c.slice(0,3).join(',')+')',background:'rgb('+background.join(',')+')',pixelPitch:pitch,
                    status:formatDisplayName(key)+' ／ '+colormapName+' ／ 強度 '+win.min+'–'+win.max+(otsuOn?' ／ Otsu表示':'') };
            },
            add:(p,r,id,files) => getService().add(p,r,sectionFor(p,id),files),
            replace:(p,r,id,item,file) => getService().replace(p,r,sectionFor(p,id),item,file),
            update:(p,r,id,item,patch) => getService().update(p,r,sectionFor(p,id),item,patch),
            remove:(p,r,id,item) => getService().remove(p,r,sectionFor(p,id),item),
            makePrimary:(p,r,id,item) => getService().makePrimary(p,r,sectionFor(p,id),item),
        };
    }

    function open(project,roi) {
        if (!current(project,roi)) return;
        try {
            RoiMediaModel.getRegistry(project); // Fail visibly on unknown data contracts.
            const adapter = createAdapter(project,roi);
            if (!adapter.sections(project,roi).length) throw new Error('先に対象切片へROIを描いてください。');
            if (RoiMediaViewer.open({project,roi,adapter}) !== false) active = {project,roi,signature:''};
        } catch (error) { showToast(error.message || String(error),8000); }
    }
    function close() {
        active = null;
        if (typeof RoiMediaViewer !== 'undefined') RoiMediaViewer.close();
    }
    function refresh(force) {
        if (!active) return;
        if (!RoiMediaViewer.isOpen()) { active = null; return; }
        if (!current(active.project,active.roi)) { close(); return; }
        const signature = JSON.stringify([active.roi.name,active.roi.rgba,active.roi.polysBySection,active.roi.geometryBySection,
            active.project.meta && active.project.meta.roiMedia,(active.project.sections || []).map(section => [section.id,
                section.meta && section.meta.roiGeometryByColorKey,
                [...new Set(Object.values(section.msiSeries || {}).map(msiSourceReference))]])]);
        if (!force && signature === active.signature) return;
        active.signature = signature;
        RoiMediaViewer.refresh();
    }
    async function beforeProjectChange(project) {
        if (typeof RoiMediaViewer !== 'undefined' && RoiMediaViewer.requestClose({restoreFocus:false}) === false) return false;
        active = null;
        if (service && project) await service.idle(project);
        return true;
    }
    function hasPending(project) {
        return !!((service && project && service.isBusy(project)) ||
            (typeof RoiMediaViewer !== 'undefined' && RoiMediaViewer.hasUnsavedChanges()));
    }
    function count(project,roi) {
        try { return RoiMediaModel.list(project,roi).length; } catch (_) { return null; }
    }
    return {open,close,refresh,count,beforeProjectChange,hasPending,inspectImage,decodePhoto,createAdapter,MAX_BYTES,MAX_PIXELS,MAX_DIMENSION};
});
