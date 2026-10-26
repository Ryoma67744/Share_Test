/** Pure registration planning. Nothing in this module writes to the library. */
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const FIELDS = ['precursor', 'product', 'ce', 'cv'];

export function canonicalNumeric(value) {
  const text = String(value ?? '').trim();
  if (!NUMBER.test(text) || text.length > 80 || !Number.isFinite(Number(text))) return null;
  let [coefficient, exponent = '0'] = text.toLowerCase().split('e');
  const negative = coefficient.startsWith('-');
  coefficient = coefficient.replace(/^[+-]/, '');
  let [whole, fraction = ''] = coefficient.split('.');
  const point = whole.length + Number(exponent);
  if (Math.abs(point) > 1000) return null;
  let digits = whole + fraction;
  if (point <= 0) digits = '0.' + '0'.repeat(-point) + digits;
  else if (point >= digits.length) digits += '0'.repeat(point - digits.length);
  else digits = digits.slice(0, point) + '.' + digits.slice(point);
  let [integer, decimal = ''] = digits.split('.');
  integer = integer.replace(/^0+/, '') || '0';
  decimal = decimal.replace(/0+$/, '');
  const normalized = integer + (decimal ? '.' + decimal : '');
  const magnitude = Number(normalized);
  if (magnitude > 1e100 || (normalized !== '0' && magnitude < 1e-100)) return null;
  return negative && normalized !== '0' ? '-' + normalized : normalized;
}

function transitionSnapshot(transition) {
  return { id: transition.id, ...Object.fromEntries(FIELDS.map(key => [key, canonicalNumeric(transition[key])])) };
}

export function compoundSnapshot(compound) {
  if (!compound) return null;
  return {
    id: compound.id,
    updated_at: compound.updated_at,
    transitions: (compound.transitions || []).map(transitionSnapshot).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Returns one result per row, in file order. Callers must explicitly acknowledge new conditions. */
export function matchExpRows(rows, library, options = {}) {
  const compounds = new Map((library || []).map(compound => [compound.name, compound]));
  const normalizedNames = new Map();
  for (const compound of library || []) {
    const key = compound.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key) normalizedNames.set(key, [...(normalizedNames.get(key) || []), compound.name]);
  }
  return rows.map((row, index) => {
    const name = String(row.name ?? '').trim();
    const polarity = row.polarity || options.polarity;
    const tags = row.tags ?? options.tags ?? [];
    const shelf = row.shelf ?? options.shelf;
    const numbers = Object.fromEntries(FIELDS.map(key => [key, canonicalNumeric(row[key])]));
    const compound = compounds.get(name) || null;
    const expected = compoundSnapshot(compound);
    const result = { row, status: 'invalid', message: '', compound, transition: null, expected, requiresAcknowledgement: false, payload: null };
    if (!name || name.length > 500 || /[\x00-\x1f\x7f]/.test(name)) result.message = '化合物名を確認してください（改行・制御文字は使用できません）。';
    else if (FIELDS.some(key => numbers[key] === null) || Number(numbers.precursor) <= 0 || Number(numbers.product) <= 0) result.message = '質量は正の数、CE・CVは有限の数値を入力してください。';
    else if (!['+', '-'].includes(polarity)) result.message = '極性を明示してください。';
    else if (!Array.isArray(tags) || tags.length > 50 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 100 || /[\x00-\x1f\x7f]/.test(tag))) result.message = 'タグを確認してください。';
    else if (!compound && !['main', 'archive'].includes(shelf)) result.message = '新規化合物の登録先を選択してください。';
    else if (compound && compound.polarity !== polarity) {
      result.status = 'polarity-conflict';
      result.message = '同名の既存化合物と極性が一致しません。別名にするか、既存の極性を確認してください。';
    } else {
      const transition = compound?.transitions?.find(item => FIELDS.every(key => canonicalNumeric(item[key]) === numbers[key])) || null;
      result.transition = transition;
      result.status = !compound ? 'new-compound' : transition ? 'exact' : 'new-condition';
      result.requiresAcknowledgement = result.status === 'new-condition';
      const candidates = normalizedNames.get(name.toLowerCase().replace(/[^a-z0-9]/g, '')) || [];
      result.message = result.status === 'exact' ? '既存トランジションを再利用します。' : result.status === 'new-condition' ? '既存化合物に新しい条件を追加します。棚・確認レベルは化合物の既存値を引き継ぎます。' : '未確認の新規化合物として登録します。';
      if (!compound && candidates.length) result.message += ` 類似名があります（自動統合しません）: ${candidates.join(', ')}`;
      result.payload = {
        row_id: String(row.id ?? index + 1), name, ...numbers, polarity,
        tags: [...new Set(tags.map(tag => tag.trim()))], shelf: shelf || compound?.shelf,
        allow_new_condition: false, expected,
      };
    }
    return result;
  });
}
