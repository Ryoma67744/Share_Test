'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require('../vendor/jszip.min.js');
const { createCanvas } = require('@napi-rs/canvas');
const Data = require('../viewer/project-report-data.js');
const root = path.resolve(__dirname, '..');
const sandbox = { JSZip, console, setTimeout, clearTimeout, Blob, Buffer, Uint8Array,
    ArrayBuffer, TextEncoder, TextDecoder, atob, btoa };
vm.createContext(sandbox);
for (const file of ['vendor/pptxgen.min.js', 'viewer/project-report-deck.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}
const deck = sandbox.ProjectReportDeck;
function fixtureImage() {
    const canvas = createCanvas(240, 120), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, 240, 120);
    for (let y = 0; y < 12; y++) for (let x = 0; x < 24; x++) {
        const value = Math.max(0, 1 - Math.hypot((x - 12) / 11, (y - 6) / 5));
        ctx.fillStyle = '#' + deck.COLOR_STOPS[Math.floor(value * (deck.COLOR_STOPS.length - 1))];
        ctx.fillRect(x * 10, y * 10, 10, 10);
    }
    return { data: canvas.toDataURL('image/png'), width: 240, height: 120 };
}
function fixture(sectionCount = 8, moleculeCount = 5) {
    const image = fixtureImage();
    const sections = Array.from({ length: sectionCount }, (_, i) => ({ id: `s${i}`, name: `切片 ${i + 1} / Section ${i + 1}` }));
    return { projectName: 'DESI 日本語 <project> & report', generatedAt: '2026-10-28T08:15:00+09:00',
        metadata: [{ label: 'Sample information', value: 'Registered sample metadata: 日本語の情報' },
            { label: 'Analysis', value: 'Shared p99.8 per molecule; no physical scale bar' },
            { label: 'Operators', value: 'A & B <original>' }], sections,
        molecules: Array.from({ length: moleculeCount }, (_, m) => ({ key: `m${m}`, name: `Molecule ${m + 1} 分子`,
            subtitle: `Q1 ${100 + m} / Q3 ${50 + m}, negative, CE 20`, upper: 10000 + m,
            sections: sections.map((section, s) => ({ sectionId: section.id, name: section.name,
                max: s === 0 ? 0 : 1000.1234 + m + s, mean: s === 0 ? 0 : 300.98765 + m + s,
                image: s === 2 ? null : image, missingReason: s === 2 ? 'Registered layer unavailable' : '' })) })) };
}
async function unzip(report) {
    const bytes = await deck.create(report, { type: 'nodebuffer' });
    assert.ok(Buffer.isBuffer(bytes), 'Node output is a buffer');
    const zip = await JSZip.loadAsync(bytes);
    const files = Object.keys(zip.files).filter(file => /^ppt\/slides\/slide\d+\.xml$/.test(file))
        .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
    const xml = await Promise.all(files.map(file => zip.file(file).async('string')));
    // PowerPoint requires unique nonvisual shape IDs on each slide. PptxGenJS
    // 4.0.1's original table counter can collide with text/image IDs; the pinned
    // vendor includes the reviewed slide-object-index correction.
    xml.forEach((source, index) => {
        const ids = [...source.matchAll(/<p:cNvPr\s+id="(\d+)"/g)].map(match => match[1]);
        assert.equal(new Set(ids).size, ids.length, 'Unique shape IDs on slide ' + (index + 1));
        for (const match of source.matchAll(/\banchor="([^\"]*)"/g)) {
            assert.ok(['t', 'ctr', 'b', 'just', 'dist'].includes(match[1]), 'OOXML vertical alignment must be valid: ' + match[1]);
        }
    });
    return { bytes, zip, files, xml, all: xml.join('\n') };
}
async function main() {
    const report = fixture(), before = JSON.stringify(report);
    const result = await unzip(report);
    assert.equal(JSON.stringify(report), before, 'Generating a report must not mutate registered project data');
    assert.equal(result.files.length, 25, '2 matrix pages + 20 two-section detail pages + 3 information pages');
    assert.match(result.xml[0], /MSI matrix 1/, 'The approved black matrix opens the report without a cover');
    assert.match(result.xml[0], /<a:srgbClr val="000000"\/>/, 'Matrix background is black');
    assert.ok(!result.xml[0].includes('Project information'), 'Information follows the MSI pages');
    assert.match(result.xml[2], /<p:bg>.*?<a:srgbClr val="FFFFFF"\/>/s, 'Detail slides have the approved white background');
    assert.ok(result.xml[22].includes('Project information'), 'All quantitative details precede metadata');
    assert.match(result.all, /DESI 日本語 &lt;project&gt; &amp; report/);
    assert.match(result.all, /Registered sample metadata: 日本語の情報/);
    assert.match(result.all, /A &amp; B &lt;original&gt;/);
    assert.match(result.all, /Registered layer unavailable/);
    for (const section of report.sections) assert.ok(result.all.includes(section.name), section.name + ' is retained');
    for (const molecule of report.molecules) {
        assert.ok(result.all.includes(molecule.name), molecule.name + ' is retained');
        assert.ok(result.all.includes(molecule.subtitle), molecule.subtitle + ' is retained');
        assert.ok(result.all.includes(String(molecule.upper)), 'Shared scale is recorded');
    }
    assert.equal(result.xml.filter(xml => xml.includes('<a:tbl>')).length, 23, 'Metadata and each detail page use native editable tables');
    assert.match(result.all, /<a:t>0<\/a:t>/, 'Real zero statistics are preserved');
    assert.match(result.all, /1001\.123/);
    assert.match(result.all, /1001\.1234/, 'Source maximum retains its supplied precision');
    const firstDetailTable = result.xml[2].match(/<a:tbl>.*?<\/a:tbl>/s)[0];
    assert.equal((firstDetailTable.match(/<a:tr /g) || []).length, 3, 'Detail table has section/max/mean rows');
    assert.equal((firstDetailTable.match(/<a:gridCol /g) || []).length, 3, 'Detail table has one label column and two section columns');
    assert.doesNotMatch(result.all, /flipH="1"|flipV="1"|\brot="[1-9]/, 'No implicit flips or rotations');
    const pics = [...result.all.matchAll(/<p:pic>.*?<\/p:pic>/gs)].map(match => match[0]);
    assert.ok(pics.length > 0, 'MSI images are real image objects');
    for (const pic of pics) {
        const ext = pic.match(/<a:ext cx="(\d+)" cy="(\d+)"/);
        assert.ok(ext, 'Image has an extent');
        assert.ok(Math.abs(Number(ext[1]) / Number(ext[2]) - 2) < 0.00001, 'Image aspect ratio is preserved');
    }
    assert.ok(Object.keys(result.zip.files).some(name => /^ppt\/media\/.*\.png$/.test(name)), 'PNG media is embedded');

    const approvedMatrix = fixture(2, 17);
    approvedMatrix.sections.forEach(section => {section.referenceImage = fixtureImage(); section.referenceLabel = 'Registered optical image';});
    const approved = await unzip(approvedMatrix);
    assert.equal(approved.xml.filter(xml => /MSI matrix \d/.test(xml)).length, 1,
        'Seventeen molecules and two sections fit as horizontal blocks of 8 + 8 + 1');
    assert.equal((approved.xml[0].match(/<p:pic>/g) || []).length, 40,
        'Matrix has 34 MSI images plus two reference images repeated across three blocks');
    assert.match(approved.xml[0], /Optical \/ TIC/, 'Reference row is included only when supplied');
    assert.doesNotMatch(result.xml[0], /Optical \/ TIC/, 'No invented reference row when reference images are unavailable');
    for (const molecule of approvedMatrix.molecules) assert.ok(approved.xml[0].includes(molecule.name), 'All matrix block labels survive');
    assert.equal(approved.xml.filter(xml => xml.includes('Max Intensity')).length, 17, 'Each molecule gets a two-section detail slide');
    const calibrated = fixture(2, 1);
    calibrated.molecules[0].sections[0].image = {...fixtureImage(), physicalWidthUm: 800, physicalHeightUm: 300};
    calibrated.molecules[0].sections[1].image = {...fixtureImage(), physicalWidthUm: 1200, physicalHeightUm: 900};
    const calibration = await unzip(calibrated), calibratedDetail = calibration.xml[1];
    assert.match(calibratedDetail, /100 µm/); assert.match(calibratedDetail, /200 µm/);
    assert.doesNotMatch(calibration.xml[0], /100 µm|200 µm/, 'No shared physical scale is attached to a matrix of differently sized images');
    const scaleBars = [...calibratedDetail.matchAll(/<p:sp>.*?<\/p:sp>/gs)].map(match => match[0])
        .filter(xml => xml.includes('cy="22860"') && xml.includes('<a:srgbClr val="000000"'));
    assert.equal(scaleBars.length, 2, 'Each calibrated detail image owns a physical scale bar');
    const scaleWidths = scaleBars.map(xml => Number(xml.match(/<a:ext cx="(\d+)"/)[1]));
    assert.ok(scaleWidths[1] > scaleWidths[0], 'Bar width follows each image physical field, rather than a common slide scale');
    const noCalibration = fixture(2, 1);
    noCalibration.molecules[0].sections[0].image = {...fixtureImage(), physicalWidthUm: NaN, physicalHeightUm: 100};
    assert.doesNotMatch((await unzip(noCalibration)).xml[1], /<a:t>\d+(?:\.\d+)? (?:µm|mm)<\/a:t>/,
        'Unknown physical calibration does not invent a scale bar');
    const longNames = fixture(3, 1);
    longNames.sections.forEach((section, i) => {
        section.name = 'LONG_SECTION_' + i + '_' + '日本語と長い切片名'.repeat(15) + '_NAME_END_' + i;
        longNames.molecules[0].sections[i].name = section.name;
    });
    longNames.molecules[0].name = '非常に長い分子名'.repeat(15) + '_MOLECULE_END';
    const longResult = await unzip(longNames), longText = longResult.all.replace(/<[^>]*>/g, '');
    for (let i = 0; i < 3; i++) assert.ok(longText.includes('_NAME_END_' + i), 'Full long section name is retained in information pages');
    assert.ok(longText.includes('_MOLECULE_END'));
    for (const xml of longResult.xml) for (const transform of xml.matchAll(/<(?:a|p):xfrm[^>]*>.*?<\/(?:a|p):xfrm>/gs)) {
        const offset = transform[0].match(/<a:off x="(-?\d+)" y="(-?\d+)"/), extent = transform[0].match(/<a:ext cx="(\d+)" cy="(\d+)"/);
        if (!offset || !extent) continue;
        const x = Number(offset[1]), y = Number(offset[2]), w = Number(extent[1]), h = Number(extent[2]);
        assert.ok(x >= 0 && y >= 0 && x + w <= 12192000 + 10 && y + h <= 6858000 + 10,
            'Long labels stay within slide geometry');
    }
    const presentation = await result.zip.file('ppt/presentation.xml').async('string');
    assert.equal((presentation.match(/<p:sldId /g) || []).length, result.files.length, 'Every page is reachable');
    for (const file of result.files) {
        const rel = file.replace('slides/', 'slides/_rels/') + '.rels';
        const relationships = await result.zip.file(rel).async('string');
        for (const match of relationships.matchAll(/Target="(\.\.\/media\/[^\"]+)"/g)) {
            assert.ok(result.zip.file(path.posix.normalize('ppt/slides/' + match[1])), 'Image relationship resolves');
        }
    }

    const largeMetadata = fixture(1, 1);
    largeMetadata.metadata = Array.from({ length: 18 }, (_, i) => ({ label: `Field ${i + 1}`, value: `BEGIN${i} ${'解析情報 abc '.repeat(35)} END${i}` }));
    const metadataResult = await unzip(largeMetadata);
    assert.ok(metadataResult.xml.filter(xml => xml.includes('Project information (')).length > 2, 'Long metadata is paginated');
    for (let i = 0; i < 18; i++) {
        assert.ok(metadataResult.all.includes(`BEGIN${i}`));
        assert.ok(metadataResult.all.includes(`END${i}`), 'Metadata ending is not dropped');
    }
    const sparse = fixture(2, 1);
    sparse.molecules[0].sections.pop();
    sparse.molecules[0].sections[0].max = null;
    sparse.molecules[0].sections[0].mean = null;
    const missing = await unzip(sparse);
    assert.match(missing.all, /No registered MSI layer/);
    assert.match(missing.all, /<a:t>—<\/a:t>/);
    const extra = fixture(1, 1);
    extra.molecules[0].sections.push({ sectionId: 'extra', name: 'Extra registered section', max: 9, mean: 4, image: null });
    assert.match((await unzip(extra)).all, /Extra registered section/, 'A molecule-only section is not silently discarded');
    const empty = fixture(0, 0);
    assert.match((await unzip(empty)).all, /No MSI molecules/);
    const invalidImage = fixture(1, 1);
    invalidImage.molecules[0].sections[0].image = { data: 'https://remote.invalid/image.png', width: 2, height: 1 };
    await assert.rejects(deck.create(invalidImage), /Invalid report image/, 'Report creation never fetches remote images');
    await assert.rejects(deck.create({}, {}), /Invalid project report/);
    await assert.rejects(deck.create(report, { type: 'invalid' }), /Unsupported/);
    const blob = await deck.create(fixture(1, 1));
    assert.ok(blob instanceof Blob, 'Browser output is a Blob');
    assert.ok(blob.size > 1000);
    const prepared = await Data.prepare({ projectName: 'Integrated registered project', generatedAt: report.generatedAt,
        metadata: { sample: 'Mouse kidney', analysis: { method: 'DESI MRM', operator: '研究者 A' },
            sections: [{ sectionId: 's1', name: 'Registered kidney section',
                acquisition: { instrument: 'Xevo TQ', rawFile: 'sample.raw', scanSpeed: 100,
                    nested: { unknown_acquisition_field: 'FULL_METADATA_VALUE' } }, pixelPitch: { x: 20, y: 30 } }] },
        sections: [{ id: 's1', name: 'Registered kidney section' }],
        molecules: [{ key: 'm1', name: 'Registered compound', subtitle: 'Q1 100 / Q3 50', metadata: {adduct: '[M-H]-'}, sections: [
            { sectionId: 's1', name: 'Registered kidney section',
                metadata: {registered_function: 'MRM Function 7'},
                raster: { W: 2, H: 1, values: Float64Array.from([5, 10]) }, stats: { max: 100, mean: 25, n: 4 } }
        ] }] }, { createCanvas });
    const integrated = await unzip(prepared);
    const integratedText = integrated.all.replace(/<[^>]*>/g, '');
    for (const value of ['Mouse kidney', '研究者 A', 'Xevo TQ', 'sample.raw', 'FULL_METADATA_VALUE',
        'Registered kidney section', 'Pixel pitch', 'Measured image pixels', 'Original measurement rows', 'p99.8', '[M-H]-', 'MRM Function 7']) {
        assert.ok(integratedText.includes(value), 'Integrated metadata retains ' + value);
    }
    assert.ok(integratedText.includes('最大・平均は元測定行の統計値を使用。'), 'Scientific display/statistics note is visible');
    const sectionMetadataRows = deck.metadataRows({ sections: [{ id: 'INTERNAL_ID', sectionId: 'INTERNAL_SECTION_ID',
        layerKey: 'INTERNAL_LAYER_KEY', name: 'Long named section', acquisition: {instrument: 'Instrument name', scanSpeed: 100} }] });
    assert.equal(JSON.stringify(sectionMetadataRows), JSON.stringify([
        {label: 'Section 1', value: 'Long named section'},
        {label: 'Section 1 / Instrument', value: 'Instrument name'},
        {label: 'Section 1 / Scan speed', value: '100'}
    ]), 'Section heading appears once, scientific labels are short, internal IDs are omitted');
    assert.equal(JSON.stringify(deck.metadataRows([{ label: 'A', value: 0 }, { label: 'B', value: false }])),
        JSON.stringify([{ label: 'A', value: '0' }, { label: 'B', value: 'false' }]), 'Legacy metadata rows retain falsy values');
    assert.equal(JSON.stringify(deck.COLOR_STOPS), JSON.stringify(Data.COLOR_STOPS.map(color => color.slice(1))), 'Legend and rendered images use the same exact stops');
    const fallback = fixture(1, 1);
    fallback.molecules[0].intensityScale = {upperBasis: 'unit-fallback', upper: 1};
    fallback.molecules[0].upper = 1;
    assert.match((await unzip(fallback)).all, /Upper bound 1 \(no positive range\)/, 'Fallback upper bound is not labelled p99.8');
    const acquisitions = fixture(2, 1);
    acquisitions.molecules[0].metadata = { sourceFile: 'first.raw', msMethod: 'Common method', acquiredAt: 'DAY_ONE' };
    acquisitions.molecules[0].sections[0].metadata = { ...acquisitions.molecules[0].metadata };
    acquisitions.molecules[0].sections[1].metadata = { sourceFile: 'second.raw', msMethod: 'Common method', acquiredAt: 'DAY_TWO', rtStart: 1.25 };
    const acquisitionText = (await unzip(acquisitions)).all.replace(/<[^>]*>/g, '');
    for (const value of ['first.raw', 'second.raw', 'DAY_ONE', 'DAY_TWO', '1.25']) assert.ok(acquisitionText.includes(value), 'Source acquisition retained: ' + value);
    assert.equal((acquisitionText.match(/Common method/g) || []).length, 1, 'Identical group metadata is printed once');
    const controller = new AbortController(); let pageProgress = 0;
    await assert.rejects(deck.create(fixture(8, 5), { type: 'nodebuffer', signal: controller.signal,
        onProgress(event) { if (event.phase === 'slides' && ++pageProgress === 3) controller.abort(); }
    }), error => error.name === 'AbortError', 'Slide assembly cooperatively cancels between pages');
    assert.equal(pageProgress, 3, 'No additional pages are assembled after cancellation');
    let freshnessChecks = 0;
    await assert.rejects(deck.create(fixture(2, 1), { type: 'nodebuffer',
        assertCurrent() { if (++freshnessChecks > 5) throw new Error('Project changed'); }
    }), /Project changed/, 'Changed project snapshots abort page assembly');
    if (process.argv.includes('--sample')) {
        const sample = fixture(7, 2);
        sample.metadata = prepared.metadata;
        sample.intensityScale = prepared.intensityScale;
        const sampleResult = await unzip(sample);
        const target = path.resolve(root, '../report-sample.pptx');
        fs.writeFileSync(target, sampleResult.bytes);
        console.log('Sample PPTX: ' + target);
        const approvedTarget = path.resolve(root, '../report-approved-layout-sample.pptx');
        const approvedSample = fixture(2, 17);
        approvedSample.projectName = 'Approved layout: synthetic MSI comparison';
        const reference = createCanvas(240, 120), referenceContext = reference.getContext('2d');
        for (let x = 0; x < 240; x++) {
            const gray = Math.floor(35 + 150 * x / 239);
            referenceContext.fillStyle = `rgb(${gray},${gray},${gray})`;
            referenceContext.fillRect(x, 0, 1, 120);
        }
        approvedSample.sections.forEach(section => {
            section.referenceImage = {data: reference.toDataURL('image/png'), width: 240, height: 120};
            section.referenceLabel = 'Synthetic optical reference';
        });
        approvedSample.molecules.forEach(molecule => molecule.sections.forEach((section, index) => {
            section.image = {...section.image, physicalWidthUm: index ? 1200 : 800, physicalHeightUm: index ? 600 : 400};
        }));
        fs.writeFileSync(approvedTarget, (await unzip(approvedSample)).bytes);
        console.log('Approved matrix/detail layout sample: ' + approvedTarget);
    }
    console.log('Project report deck regression: PASS (editable PPTX, pagination, missing data, complete metadata, image geometry)');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
