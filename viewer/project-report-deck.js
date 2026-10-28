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
        const n = Number(value);
        return n !== 0 && (Math.abs(n) >= 1e6 || Math.abs(n) < 0.001)
            ? n.toExponential(5) : Number(n.toPrecision(7)).toString();
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
        const h = options.height || 0.13;
        // Interpolate the 21 shared stops for a continuous, editable legend.
        const steps = 80;
        for (let i = 0; i < steps; i++) {
            const position = i / (steps - 1) * (COLOR_STOPS.length - 1);
            const lo = Math.floor(position), hi = Math.min(lo + 1, COLOR_STOPS.length - 1), t = position - lo;
            const color = [0, 2, 4].map(offset => Math.round(
                parseInt(COLOR_STOPS[lo].slice(offset, offset + 2), 16) * (1 - t) +
                parseInt(COLOR_STOPS[hi].slice(offset, offset + 2), 16) * t).toString(16).padStart(2, '0')).join('');
            slide.addShape(pptx.ShapeType.rect, { x: x + i * w / steps, y, w: w / steps + 0.001,
                h, line: { color, transparency: 100 }, fill: { color } });
        }
        text(slide, '0', { x, y: y + h + 0.025, w: w / 2, h: 0.18 }, { fontSize: options.fontSize || 8 });
        text(slide, number(upper), { x: x + w / 2, y: y + h + 0.025, w: w / 2, h: 0.18 },
            { fontSize: options.fontSize || 8, align: 'right' });
    }
    function picture(slide, entry, box) {
        const image = entry && entry.image;
        if (!image) {
            text(slide, 'No image\n' + string(entry && entry.missingReason || 'No registered MSI image'), box,
                { fontSize: 11, color: 'AFAFAF', align: 'center' });
            return;
        }
        if (!/^data:image\/(?:png|jpeg);base64,/i.test(image.data || '') ||
            !Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) {
            throw new Error('Invalid report image for section: ' + string(entry.name || entry.sectionId));
        }
        const scale = Math.min(box.w / image.width, box.h / image.height);
        const w = image.width * scale, h = image.height * scale;
        slide.addImage({ data: image.data, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2,
            w, h, altText: string(entry.name || entry.sectionId) });
    }
    function sectionsFor(report) {
        const sections = [], seen = new Set();
        const add = (id, name) => {
            id = string(id);
            if (!seen.has(id)) { seen.add(id); sections.push({ id, name: string(name) || id }); }
        };
        for (const section of report.sections || []) add(section.id, section.name);
        for (const molecule of report.molecules || []) {
            for (const section of molecule.sections || []) add(section.sectionId, section.name);
        }
        return sections;
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
        percentile: 'Color upper percentile (%)', basis: 'Display scale basis',
        statisticsBasis: 'Statistics basis', percentileValue: 'Measured percentile value',
        sampleCount: 'Measured display pixel count', upper: 'Color upper bound', upperBasis: 'Upper bound source'
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
                } else result.push({ label: prefix, value: Array.isArray(value) ? '[]' : '{}' });
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
    function addCover(pptx, report, sections) {
        const slide = base(pptx, report, 'DESI MSI report', true);
        text(slide, report.projectName || '(untitled project)', { x: 0.65, y: 1.35, w: 12.0, h: 1.7 },
            { fontSize: 36, bold: true, color: '17223B' });
        text(slide, `${sections.length} sections     ${(report.molecules || []).length} molecules`,
            { x: 0.68, y: 3.42, w: 11.8, h: 0.45 }, { fontSize: 23, color: '17223B' });
        text(slide, 'Generated: ' + string(report.generatedAt), { x: 0.68, y: 4.05, w: 11.8, h: 0.55 },
            { fontSize: 16, color: '667085' });
        text(slide, 'Project information, section names and molecule names come from the registered project.',
            { x: 0.68, y: 5.14, w: 11.8, h: 0.65 }, { fontSize: 15, color: '667085' });
        if (!report.molecules.length) text(slide, 'No MSI molecules are registered in this project.',
            { x: 0.68, y: 6.05, w: 11.8, h: 0.4 }, { color: '667085', fontSize: 16 });
    }
    async function addMetadata(pptx, report, checkpoint) {
        const rows = metadataRows(report.metadata);
        if (report.intensityScale) rows.push(...metadataRows({ 'Intensity scale': report.intensityScale }));
        // Prepared reports may include further registered molecule metadata.
        for (let moleculeIndex = 0; moleculeIndex < report.molecules.length; moleculeIndex++) {
            const molecule = report.molecules[moleculeIndex], scope = 'Molecule ' + (moleculeIndex + 1);
            const common = metadataRows(molecule.metadata, { prefix: scope, skipName: true });
            const scale = metadataRows(molecule.intensityScale, { prefix: scope });
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
            if (common.length || scale.length || sectionRows.length) rows.push(
                { label: scope, value: molecule.name || molecule.key }, ...common, ...scale, ...sectionRows);
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
        const moleculePages = chunks(report.molecules, 4), sectionPages = chunks(sections, 4);
        const count = moleculePages.length * sectionPages.length; let page = 0;
        for (const molecules of moleculePages) for (const sectionPage of sectionPages) {
            await checkpoint();
            const slide = base(pptx, report, `MSI matrix (${++page}/${count})`);
            const left = 2.65, width = (WIDTH - left - 0.3) / sectionPage.length;
            sectionPage.forEach((section, index) => text(slide, section.name,
                { x: left + index * width + 0.05, y: 0.83, w: width - 0.1, h: 0.46 },
                { fontSize: 16, align: 'center' }));
            const top = 1.42, rowHeight = Math.min(1.36, 5.4 / molecules.length);
            molecules.forEach((molecule, row) => {
                const y = top + row * rowHeight;
                text(slide, molecule.name || molecule.key, { x: 0.35, y, w: 2.14, h: 0.45 }, { fontSize: 15, bold: true });
                text(slide, molecule.subtitle, { x: 0.35, y: y + 0.47, w: 2.14, h: 0.38 }, { fontSize: 10, color: 'C6C6C6' });
                colorBar(pptx, slide, 0.35, y + 0.94, 2.13, molecule.upper, { height: 0.1 });
                sectionPage.forEach((section, column) => picture(slide, entryFor(molecule, section),
                    { x: left + column * width + 0.08, y, w: width - 0.16, h: rowHeight - 0.16 }));
            });
        }
    }
    async function addDetails(pptx, report, sections, checkpoint) {
        for (const molecule of report.molecules) {
            const pages = chunks(sections, 6);
            for (let index = 0; index < pages.length; index++) {
                await checkpoint();
                const sectionPage = pages[index];
                const slide = base(pptx, report, `${molecule.name || molecule.key} (${index + 1}/${pages.length})`);
                text(slide, molecule.subtitle, { x: 0.35, y: 0.81, w: 12.5, h: 0.4 },
                    { fontSize: 14, color: 'C6C6C6' });
                const columns = Math.min(3, sectionPage.length), rows = Math.ceil(sectionPage.length / 3);
                const cellW = 9.0 / columns, cellH = 5.45 / rows;
                sectionPage.forEach((section, i) => {
                    const x = 0.35 + (i % columns) * cellW, y = 1.38 + Math.floor(i / columns) * cellH;
                    text(slide, `${i + 1}. ${section.name}`, { x, y, w: cellW - 0.16, h: 0.45 },
                        { fontSize: 15, align: 'center' });
                    picture(slide, entryFor(molecule, section), { x: x + 0.04, y: y + 0.53,
                        w: cellW - 0.24, h: cellH - 0.7 });
                });
                const table = [['Section', 'Max', 'Mean']].concat(sectionPage.map((section, i) => {
                    const entry = entryFor(molecule, section);
                    return [String(i + 1), number(entry.max), number(entry.mean)];
                }));
                slide.addTable(table, { x: 9.72, y: 1.48, w: 3.2, colW: [0.7, 1.25, 1.25],
                    rowH: 0.49, autoPage: false, border: { type: 'solid', color: '666666', pt: 0.5 },
                    margin: [4, 3, 4, 3], fontFace: FONT, fontSize: 11, color: 'FFFFFF', fill: '000000',
                    align: 'center', valign: 'middle', lang: 'ja-JP' });
                text(slide, 'Intensity', { x: 9.72, y: 5.3, w: 3.2, h: 0.28 }, { fontSize: 13 });
                colorBar(pptx, slide, 9.72, 5.67, 3.2, molecule.upper, { height: 0.16, fontSize: 10 });
                const basis = molecule.intensityScale && molecule.intensityScale.upperBasis;
                const scaleNote = basis === 'percentile' ? 'Shared display p99.8' :
                    basis === 'positive-maximum-fallback' ? 'Shared positive maximum (fallback)' :
                    basis === 'unit-fallback' ? 'Upper bound 1 (no positive range)' : 'Common scale for this molecule';
                text(slide, scaleNote + '\nMissing statistics: —',
                    { x: 9.72, y: 6.2, w: 3.2, h: 0.55 }, { fontSize: 10, color: 'B5B5B5' });
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
        addCover(pptx, report, sections);
        await addMetadata(pptx, report, checkpoint);
        await addMatrices(pptx, report, sections, checkpoint);
        await addDetails(pptx, report, sections, checkpoint);
        await checkpoint('write');
        const output = await pptx.write({ outputType: type, compression: true });
        assertCurrent();
        return output;
    }
    return Object.freeze({ create, COLOR_STOPS: Object.freeze(COLOR_STOPS), metadataRows, metadataPages });
});
