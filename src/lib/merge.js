// バックアップJSON取込(4.8)およびExcel取込(4.7)で共有する「マージ方式」のロジック。
// 既存データを上書きせず、新規分だけを追加する。実際のFirestore書き込みは呼び出し側が行う。

// 薬剤:YJコードが一致すれば同一とみなす(なければ薬剤名で判定)。新規のみ追加対象にする。
// 戻り値: { toAdd: 新規追加する薬剤の配列, resolveId: (importedId) => 既存またはtoAdd内のローカルidを返す関数 }
export function planDrugMerge(existingDrugs, incomingDrugs) {
  const toAdd = [];
  const resolvedByImportedId = new Map(); // incoming id -> existing local id (新規分はnull仮置き)
  const addIndexByImportedId = new Map(); // incoming id -> toAdd配列内のindex(新規分のみ)

  incomingDrugs.forEach((d) => {
    let existing = null;
    if (d.yj) existing = existingDrugs.find((x) => x.yj && x.yj === d.yj);
    if (!existing && d.name) existing = existingDrugs.find((x) => x.name === d.name);
    if (existing) {
      resolvedByImportedId.set(d.id, existing.id);
    } else {
      addIndexByImportedId.set(d.id, toAdd.length);
      toAdd.push(d);
    }
  });

  return {
    toAdd,
    // newIds は toAdd と同じ順序で、Firestore書き込み後に払い出された実IDの配列
    resolveIds(newIds) {
      const map = new Map(resolvedByImportedId);
      addIndexByImportedId.forEach((idx, importedId) => {
        map.set(importedId, newIds[idx]);
      });
      return map;
    },
  };
}

// 資料:同じ薬・同じ種類・同じタイトル・同じURL(またはtype='paper'なら取り寄せ先)なら重複とみなしスキップ。
export function planResourceMerge(existingResources, incomingResources, drugIdMap) {
  const toAdd = [];
  incomingResources.forEach((r) => {
    const localDrugId = drugIdMap.get(r.drugId);
    if (!localDrugId) return; // 対応する薬が見つからない場合はスキップ
    const isDup = existingResources.some(
      (x) =>
        x.drugId === localDrugId &&
        x.type === r.type &&
        x.title === r.title &&
        (r.type === 'web' ? x.url === r.url : x.paperFrom === r.paperFrom),
    );
    if (isDup) return;
    const { id, ...rest } = r;
    toAdd.push({ ...rest, drugId: localDrugId });
  });
  return toAdd;
}

// サイト:ドメインが一致すれば重複とみなしスキップ。新規ドメインのみ追加。
export function planSiteMerge(existingSites, incomingSites) {
  const toAdd = [];
  incomingSites.forEach((s) => {
    const existing = existingSites.find((x) => x.domain === s.domain);
    if (existing) return;
    const { id, ...rest } = s;
    toAdd.push(rest);
  });
  return toAdd;
}

// 取り寄せ先履歴:重複しないものだけ追加
export function planPaperFromHistoryMerge(existingHistory, incomingHistory) {
  if (!Array.isArray(incomingHistory)) return [];
  return incomingHistory.filter((name) => name && !existingHistory.includes(name));
}
