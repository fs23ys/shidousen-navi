// 列(Excel上の1列)ごとに、取込先を1つ選ぶ方式のマッピング。
// 「薬剤名」「YJコード」のような薬剤マスタの項目だけでなく、
// 「URL(患者さん向け資料)」「URL(医療関係者向け資料)」のような資料(resources)の列も
// 同じ行の中に複数あってよい形式に対応する(実際の薬局のExcelに合わせた設計)。
export const COLUMN_TARGETS = [
  { key: 'none', label: '(使わない)' },
  { key: 'name', label: '薬剤名' },
  { key: 'yj', label: 'YJコード' },
  { key: 'jan', label: 'JANコード' },
  { key: 'gs1', label: 'GS1コード' },
  { key: 'category', label: '分類(薬効分類など)' },
  { key: 'maker', label: 'メーカー名' },
  { key: 'url_patient', label: 'URL(患者さん向け資料)' },
  { key: 'url_hcp', label: 'URL(医療関係者向け資料)' },
  { key: 'memo', label: 'メモ' },
];

// 上から順にチェックし、最初に一致したキーワードの取込先を採用する。
// 「URL◯_患者向け」のような具体的な列を、単なる「url」というだけの汎用判定より先に判定する。
const KEYWORD_RULES = [
  { key: 'name', words: ['薬剤名', '薬品名', '医薬品名', '品名', '製品名'] },
  { key: 'yj', words: ['yjコード', 'yj'] },
  { key: 'jan', words: ['janコード', 'jan'] },
  { key: 'gs1', words: ['gs1コード', 'gs1'] },
  { key: 'category', words: ['薬効分類', '分類', '薬効'] },
  { key: 'maker', words: ['メーカー', '製造販売元', '製造元', '会社名'] },
  { key: 'url_hcp', words: ['医療従事者', '医療関係者', '医療従事', 'hcp'] },
  { key: 'url_patient', words: ['患者さん向け', '患者向け', '疾患', '患者'] },
  { key: 'memo', words: ['メモ', '備考', 'memo'] },
  { key: 'url_patient', words: ['url'] }, // それ以外の「URL」列は患者さん向けと仮定(手動で変更可)
];

function normalizeHeader(s) {
  return String(s ?? '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .trim();
}

// ファイルを読み込み、先頭シートを { headers: string[], rows: string[][] } の形で返す
// xlsx(SheetJS)はサイズが大きいので、Excel取込を実際に使うときだけ動的に読み込む
export async function readExcelFile(file) {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const headers = (rows[0] || []).map((h) => String(h ?? ''));
  const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  return { headers, rows: dataRows };
}

// 列名から取込先を自動推測する。戻り値: 列indexと同じ長さの配列(各要素はCOLUMN_TARGETSのkey)
export function guessColumnMapping(headers) {
  return headers.map((h) => {
    const norm = normalizeHeader(h);
    for (const rule of KEYWORD_RULES) {
      if (rule.words.some((w) => norm.includes(w))) return rule.key;
    }
    return 'none';
  });
}

export function titleFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host + ' の資料';
  } catch (e) {
    return '無題の資料';
  }
}

// mapping(列indexごとのCOLUMN_TARGETS key)に従って、行データを
// 薬剤(drugs)と、それに紐づく資料(resources、URL列がある場合のみ)の配列に変換する。
// 薬剤名の列が空の行は取り込まない。同じ行の複数のURL列はそれぞれ別の資料になる。
export function buildImportPlan(rows, mapping) {
  const colsFor = (target) => mapping.reduce((acc, t, i) => (t === target ? [...acc, i] : acc), []);
  const singleCol = (target) => colsFor(target)[0] ?? null;
  const cell = (row, idx) => (idx == null ? '' : String(row[idx] ?? '').trim());

  const nameCol = singleCol('name');
  const yjCol = singleCol('yj');
  const janCol = singleCol('jan');
  const gs1Col = singleCol('gs1');
  const categoryCol = singleCol('category');
  const makerCol = singleCol('maker');
  const memoCols = colsFor('memo');
  const patientUrlCols = colsFor('url_patient');
  const hcpUrlCols = colsFor('url_hcp');

  const drugs = [];
  const resources = [];

  rows.forEach((row, rowIdx) => {
    const name = cell(row, nameCol);
    if (!name) return;
    const tempId = `x${rowIdx}`;
    drugs.push({
      id: tempId,
      name,
      yj: cell(row, yjCol),
      jan: cell(row, janCol),
      gs1: cell(row, gs1Col),
      category: cell(row, categoryCol),
      maker: cell(row, makerCol),
    });

    const memo = memoCols
      .map((c) => cell(row, c))
      .filter(Boolean)
      .join(' / ');

    patientUrlCols.forEach((c) => {
      const url = cell(row, c);
      if (url) resources.push({ tempDrugId: tempId, type: 'web', url, audience: 'patient', memo });
    });
    hcpUrlCols.forEach((c) => {
      const url = cell(row, c);
      if (url) resources.push({ tempDrugId: tempId, type: 'web', url, audience: 'hcp', memo });
    });
  });

  return { drugs, resources };
}
