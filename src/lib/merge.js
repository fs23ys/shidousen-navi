// バックアップJSON取込(4.8)およびExcel取込(4.7)で共有する「マージ方式」のロジック。
// 既存データを上書きせず、新規分だけを追加する。実際のFirestore書き込みは呼び出し側が行う。

// 薬剤:YJコードが一致すれば同一とみなす(なければ薬剤名で判定)。新規のみ追加対象にする。
// 戻り値: { toAdd: 新規追加する薬剤の配列, resolveId: (importedId) => 既存またはtoAdd内のローカルidを返す関数 }
export function planDrugMerge(existingDrugs, incomingDrugs) {
  const toAdd = [];
  const resolvedByImportedId = new Map(); // incoming id ->既存の薬のローカルid
  const addIndexByImportedId = new Map(); // incoming id -> toAdd配列内のindex(新規分のみ)
  const yjToAddIndex = new Map(); // 同じ取込バッチ内で、既にtoAdd登録予定になっているYJコード/薬剤名
  const nameToAddIndex = new Map();

  incomingDrugs.forEach((d) => {
    // YJコードがある場合はYJコードのみで判定する(名前へのフォールバックはしない)。
    // 過去の不具合等でYJコードと名前が別々の薬を指すよう壊れたドキュメントが残っていた場合、
    // 名前だけで一致してしまうと全く無関係な薬の資料が巻き込まれてしまうため。
    // YJコードが空の行(YJコード自体が存在しない薬)のときだけ名前で判定する。
    let existing = null;
    if (d.yj) {
      existing = existingDrugs.find((x) => x.yj && x.yj === d.yj);
    } else if (d.name) {
      existing = existingDrugs.find((x) => x.name === d.name);
    }
    if (existing) {
      resolvedByImportedId.set(d.id, existing.id);
      return;
    }

    // 同じ薬が複数行に分けて書かれている場合(例:同じ薬の資料を行を増やして記入)、
    // このバッチ内で既に追加予定になっている同じ薬があればそれと同じ扱いにする(二重登録を防ぐ)。
    // 既存マッチと同じ理由で、YJコードがある場合は名前へのフォールバックをしない。
    let pendingIndex = null;
    if (d.yj) {
      if (yjToAddIndex.has(d.yj)) pendingIndex = yjToAddIndex.get(d.yj);
    } else if (d.name && nameToAddIndex.has(d.name)) {
      pendingIndex = nameToAddIndex.get(d.name);
    }

    if (pendingIndex != null) {
      addIndexByImportedId.set(d.id, pendingIndex);
      return;
    }

    const idx = toAdd.length;
    toAdd.push(d);
    addIndexByImportedId.set(d.id, idx);
    if (d.yj) yjToAddIndex.set(d.yj, idx);
    if (d.name) nameToAddIndex.set(d.name, idx);
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

// 採用医薬品リストの完全同期(Excel再取込用)。
// マージ(追加のみ)とは異なり、最新の取込内容に薬剤一覧を合わせる:
// 新規は追加、既存と一致するもの(YJコード優先、なければ薬剤名)は内容を最新の値に更新、
// 取込内容に存在しない既存の薬は削除対象として返す(実際の削除は呼び出し側が確認の上で行う)。
export function planDrugSync(existingDrugs, incomingDrugs) {
  const toAdd = [];
  const toUpdate = []; // { id, fields }
  const resolvedByImportedId = new Map();
  const addIndexByImportedId = new Map();
  const yjToAddIndex = new Map();
  const nameToAddIndex = new Map();
  const matchedExistingIds = new Set();
  const updatedExistingIds = new Set();

  incomingDrugs.forEach((d) => {
    // YJコードがある場合はYJコードのみで判定する(名前へのフォールバックはしない)。
    // 過去の不具合等でYJコードと名前が別々の薬を指すよう壊れたドキュメントが残っていた場合、
    // 名前だけで一致してしまうと全く無関係な薬の資料が巻き込まれてしまうため。
    // YJコードが空の行(YJコード自体が存在しない薬)のときだけ名前で判定する。
    let existing = null;
    if (d.yj) {
      existing = existingDrugs.find((x) => x.yj && x.yj === d.yj);
    } else if (d.name) {
      existing = existingDrugs.find((x) => x.name === d.name);
    }
    if (existing) {
      resolvedByImportedId.set(d.id, existing.id);
      matchedExistingIds.add(existing.id);
      // 同じ薬が複数行にまたがる場合は、最初の行の内容を採用する(2行目以降は資料の追加行のことが多いため)
      if (!updatedExistingIds.has(existing.id)) {
        updatedExistingIds.add(existing.id);
        const { id, ...fields } = d;
        toUpdate.push({ id: existing.id, fields });
      }
      return;
    }

    // 既存マッチと同じ理由で、YJコードがある場合は名前へのフォールバックをしない。
    let pendingIndex = null;
    if (d.yj) {
      if (yjToAddIndex.has(d.yj)) pendingIndex = yjToAddIndex.get(d.yj);
    } else if (d.name && nameToAddIndex.has(d.name)) {
      pendingIndex = nameToAddIndex.get(d.name);
    }
    if (pendingIndex != null) {
      addIndexByImportedId.set(d.id, pendingIndex);
      return;
    }

    const idx = toAdd.length;
    toAdd.push(d);
    addIndexByImportedId.set(d.id, idx);
    if (d.yj) yjToAddIndex.set(d.yj, idx);
    if (d.name) nameToAddIndex.set(d.name, idx);
  });

  const toDelete = existingDrugs.filter((x) => !matchedExistingIds.has(x.id));

  return {
    toAdd,
    toUpdate,
    toDelete,
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
