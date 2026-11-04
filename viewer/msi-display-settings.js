/* Display preferences only. No measurement coordinates, intensities or ROI writes. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MsiDisplaySettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    const VERSION = 1;
    const maps = ['plasma','viridis','inferno','hot','hotmetal','jet','grayscale'];
    function normalize(value) {
        if (!value || value.version !== VERSION) return null;
        return {version:VERSION,
            preset:['current','hdi','custom'].includes(value.preset) ? value.preset : 'current',
            aspectMode:value.aspectMode === 'physical' ? 'physical' : 'legacy',
            rangePolicy:value.rangePolicy === 'maximum' ? 'maximum' : 'legacy'};
    }
    function resolve(project, override) {
        const meta = project && project.meta || {};
        const saved = normalize(meta.msiDisplay);
        const transient = normalize(override);
        if (!transient) override = null;
        const value = transient || saved || {version:VERSION,preset:'current',aspectMode:'legacy',rangePolicy:'legacy'};
        const fallbackMap = value.preset === 'hdi' ? 'hotmetal' : 'plasma';
        return {...value, explicit:!!(transient || saved),
            colormap:maps.includes(override && override.colormap) ? override.colormap
                : (maps.includes(meta.colormap) ? meta.colormap : fallbackMap),
            interpolation:(override && override.interpolation || meta.msiSmoothing) === 'linear' ? 'linear' : 'none'};
    }
    function preset(name, aspectMode) {
        const hdi = name === 'hdi';
        return {version:VERSION,preset:hdi?'hdi':'current',aspectMode:aspectMode || (hdi?'physical':'legacy'),
            rangePolicy:hdi?'maximum':'legacy',colormap:hdi?'hotmetal':'plasma',interpolation:'none'};
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
