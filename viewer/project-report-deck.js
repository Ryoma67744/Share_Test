/* Editable PowerPoint reports. PptxGenJS and JSZip are loaded locally by the caller. */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.ProjectReportDeck = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
    'use strict';
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
        // Interpolate the 21 shared stops for a continuous, editable legend.
        const steps = 80;
        for (let i = 0; i < steps; i++) {
            const position = i / (steps - 1) * (COLOR_STOPS.length - 1);
            const lo = Math.floor(position), hi = Math.min(lo + 1, COLOR_STOPS.length - 1), t = position - lo;
            const color = [0, 2, 4].map(offset => Math.round(
                parseInt(COLOR_STOPS[lo].slice(offset, offset + 2), 16) * (1 - t) +
                parseInt(COLOR_STOPS[hi].slice(offset, offset + 2), 16) * t).toString(16).padStart(2, '0')).join('');
            slide.addShape(pptx.ShapeType.rect, { x, y: y + (steps - 1 - i) * h / steps, w,
                h: h / steps + 0.001, line: { color, transparency: 100 }, fill: { color } });
        }
        for (let tick = 0; tick <= 4; tick++) {
            const value = Number(upper) * tick / 4;
            text(slide, tick === 4 ? number(upper) : Number.isFinite(value) ? String(Number(value.toPrecision(4))) : '—',
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
    function imageScaleBar(pptx, slide, entry, bounds) {
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
        const x = bounds.x + bounds.w - width, y = bounds.y + bounds.h + 0.13;
        const label = length >= 1000 ? number(length / 1000) + ' mm' : number(length) + ' µm';
        slide.addShape(pptx.ShapeType.rect, {x, y, w: width, h: 0.025,
            line: {color: '000000', transparency: 100}, fill: {color: '000000'}});
        text(slide, label, {x: Math.max(bounds.x, x - 0.3), y: y - 0.14,
            w: Math.max(width, 0.6), h: 0.13}, {fontSize: 8, color: '000000', align: 'center'});
    }
    function entryFor(molecule, section) {
        return (molecule.sections || []).find(entry => string(entry.sectionId) === section.id) ||
            { sectionId: section.id, name: section.name, image: null, max: null, mean: null, missingReason: 'No registered MSI layer' };
    }
    // Approximate East Asian width conservatively. Splitting creates additional
    // editable rows/pages instead of discarding long notes or shrinking them away.
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
    const FIELD_LABELS = {
        sample: 'Sample', analysis: 'Analysis', machine: 'Instrument', instrument: 'Instrument',
        operator: 'Operator', date: 'Date', note: 'Note', notes: 'Notes', tissue: 'Tissue',
        species: 'Species', treatment: 'Treatment', sections: 'Sections', sectionId: 'Section ID',
        acquisition: 'Acquisition', pixelPitch: 'Pixel pitch (µm/px)', name: 'Name',
        raw: 'Raw metadata', fileName: 'File name', filename: 'File name', file: 'File',
        sourceFile: 'Source file', rawFile: 'Raw file', acquiredAt: 'Acquired at',
        scanSpeed: 'Scan speed', msMethod: 'MS method', rtStart: 'RT start', rtEnd: 'RT end',
        polarity: 'Polarity', precursor: 'Precursor m/z', product: 'Product m/z',
        ce: 'Collision energy', cv: 'Cone voltage', mz: 'm/z', adduct: 'Adduct',
        percentile: 'Percentile (%)', basis: 'Image scale',
        statisticsBasis: 'Statistics', percentileValue: 'p99.8 value',
        sampleCount: 'Measured pixels', upper: 'Upper limit', upperBasis: 'Upper limit source'
    };
    function fieldLabel(key) {
        const label = FIELD_LABELS[key] || string(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
        return label.charAt(0).toUpperCase() + label.slice(1);
    }
    function metadataRows(metadata, options = {}) {
        const result = [], parents = new Set();
        if (metadata == null || (typeof metadata === 'object' && !Object.keys(metadata).length)) return result;
        const labelValue = item => item && typeof item === 'object' &&
            Object.prototype.hasOwnProperty.call(item, 'label') && Object.prototype.hasOwnProperty.call(item, 'value');
        const internal = new Set(['id', 'sectionId', 'layerKey']);
        const containers = new Set(['acquisition', 'raw', 'metadata']);
        const join = (prefix, label) => [prefix, label].filter(Boolean).join(' / ');
        const visit = (value, prefix, skipName = false) => {
            if (value == null || value === '') return;
            if (value && typeof value === 'object') {
                if (parents.has(value)) { result.push({ label: prefix, value: '[Circular reference]' }); return; }
                parents.add(value);
                const entries = Object.entries(value);
                const list = Array.isArray(value) || entries.every(([key]) => /^\d+$/.test(key));
                if (list && entries.length && entries.every(([, item]) => labelValue(item))) {
                    for (const [, item] of entries) visit(item.value, join(prefix, string(item.label)));
                } else if (entries.length) {
                    for (const [key, item] of entries) {
                        if (internal.has(key) || (skipName && key === 'name')) continue;
                        if (key === 'sections' && Array.isArray(item)) {
                            item.forEach((section, index) => {
                                const scope = join(prefix, 'Section ' + (index + 1));
                                result.push({ label: scope, value: string(section && section.name) || '(unnamed section)' });
                                visit(section, scope, true);
                            });
                        } else if (containers.has(key)) visit(item, prefix);
                        else visit(item, join(prefix, list ? String(Number(key) + 1) : fieldLabel(key)));
                    }
                }
                parents.delete(value);
            } else result.push({ label: prefix, value: string(value) });
        };
        if (metadata != null) visit(metadata, options.prefix || '', !!options.skipName);
        return result;
    }
    function metadataDifference(value, baseline) {
        if (Object.is(value, baseline)) return undefined;
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) {
            return Array.isArray(baseline) && JSON.stringify(value) === JSON.stringify(baseline) ? undefined : value;
        }
        const different = {};
        for (const [key, item] of Object.entries(value)) {
            const changed = metadataDifference(item, baseline && baseline[key]);
            if (changed !== undefined) different[key] = changed;
        }
        return Object.keys(different).length ? different : undefined;
    }
    function metadataPages(metadata) {
        const pages = []; let rows = [], height = 0;
        for (const item of metadataRows(metadata)) {
            const labels = wrap(item.label, 25), values = wrap(item.value, 85);
            for (let offset = 0; offset < Math.max(labels.length, values.length); offset += 3) {
                const labelLines = labels.slice(offset, offset + 3), valueLines = values.slice(offset, offset + 3);
                const rowHeight = Math.max(0.44, Math.max(labelLines.length, valueLines.length) * 0.25 + 0.12);
                if (height + rowHeight > 5.6 && rows.length) { pages.push(rows); rows = []; height = 0; }
                rows.push({ label: labelLines.join('\n'), value: valueLines.join('\n'), height: rowHeight });
                height += rowHeight;
            }
        }
        if (rows.length) pages.push(rows);
        return pages;
    }
    async function addMetadata(pptx, report, checkpoint) {
        const sections = sectionsFor(report);
        const rows = [{label: 'Generated', value: string(report.generatedAt)},
            {label: 'Sections / molecules', value: sections.length + ' / ' + report.molecules.length},
            ...sections.map((section, i) => ({label: 'Section ' + (i + 1), value: section.name})),
            ...metadataRows(report.metadata)];
        const scaleInfo = scale => {
            const names = { 'finite-measured-display-raster': 'Measured image pixels',
                'original-measurement-rows': 'Original measurement rows', percentile: 'p99.8',
                'positive-maximum-fallback': 'Positive maximum (p99.8 is zero or negative)',
                'unit-fallback': '1 (no positive intensity range)' };
            return Object.fromEntries(Object.entries(scale || {}).map(([key, value]) =>
                [key, ['basis', 'statisticsBasis', 'upperBasis'].includes(key) ? names[value] || value : value]));
        };
        if (report.intensityScale) rows.push(...metadataRows({ 'Intensity scale': scaleInfo(report.intensityScale) }));
        // Prepared reports may include further registered molecule metadata.
        for (let moleculeIndex = 0; moleculeIndex < report.molecules.length; moleculeIndex++) {
            const molecule = report.molecules[moleculeIndex], scope = 'Molecule ' + (moleculeIndex + 1);
            const common = metadataRows(molecule.metadata, { prefix: scope, skipName: true });
            const scale = metadataRows(scaleInfo(molecule.intensityScale || {upper: molecule.upper}), { prefix: scope });
            const sectionRows = [];
            for (let sectionIndex = 0; sectionIndex < (molecule.sections || []).length; sectionIndex++) {
                const section = molecule.sections[sectionIndex];
                if (!section.metadata) continue;
                // The molecule's common fields appear once above. Preserve
                // source/measurement fields that differ for a given section.
                const specific = metadataDifference(section.metadata, molecule.metadata);
                if (specific) {
                    const sectionScope = scope + ' / Section ' + (sectionIndex + 1);
                    const details = metadataRows(specific, { prefix: sectionScope, skipName: true });
                    if (details.length) sectionRows.push({ label: sectionScope, value: section.name || '(unnamed section)' }, ...details);
                }
            }
            rows.push({ label: scope, value: molecule.name || molecule.key },
                ...(molecule.subtitle ? [{label: scope + ' / Transition', value: molecule.subtitle}] : []),
                ...common, ...scale, ...sectionRows);
        }
        const pages = metadataPages(rows);
        for (let index = 0; index < pages.length; index++) {
            await checkpoint();
            const rows = pages[index];
            const slide = base(pptx, report, `Project information (${index + 1}/${pages.length})`, true);
            let y = 1.0;
            for (const row of rows) {
                slide.addTable([[row.label, row.value]], { x: 0.45, y, w: 12.43,
                    colW: [2.85, 9.58], rowH: row.height, h: row.height, autoPage: false,
                    border: { type: 'solid', color: 'D0D5DD', pt: 0.5 }, margin: [4, 7, 4, 7],
                    fontFace: FONT, fontSize: 14, color: '17223B', fill: 'FFFFFF', valign: 'top',
                    lang: 'ja-JP', paraSpaceAfterPt: 0 });
                y += row.height;
            }
        }
    }
    async function addMatrices(pptx, report, sections, checkpoint) {
        if (!report.molecules.length || !sections.length) {
            await checkpoint();
            const slide = base(pptx, report, report.projectName);
            text(slide, 'No MSI molecules are registered in this project.',
                {x: 0.4, y: 3.0, w: 12.4, h: 0.7}, {fontSize: 22});
            return;
        }
        const sectionPages = chunks(sections, 4), moleculeBlocks = chunks(report.molecules, 8);
        const borderColors = ['FF0000', '00D000', '00BFFF', 'FFAA00'];
        let page = 0;
        for (const sectionPage of sectionPages) {
            const maxBlocks = sectionPage.length <= 2 ? 3 : sectionPage.length === 3 ? 2 : 1;
            for (const blocks of chunks(moleculeBlocks, maxBlocks)) {
                await checkpoint();
                const slide = pptx.addSlide(); slide.background = {color: '000000'};
                const blockWidth = (WIDTH - 0.16) / blocks.length;
                const hasReference = sectionPage.some(section => !!section.referenceImage);
                const maxRows = Math.max(...blocks.map(block => block.length));
                const rowHeight = (6.64 - (hasReference ? 0.04 : 0)) / (maxRows + (hasReference ? 1 : 0));
                blocks.forEach((molecules, block) => {
                    const x = 0.08 + block * blockWidth;
                    const labelWidth = blockWidth * (sectionPage.length <= 2 ? 0.39 : 0.3);
                    const imageWidth = (blockWidth - labelWidth - 0.08) / sectionPage.length;
                    const labelFont = blocks.length === 3 ? 9 : blocks.length === 2 ? 10 : 12;
                    text(slide, report.projectName, {x: x + labelWidth, y: 0.05,
                        w: blockWidth - labelWidth - 0.08, h: 0.22}, {fontSize: 10, bold: true, align: 'center'});
                    sectionPage.forEach((section, column) => {
                        const left = x + labelWidth + column * imageWidth;
                        slide.addShape(pptx.ShapeType.rect, {x: left, y: 0.3, w: imageWidth, h: 0.31,
                            fill: {color: '000000'}, line: {color: borderColors[sections.indexOf(section) % borderColors.length], width: 2}});
                        text(slide, shortLabel(section.name, Math.max(12, imageWidth * 17), 2),
                            {x: left + 0.025, y: 0.31, w: imageWidth - 0.05, h: 0.29}, {fontSize: 9, bold: true, align: 'center'});
                    });
                    const top = 0.66;
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
                        sectionPage.forEach((section, column) => picture(slide, entryFor(molecule, section),
                            {x: x + labelWidth + column * imageWidth + 0.02, y,
                                w: imageWidth - 0.04, h: rowHeight - 0.025}, {fontSize: 7}));
                    });
                });
                text(slide, 'MSI matrix ' + (++page), {x: 0.1, y: 7.32, w: 4, h: 0.13}, {fontSize: 7, color: '999999'});
            }
        }
    }
    async function addDetails(pptx, report, sections, checkpoint) {
        for (const molecule of report.molecules) {
            const pages = chunks(sections, 2);
            for (let index = 0; index < pages.length; index++) {
                await checkpoint();
                const sectionPage = pages[index];
                const slide = pptx.addSlide(); slide.background = {color: 'FFFFFF'};
                text(slide, `${molecule.name || molecule.key}${pages.length > 1 ? ' (' + (index + 1) + '/' + pages.length + ')' : ''}`,
                    {x: 0.12, y: 0.06, w: 13.0, h: 0.37}, {fontSize: 24, bold: true, color: '000000'});
                text(slide, molecule.subtitle, {x: 0.12, y: 0.46, w: 12.95, h: 0.22}, {fontSize: 11, color: '333333'});
                const tableWidth = 11.83, headerWidth = 1.55;
                const dataWidth = (tableWidth - headerWidth) / sectionPage.length;
                const table = [['Section', ...sectionPage.map(section => shortLabel(section.name, Math.floor(dataWidth * 13), 3))],
                    ['Max Intensity', ...sectionPage.map(section => number(entryFor(molecule, section).max))],
                    ['Mean Intensity', ...sectionPage.map(section => number(entryFor(molecule, section).mean))]];
                const cells = table.map((row, rowIndex) => row.map((value, column) => ({text: value,
                    options: {bold: column === 0 || rowIndex === 0, fontSize: rowIndex === 0 ? 11 : 13,
                        fill: rowIndex === 0 ? 'D1DAE9' : rowIndex === 1 ? 'E9EDF4' : 'D1DAE9'}})));
                slide.addTable(cells, {x: 0.12, y: 0.76, w: tableWidth,
                    colW: [headerWidth, ...sectionPage.map(() => dataWidth)], rowH: [0.63, 0.36, 0.36],
                    h: 1.35, autoPage: false, border: {type: 'solid', color: 'FFFFFF', pt: 1},
                    margin: [2, 5, 2, 5], fontFace: FONT, fontSize: 13, color: '000000',
                    align: 'center', valign: 'middle', lang: 'ja-JP'});
                const cellW = 11.83 / sectionPage.length;
                sectionPage.forEach((section, i) => {
                    const x = 0.12 + i * cellW, entry = entryFor(molecule, section);
                    text(slide, shortLabel(section.name, Math.floor(cellW * 14), 2),
                        {x: x + 0.05, y: 2.2, w: cellW - 0.1, h: 0.35},
                        {fontSize: 17, color: '000000', align: 'center'});
                    const bounds = picture(slide, entry, {x: x + 0.08, y: 2.62, w: cellW - 0.16, h: 4.15}, {light: true});
                    imageScaleBar(pptx, slide, entry, bounds);
                });
                text(slide, 'Intensity', {x: 12.02, y: 2.38, w: 1.15, h: 0.25}, {fontSize: 10, color: '000000', align: 'center'});
                colorBar(pptx, slide, 12.12, 2.83, 0.24, molecule.upper, {height: 3.7});
                const basis = molecule.intensityScale && molecule.intensityScale.upperBasis;
                const scaleNote = basis === 'percentile' ? 'Shared display p99.8' :
                    basis === 'positive-maximum-fallback' ? 'Shared positive maximum (fallback)' :
                    basis === 'unit-fallback' ? 'Upper bound 1 (no positive range)' : 'Common scale for this molecule';
                text(slide, scaleNote + '    Missing statistics: —',
                    {x: 0.2, y: 7.15, w: 11.7, h: 0.17}, {fontSize: 9, color: '667085'});
                text(slide, pptx._slides.length, {x: 12.3, y: 7.15, w: 0.7, h: 0.17},
                    {fontSize: 9, color: '667085', align: 'right'});
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
        const sections = sectionsFor(report);
        await addMatrices(pptx, report, sections, checkpoint);
        await addDetails(pptx, report, sections, checkpoint);
        await addMetadata(pptx, report, checkpoint);
        await checkpoint('write');
        const output = await pptx.write({ outputType: type, compression: true });
        assertCurrent();
        return output;
    }
    return Object.freeze({ create, COLOR_STOPS: Object.freeze(COLOR_STOPS), metadataRows, metadataPages });
});
