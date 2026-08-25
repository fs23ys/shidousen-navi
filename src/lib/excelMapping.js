export const DRUG_FIELDS = [
  { key: 'name', label: '薬剤名', required: true },
  { key: 'jan', label: 'JANコード', required: false },
  { key: 'gs1', label: 'GS1コード', required: false },
  { key: 'yj', label: 'YJコード', required: false },
  { key: 'category', label: '分類(薬効分類など)', required: false },
  { key: 'maker', label: 'メーカー名', required: false },
];

const KEYWORD_MAP = {
  name: ['薬品名', '医薬品名', '品名', '製品名', '薬剤名', 'name'],
  jan: ['janコード', 'jan', 'janコ'],
  gs1: ['gs1コード', 'gs1'],
  yj: ['yjコード', 'yj', '個別医薬品コード'],
  category: ['薬効分類', '分類', '薬効', 'category'],
  maker: ['メーカー', '製造販売元', '製造元', '会社名', 'maker'],
};

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

// 列名から各フィールドへの対応を自動推測する。戻り値: { name: 列index|null, jan: ..., ... }
export function guessColumnMapping(headers) {
  const normalized = headers.map(normalizeHeader);
  const mapping = {};
  for (const field of DRUG_FIELDS) {
    const keywords = KEYWORD_MAP[field.key] || [];
    let foundIndex = null;
    for (const kw of keywords) {
      const idx = normalized.findIndex((h) => h.includes(kw));
      if (idx !== -1) {
        foundIndex = idx;
        break;
      }
    }
    mapping[field.key] = foundIndex;
  }
  return mapping;
}

// mapping ({fieldKey: columnIndex|null}) に従って行データを drugs オブジェクトの配列に変換する
export function rowsToDrugs(rows, mapping) {
  return rows
    .map((row) => {
      const obj = {};
      for (const field of DRUG_FIELDS) {
        const idx = mapping[field.key];
        obj[field.key] = idx == null || idx === -1 ? '' : String(row[idx] ?? '').trim();
      }
      return obj;
    })
    .filter((d) => d.name); // 薬剤名が空の行は取り込まない
}
