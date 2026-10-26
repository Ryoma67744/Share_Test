import { parseExp, createDraft, validateEdits, validateSelectedExport, writeSelectedExp, serializeDocument, restoreDocument, MAX_EXP_BYTES } from './exp-core.mjs';
import { matchExpRows, canonicalNumeric } from './exp-library-import.mjs';

const FIELDS = ['name', 'precursor', 'product', 'cv', 'ce'];
const LABELS = { name: '化合物名', precursor: 'Precursor', product: 'Product', cv: 'CV（コーン）', ce: 'CE（衝突）' };
const MAX_FILE_BYTES = MAX_EXP_BYTES;
const MAX_DRAFT_BYTES = 16 * 1024 * 1024;
const ARCHIVE_FORMAT = 'mrm-exp-document';
let activeEditor = null;

function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
}
function button(text, handler, className) {
    const result = node('button', text, className);
    result.type = 'button';
    if (handler) result.addEventListener('click', handler);
    return result;
}
function option(value, text) { const result = node('option', text); result.value = value; return result; }
function labelled(text, control) { const result = node('label', text); result.append(control); return result; }
function displayError(error) { return error?.message || String(error); }
function base64Bytes(base64) {
    if (typeof base64 !== 'string' || base64.length > MAX_DRAFT_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
        throw new Error('原本データのBase64形式が不正です。');
    }
    const binary = atob(base64);
    return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}
async function digest(bytes) {
    if (!globalThis.crypto?.subtle) throw new Error('安全な接続（HTTPS）で開いてください。原本の整合性を確認できません。');
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
}

/** Keep selection in source order; an omitted selection is a legacy all-row draft. */
function normalizeSelection(rows, selectedIds) {
    if (selectedIds === undefined) return rows.map(row => row.id);
    const ids = new Set(rows.map(row => row.id));
    if (!Array.isArray(selectedIds) || selectedIds.some(id => typeof id !== 'string' || !ids.has(id)) ||
        new Set(selectedIds).size !== selectedIds.length) {
        throw new Error('保存されたMRMの選択状態が不正です。現在の編集内容を保持しました。');
    }
    const selected = new Set(selectedIds);
    return rows.filter(row => selected.has(row.id)).map(row => row.id);
}

export function editorStateKey(rows, selectedIds) {
    return JSON.stringify({ rows, selectedIds: normalizeSelection(rows, selectedIds) });
}

/** Additional UI metadata is accepted and preserved by the document storage RPC. */
export function serializeEditorDocument(doc, rows, selectedIds) {
    return { ...serializeDocument(doc, rows), selectedIds: normalizeSelection(rows, selectedIds) };
}

function restoreEditorDocument(payload) {
    const restored = restoreDocument(payload);
    return { ...restored, selectedIds: normalizeSelection(restored.rows, payload.selectedIds) };
}

/** Portable drafts include an integrity checksum and the original bytes. */
export async function createDraftArchive(doc, rows, selectedIds) {
    const payload = serializeEditorDocument(doc, rows, selectedIds);
    return { format: ARCHIVE_FORMAT, version: 1, sha256: await digest(base64Bytes(payload.originalBase64)), document: payload };
}

export async function restoreDraftArchive(archive) {
    if (!archive || archive.format !== ARCHIVE_FORMAT || archive.version !== 1 || !archive.document ||
        typeof archive.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(archive.sha256)) {
        throw new Error('対応する .exp 作業ファイルではありません（形式またはバージョンが不正です）。');
    }
    const actual = await digest(base64Bytes(archive.document.originalBase64));
    if (actual !== archive.sha256) throw new Error('原本のハッシュが一致しません。作業ファイルが破損しています。');
    return restoreEditorDocument(archive.document);
}

/** Server documents carry a checksum calculated when their source was saved. */
export async function restoreSavedDocument(saved) {
    if (!saved?.payload || typeof saved.source_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(saved.source_sha256)) {
        throw new Error('保存メソッドの原本ハッシュがありません。保存データを確認してください。');
    }
    const actual = await digest(base64Bytes(saved.payload.originalBase64));
    if (actual !== saved.source_sha256) throw new Error('保存メソッドの原本ハッシュが一致しません。現在の編集内容を保持しました。');
    return restoreEditorDocument(saved.payload);
}

export function safeDownloadName(filename, suffix) {
    const clean = String(filename || 'method').replace(/[\\/\u0000-\u001f\u007f]/g, '_').replace(/\.(?:exp|json)$/i, '').slice(0, 160);
    return (clean || 'method') + suffix;
}

function download(bytes, filename, mime = 'application/octet-stream') {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const anchor = node('a'); anchor.href = url; anchor.download = filename;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function libraryChoices(library) {
    return (Array.isArray(library) ? library : []).flatMap(compound => (compound.transitions || []).map(transition => ({
        name: compound.name, precursor: transition.precursor, product: transition.product, cv: transition.cv, ce: transition.ce,
        polarity: compound.polarity, compoundId: compound.id, transitionId: transition.id,
    })));
}

/** All callbacks are injected so file editing works without database access. */
export async function openExpEditor({ library = [], getLibrary, refreshLibrary, getPassword, registerRows, saveDocument, listDocuments, getDocument } = {}) {
    if (activeEditor) { activeEditor.dialog.focus(); return activeEditor; }
    const state = { doc: null, rows: [], selected: new Set(), cells: new Map(), savedRows: '', busy: false,
        documentId: null, revision: null, name: '' };
    const dialog = node('dialog', undefined, 'exp-dialog');
    dialog.setAttribute('aria-labelledby', 'exp-editor-title');
    const content = node('div', undefined, 'exp-editor'); dialog.append(content);
    const head = node('div', undefined, 'exp-head');
    const title = node('h2', '.exp を開いて編集'); title.id = 'exp-editor-title';
    const close = button('閉じる', () => closeEditor()); head.append(title, close);
    const description = node('p', '元の .exp を読み込み、化合物名・質量・CV・CEを編集して別名保存します。チェックしたMRMだけを .exp に出力します。同じチェックはライブラリ登録・1行の置換にも使用します。', 'exp-help');
    const toolbar = node('div', undefined, 'exp-toolbar');
    const expFile = node('input', undefined, 'exp-file'); expFile.type = 'file'; expFile.accept = '.exp';
    expFile.setAttribute('aria-label', '.exp ファイルを選択');
    const encoding = node('select'); encoding.setAttribute('aria-label', '文字コード');
    for (const [value, label] of [['auto', '自動'], ['utf-8', 'UTF-8'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'], ['windows-1252', 'Windows-1252'], ['shift_jis', 'Shift_JIS']]) encoding.append(option(value, label));
    const draftFile = node('input'); draftFile.type = 'file'; draftFile.accept = '.json'; draftFile.hidden = true;
    const loadDraft = button('作業ファイルを開く', () => draftFile.click());
    const loadRemote = button('保存したメソッドを開く', () => runTask(showSavedDocuments));
    loadRemote.hidden = !listDocuments || !getDocument;
    toolbar.append(expFile, labelled('文字コード', encoding), loadDraft, loadRemote, draftFile);
    const summary = node('div', 'ファイルを選択してください。', 'exp-summary');
    const warning = node('p', '対応形式を検査してから編集します。一部のMRMだけを出力できるのは、チャンネル条件と測定時間の構造を確認できる形式です。行の追加・削除・並べ替えは利用できません。', 'exp-warning');
    const controls = node('div', undefined, 'exp-toolbar');
    const replace = button('選択した1行をライブラリのMRMで置換', showLibraryReplacement);
    const reset = button('変更をすべて元に戻す', () => {
        if (!state.doc || !confirm('すべての編集を読み込み時の .exp の値へ戻しますか？')) return;
        state.rows = createDraft(state.doc); panel.replaceChildren(); renderRows();
    });
    controls.append(replace, reset);
    for (const label of ['行を追加', '行を削除', '並べ替え']) {
        const disabled = button(label); disabled.disabled = true;
        disabled.title = '編集表の行の追加・削除・並べ替えには対応していません。出力対象はチェックで指定します。'; controls.append(disabled);
    }
    const gridWrap = node('div', undefined, 'exp-scroll');
    const table = node('table', undefined, 'exp-table');
    table.setAttribute('aria-label', '.exp のMRM編集');
    const tableHead = node('thead'); const heading = node('tr');
    const selectAll = node('input'); selectAll.type = 'checkbox'; selectAll.setAttribute('aria-label', 'すべてのMRMを選択');
    const selectionHead = node('th'); selectionHead.append(selectAll, document.createTextNode(' 出力対象')); heading.append(selectionHead, node('th', '順番'));
    for (const field of FIELDS) heading.append(node('th', LABELS[field]));
    heading.append(node('th', 'その他の条件（保持）')); tableHead.append(heading);
    const body = node('tbody'); table.append(tableHead, body); gridWrap.append(table);
    const diagnostics = node('div', undefined, 'exp-diagnostics'); diagnostics.setAttribute('role', 'alert');
    const exportDiagnostics = node('div', undefined, 'exp-diagnostics'); exportDiagnostics.setAttribute('role', 'alert');
    exportDiagnostics.setAttribute('aria-label', '.exp 出力の確認');
    const panel = node('div', undefined, 'exp-panel');
    const status = node('div', undefined, 'exp-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const actions = node('div', undefined, 'exp-actions');
    const importButton = button('選択したMRMをライブラリへ登録', () => runTask(showRegistration)); importButton.hidden = !registerRows;
    const draftButton = button('作業ファイルを保存', () => runTask(async () => {
        const archive = await createDraftArchive(state.doc, state.rows, selectedIds());
        download(JSON.stringify(archive, null, 2), safeDownloadName(state.doc.filename, '.mrm-draft.json'), 'application/json');
        state.savedRows = rowsKey(); update(); status.textContent = '原本・全行の編集内容・チェック状態を含む作業ファイルを保存しました。';
    }));
    const saveRemote = button('メソッドとして保存', showSaveDocument); saveRemote.hidden = !saveDocument;
    const exportButton = button('選択したMRMを .exp 保存 (0件)', () => runTask(async () => {
        const selected = selectedIds();
        const bytes = writeSelectedExp(state.doc, state.rows, selected);
        download(bytes, safeDownloadName(state.doc.filename, '_edited.exp'));
        const excluded = state.rows.length - selected.length;
        if (excluded === 0) state.savedRows = rowsKey();
        update(); status.textContent = `${selected.length} 件のMRMを .exp に保存しました（除外 ${excluded} 件）。対象のMassLynxで変更値と測定条件を確認してください。${excluded ? '\n全行の編集内容とチェック状態を残すには、作業ファイルまたはメソッドとして保存してください。' : ''}`;
    }), 'exp-primary');
    actions.append(importButton, draftButton, saveRemote, exportButton);
    content.append(head, description, toolbar, summary, warning, controls, gridWrap, diagnostics, exportDiagnostics, panel, status, actions);
    document.body.append(dialog);

    function currentLibrary() { return getLibrary ? getLibrary() : typeof library === 'function' ? library() : library; }
    function selectedIds() { return state.rows.filter(row => state.selected.has(row.id)).map(row => row.id); }
    function rowsKey() { return editorStateKey(state.rows, selectedIds()); }
    function dirty() { return !!state.doc && rowsKey() !== state.savedRows; }
    function canReplace() { return !dirty() || confirm('保存していない編集があります。破棄して別のファイルを開きますか？'); }
    function closeEditor() {
        if (state.busy) return;
        if (dirty() && !confirm('保存していない編集があります。破棄して閉じますか？')) return;
        window.removeEventListener('beforeunload', beforeUnload); dialog.close(); dialog.remove(); activeEditor = null;
    }
    function beforeUnload(event) { if (dirty()) { event.preventDefault(); event.returnValue = ''; } }
    async function password() {
        const result = getPassword ? await getPassword() : null;
        if (!result) throw new Error('認証が必要です。管理者としてログインしてください。');
        return result;
    }
    async function runTask(task) {
        if (state.busy) return;
        state.busy = true; status.textContent = '処理中…'; update();
        try { await task(); } catch (error) { status.textContent = displayError(error); }
        finally {
            state.busy = false;
            if (status.textContent === '処理中…') status.textContent = '';
            update();
        }
    }
    function installDocument(doc, rows, metadata = {}, selection) {
        const selected = normalizeSelection(rows, selection);
        state.doc = doc; state.rows = rows; state.selected = new Set(selected);
        state.savedRows = rowsKey(); state.documentId = metadata.id || null; state.revision = metadata.revision || null;
        state.name = metadata.name || safeDownloadName(doc.filename, ''); panel.replaceChildren(); renderRows();
        status.textContent = '読み込みました。黄色のセルは原本から変更された項目です。';
    }
    function renderRows() {
        body.replaceChildren(); state.cells.clear();
        for (const [index, row] of state.rows.entries()) {
            const tr = node('tr'); const selectionCell = node('td');
            const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(row.id);
            checkbox.setAttribute('aria-label', `${index + 1} 行目を選択`); checkbox.dataset.rowSelection = row.id;
            checkbox.addEventListener('change', () => { checkbox.checked ? state.selected.add(row.id) : state.selected.delete(row.id); panel.replaceChildren(); update(); });
            selectionCell.append(checkbox); tr.append(selectionCell, node('td', String(index + 1), 'exp-row-number'));
            const cells = new Map();
            for (const field of FIELDS) {
                const cell = node('td', undefined, field === 'name' ? 'exp-name' : undefined);
                const input = node('input'); input.type = 'text'; input.value = String(row[field] ?? '');
                if (field !== 'name') input.inputMode = 'decimal';
                input.setAttribute('aria-label', `${index + 1} 行目 ${LABELS[field]}`); input.autocomplete = 'off';
                input.addEventListener('input', () => { row[field] = input.value; panel.replaceChildren(); update(); });
                cell.append(input); tr.append(cell); cells.set(field, input);
            }
            const detailsCell = node('td'); const details = node('details'); details.append(node('summary', '条件を表示'));
            const values = row.details || {};
            details.append(node('div', [['Dwell', values.dwell], ['Delay', values.delay], ['AutoDwell', values.autoDwell], ['化学式', values.formula], ['コメント', values.comment]].map(([key, value]) => `${key}: ${value ?? '—'}`).join('\n')));
            detailsCell.append(details); tr.append(detailsCell); body.append(tr); state.cells.set(row.id, cells);
        }
        update();
    }
    function update() {
        const validation = state.doc ? validateEdits(state.doc, state.rows) : { valid: false, errors: [], changedCells: 0 };
        const exportValidation = state.doc ? validateSelectedExport(state.doc, state.rows, selectedIds()) : { valid: false, errors: [] };
        const originals = new Map((state.doc?.rows || []).map(row => [row.id, row]));
        for (const row of state.rows) for (const field of FIELDS) {
            const input = state.cells.get(row.id)?.get(field); if (!input) continue;
            const original = originals.get(row.id)?.[field];
            const changed = field === 'name' ? String(row[field]) !== String(original) : canonicalNumeric(row[field]) !== canonicalNumeric(original) || canonicalNumeric(row[field]) === null;
            input.classList.toggle('exp-changed', changed);
            const issue = validation.errors.find(error => error.rowId === row.id && error.field === field);
            input.setAttribute('aria-invalid', issue ? 'true' : 'false'); input.title = issue?.message || '';
            input.disabled = state.busy;
        }
        function issueText(error) {
            const index = state.rows.findIndex(row => row.id === error.rowId);
            return `${index >= 0 ? `${index + 1}行目 ` : ''}${LABELS[error.field] || error.field || ''}: ${error.message}`;
        }
        diagnostics.textContent = validation.errors.length ? `作業全体の確認（作業ファイル・メソッド保存／ライブラリ登録）:\n${validation.errors.map(issueText).join('\n')}` : '';
        exportDiagnostics.textContent = exportValidation.errors.length ? `.exp を出力できません:\n${exportValidation.errors.map(issueText).join('\n')}` : '';
        if (state.doc) {
            const polarity = state.doc.polarity === 'positive' ? '+' : state.doc.polarity === 'negative' ? '−' : '未指定（登録時に指定）';
            const count = Array.isArray(validation.changedCells) ? validation.changedCells.length : validation.changedCells;
            summary.textContent = `${state.doc.filename} ｜ ${state.doc.encoding} ｜ 極性 ${polarity} ｜ ${state.rows.length} チャンネル ｜ 出力対象 ${state.selected.size} 件 / 除外 ${state.rows.length - state.selected.size} 件 ｜ 変更 ${count ?? '—'} 項目${dirty() ? ' ｜ 未保存' : ''}${state.revision ? ` ｜ 保存版 ${state.revision}` : ''}`;
            const warnings = (state.doc.warnings || []).map(item => typeof item === 'string' ? item : item.message).filter(Boolean);
            warning.textContent = ['チェックを外したMRMは出力から除外します。一部出力は対応形式のみ可能です。行の追加・削除・並べ替えは利用できません。', ...warnings].join('\n');
        }
        selectAll.checked = state.rows.length > 0 && state.selected.size === state.rows.length;
        selectAll.indeterminate = state.selected.size > 0 && state.selected.size < state.rows.length;
        selectAll.disabled = state.busy || !state.doc;
        for (const checkbox of body.querySelectorAll('input[type=checkbox]')) checkbox.disabled = state.busy;
        for (const control of [expFile, encoding, loadDraft, loadRemote, close]) control.disabled = state.busy;
        replace.disabled = state.busy || !state.doc || state.selected.size !== 1;
        reset.disabled = state.busy || !state.doc;
        for (const control of [draftButton, saveRemote]) control.disabled = state.busy || !validation.valid;
        exportButton.textContent = `選択したMRMを .exp 保存 (${state.selected.size}件)`;
        exportButton.disabled = state.busy || !exportValidation.valid;
        importButton.disabled = state.busy || !validation.valid || !state.selected.size;
        for (const control of panel.querySelectorAll('button,input,select')) control.disabled = state.busy || control.dataset.blocked === 'true';
    }

    selectAll.addEventListener('change', () => {
        state.selected = new Set(selectAll.checked ? state.rows.map(row => row.id) : []);
        panel.replaceChildren(); renderRows();
    });
    expFile.addEventListener('change', () => runTask(async () => {
        const file = expFile.files[0]; if (!file) return;
        try {
            if (!/\.exp$/i.test(file.name)) throw new Error('.exp ファイルを選んでください。');
            if (file.size > MAX_FILE_BYTES) throw new Error(`.exp ファイルは${MAX_FILE_BYTES / 1024 / 1024} MiB以下を選んでください。`);
            const doc = parseExp(new Uint8Array(await file.arrayBuffer()), { filename: file.name, encoding: encoding.value });
            if (canReplace()) installDocument(doc, createDraft(doc));
        } finally { expFile.value = ''; }
    }));
    draftFile.addEventListener('change', () => runTask(async () => {
        const file = draftFile.files[0]; if (!file) return;
        try {
            if (file.size > MAX_DRAFT_BYTES) throw new Error('作業ファイルは16 MB以下を選んでください。');
            const restored = await restoreDraftArchive(JSON.parse(await file.text()));
            if (canReplace()) installDocument(restored.document, restored.rows, {}, restored.selectedIds);
        } finally { draftFile.value = ''; }
    }));

    function showLibraryReplacement() {
        panel.replaceChildren(node('h3', '選択した1行へライブラリのMRMをコピー'));
        const choices = libraryChoices(currentLibrary()); const select = node('select');
        select.setAttribute('aria-label', 'コピー元MRM');
        select.append(option('', 'MRMを選択'));
        for (const [index, choice] of choices.entries()) select.append(option(String(index), `${choice.name} ｜ ${choice.precursor} → ${choice.product} ｜ CV ${choice.cv} / CE ${choice.ce} ｜ ${choice.polarity || '?'}`));
        const info = node('p', '選択した行の5項目を置換します。Dwell等とチャンネル順序は元の行のまま保持します。', 'exp-help');
        const apply = button('このMRMをコピー', () => {
            const chosen = choices[Number(select.value)];
            if (select.value === '' || !chosen) { status.textContent = 'コピー元のMRMを選択してください。'; return; }
            const expected = state.doc.polarity === 'positive' ? '+' : state.doc.polarity === 'negative' ? '-' : null;
            if (!expected || !chosen.polarity || chosen.polarity !== expected) {
                status.textContent = '原本とコピー元の極性が同じと確認できません。手入力で内容を確認してください。'; return;
            }
            const row = state.rows.find(item => state.selected.has(item.id));
            for (const field of FIELDS) row[field] = chosen[field];
            panel.replaceChildren(); renderRows(); status.textContent = '選択した行へコピーしました。原本の測定条件は保持しています。';
        });
        panel.append(info, select, apply);
    }

    async function showRegistration() {
        panel.replaceChildren();
        let reviewedLibrary = refreshLibrary ? await refreshLibrary() : currentLibrary();
        panel.replaceChildren(node('h3', 'ライブラリ登録の確認'));
        const instructions = node('p', '選択した行を照合します。既存の確認レベル・注釈・推奨設定を保持し、測定履歴は作成しません。', 'exp-help');
        const options = node('div', undefined, 'exp-options');
        const polarity = node('select'); polarity.append(option('', '極性を指定'), option('+', '+'), option('-', '−'));
        polarity.value = state.doc.polarity === 'positive' ? '+' : state.doc.polarity === 'negative' ? '-' : '';
        polarity.dataset.blocked = String(!!state.doc.polarity);
        polarity.disabled = !!state.doc.polarity;
        const tags = node('input'); tags.placeholder = 'タグ（カンマ区切り）'; tags.setAttribute('aria-label', '追加するタグ');
        const shelf = node('select'); shelf.append(option('', '登録先を選択'), option('main', '検証済みライブラリ'), option('archive', '使用実績アーカイブ'));
        options.append(labelled('極性', polarity), tags, labelled('新規化合物の登録先', shelf));
        const note = node('p', '作成しただけの条件は作業メソッドとして保存してください。実測済みで未最適化ならアーカイブ、検証済みなら検証済みライブラリを選択します。既存化合物の登録先と確認レベルは変更しません。', 'exp-help');
        const preview = node('div', undefined, 'exp-scroll');
        let previewMatches = [];
        let previewFresh = true;
        const acknowledgement = node('input'); acknowledgement.type = 'checkbox';
        const ackLabel = labelled('既存化合物へ条件を追加します。確認レベルは化合物単位なので、新しい条件も同じ分類で表示されることを確認しました。', acknowledgement); ackLabel.className = 'exp-check';
        const commit = button('この内容を登録する', () => runTask(async () => {
            const matches = previewMatches;
            if (!previewFresh || !matches.length) throw new Error('「再照合する」でライブラリを再読み込みしてください。');
            if (matches.some(match => !match.payload)) throw new Error('登録できない行があります。編集値または極性を確認してください。');
            if (matches.some(match => match.requiresAcknowledgement) && !acknowledgement.checked) throw new Error('既存化合物への条件追加について確認してください。');
            const payloads = matches.map(match => ({ ...match.payload, allow_new_condition: !!acknowledgement.checked }));
            let result;
            try { result = await registerRows(payloads, { password: await password() }); }
            catch (error) {
                previewFresh = false;
                commit.dataset.blocked = 'true';
                throw new Error(`${displayError(error)}\n「再照合する」で最新の内容を確認してから再度登録してください。`);
            }
            panel.replaceChildren(); status.textContent = `${result?.ok_count ?? payloads.length} 行の登録処理が完了しました。既存の一致するMRMは再利用しています。`;
        }), 'exp-primary');
        function calculate() {
            return matchExpRows(state.rows.filter(row => state.selected.has(row.id)), reviewedLibrary, {
                polarity: polarity.value, tags: tags.value.split(/[,、]/).map(value => value.trim()).filter(Boolean), shelf: shelf.value,
            });
        }
        function drawPreview() {
            if (!previewFresh) {
                previewMatches = []; preview.replaceChildren(node('p', '最新の照合が必要です。「再照合する」を押してください。'));
                commit.dataset.blocked = 'true'; commit.disabled = true; return;
            }
            const matches = calculate(); previewMatches = matches;
            const resultTable = node('table', undefined, 'exp-table'); const resultBody = node('tbody');
            for (const match of matches) {
                const row = node('tr'); row.append(node('td', match.row.name), node('td', match.message)); resultBody.append(row);
            }
            resultTable.append(resultBody); preview.replaceChildren(resultTable);
            ackLabel.hidden = !matches.some(match => match.requiresAcknowledgement);
            commit.dataset.blocked = String(matches.some(match => !match.payload) || (!ackLabel.hidden && !acknowledgement.checked));
            commit.disabled = commit.dataset.blocked === 'true';
        }
        for (const control of [polarity, tags, shelf]) control.addEventListener('input', () => { acknowledgement.checked = false; drawPreview(); });
        acknowledgement.addEventListener('change', () => {
            commit.dataset.blocked = String(!previewFresh || !previewMatches.length || previewMatches.some(match => !match.payload) || (!ackLabel.hidden && !acknowledgement.checked));
            commit.disabled = commit.dataset.blocked === 'true';
        });
        const recheck = button('再照合する', () => runTask(async () => {
            acknowledgement.checked = false; previewMatches = []; previewFresh = false; commit.dataset.blocked = 'true';
            reviewedLibrary = refreshLibrary ? await refreshLibrary() : currentLibrary();
            previewFresh = true;
            drawPreview(); status.textContent = '最新のライブラリと再照合しました。登録内容を確認してください。';
        }));
        panel.append(instructions, options, note, preview, ackLabel, recheck, commit); drawPreview();
    }

    function showSaveDocument() {
        panel.replaceChildren(node('h3', '原本と編集内容をメソッドとして保存'));
        const name = node('input', undefined, 'exp-draft-name'); name.value = state.name; name.maxLength = 160;
        name.setAttribute('aria-label', 'メソッド名');
        const save = button(state.documentId ? `版 ${state.revision} を更新` : '新規保存', () => runTask(async () => {
            await saveToServer(false, name.value);
        }), 'exp-primary');
        panel.append(name, save);
        if (state.documentId) panel.append(button('別メソッドとして新規保存', () => runTask(() => saveToServer(true, name.value))));
        panel.append(node('p', '原本の .exp と全行の編集値・チェック状態を保存します。同時に変更された場合は上書きせず、再読み込みを求めます。', 'exp-help'));
    }
    async function saveToServer(asNew, name) {
        if (!name.trim()) throw new Error('メソッド名を入力してください。');
        const payload = serializeEditorDocument(state.doc, state.rows, selectedIds());
        const result = await saveDocument({ name: name.trim(), payload, id: asNew ? null : state.documentId, expected_revision: asNew ? null : state.revision }, { password: await password() });
        state.documentId = result.id; state.revision = result.revision; state.name = result.name || name.trim();
        state.savedRows = rowsKey(); panel.replaceChildren(); status.textContent = `「${state.name}」を保存しました（版 ${state.revision}）。`;
    }
    async function showSavedDocuments() {
        const pw = await password(); const documents = await listDocuments({ password: pw });
        panel.replaceChildren(node('h3', '保存したメソッドを開く'));
        if (!documents.length) { panel.append(node('p', '保存したメソッドはありません。')); status.textContent = ''; return; }
        const select = node('select'); select.setAttribute('aria-label', '保存したメソッド');
        for (const item of documents) select.append(option(String(item.id), `${item.name} ｜ 版 ${item.revision} ｜ ${item.updated_at ? new Date(item.updated_at).toLocaleString('ja-JP') : ''}`));
        panel.append(select, button('開く', () => runTask(async () => {
            const saved = await getDocument(select.value, { password: await password() });
            const restored = await restoreSavedDocument(saved);
            if (canReplace()) installDocument(restored.document, restored.rows, saved, restored.selectedIds);
        })));
        status.textContent = '';
    }

    dialog.addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
    window.addEventListener('beforeunload', beforeUnload);
    activeEditor = { dialog, close: closeEditor };
    dialog.showModal(); update(); expFile.focus();
    return activeEditor;
}
