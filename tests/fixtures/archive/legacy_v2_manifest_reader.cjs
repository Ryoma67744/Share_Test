'use strict';
// Frozen manifest-selection gate from viewer/index.html at
// cdcfa34fe4631d7c87a0231dadcb564468d07b75, immediately after JSZip.loadAsync.
// The old importer cannot reach prepareImport or any storage write when this
// gate rejects a v3 archive. Keep this reader independent of current helpers.
module.exports = async function legacyV2ManifestReader(zip) {
    const rootJsonPaths = Object.keys(zip.files).filter(p => /^[^/]+\.json$/i.test(p));
    let projectDocCount = 0;
    let projDoc = null;
    for (const p of rootJsonPaths) {
        try {
            const candidate = JSON.parse(await zip.file(p).async('string'));
            if (candidate && (candidate.format === 'desi_data_share_v1' || candidate.format === 'desi_data_share_v2')) {
                projectDocCount++;
                projDoc = candidate;
            }
        } catch (e) {}
    }
    if (!projDoc) throw new Error('Project JSON (format=desi_data_share_v1/v2) not found in ZIP root');
    if (projectDocCount !== 1) throw new Error('ZIP に複数のプロジェクト定義があります / Multiple project manifests in ZIP');
    return projDoc;
};
