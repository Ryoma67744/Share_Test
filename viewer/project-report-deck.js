/* Editable PowerPoint reports. PptxGenJS and JSZip are loaded locally by the caller. */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.ProjectReportDeck = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
    'use strict';
    const REPORT_REVISION = 'ppt-20261110-1';
    const WIDTH = 13.333333, HEIGHT = 7.5;
    const FONT = 'Yu Gothic';
    // Same reference boostmap ramp as ProjectReportData. These are scientific
    // legend marks, rendered as editable native rectangles, not an illustration.
    const COLOR_STOPS = ['000000', '00002E', '00005C', '00008A', '0000B8', '0000E5', '1500E9',
        '4400BB', '71008D', '9F0060', 'CC0032', 'FB0004', 'FF2B00', 'FF5800', 'FF8600',
        'FFB400', 'FFE200', 'FFFF11', 'FFFF3E', 'FFFF6A', 'FFFF97'];
    const string = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    function chunks(items, size) {
        const pages = [];
        for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
        return pages;
    }
    function number(value) {
        if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
        return String(Number(value));
    }
    function text(slide, value, box, options) {
        slide.addText(string(value), Object.assign({ ...box, fontFace: FONT, fontSize: 16,
            color: 'FFFFFF', margin: 0, breakLine: false, valign: 'mid',
            fit: 'shrink', lang: 'ja-JP', paraSpaceAfterPt: 0 }, options));
    }
    function base(pptx, report, title, light) {
        const slide = pptx.addSlide();
        slide.background = { color: light ? 'FFFFFF' : '000000' };
        text(slide, title, { x: 0.35, y: 0.24, w: 12.63, h: 0.46 },
            { fontSize: 25, bold: true, color: light ? '17223B' : 'FFFFFF' });
        text(slide, report.projectName, { x: 0.35, y: 7.12, w: 11.8, h: 0.18 },
            { fontSize: 8, color: light ? '667085' : 'B5B5B5' });
        text(slide, pptx._slides.length, { x: 12.25, y: 7.08, w: 0.7, h: 0.22 },
            { fontSize: 9, align: 'right', color: light ? '667085' : 'B5B5B5' });
        return slide;
    }
    function colorBar(pptx, slide, x, y, w, upper, options = {}) {
        const h = options.height || 3.7;
        const stops=options.stops || COLOR_STOPS,lower=options.lower || 0;
        // Interpolate the 21 shared stops for a continuous, editable legend.
        const steps = 80;
        for (let i = 0; i < steps; i++) {
            const position = i / (steps - 1) * (stops.length - 1);
            const lo = Math.floor(position), hi = Math.min(lo + 1, stops.length - 1), t = position - lo;
            const color = [0, 2, 4].map(offset => Math.round(
                parseInt(stops[lo].slice(offset, offset + 2), 16) * (1 - t) +
                parseInt(stops[hi].slice(offset, offset + 2), 16) * t).toString(16).padStart(2, '0')).join('');
            slide.addShape(pptx.ShapeType.rect, { x, y: y + (steps - 1 - i) * h / steps, w,
                h: h / steps + 0.001, line: { color, transparency: 100 }, fill: { color } });
        }
        for (let tick = 0; tick <= 4; tick++) {
            const value = lower+(Number(upper)-lower) * tick / 4;
            text(slide, options.percent ? Math.round(tick*25)+'%' : tick === 4 ? number(upper) : Number.isFinite(value) ? String(Number(value.toPrecision(4))) : '—',
                { x: x + w + 0.07, y: y + h * (1 - tick / 4) - 0.09, w: 0.72, h: 0.19 },
                { fontSize: 9, color: options.color || '17223B' });
        }
    }
    function picture(slide, entry, box, options = {}) {
        const image = entry && entry.image;
        if (!image) {
            text(slide, 'No image\n' + string(entry && entry.missingReason || 'No registered MSI image'), box,
                { fontSize: options.fontSize || 11, color: options.light ? '667085' : 'AFAFAF', align: 'center' });
            return null;
        }
        if (!/^data:image\/(?:png|jpeg);base64,/i.test(image.data || '') ||
            !Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) {
            throw new Error('Invalid report image for section: ' + string(entry.name || entry.sectionId));
        }
        const scale = Math.min(box.w / image.width, box.h / image.height);
        const w = image.width * scale, h = image.height * scale;
        const bounds = {x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h};
        slide.addImage({ data: image.data, ...bounds,
            w, h, altText: string(entry.name || entry.sectionId) });
        return bounds;
    }
    function sectionsFor(report) {
        const sections = [], seen = new Set();
        const add = (id, name, source = {}) => {
            id = string(id);
            if (!seen.has(id)) { seen.add(id); sections.push({ id, name: string(name) || id,
                referenceImage: source.referenceImage, referenceLabel: source.referenceLabel }); }
        };
        for (const section of report.sections || []) add(section.id, section.name, section);
        for (const molecule of report.molecules || []) {
            for (const section of molecule.sections || []) add(section.sectionId, section.name);
        }
        return sections;
    }
    function validWindow(value) {
        return value && Number.isFinite(value.min) && Number.isFinite(value.max) && value.max > value.min;
    }
    function outputGroupLabel(report) {
        const group = report.outputGroup;
        if (!group) return '';
        if (group.kind === 'independent') return (group.name === '独立' ? '' : group.name + ' | ')
            + '独立・この切片の自動Range';
        return group.name + ' | 共通自動Range';
    }
    // The explicit plan is the authoritative export boundary. Do not restore
    // an excluded section from a molecule entry, a reference, or a Ratio ROI.
    // Range calculation belongs to data preparation, before any page chunks.
    function outputReports(report) {
        if (report.outputPlan == null) return [report];
        const plan = report.outputPlan;
        if (plan.version !== 1 || !Array.isArray(plan.groups)) throw new Error('Invalid report output plan');
        const registered = new Map(report.sections.map(section => [string(section.id), section]));
        const ids = new Set(), assigned = new Set();
        const groups = plan.groups.map(group => {
            if (!group || !group.id || ids.has(string(group.id)) || !['compare', 'independent'].includes(group.kind)
                || !Array.isArray(group.sectionIds) || !group.sectionIds.length
                || group.kind === 'independent' && group.sectionIds.length !== 1) throw new Error('Invalid report output group');
            ids.add(string(group.id));
            const sectionIds = group.sectionIds.map(string);
            for (const id of sectionIds) {
                if (!registered.has(id) || assigned.has(id)) throw new Error('Invalid report section assignment');
                assigned.add(id);
            }
            return {id:string(group.id), name:string(group.name) || string(group.id), kind:group.kind, sectionIds};
        });
        const ordered = [...groups.filter(group => group.kind === 'compare'), ...groups.filter(group => group.kind === 'independent')];
        return ordered.map(group => {
            const included = new Set(group.sectionIds);
            const sections = group.sectionIds.map(id => ({...registered.get(id), id}));
            const molecules = report.molecules.map(molecule => {
                const entries = (molecule.sections || []).filter(entry => included.has(string(entry.sectionId)));
                if (!entries.length) return null;
                if (entries.some(entry => entry.outputGroupId != null && string(entry.outputGroupId) !== group.id))
                    throw new Error('Report entry belongs to another output group');
                const supplied = molecule.outputScales && molecule.outputScales[group.id];
                const scale = validWindow(supplied) ? supplied : entries.map(entry => entry.displayWindow).find(validWindow);
                if (!scale && entries.some(entry => entry.image)) throw new Error('Automatic report Range is unavailable');
                if (entries.some(entry => validWindow(entry.displayWindow)
                    && scale && (entry.displayWindow.min !== scale.min || entry.displayWindow.max !== scale.max)))
                    throw new Error('Report group Range is inconsistent');
                return {...molecule, sections:entries, outputScale:scale || {min:0,max:1,available:false,upperBasis:'unit-fallback'}};
            }).filter(Boolean);
            return {...report, sections, molecules, outputGroup:group};
        }).filter(scope => scope.molecules.length);
    }
    function imageScaleBar(pptx, slide, entry, bounds, cell) {
        const image = entry && entry.image;
        if (!bounds || !image || !Number.isFinite(image.physicalWidthUm) || image.physicalWidthUm <= 0
            || !Number.isFinite(image.physicalHeightUm) || image.physicalHeightUm <= 0) return;
        // Every bar is calibrated to its own contained image. A common bar
        // would be invalid when different physical fields are fitted equally.
        const target = image.physicalWidthUm * 0.24;
        const order = Math.pow(10, Math.floor(Math.log10(target)));
        let length = order;
        for (const factor of [1, 2, 5, 10]) if (factor * order <= target) length = factor * order;
        const width = bounds.w * length / image.physicalWidthUm;
        const x = bounds.x + bounds.w - width;
        const label = length >= 1000 ? number(length / 1000) + ' mm' : number(length) + ' µm';
        // Reserve a white band below the entire image region. Previously the
        // small label straddled the image edge and could disappear on black
        // pixels. Keep the calibrated width; only increase ink/text visibility.
        slide.addShape(pptx.ShapeType.rect, {x, y: 6.97, w: width, h: 0.055,
            line: {color: '000000', transparency: 100}, fill: {color: '000000'}});
        const labelWidth = Math.min(cell.w, Math.max(width, 1.0));
        const labelX = Math.max(cell.x, Math.min(x + width / 2 - labelWidth / 2, cell.x + cell.w - labelWidth));
        text(slide, label, {x: labelX, y: 6.68, w: labelWidth, h: 0.23},
            {fontSize: 11, bold: true, color: '000000', align: 'center'});
    }
    function entryFor(molecule, section) {
        return (molecule.sections || []).find(entry => string(entry.sectionId) === section.id);
    }
    function registeredPixelSize(entry) {
        // Acquisition pitch is independent of the resampled display raster.
        // Never fall back to entry.pixelPitch or infer it from image dimensions.
        const pitch = entry && entry.registeredPixelPitch;
        return pitch && Number.isFinite(pitch.x) && pitch.x > 0 && Number.isFinite(pitch.y) && pitch.y > 0
            ? number(pitch.x) + ' × ' + number(pitch.y) + ' µm/px' : null;
    }
    function matrixPixelSize(molecules, section) {
        const values = new Set(molecules.map(molecule => registeredPixelSize(entryFor(molecule, section))));
        if (values.size > 1) return 'Pixel size: varies';
        return values.values().next().value || 'Pixel size: —';
    }
    function planMatrices(molecules, sections) {
        // Group by registration, never image availability or intensity. Every
        // row in a group owns an entry for every column, including read failures
        // and valid all-zero measurements. Ratios retain their own diagnostics.
        const groups = new Map();
        for (const molecule of molecules) {
            const registered = new Set((molecule.sections || []).map(entry => string(entry.sectionId)));
            const included = sections.filter(section => registered.has(section.id));
            if (!included.length) continue;
            const kind = molecule.kind === 'ratio' ? 'ratio' : 'msi';
            const key = JSON.stringify([kind, included.map(section => section.id)]);
            if (!groups.has(key)) groups.set(key, {kind, sections: included, molecules: []});
            groups.get(key).molecules.push(molecule);
        }
        const pages = [];
        for (const group of groups.values()) {
            for (const sectionPage of chunks(group.sections, 4)) {
                const maxBlocks = sectionPage.length <= 2 ? 3 : sectionPage.length === 3 ? 2 : 1;
                for (const blocks of chunks(chunks(group.molecules, 8), maxBlocks)) {
                    pages.push({kind: group.kind, sections: sectionPage, blocks});
                }
            }
        }
        return pages;
    }
    // Approximate East Asian width conservatively for compact matrix labels.
    function wrap(value, capacity) {
        const lines = []; let line = '', width = 0;
        for (const character of string(value).replace(/\r\n?/g, '\n')) {
            if (character === '\n') { lines.push(line); line = ''; width = 0; continue; }
            const size = character.codePointAt(0) > 255 ? 2 : 1;
            if (width + size > capacity) { lines.push(line); line = ''; width = 0; }
            line += character; width += size;
        }
        lines.push(line);
        return lines;
    }
    function shortLabel(value, capacity, maxLines = 3) {
        const lines = wrap(value, capacity);
        if (lines.length > maxLines) return lines.slice(0, maxLines).join('\n').replace(/.$/, '…');
        return lines.join('\n');
    }
    async function addMatrices(pptx, report, sections, checkpoint) {
        if (!report.molecules.length || !sections.length) {
            await checkpoint();
            const slide = base(pptx, report, report.projectName);
            text(slide, 'No MSI molecules are registered in this project.',
                {x: 0.4, y: 3.0, w: 12.4, h: 0.7}, {fontSize: 22});
            return;
        }
        const borderColors = ['FF0000', '00D000', '00BFFF', 'FFAA00'];
        let page = 0;
        for (const {sections: sectionPage, blocks} of planMatrices(report.molecules, sections)) {
            await checkpoint();
            const slide = pptx.addSlide(); slide.background = {color: '000000'};
            const blockWidth = (WIDTH - 0.16) / blocks.length;
            const hasReference = sectionPage.some(section => !!section.referenceImage);
            const maxRows = Math.max(...blocks.map(block => block.length));
            const headerOffset = report.outputGroup ? 0.26 : 0;
            if (report.outputGroup) text(slide, outputGroupLabel(report),
                {x:0.1,y:0.04,w:13.1,h:0.2},{fontSize:10,bold:true});
            const top = 0.86 + headerOffset;
            const rowHeight = (7.3 - top - (hasReference ? 0.04 : 0)) / (maxRows + (hasReference ? 1 : 0));
            const pageMolecules = blocks.flat();
            blocks.forEach((molecules, block) => {
                const x = 0.08 + block * blockWidth;
                const labelWidth = blockWidth * (sectionPage.length <= 2 ? 0.39 : 0.3);
                const imageWidth = (blockWidth - labelWidth - 0.08) / sectionPage.length;
                const labelFont = blocks.length === 3 ? 9 : blocks.length === 2 ? 10 : 12;
                text(slide, report.projectName, {x: x + labelWidth, y: 0.05 + headerOffset,
                    w: blockWidth - labelWidth - 0.08, h: 0.22}, {fontSize: 10, bold: true, align: 'center'});
                sectionPage.forEach((section, column) => {
                    const left = x + labelWidth + column * imageWidth;
                    slide.addShape(pptx.ShapeType.rect, {x: left, y: 0.3 + headerOffset, w: imageWidth, h: 0.31,
                        fill: {color: '000000'}, line: {color: borderColors[sections.indexOf(section) % borderColors.length], width: 2}});
                    text(slide, shortLabel(section.name, Math.max(12, imageWidth * 17), 2),
                        {x: left + 0.025, y: 0.31 + headerOffset, w: imageWidth - 0.05, h: 0.29}, {fontSize: 9, bold: true, align: 'center'});
                    text(slide, matrixPixelSize(pageMolecules, section),
                        {x: left + 0.025, y: 0.65 + headerOffset, w: imageWidth - 0.05, h: 0.17}, {fontSize: 8, align: 'center'});
                });
                if (hasReference) {
                    text(slide, 'Optical / TIC', {x: x + 0.015, y: top, w: labelWidth - 0.05, h: rowHeight},
                        {fontSize: labelFont, bold: true});
                    sectionPage.forEach((section, column) => {
                        if (!section.referenceImage) return;
                        const box = {x: x + labelWidth + column * imageWidth + 0.02, y: top,
                            w: imageWidth - 0.04, h: rowHeight - 0.03};
                        picture(slide, {image: section.referenceImage, name: section.referenceLabel || 'Optical / TIC'}, box);
                    });
                }
                molecules.forEach((molecule, row) => {
                    const y = top + (row + (hasReference ? 1 : 0)) * rowHeight;
                    const subtitle = string(molecule.subtitle).split(/\s+\|\s+/)[0];
                    text(slide, shortLabel(molecule.name || molecule.key, Math.max(18, labelWidth * 17), 2),
                        {x: x + 0.015, y: y + 0.02, w: labelWidth - 0.05, h: rowHeight * 0.48},
                        {fontSize: labelFont, bold: true});
                    text(slide, shortLabel(subtitle, Math.max(18, labelWidth * 18), 2),
                        {x: x + 0.015, y: y + rowHeight * 0.5, w: labelWidth - 0.05, h: rowHeight * 0.45},
                        {fontSize: labelFont - 1, color: 'D9D9D9'});
                    sectionPage.forEach((section, column) => {
                        const entry = entryFor(molecule, section);
                        const range = report.outputGroup && entry && (entry.displayWindow || molecule.outputScale);
                        if (entry) picture(slide, entry,
                            {x: x + labelWidth + column * imageWidth + 0.02, y,
                                w: imageWidth - 0.04, h: rowHeight - 0.025 - (range ? 0.16 : 0)}, {fontSize: 7});
                        if (range) text(slide, 'Range ' + number(range.min) + ' – ' + number(range.max),
                            {x:x+labelWidth+column*imageWidth+0.02,y:y+rowHeight-0.15,w:imageWidth-0.04,h:0.12},
                            {fontSize:7,color:'D9D9D9',align:'center'});
                    });
                });
            });
            text(slide, 'MSI matrix ' + (++page), {x: 0.1, y: 7.32, w: 4, h: 0.13}, {fontSize: 7, color: '999999'});
        }
    }
    async function addDetails(pptx, report, sections, checkpoint) {
        for (const molecule of report.molecules) {
            // Registration determines inclusion, not image availability: keep
            // load failures visible and retain valid all-zero measurements.
            const pages = chunks(sections.filter(section => entryFor(molecule, section)), 2);
            for (let index = 0; index < pages.length; index++) {
                await checkpoint();
                const sectionPage = pages[index];
                const slide = pptx.addSlide(); slide.background = {color: 'FFFFFF'};
                const headerOffset = report.outputGroup ? 0.24 : 0;
                if (report.outputGroup) text(slide, outputGroupLabel(report),
                    {x:0.12,y:0.04,w:13.0,h:0.18},{fontSize:10,bold:true,color:'333333'});
                text(slide, `${molecule.name || molecule.key}${pages.length > 1 ? ' (' + (index + 1) + '/' + pages.length + ')' : ''}`,
                    {x: 0.12, y: 0.06 + headerOffset, w: 13.0, h: 0.37}, {fontSize: 24, bold: true, color: '000000'});
                text(slide, molecule.subtitle, {x: 0.12, y: 0.46 + headerOffset, w: 12.95, h: 0.22}, {fontSize: 11, color: '333333'});
                const ratio=molecule.kind==='ratio';
                const tableWidth = 11.83, headerWidth = ratio?2.2:1.55;
                const dataWidth = (tableWidth - headerWidth) / sectionPage.length;
                const table = [['Section', ...sectionPage.map(section => shortLabel(section.name, Math.floor(dataWidth * 13), 3))],
                    ...(ratio ? [['Total signal ratio','totalRatio'],['Mean point ratio','mean'],['Median point ratio','median'],['Valid / paired','nValid']]
                        .map(([label,key])=>[label,...sectionPage.map(section=>{
                            const stats=entryFor(molecule,section).ratioStatistics || {};
                            return key==='nValid'?number(stats.nValid)+' / '+number(stats.nCandidate):number(stats[key]);
                        })]) : [['Max Intensity', ...sectionPage.map(section => number(entryFor(molecule, section).max))],
                    ['Mean Intensity', ...sectionPage.map(section => number(entryFor(molecule, section).mean))]])];
                const cells = table.map((row, rowIndex) => row.map((value, column) => ({text: value,
                    options: {bold: column === 0 || rowIndex === 0, fontSize: ratio?10:rowIndex === 0 ? 11 : 13,
                        fill: rowIndex === 0 ? 'D1DAE9' : rowIndex === 1 ? 'E9EDF4' : 'D1DAE9'}})));
                slide.addTable(cells, {x: 0.12, y: 0.76 + headerOffset, w: tableWidth,
                    colW: [headerWidth, ...sectionPage.map(() => dataWidth)], rowH: ratio?[0.48,0.24,0.24,0.24,0.24]:[0.63, 0.36, 0.36],
                    h: ratio?1.44:1.35, autoPage: false, border: {type: 'solid', color: 'FFFFFF', pt: 1},
                    margin: [2, 5, 2, 5], fontFace: FONT, fontSize: 13, color: '000000',
                    align: 'center', valign: 'middle', lang: 'ja-JP'});
                const cellW = 11.83 / sectionPage.length;
                const style=molecule.displayStyle || report.displayStyle;
                const ranges=sectionPage.map(section=>entryFor(molecule,section).displayWindow).filter(Boolean);
                const individual=!report.outputGroup && style && new Set(ranges.map(w=>JSON.stringify(w))).size>1;
                sectionPage.forEach((section, i) => {
                    const x = 0.12 + i * cellW, entry = entryFor(molecule, section);
                    text(slide, section.name,
                        {x: x + 0.05, y: 2.2 + headerOffset, w: cellW - 0.1, h: 0.25},
                        {fontSize: 17, color: '000000', align: 'center'});
                    text(slide, 'Pixel size: ' + (registeredPixelSize(entry) || '—'),
                        {x: x + 0.05, y: 2.47 + headerOffset, w: cellW - 0.1, h: 0.16},
                        {fontSize: 9, color: '333333', align: 'center'});
                    const window = report.outputGroup ? entry.displayWindow || molecule.outputScale : style && entry.displayWindow;
                    if(window)text(slide,'Range '+number(window.min)+' – '+number(window.max),
                        {x:x+0.05,y:2.65+headerOffset,w:cellW-0.1,h:0.15},{fontSize:8,color:'333333',align:'center'});
                    const imageTop = (window ? 2.84 : 2.66) + headerOffset;
                    const cell = {x: x + 0.08, y: imageTop, w: cellW - 0.16, h: 6.62 - imageTop};
                    const bounds = picture(slide, entry, cell, {light: true});
                    imageScaleBar(pptx, slide, entry, bounds, cell);
                    if(ratio && entry.metadata && entry.metadata.formula)
                        text(slide,shortLabel(entry.metadata.formula,Math.floor(cellW*17),2),
                            {x:x+0.08,y:6.65,w:cellW-0.16,h:0.27},{fontSize:9,color:'333333',align:'center'});
                });
                text(slide, individual?'Colour level':ratio?'Ratio':'Intensity', {x: 12.02, y: 2.38+headerOffset, w: 1.15, h: 0.25}, {fontSize: 10, color: '000000', align: 'center'});
                const range=report.outputGroup ? molecule.outputScale : style && ranges[0];
                colorBar(pptx, slide, 12.12, 2.83+headerOffset, 0.24, individual?1:range?range.max:molecule.upper, {height: 3.7-headerOffset,
                    lower:individual?0:range?range.min:0,percent:individual,
                    stops:style && style.lut.map(c=>c.map(v=>Math.round(v).toString(16).padStart(2,'0')).join(''))});
                const basis = report.outputGroup ? molecule.outputScale.upperBasis : molecule.intensityScale && molecule.intensityScale.upperBasis;
                const automaticNote = range && range.available === false ? 'No valid display samples; fallback Range 0 – 1'
                    : basis === 'percentile' ? 'Automatic display p99.8'
                    : basis === 'positive-maximum-fallback' ? 'Automatic positive maximum (fallback)'
                    : basis === 'unit-fallback' ? 'Upper bound 1 (no positive range)' : 'Automatic display Range';
                const scaleNote = style ? 'Display style: '+style.colormap+' / '+(report.outputGroup?automaticNote:style.mode==='individual'?'Individual':'Same (all sections)')
                    +' / '+style.smoothing+(style.smoothing==='linear'?' (strength '+(style.linearStrength || 10)+'/10)'
                        :style.smoothing==='median'?' (strength '+(style.smoothingStrength || 1)+'/10)':'')
                    +(style.otsu?' / Otsu (available masks)':'') : report.outputGroup ? automaticNote : basis === 'percentile' ? 'Shared display p99.8' :
                    basis === 'positive-maximum-fallback' ? 'Shared positive maximum (fallback)' :
                    basis === 'unit-fallback' ? 'Upper bound 1 (no positive range)' : 'Common scale for this molecule';
                const qualityNotes = [...new Set(sectionPage.map(section => entryFor(molecule, section).qualityNote).filter(Boolean))];
                if (qualityNotes.length) text(slide, qualityNotes.join(' / '),
                    {x: 0.2, y: 6.94, w: 11.7, h: 0.17}, {fontSize: 8, color: '7A4B00'});
                text(slide, scaleNote + '    Missing statistics: —',
                    {x: 0.2, y: 7.15, w: 11.7, h: 0.17}, {fontSize: 9, color: '667085'});
                text(slide, pptx._slides.length, {x: 12.3, y: 7.15, w: 0.7, h: 0.17},
                    {fontSize: 9, color: '667085', align: 'right'});
            }
        }
    }
    async function addRatioRois(pptx,report,checkpoint) {
        for(const molecule of report.molecules.filter(m=>m.kind==='ratio')) {
            const rows=molecule.sections.flatMap(section=>(section.ratioRois || []).map(roi=>{
                const stats=roi.statistics || {};
                return [shortLabel(section.name,26,2),shortLabel(roi.name,26,2),number(stats.totalRatio),
                    number(stats.mean),number(stats.median),number(stats.nValid)+' / '+number(stats.nCandidate),
                    roi.status==='unavailable'?'Unavailable: '+string(roi.reason):stats.nValid===0?'No valid pairs':'Ready'];
            }));
            for(const page of chunks(rows,12)) {
                await checkpoint();
                const slide=base(pptx,report,(molecule.name || 'Ratio')+' — ROI',true);
                if(report.outputGroup)text(slide,outputGroupLabel(report),
                    {x:0.35,y:0.04,w:12.6,h:0.17},{fontSize:10,bold:true,color:'333333'});
                text(slide,molecule.subtitle,{x:0.35,y:0.85,w:12.6,h:0.35},{fontSize:11,color:'333333'});
                slide.addTable([['Section','ROI','Total signal ratio','Mean point ratio','Median point ratio','Valid / paired','Status'],...page],
                    {x:0.35,y:1.35,w:12.6,h:4.9,colW:[1.9,1.9,1.65,1.65,1.65,1.3,2.55],
                        rowH:0.36,autoPage:false,margin:4,fontFace:FONT,fontSize:11,color:'17223B',
                        border:{type:'solid',color:'D1DAE9',pt:1},fill:'FFFFFF',align:'center',valign:'middle'});
                text(slide,'Total signal ratio = ΣX / ΣY; point ratios = X / Y on the same valid original rows. Display filters do not change these values.',
                    {x:0.35,y:6.55,w:12.6,h:0.3},{fontSize:9,color:'667085'});
            }
        }
    }
    async function create(input, options = {}) {
        if (!input || !Array.isArray(input.molecules) || !Array.isArray(input.sections)) throw new Error('Invalid project report');
        if (!root.PptxGenJS) throw new Error('PptxGenJS is not loaded');
        const type = options.type || 'blob';
        if (!['blob', 'nodebuffer', 'uint8array'].includes(type)) throw new Error('Unsupported report output type');
        const report = { ...input, projectName: string(input.projectName) };
        const pptx = new root.PptxGenJS();
        function assertCurrent() {
            if (options.signal && options.signal.aborted) {
                const error = new Error('PPT レポートの作成を中止しました。'); error.name = 'AbortError'; throw error;
            }
            if (typeof options.assertCurrent === 'function') options.assertCurrent();
        }
        async function checkpoint(phase = 'slides') {
            assertCurrent();
            // Let the browser paint progress and dispatch cancellation or
            // project changes between complete pages. One page is bounded.
            await new Promise(resolve => setTimeout(resolve, 0));
            assertCurrent();
            if (typeof options.onProgress === 'function') options.onProgress({ phase,
                index: pptx._slides.length, message: phase === 'write' ? 'PowerPoint ファイルを保存用にまとめています…'
                    : 'PowerPoint を作成中：' + (pptx._slides.length + 1) + ' ページ' });
            assertCurrent();
        }
        await checkpoint();
        pptx.defineLayout({ name: 'DESI_REPORT', width: WIDTH, height: HEIGHT });
        pptx.layout = 'DESI_REPORT';
        pptx.author = 'Share_Test'; pptx.subject = 'Registered project MSI report';
        pptx.title = report.projectName + ' — DESI MSI report';
        pptx.company = 'Share_Test'; pptx.lang = 'ja-JP';
        pptx.theme = { headFontFace: FONT, bodyFontFace: FONT, lang: 'ja-JP' };
        const scopes = outputReports(report);
        for (const scope of scopes) {
            const sections = (scope.outputGroup ? scope.sections : sectionsFor(scope)).filter(section =>
                scope.molecules.some(molecule => entryFor(molecule, section)));
            await addMatrices(pptx, scope, sections, checkpoint);
            await addDetails(pptx, scope, sections, checkpoint);
            await addRatioRois(pptx, scope, checkpoint);
        }
        if (!scopes.length) await addMatrices(pptx,{...report,molecules:[]},[],checkpoint);
        await checkpoint('write');
        const output = await pptx.write({ outputType: type, compression: true });
        assertCurrent();
        return output;
    }
    return Object.freeze({ REPORT_REVISION, create, planMatrices, COLOR_STOPS: Object.freeze(COLOR_STOPS) });
});
