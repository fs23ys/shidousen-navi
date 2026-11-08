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
    // d.id は取込時の一時的な行番号ベースのidであり、Firestoreの実ドキュメントIDではない。
    // そのままFirestoreに書き込むと"id"という名前のフィールドとしてデータに残ってしまい、
    // 読み込み時に本物のドキュメントIDを上書きしてしまう不具合の原因になるため、必ず取り除く。
    const { id: _tempId, ...cleanDrug } = d;
    toAdd.push(cleanDrug);
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
// 取込内容に存在しない既存の薬は「アーカイブ」対象として返す(実際に削除はせず、一覧から
// 隠すだけにする。資料・アップロード済みPDFも保持したままにし、完全な削除は別途、利用者が
// アーカイブ一覧から手動で行う)。既にアーカイブ済みの薬は、今回も一致しなければそのまま
// 変更なし(再度アーカイブ対象として扱い直さない)。一致した場合は自動的にアーカイブを解除する。
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
        // 以前アーカイブ済み(店舗在庫なし等で前回の取込で一覧から隠されていた)薬が
        // 今回のExcelに再び現れた場合は、再採用とみなしてアーカイブを解除する。
        // 注意: 薬の更新にはupdateDrugsBatch(merge:true のset+stripUndefined)を使っており、
        // undefinedを指定してもFirestore上の既存フィールドは消えない(deleteField()とは違う)。
        // そのため「解除」は値をfalseにして明示的に上書きする必要がある。
        fields.archived = false;
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
    // d.id は取込時の一時的な行番号ベースのidであり、Firestoreの実ドキュメントIDではない。
    // そのままFirestoreに書き込むと"id"という名前のフィールドとしてデータに残ってしまい、
    // 読み込み時に本物のドキュメントIDを上書きしてしまう不具合の原因になるため、必ず取り除く。
    const { id: _tempId, ...cleanDrug } = d;
    toAdd.push(cleanDrug);
    addIndexByImportedId.set(d.id, idx);
    if (d.yj) yjToAddIndex.set(d.yj, idx);
    if (d.name) nameToAddIndex.set(d.name, idx);
  });

  // 一致しなかった既存の薬のうち、まだアーカイブされていないものだけを今回新たに
  // アーカイブする(既にアーカイブ済みの薬は、変更せずそのままにしておく)。
  const toArchive = existingDrugs.filter((x) => !matchedExistingIds.has(x.id) && !x.archived);

  return {
    toAdd,
    toUpdate,
    toArchive,
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
