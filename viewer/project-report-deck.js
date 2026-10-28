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
        return (molecule.sections || []).find(entry => string(entry.sectionId) === section.id) ||
            { sectionId: section.id, name: section.name, image: null, max: null, mean: null, missingReason: 'No registered MSI layer' };
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
                    text(slide, section.name,
                        {x: x + 0.05, y: 2.2, w: cellW - 0.1, h: 0.35},
                        {fontSize: 17, color: '000000', align: 'center'});
                    const cell = {x: x + 0.08, y: 2.62, w: cellW - 0.16, h: 4.0};
                    const bounds = picture(slide, entry, cell, {light: true});
                    imageScaleBar(pptx, slide, entry, bounds, cell);
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
        await checkpoint('write');
        const output = await pptx.write({ outputType: type, compression: true });
        assertCurrent();
        return output;
    }
    return Object.freeze({ create, COLOR_STOPS: Object.freeze(COLOR_STOPS) });
});
