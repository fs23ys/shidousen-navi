// 列(Excel上の1列)ごとに、取込先を1つ選ぶ方式のマッピング。
// 実際の薬局のExcelでは、対象(患者さん向け/医療関係者向け/疾患向け)ごとに
// 「URL列」とその直後の「そのURLが何の資料かという資料タイトル列」がペアになっている。
// 同じ薬で同じ対象の資料が複数ある場合は、列を増やすのではなく行を増やして記入する運用のため、
// 各対象のURL列・タイトル列は1本ずつでよい(複数分は行の重複として現れ、薬剤側でマージされる)。
export const COLUMN_TARGETS = [
  { key: 'none', label: '(使わない)' },
  { key: 'name', label: '薬剤名' },
  { key: 'yj', label: 'YJコード' },
  { key: 'category', label: '分類(薬効分類など)' },
  { key: 'maker', label: 'メーカー名' },
  { key: 'url_patient', label: 'URL(患者さん向け資料)' },
  { key: 'title_patient', label: '資料タイトル(患者さん向けURL用)' },
  { key: 'url_hcp', label: 'URL(医療関係者向け資料)' },
  { key: 'title_hcp', label: '資料タイトル(医療関係者向けURL用)' },
  { key: 'url_disease', label: 'URL(疾患向け資料)' },
  { key: 'title_disease', label: '資料タイトル(疾患向けURL用)' },
  { key: 'url_paper', label: 'URL(紙資材取り寄せサイト)' },
  { key: 'memo', label: 'メモ' },
];

// 対象(audience)ごとの「URL列」→「タイトル列」の対応。
const AUDIENCE_URL_PAIRS = [
  { urlTarget: 'url_patient', titleTarget: 'title_patient', audience: 'patient' },
  { urlTarget: 'url_hcp', titleTarget: 'title_hcp', audience: 'hcp' },
  { urlTarget: 'url_disease', titleTarget: 'title_disease', audience: 'disease' },
];

// 上から順にチェックし、最初に一致したキーワードの取込先を採用する。
// 「資料タイトル」列は対象ごとの区別が名前だけでは付けにくいため自動判定せず、手動で選んでもらう。
const KEYWORD_RULES = [
  { key: 'name', words: ['薬剤名', '薬品名', '医薬品名', '品名', '製品名'] },
  { key: 'yj', words: ['yjコード', 'yj'] },
  { key: 'category', words: ['薬効分類', '分類', '薬効'] },
  { key: 'maker', words: ['メーカー', '製造販売元', '製造元', '会社名'] },
  { key: 'url_hcp', words: ['医療従事者', '医療関係者', '医療従事', 'hcp'] },
  { key: 'url_disease', words: ['疾患'] },
  { key: 'url_paper', words: ['取り寄せ', '資材取り寄せ'] },
  { key: 'url_patient', words: ['患者さん向け', '患者向け', '患者'] },
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
// 薬剤名の列が空の行は取り込まない。
// 同じ薬・同じ対象の資料が複数行にまたがっていても、薬剤側は名前/YJコードでマージされるため、
// それぞれの行の資料がすべて同じ薬に紐づいて登録される。
export function buildImportPlan(rows, mapping) {
  const findCol = (target) => {
    const i = mapping.indexOf(target);
    return i === -1 ? null : i;
  };
  const cell = (row, idx) => (idx == null ? '' : String(row[idx] ?? '').trim());

  const nameCol = findCol('name');
  const yjCol = findCol('yj');
  const categoryCol = findCol('category');
  const makerCol = findCol('maker');
  const memoCols = mapping.reduce((acc, t, i) => (t === 'memo' ? [...acc, i] : acc), []);
  const urlPairs = AUDIENCE_URL_PAIRS.map((p) => ({
    audience: p.audience,
    urlCol: findCol(p.urlTarget),
    titleCol: findCol(p.titleTarget),
  }));
  const paperCol = findCol('url_paper');

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
      category: cell(row, categoryCol),
      maker: cell(row, makerCol),
    });

    const rowMemo = memoCols
      .map((c) => cell(row, c))
      .filter(Boolean)
      .join(' / ');

    urlPairs.forEach(({ audience, urlCol, titleCol }) => {
      const url = cell(row, urlCol);
      if (!url) return;
      resources.push({ tempDrugId: tempId, type: 'web', url, audience, title: cell(row, titleCol), memo: rowMemo });
    });

    // 資材取り寄せサイト:紙資材(現物)の注文ページへのリンク。type='paper'として登録し、
    // 連絡方法(paperContact)にURLを入れることで、カード側で直接開けるボタンとして表示する。
    const paperUrl = cell(row, paperCol);
    if (paperUrl) {
      resources.push({
        tempDrugId: tempId,
        type: 'paper',
        paperFrom: '',
        paperContact: paperUrl,
        audience: 'patient',
        title: '',
        memo: rowMemo,
      });
    }
  });

  return { drugs, resources };
}
