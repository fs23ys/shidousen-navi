import './style.css';
import { signInWithGoogle, signOut, watchAuth } from './firebase.js';
import {
  subscribeDrugs,
  subscribeResources,
  subscribeSites,
  subscribePaperFromHistory,
  addResource,
  updateResource,
  deleteResource,
  addDrugsBatch,
  addResourcesBatch,
  addSitesBatch,
  addPaperFromHistoryMany,
  uploadResourceFile,
  deleteResourceFile,
  MAX_RESOURCE_FILE_BYTES,
} from './store.js';
import { toSearchKey } from './lib/searchKey.js';
import { fetchSioriId, sioriDirectUrl } from './lib/siori.js';
import { buildSiteSearchUrl } from './lib/siteSearch.js';
import {
  planDrugMerge,
  planResourceMerge,
  planSiteMerge,
  planPaperFromHistoryMerge,
} from './lib/merge.js';
import { readExcelFile, guessColumnMapping, buildImportPlan, titleFromUrl, COLUMN_TARGETS } from './lib/excelMapping.js';
import { downloadJson, readJsonFile } from './lib/backup.js';

/* ---------------- STATE ---------------- */
let drugs = [];
let resources = [];
let sites = [];
let paperFromHistory = [];

let selectedDrugId = null;
let currentType = localStorage.getItem('shidousen.lastType') || 'web';
let currentAudience = localStorage.getItem('shidousen.lastAudience') || 'patient';
let audienceFilter = 'all';
let editingResourceId = null;

let unsubscribers = [];

const TYPE_META = {
  web: { label: 'WEB', color: 'var(--sage)', tint: 'var(--sage-tint)' },
  paper: { label: '紙', color: 'var(--clay)', tint: 'var(--clay-tint)' },
};
const AUDIENCE_META = {
  patient: { label: '患者さん向け', color: '#4F8D77', tint: '#DCF3E7' },
  hcp: { label: '医療関係者向け', color: '#B8942E', tint: '#FBF3D8' },
};

/* ---------------- AUTH ---------------- */
const lockScreen = document.getElementById('lockScreen');
const lockError = document.getElementById('lockError');
const googleSignInBtn = document.getElementById('googleSignInBtn');
const logoutBtn = document.getElementById('logoutBtn');

googleSignInBtn.addEventListener('click', async () => {
  lockError.classList.remove('show');
  googleSignInBtn.disabled = true;
  try {
    await signInWithGoogle();
  } catch (e) {
    lockError.classList.add('show');
  } finally {
    googleSignInBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', () => {
  signOut();
});

watchAuth((user) => {
  if (user) {
    lockScreen.classList.add('hidden');
    startSubscriptions();
  } else {
    lockScreen.classList.remove('hidden');
    stopSubscriptions();
  }
});

function startSubscriptions() {
  if (unsubscribers.length) return; // already subscribed
  unsubscribers.push(
    subscribeDrugs((list) => {
      drugs = list;
      document.getElementById('drugTotalCount').textContent = drugs.length + '件';
      document.getElementById('drugManageCount').textContent = ' ' + drugs.length;
      if (document.getElementById('suggestList').classList.contains('open')) renderSuggestions();
      if (selectedDrugId) renderSelection();
    }),
    subscribeResources((list) => {
      resources = list;
      if (selectedDrugId) renderResources();
      if (document.getElementById('suggestList').classList.contains('open')) renderSuggestions();
    }),
    subscribeSites((list) => {
      sites = list;
      if (selectedDrugId) renderSiteLinks();
    }),
    subscribePaperFromHistory((list) => {
      paperFromHistory = list;
      updatePaperFromDatalist();
    }),
  );
}

function stopSubscriptions() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  drugs = [];
  resources = [];
  sites = [];
  paperFromHistory = [];
  selectedDrugId = null;
  document.getElementById('resultZone').classList.remove('open');
  document.getElementById('emptyHero').style.display = 'block';
}

/* ---------------- SEARCH / AUTOCOMPLETE ---------------- */
const drugInput = document.getElementById('drugInput');
const suggestList = document.getElementById('suggestList');

drugInput.addEventListener('input', renderSuggestions);
drugInput.addEventListener('focus', renderSuggestions);
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-zone')) suggestList.classList.remove('open');
});

const jaCollator = new Intl.Collator('ja');

function renderSuggestions() {
  const qRaw = drugInput.value.trim();
  const q = toSearchKey(qRaw);
  const matches = drugs
    .filter((d) => (q === '' ? true : toSearchKey(d.name).includes(q) || toSearchKey(d.category).includes(q)))
    .sort((a, b) => jaCollator.compare(a.name, b.name));
  if (matches.length === 0) {
    suggestList.innerHTML = `<div class="suggest-empty">一致する採用薬が見つかりません</div>`;
  } else {
    suggestList.innerHTML = matches
      .slice(0, 8)
      .map((d) => {
        const cnt = resources.filter((r) => r.drugId === d.id).length;
        return `<div class="suggest-item" data-id="${d.id}">
          <div>
            <div class="suggest-name">${escapeHtml(d.name)}</div>
            <div class="suggest-meta">${escapeHtml(d.category || '')} · <span class="mono">YJ ${escapeHtml(d.yj || '')}</span></div>
          </div>
          <span class="suggest-count">資料${cnt}件</span>
        </div>`;
      })
      .join('');
  }
  suggestList.classList.add('open');
}

suggestList.addEventListener('click', (e) => {
  const item = e.target.closest('.suggest-item');
  if (item) selectDrug(item.dataset.id);
});

function selectDrug(id) {
  selectedDrugId = id;
  drugInput.value = '';
  suggestList.classList.remove('open');
  renderSelection();
}

function renderSelection() {
  const d = drugs.find((x) => x.id === selectedDrugId);
  if (!d) return;
  audienceFilter = 'all';
  document.querySelectorAll('#audienceFilter button').forEach((b) => b.classList.toggle('active', b.dataset.aud === 'all'));
  document.getElementById('emptyHero').style.display = 'none';
  document.getElementById('resultZone').classList.add('open');
  document.getElementById('selDrugName').textContent = d.name;
  document.getElementById('selDrugCode').textContent = d.category || '';
  document.getElementById('selDrugCodes').innerHTML = `
    <span class="code-item"><span class="k">YJ</span>${escapeHtml(d.yj || '')}</span>
  `;
  document.getElementById('modalDrugLabel').textContent = d.name + ' に資料を登録';
  renderResources();
  renderSiteLinks();
}

/* ---------------- RESOURCE LIST ---------------- */
const resListEl = document.getElementById('resList');

function renderResources() {
  let list = resources.filter((r) => r.drugId === selectedDrugId);
  if (audienceFilter !== 'all') list = list.filter((r) => r.audience === audienceFilter);
  document.getElementById('resCount').textContent = list.length;
  if (list.length === 0) {
    resListEl.innerHTML = `<div class="empty-panel">${
      audienceFilter === 'all'
        ? 'まだ資料が登録されていません。<br>右上の「＋ 資料を追加」から登録できます。'
        : '該当する対象の資料はまだありません。'
    }</div>`;
    return;
  }
  resListEl.innerHTML = list
    .map((r) => {
      const meta = TYPE_META[r.type];
      const aud = AUDIENCE_META[r.audience] || AUDIENCE_META.patient;
      let detail = '';
      let action = '';
      if (r.type === 'web') {
        action = `<a href="${escapeHtml(r.url || '#')}" target="_blank" rel="noopener">開く ↗</a>`;
        if (r.storagePath) {
          detail = `<div class="res-detail">📎 アプリ内に保存したPDF(外部サイトの状態に関わらず開けます)</div>`;
        }
      } else {
        detail = `<div class="res-detail"><span class="k">取り寄せ先</span>${escapeHtml(r.paperFrom || '')}</div>
                  <div class="res-detail"><span class="k">連絡方法</span>${escapeHtml(r.paperContact || '')}</div>`;
        action = `<button data-action="copy" data-text="${escapeHtml(r.paperContact || '')}">連絡先をコピー</button>`;
      }
      return `<div class="res-card" style="--tab-color:${meta.color};--tab-tint:${meta.tint}">
        <div class="res-top">
          <div class="res-title">${escapeHtml(r.title)}</div>
          <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;flex-shrink:0;">
            <span class="res-type-chip">${meta.label}</span>
            <span class="aud-chip" style="--aud-color:${aud.color};--aud-tint:${aud.tint}">${aud.label}</span>
          </div>
        </div>
        ${detail}
        ${r.memo ? `<div class="res-memo">💬 ${escapeHtml(r.memo)}</div>` : ''}
        <div class="res-actions">
          ${action}
          <button data-action="edit" data-id="${r.id}">編集</button>
          <button class="res-del" data-action="delete" data-id="${r.id}">削除</button>
        </div>
      </div>`;
    })
    .join('');
}

resListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'edit') openEditModal(btn.dataset.id);
  if (action === 'delete') {
    const target = resources.find((x) => x.id === btn.dataset.id);
    await deleteResource(btn.dataset.id, target?.storagePath);
    showToast('資料を削除しました');
  }
  if (action === 'copy') copyText(btn.dataset.text);
});

document.querySelectorAll('#audienceFilter button').forEach((b) => {
  b.addEventListener('click', () => {
    audienceFilter = b.dataset.aud;
    document.querySelectorAll('#audienceFilter button').forEach((x) => x.classList.toggle('active', x === b));
    renderResources();
  });
});

/* ---------------- SITE SEARCH LINKS ---------------- */
const siteListEl = document.getElementById('siteList');

function renderSiteLinks() {
  const d = drugs.find((x) => x.id === selectedDrugId);
  const visibleSites = sites.filter((s) => !s.makerOnly || s.makerOnly === d.maker);
  const hiddenCount = sites.length - visibleSites.length;
  document.getElementById('siteCount').textContent = visibleSites.length;
  if (visibleSites.length === 0) {
    siteListEl.innerHTML = `<div class="empty-panel">検索対象サイトが未登録です。</div>`;
    return;
  }
  siteListEl.innerHTML = visibleSites
    .map((s) => {
      const url = buildSiteSearchUrl(s.domain, d.name);
      const isSiori = s.domain === 'rad-ar.or.jp';
      return `<div class="site-card">
        <div class="site-info">
          <div class="site-name">${escapeHtml(s.name)}${s.required ? ' <span class="req-badge">必須</span>' : ''}</div>
        </div>
        <a class="site-go" id="${isSiori ? 'siteGoSiori' : ''}" href="${url}" target="_blank" rel="noopener">
          ${isSiori ? '<span id="siteGoSioriLabel">検索 ↗</span>' : '検索 ↗'}
        </a>
      </div>`;
    })
    .join('');
  if (hiddenCount > 0) {
    siteListEl.innerHTML += `<div class="hidden-note">他メーカー限定のサイトを${hiddenCount}件、この薬とは関係ないため非表示にしています</div>`;
  }

  // くすりのしおりだけ、ページ読み込み後に非同期でAPIを叩き、ピンポイントのURLに差し替える(非公式API・失敗時は無言でGoogle検索のまま)
  const sioriSite = visibleSites.find((s) => s.domain === 'rad-ar.or.jp');
  if (sioriSite) {
    const thisDrugId = selectedDrugId;
    const labelEl = document.getElementById('siteGoSioriLabel');
    if (labelEl) labelEl.textContent = '検索中…';
    fetchSioriId(d.name).then((id) => {
      if (selectedDrugId !== thisDrugId) return; // その間に別の薬に切り替わっていたら何もしない
      const linkEl = document.getElementById('siteGoSiori');
      const label = document.getElementById('siteGoSioriLabel');
      if (!linkEl) return;
      if (id) {
        linkEl.href = sioriDirectUrl(id);
        if (label) label.textContent = 'しおりを開く ↗';
      } else {
        if (label) label.textContent = '検索 ↗';
      }
    });
  }
}

/* ---------------- ADD / EDIT RESOURCE MODAL ---------------- */
const addModal = document.getElementById('addModal');
const fUrl = document.getElementById('fUrl');
const fFile = document.getElementById('fFile');
const fFileCurrent = document.getElementById('fFileCurrent');
const fTitle = document.getElementById('fTitle');
const fPaperFrom = document.getElementById('fPaperFrom');
const fPaperContact = document.getElementById('fPaperContact');
const fMemo = document.getElementById('fMemo');

document.getElementById('openAddModalBtn').addEventListener('click', openAddModal);
document.getElementById('cancelModalBtn').addEventListener('click', closeAddModal);
document.getElementById('saveResourceBtn').addEventListener('click', saveResource);
fUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveResource();
  }
});

document.querySelectorAll('#typeTabs .type-tab').forEach((b) => b.addEventListener('click', () => setType(b.dataset.type)));
document.querySelectorAll('#audienceTabs .type-tab').forEach((b) => b.addEventListener('click', () => setAudience(b.dataset.aud)));

function openAddModal() {
  if (!selectedDrugId) return;
  editingResourceId = null;
  document.getElementById('modalHeading').textContent = '資料を登録';
  document.getElementById('saveResourceBtn').textContent = '登録する';
  addModal.classList.add('open');
  setType(currentType); // 前回選んだ種類を維持
  setAudience(currentAudience); // 前回選んだ対象を維持
  [fTitle, fUrl, fPaperFrom, fPaperContact, fMemo].forEach((el) => (el.value = ''));
  fFile.value = '';
  fFileCurrent.textContent = '';
  setTimeout(() => {
    (currentType === 'web' ? fUrl : fPaperFrom).focus();
  }, 50);
}

function openEditModal(resourceId) {
  const r = resources.find((x) => x.id === resourceId);
  if (!r) return;
  editingResourceId = resourceId;
  document.getElementById('modalHeading').textContent = '資料を編集';
  document.getElementById('saveResourceBtn').textContent = '変更を保存';
  addModal.classList.add('open');
  setType(r.type);
  setAudience(r.audience || 'patient');
  fTitle.value = r.title || '';
  fUrl.value = r.url || '';
  fPaperFrom.value = r.paperFrom || '';
  fPaperContact.value = r.paperContact || '';
  fMemo.value = r.memo || '';
  fFile.value = '';
  fFileCurrent.textContent = r.storagePath ? '📎 現在アップロード済みのPDFがあります。新しいファイルを選ぶと置き換わります。' : '';
  setTimeout(() => fTitle.focus(), 50);
}

function closeAddModal() {
  addModal.classList.remove('open');
  editingResourceId = null;
}

function setAudience(aud) {
  currentAudience = aud;
  localStorage.setItem('shidousen.lastAudience', aud);
  document.querySelectorAll('#audienceTabs .type-tab').forEach((b) => b.classList.toggle('active', b.dataset.aud === aud));
}

function setType(type) {
  currentType = type;
  localStorage.setItem('shidousen.lastType', type);
  document.querySelectorAll('#typeTabs .type-tab').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  ['web', 'paper'].forEach((t) => {
    document.getElementById('typeFields-' + t).style.display = t === type ? 'block' : 'none';
  });
}

async function saveResource() {
  let title = fTitle.value.trim();
  let url = fUrl.value.trim();
  const file = fFile.files[0];
  const editingBefore = editingResourceId ? resources.find((x) => x.id === editingResourceId) : null;

  if (currentType === 'web' && !url && !file && !title) {
    showToast('URL・PDFファイル・タイトルのいずれかを入力してください');
    return;
  }
  if (currentType === 'paper' && !title) {
    showToast('資料タイトルを入力してください');
    return;
  }
  if (file && file.size > MAX_RESOURCE_FILE_BYTES) {
    showToast('ファイルが大きすぎます(20MBまで)');
    return;
  }

  const saveBtn = document.getElementById('saveResourceBtn');
  saveBtn.disabled = true;
  try {
    let storagePath;
    if (currentType === 'web' && file) {
      saveBtn.innerHTML = `<span class="spinner-inline"></span>アップロード中…`;
      const uploaded = await uploadResourceFile(selectedDrugId, file);
      url = uploaded.url;
      storagePath = uploaded.storagePath;
      if (editingBefore?.storagePath) await deleteResourceFile(editingBefore.storagePath);
    }

    if (!title) {
      if (currentType === 'web' && file) {
        title = file.name.replace(/\.[^.]+$/, '');
      } else if (currentType === 'web' && url) {
        title = titleFromUrl(url);
      } else {
        title = '無題の資料';
      }
    }

    const memo = fMemo.value.trim();
    const fields = { type: currentType, title, memo, audience: currentAudience };
    if (currentType === 'web') {
      fields.url = url;
      fields.paperFrom = undefined;
      fields.paperContact = undefined;
      if (storagePath) {
        fields.storagePath = storagePath;
      } else if (editingBefore?.storagePath && url !== editingBefore.url) {
        // アップロード済みファイルのURLから、手動で別のURLに書き換えられた場合は紐付けを解除する
        fields.storagePath = undefined;
        await deleteResourceFile(editingBefore.storagePath);
      }
    } else {
      fields.paperFrom = fPaperFrom.value.trim();
      fields.paperContact = fPaperContact.value.trim();
      fields.url = undefined;
      if (editingBefore?.storagePath) {
        fields.storagePath = undefined;
        await deleteResourceFile(editingBefore.storagePath);
      }
    }

    if (editingResourceId) {
      await updateResource(editingResourceId, fields);
      closeAddModal();
      showToast('資料を更新しました');
    } else {
      await addResource({ drugId: selectedDrugId, ...fields });
      closeAddModal();
      showToast('資料を登録しました');
    }
  } catch (e) {
    showToast(e?.message === 'FILE_TOO_LARGE' ? 'ファイルが大きすぎます(20MBまで)' : '保存に失敗しました。通信状況をご確認ください');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = editingResourceId ? '変更を保存' : '登録する';
  }
}

function updatePaperFromDatalist() {
  document.getElementById('paperFromHistory').innerHTML = paperFromHistory.map((v) => `<option value="${escapeHtml(v)}">`).join('');
}

/* ---------------- EXCEL IMPORT (採用医薬品リストの取込) ---------------- */
const excelFileInput = document.getElementById('excelFileInput');
const excelModal = document.getElementById('excelModal');
const excelMapBody = document.getElementById('excelMapBody');
const excelPreview = document.getElementById('excelPreview');
const excelSummary = document.getElementById('excelSummary');
let excelState = null; // { headers, rows, mapping }

excelFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { headers, rows } = await readExcelFile(file);
    if (rows.length === 0) {
      showToast('データ行が見つかりませんでした');
      return;
    }
    excelState = { headers, rows, mapping: guessColumnMapping(headers), fileName: file.name };
    document.getElementById('excelFileLabel').textContent = `${file.name}(${rows.length}行)`;
    excelSummary.textContent = '';
    renderExcelMapping();
    excelModal.classList.add('open');
  } catch (err) {
    showToast('Excelファイルの読み込みに失敗しました');
  }
});

function renderExcelMapping() {
  const { headers, mapping } = excelState;
  excelMapBody.innerHTML = headers
    .map((h, i) => {
      const options = COLUMN_TARGETS.map(
        (t) => `<option value="${t.key}" ${mapping[i] === t.key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`,
      ).join('');
      return `<tr>
        <td>${escapeHtml(h || '(無題の列' + (i + 1) + ')')}</td>
        <td><select data-col="${i}">${options}</select></td>
      </tr>`;
    })
    .join('');
  excelMapBody.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', () => {
      excelState.mapping[Number(sel.dataset.col)] = sel.value;
      renderExcelPreview();
    });
  });
  renderExcelPreview();
}

function renderExcelPreview() {
  const { rows, mapping } = excelState;
  const { drugs: sampleDrugs, resources: sampleResources } = buildImportPlan(rows.slice(0, 5), mapping);
  if (sampleDrugs.length === 0) {
    excelPreview.innerHTML = `<div style="padding:8px;">プレビューできる行がありません(薬剤名の列を選んでください)</div>`;
    return;
  }
  excelPreview.innerHTML = `<table>
    <thead><tr><th>薬剤名</th><th>YJコード</th><th>資料</th><th>メモ</th></tr></thead>
    <tbody>${sampleDrugs
      .map((d) => {
        const res = sampleResources.filter((r) => r.tempDrugId === d.id);
        const resSummary = res.length === 0 ? '—' : res.map((r) => (r.audience === 'patient' ? '患者向け' : '医療向け')).join(' / ');
        return `<tr><td>${escapeHtml(d.name)}</td><td>${escapeHtml(d.yj || '')}</td><td>${escapeHtml(resSummary)}</td><td>${escapeHtml(res[0]?.memo || '')}</td></tr>`;
      })
      .join('')}</tbody>
  </table>`;
}

document.getElementById('excelCancelBtn').addEventListener('click', () => {
  excelModal.classList.remove('open');
  excelState = null;
});

document.getElementById('excelImportBtn').addEventListener('click', async () => {
  if (!excelState || !excelState.mapping.includes('name')) {
    showToast('薬剤名の列を選んでください');
    return;
  }
  const importBtn = document.getElementById('excelImportBtn');
  importBtn.disabled = true;
  importBtn.innerHTML = `<span class="spinner-inline"></span>取り込み中…`;
  try {
    const { drugs: incomingDrugs, resources: incomingResources } = buildImportPlan(excelState.rows, excelState.mapping);

    const drugPlan = planDrugMerge(drugs, incomingDrugs);
    const newDrugIds = drugPlan.toAdd.length > 0 ? await addDrugsBatch(drugPlan.toAdd) : [];
    const drugIdMap = drugPlan.resolveIds(newDrugIds);

    // 資料側はドメインが同じでもtype・タイトル・URLが完全一致した場合のみ重複とみなす(4.8のマージ方式と共通)
    const seenKeys = new Set(resources.map((r) => `${r.drugId}|${r.type}|${r.title}|${r.url}`));
    const resourcesToAdd = [];
    incomingResources.forEach((r) => {
      const localDrugId = drugIdMap.get(r.tempDrugId);
      if (!localDrugId) return;
      const title = titleFromUrl(r.url);
      const key = `${localDrugId}|web|${title}|${r.url}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      resourcesToAdd.push({ drugId: localDrugId, type: 'web', url: r.url, audience: r.audience, memo: r.memo || '', title });
    });
    if (resourcesToAdd.length > 0) await addResourcesBatch(resourcesToAdd);

    excelModal.classList.remove('open');
    showToast(`Excelから薬剤+${drugPlan.toAdd.length}件、資料+${resourcesToAdd.length}件を取り込みました`);
    excelState = null;
  } catch (err) {
    showToast('取り込みに失敗しました。通信状況をご確認ください');
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = 'この内容で取り込む';
  }
});

/* ---------------- BACKUP: EXPORT / IMPORT ---------------- */
document.getElementById('exportDataBtn').addEventListener('click', () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    drugs,
    resources,
    sites,
    paperFromHistory,
  };
  downloadJson(payload, 'shidousen-navi-backup');
  showToast('バックアップファイルを書き出しました');
});

document.getElementById('importFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = await readJsonFile(file);
    if (!Array.isArray(data.drugs) || !Array.isArray(data.resources) || !Array.isArray(data.sites)) {
      showToast('ファイルの形式が正しくありません');
      return;
    }

    const drugPlan = planDrugMerge(drugs, data.drugs);
    const newDrugIds = drugPlan.toAdd.length > 0 ? await addDrugsBatch(drugPlan.toAdd) : [];
    const drugIdMap = drugPlan.resolveIds(newDrugIds);

    const resourcesToAdd = planResourceMerge(resources, data.resources, drugIdMap);
    if (resourcesToAdd.length > 0) await addResourcesBatch(resourcesToAdd);

    const sitesToAdd = planSiteMerge(sites, data.sites);
    if (sitesToAdd.length > 0) await addSitesBatch(sitesToAdd);

    const historyToAdd = planPaperFromHistoryMerge(paperFromHistory, data.paperFromHistory || []);
    if (historyToAdd.length > 0) await addPaperFromHistoryMany(historyToAdd);

    showToast(
      `取り込み完了:薬剤+${drugPlan.toAdd.length}件、資料+${resourcesToAdd.length}件、サイト+${sitesToAdd.length}件`,
    );
  } catch (err) {
    showToast('読み込みに失敗しました(JSONファイルを確認してください)');
  }
});

/* ---------------- UTIL ---------------- */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function copyText(t) {
  if (!t) {
    showToast('コピーする内容がありません');
    return;
  }
  navigator.clipboard
    ?.writeText(t)
    .then(() => showToast('コピーしました: ' + t))
    .catch(() => showToast(t));
}

let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

updatePaperFromDatalist();
