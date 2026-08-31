import {
  collection,
  doc,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  setDoc,
  arrayUnion,
  deleteField,
  query,
  orderBy,
  limit,
  getDocs,
  serverTimestamp,
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { db, storage } from './firebase.js';

export const MAX_RESOURCE_FILE_BYTES = 20 * 1024 * 1024; // 20MB

const drugsCol = collection(db, 'drugs');
const resourcesCol = collection(db, 'resources');
const sitesCol = collection(db, 'sites');
const metaDoc = doc(db, 'meta', 'paperFromHistory');

const REQUIRED_SITES = [
  { name: 'くすりのしおり', domain: 'rad-ar.or.jp', required: true },
  { name: 'PMDA 患者向医薬品ガイド', domain: 'pmda.go.jp', required: true },
];

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function toUpdatePayload(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v === undefined ? deleteField() : v;
  }
  return out;
}

/* ---------------- SUBSCRIPTIONS ---------------- */
export function subscribeDrugs(cb) {
  return onSnapshot(drugsCol, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function subscribeResources(cb) {
  return onSnapshot(resourcesCol, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

let seedingSites = false;
export function subscribeSites(cb) {
  return onSnapshot(sitesCol, async (snap) => {
    if (snap.empty && !seedingSites) {
      seedingSites = true;
      try {
        const batch = writeBatch(db);
        REQUIRED_SITES.forEach((s) => batch.set(doc(sitesCol), s));
        await batch.commit();
      } finally {
        seedingSites = false;
      }
      return; // onSnapshot will fire again once with the seeded docs
    }
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function subscribePaperFromHistory(cb) {
  return onSnapshot(metaDoc, (snap) => {
    cb(snap.exists() ? snap.data().values || [] : []);
  });
}

/* ---------------- RESOURCES ---------------- */
export async function addResource(fields) {
  const ref = await addDoc(resourcesCol, stripUndefined(fields));
  if (fields.type === 'paper' && fields.paperFrom) {
    await addPaperFromHistory(fields.paperFrom);
  }
  return ref.id;
}

export async function updateResource(id, fields) {
  await updateDoc(doc(resourcesCol, id), toUpdatePayload(fields));
  if (fields.type === 'paper' && fields.paperFrom) {
    await addPaperFromHistory(fields.paperFrom);
  }
}

export async function deleteResource(id, storagePath) {
  await deleteDoc(doc(resourcesCol, id));
  if (storagePath) await deleteResourceFile(storagePath);
}

/* ---------------- RESOURCE FILE UPLOAD (Cloud Storage) ---------------- */
// 資料のURLの代わりに、PDFファイル自体をアプリ内(Cloud Storage)に保存する。
// 外部サイトがPDFを強制ダウンロード設定にしていても、Storageのダウンロードリンクは
// ブラウザのPDFビューアでそのまま開ける。
export async function uploadResourceFile(drugId, file) {
  if (file.size > MAX_RESOURCE_FILE_BYTES) {
    throw new Error('FILE_TOO_LARGE');
  }
  const path = `resources/${drugId}/${Date.now()}_${file.name}`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, file, { contentType: file.type || 'application/pdf' });
  const url = await getDownloadURL(fileRef);
  return { url, storagePath: path };
}

export async function deleteResourceFile(storagePath) {
  if (!storagePath) return;
  try {
    await deleteObject(storageRef(storage, storagePath));
  } catch (e) {
    // 既に削除済みなどは無視する
  }
}

/* ---------------- PAPER-FROM HISTORY ---------------- */
export async function addPaperFromHistory(name) {
  if (!name) return;
  await setDoc(metaDoc, { values: arrayUnion(name) }, { merge: true });
}

export async function addPaperFromHistoryMany(names) {
  if (!names || names.length === 0) return;
  await setDoc(metaDoc, { values: arrayUnion(...names) }, { merge: true });
}

/* ---------------- BATCH ADD (drugs / resources / sites) ---------------- */
// Firestore batched writes are capped at 500 operations; chunk defensively.
async function batchAddAll(col, items) {
  const ids = [];
  for (let i = 0; i < items.length; i += 400) {
    const chunk = items.slice(i, i + 400);
    const batch = writeBatch(db);
    const refs = chunk.map((item) => {
      const ref = doc(col);
      batch.set(ref, stripUndefined(item));
      return ref;
    });
    await batch.commit();
    ids.push(...refs.map((r) => r.id));
  }
  return ids;
}

export function addDrugsBatch(drugList) {
  return batchAddAll(drugsCol, drugList);
}

export function addResourcesBatch(resourceList) {
  return batchAddAll(resourcesCol, resourceList);
}

export function addSitesBatch(siteList) {
  return batchAddAll(sitesCol, siteList);
}

/* ---------------- BATCH UPDATE / DELETE (採用医薬品リストの完全同期用) ---------------- */
async function batchDeleteAll(col, ids) {
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const batch = writeBatch(db);
    chunk.forEach((id) => batch.delete(doc(col, id)));
    await batch.commit();
  }
}

// update()ではなくset(..., {merge:true})を使う: 対象ドキュメントが何らかの理由で
// 既に存在しない場合でもエラーで処理全体が止まらず、内容を作り直して同期できる。
export function updateDrugsBatch(updates) {
  return (async () => {
    for (let i = 0; i < updates.length; i += 400) {
      const chunk = updates.slice(i, i + 400);
      const batch = writeBatch(db);
      chunk.forEach(({ id, fields }) => batch.set(doc(drugsCol, id), stripUndefined(fields), { merge: true }));
      await batch.commit();
    }
  })();
}

export function deleteDrugsBatch(ids) {
  return batchDeleteAll(drugsCol, ids);
}

export function deleteResourcesBatch(ids) {
  return batchDeleteAll(resourcesCol, ids);
}

export function updateResourcesBatch(updates) {
  return (async () => {
    for (let i = 0; i < updates.length; i += 400) {
      const chunk = updates.slice(i, i + 400);
      const batch = writeBatch(db);
      chunk.forEach(({ id, fields }) => batch.set(doc(resourcesCol, id), stripUndefined(fields), { merge: true }));
      await batch.commit();
    }
  })();
}
