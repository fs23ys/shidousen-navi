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
} from 'firebase/firestore';
import { db } from './firebase.js';

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

export async function deleteResource(id) {
  await deleteDoc(doc(resourcesCol, id));
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
