// 公開済み parquet の「形」を読むだけの診断コマンド (READ ONLY)。
//
//   npm run parquet-info              … 読めるプロジェクトを一覧して終わり
//   npm run parquet-info -- <slug>    … その測定PJの parquet の形を出す
//
// 何を見たいか:
//   共有ビューで化合物を切り替えるときの待ち時間は、**row group の数**で
//   ほぼ決まる。parquet は「列 × row group」ごとに 1 本ずつ読むので、
//   row group が 500 個あれば 1 化合物あたり 500 リクエストになる。
//   標準的な粒度は 1 row group = 10 万〜100 万行。ここが極端に細かいなら、
//   ビューア側で何をするより **書き出し直す**のが根本解決になる。
//
// フッタしか読まない (数百 KB)。データ本体は 1 バイトも落とさない。
import { listProjectCatalog, getReadToken, getProjectDoc, storageObjectUrl } from './supabase.js';
import { assertConfigured } from './config.js';
import { asyncBufferFromUrl } from './parquet.js';
import { parquetMetadataAsync } from 'hyparquet';

const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 1 : 0) + ' ' + u[i];
};

async function main() {
  assertConfigured();
  const slug = process.argv[2];
  const cat = await listProjectCatalog();

  if (!slug) {
    console.log('読めるプロジェクト:');
    for (const p of cat) console.log('  ' + p.slug + (p.is_public ? '  [公開]' : '  [非公開]') + '  ' + (p.display_name || ''));
    console.log('\n形を見るには: npm run parquet-info -- <slug>');
    return;
  }

  const entry = cat.find((p) => p.slug === slug);
  if (!entry) throw new Error('project not found: ' + slug);
  const tok = await getReadToken(slug, entry.is_public);
  if (!tok) throw new Error("project '" + slug + "' is private and no password is configured for it.");
  const doc = await getProjectDoc(tok.token);

  // parquet の storage path を集める (同じ 1 本を全切片が共有しているのが普通)
  const paths = new Map();   // path -> 参照している化合物の数
  for (const s of (doc.sections || [])) {
    for (const def of Object.values((s.storage_paths || {}).msiSeries || {})) {
      if (def && def.kind === 'parquet' && def.path) paths.set(def.path, (paths.get(def.path) || 0) + 1);
    }
  }
  if (!paths.size) {
    console.log('このプロジェクトに parquet はありません (DESI の xlsx/txt だけ)。');
    return;
  }

  for (const [path, refs] of paths) {
    const url = storageObjectUrl(path);
    console.log('\n' + path);
    console.log('  参照している化合物 × 切片: ' + refs + ' 件');
    const file = await asyncBufferFromUrl(url);
    const meta = await parquetMetadataAsync(file);
    const nRows = Number(meta.num_rows);
    const nRg = meta.row_groups.length;
    const nCol = nRg ? meta.row_groups[0].columns.length : 0;
    const perRg = nRg ? Math.round(nRows / nRg) : 0;
    console.log('  サイズ            : ' + fmtBytes(file.byteLength));
    console.log('  行数              : ' + nRows.toLocaleString());
    console.log('  列数              : ' + nCol.toLocaleString());
    console.log('  ★ row group 数    : ' + nRg.toLocaleString() + '  (1 つあたり ' + perRg.toLocaleString() + ' 行)');
    console.log('  1 化合物を出すのに : 約 ' + nRg.toLocaleString() + ' 本の HTTP リクエスト');
    // 1 列の実バイト数 (m/z 列の 1 本を代表として合計する)
    let colBytes = 0;
    const probe = Math.min(3, Math.max(0, nCol - 1));
    for (const rg of meta.row_groups) {
      const c = rg.columns[probe];
      if (c && c.meta_data) colBytes += Number(c.meta_data.total_compressed_size);
    }
    console.log('  1 列の実バイト数   : ' + fmtBytes(colBytes)
      + '  (= 1 リクエストあたり平均 ' + fmtBytes(nRg ? colBytes / nRg : 0) + ')');
    if (perRg > 0 && perRg < 20000) {
      console.log('\n  → row group が細かすぎます。標準は 1 つ 10 万〜100 万行です。');
      console.log('     書き出し側で row group を大きくすれば、1 化合物あたりの');
      console.log('     リクエストが ' + nRg.toLocaleString() + ' 本から数本になります。');
    } else {
      console.log('\n  → row group の粒度は標準的です。待ち時間の原因は他にあります。');
    }
  }
}

main().catch((e) => { console.error('ERROR: ' + (e && e.message || e)); process.exit(1); });
