/* Display preferences only. No measurement coordinates, intensities or ROI writes. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MsiDisplaySettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    const VERSION = 2;
    const maps = ['plasma','viridis','inferno','hot','hotmetal','jet','grayscale'];
    function normalizeLevel(value, fallback) {
        return typeof value === 'number' && Number.isFinite(value)
            ? Math.max(1, Math.min(10, Math.round(value))) : fallback;
    }
    function normalize(value) {
        if (!value || ![1, VERSION].includes(value.version)) return null;
        const legacy = value.version === 1;
        const legacyStrength = typeof value.smoothingStrength === 'number' && Number.isFinite(value.smoothingStrength)
            ? Math.max(0, Math.min(100, value.smoothingStrength)) : 0;
        return {version:VERSION,
            preset:['current','hdi','custom'].includes(value.preset) ? value.preset : 'current',
            aspectMode:value.aspectMode === 'physical' ? 'physical' : 'legacy',
            rangePolicy:value.rangePolicy === 'maximum' ? 'maximum' : 'legacy',
            smoothingStrength:legacy ? Math.max(1, Math.ceil(legacyStrength / 10)) : normalizeLevel(value.smoothingStrength, 1),
            linearStrength:legacy ? 10 : normalizeLevel(value.linearStrength, 10)};
    }
    function resolve(project, override) {
        const meta = project && project.meta || {};
        const saved = normalize(meta.msiDisplay);
        const transient = normalize(override);
        if (!transient) override = null;
        const value = transient || saved || {version:VERSION,preset:'current',aspectMode:'legacy',rangePolicy:'legacy',smoothingStrength:1,linearStrength:10};
        const fallbackMap = value.preset === 'hdi' ? 'hotmetal' : 'plasma';
        const source = transient ? override : saved ? meta.msiDisplay : null;
        let interpolation = override && override.interpolation || meta.msiSmoothing;
        // Version 1 used an additional Gaussian amount under Linear. Replace
        // that display effect with Median; ordinary legacy Linear stays at 10.
        if (source && source.version === 1 && typeof source.smoothingStrength === 'number'
            && Number.isFinite(source.smoothingStrength) && source.smoothingStrength > 0 && interpolation === 'linear') {
            interpolation = 'median';
        }
        return {...value, explicit:!!(transient || saved),
            colormap:maps.includes(override && override.colormap) ? override.colormap
                : (maps.includes(meta.colormap) ? meta.colormap : fallbackMap),
            interpolation:['linear','median'].includes(interpolation) ? interpolation : 'none'};
    }
    function preset(name, aspectMode) {
        const hdi = name === 'hdi';
        return {version:VERSION,preset:hdi?'hdi':'current',aspectMode:aspectMode || (hdi?'physical':'legacy'),
            rangePolicy:hdi?'maximum':'legacy',colormap:hdi?'hotmetal':'plasma',interpolation:'none',smoothingStrength:1,linearStrength:10};
    }
    function newProjectMeta() {
        return {msiDisplay:normalize(preset('hdi')),colormap:'hotmetal',msiSmoothing:'none'};
    }
    // Independent piecewise RGB approximation of the installed HDI HotMetal
    // palette. This is distinct from matplotlib Hot and never changes values.
    function hotMetalLut(size = 256) {
        const stops = [[0,0,0,0],[3/11,0,0,255],[6/11,255,0,0],[9/11,255,255,0],[1,255,255,165]];
        return Array.from({length:size},(_,i) => {
            const t = size > 1 ? i/(size-1) : 0;
            let j=0;while(j<stops.length-2 && t>stops[j+1][0])j++;
            const a=stops[j],b=stops[j+1],u=(t-a[0])/(b[0]-a[0]);
            return [1,2,3].map(k=>Math.round(a[k]+(b[k]-a[k])*u));
        });
    }
    return {VERSION,normalize,resolve,preset,newProjectMeta,hotMetalLut};
});
