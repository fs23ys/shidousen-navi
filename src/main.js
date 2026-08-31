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
  updateDrugsBatch,
  deleteDrugsBatch,
  deleteResourcesBatch,
  updateResourcesBatch,
} from './store.js';
import { toSearchKey } from './lib/searchKey.js';
import { fetchSioriId, sioriDirectUrl } from './lib/siori.js';
import { buildSiteSearchUrl } from './lib/siteSearch.js';
import {
  planDrugMerge,
  planDrugSync,
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
  hcp: { label: '医療関係者向け', color: '#E0A86E', tint: '#FBEBD8' },
  disease: { label: '疾患向け', color: '#D9B84F', tint: '#FBF3D8' },
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

/* ---------------- HAMBURGER MENU / DRAWER ---------------- */
const drawer = document.getElementById('drawer');
const drawerOverlay = document.getElementById('drawerOverlay');

function openDrawer() {
  drawer.classList.add('open');
  drawerOverlay.classList.add('open');
}
function closeDrawer() {
  drawer.classList.remove('open');
  drawerOverlay.classList.remove('open');
}
document.getElementById('menuBtn').addEventListener('click', openDrawer);
document.getElementById('drawerCloseBtn').addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', closeDrawer);

/* ---------------- FAVORITES MODAL(薬をまたいだお気に入り一覧) ---------------- */
const favoritesModal = document.getElementById('favoritesModal');
const favoritesList = document.getElementById('favoritesList');

function renderFavoritesModal() {
  const favs = resources.filter((r) => r.favorite);
  if (favs.length === 0) {
    favoritesList.innerHTML = `<div class="empty-panel">お気に入りに登録された資料はまだありません。資料カードの☆から登録できます。</div>`;
    return;
  }
  favoritesList.innerHTML = favs
    .map((r) => {
      const d = drugs.find((x) => x.id === r.drugId);
      const meta = TYPE_META[r.type];
      const icon = r.type === 'paper' ? '📦' : r.storagePath ? '📄' : '🌐';
      const openBtn =
        r.type === 'web'
          ? `<a href="${escapeHtml(r.url || '#')}" target="_blank" rel="noopener">開く ↗</a>`
          : /^https?:\/\//i.test(r.paperContact || '')
            ? `<a href="${escapeHtml(r.paperContact)}" target="_blank" rel="noopener">📦 取り寄せ ↗</a>`
            : '';
      return `<div class="res-card" style="--tab-color:${meta.color};--tab-tint:${meta.tint}">
        <div class="res-top">
          <span class="res-icon">${icon}</span>
          <div class="res-title">${escapeHtml(r.title)}
            <div style="font-size:11px; color:var(--ink-faint); font-weight:400; margin-top:2px;">${escapeHtml(d?.name || '(削除された薬剤)')}</div>
          </div>
        </div>
        <div class="res-actions">
          ${openBtn}
          ${d ? `<button data-action="goto" data-drug-id="${d.id}">この薬を開く</button>` : ''}
        </div>
      </div>`;
    })
    .join('');
}

function openFavoritesModal() {
  renderFavoritesModal();
  favoritesModal.classList.add('open');
}
function closeFavoritesModal() {
  favoritesModal.classList.remove('open');
}
document.getElementById('showFavoritesBtn').addEventListener('click', () => {
  closeDrawer();
  openFavoritesModal();
});
document.getElementById('favoritesCloseBtn').addEventListener('click', closeFavoritesModal);
favoritesModal.addEventListener('click', (e) => {
  if (e.target === favoritesModal) closeFavoritesModal();
});
favoritesList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action="goto"]');
  if (!btn) return;
  closeFavoritesModal();
  selectDrug(btn.dataset.drugId);
  drugInput.focus();
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
      renderSuggestions();
      if (selectedDrugId) renderSelection();
    }),
    subscribeResources((list) => {
      resources = list;
      if (selectedDrugId) renderResources();
      renderSuggestions();
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

// キーボードショートカット:「/」でどこからでも検索欄にフォーカス、検索欄でEscを押すとクリア
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-overlay.open')) return; // モーダル表示中は入力の邪魔をしない
  const activeTag = document.activeElement?.tagName;
  const isTyping = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT';

  if (e.key === '/' && !isTyping) {
    e.preventDefault();
    drugInput.focus();
  }
  if (e.key === 'Escape' && document.activeElement === drugInput) {
    drugInput.value = '';
    renderSuggestions();
    drugInput.blur();
  }
});

const jaCollator = new Intl.Collator('ja');

let recentDrugIds = JSON.parse(localStorage.getItem('shidousen.recentDrugIds') || '[]');
function pushRecentDrug(id) {
  recentDrugIds = [id, ...recentDrugIds.filter((x) => x !== id)].slice(0, 20);
  localStorage.setItem('shidousen.recentDrugIds', JSON.stringify(recentDrugIds));
}

// 検索結果リストは常時表示(左カラムに固定)。
// 入力が空なら、直近で選択した薬(最大10件)を新しい順に表示する。まだ履歴がなければ採用薬全件を五十音順で表示する。
function renderSuggestions() {
  const qRaw = drugInput.value.trim();
  const q = toSearchKey(qRaw);
  let matches;
  let sectionLabel = '';
  if (q === '') {
    const recent = recentDrugIds.map((id) => drugs.find((d) => d.id === id)).filter(Boolean).slice(0, 10);
    if (recent.length > 0) {
      matches = recent;
      sectionLabel = '最近選択した薬';
    } else {
      matches = drugs.slice().sort((a, b) => jaCollator.compare(a.name, b.name));
    }
  } else {
    matches = drugs
      .filter((d) => toSearchKey(d.name).includes(q) || toSearchKey(d.category).includes(q))
      .sort((a, b) => jaCollator.compare(a.name, b.name));
  }
  if (matches.length === 0) {
    suggestList.innerHTML = `<div class="suggest-empty">一致する採用薬が見つかりません</div>`;
  } else {
    const label = sectionLabel ? `<div class="suggest-section-label">${escapeHtml(sectionLabel)}</div>` : '';
    suggestList.innerHTML =
      label +
      matches
        .slice(0, 50)
        .map((d) => {
          const cnt = resources.filter((r) => r.drugId === d.id).length;
          return `<div class="suggest-item ${d.id === selectedDrugId ? 'active' : ''}" data-id="${d.id}">
            <div>
              <div class="suggest-name">${escapeHtml(d.name)}</div>
              <div class="suggest-meta">${escapeHtml(d.category || '')} · <span class="mono">YJ ${escapeHtml(d.yj || '')}</span></div>
            </div>
            <span class="suggest-count">資料${cnt}件</span>
          </div>`;
        })
        .join('');
  }
}

suggestList.addEventListener('click', (e) => {
  const item = e.target.closest('.suggest-item');
  if (item) selectDrug(item.dataset.id);
});

function selectDrug(id) {
  selectedDrugId = id;
  pushRecentDrug(id);
  renderSuggestions();
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

let favoriteOnly = false;

function renderResources() {
  let list = resources.filter((r) => r.drugId === selectedDrugId);
  if (audienceFilter !== 'all') list = list.filter((r) => r.audience === audienceFilter);
  if (favoriteOnly) list = list.filter((r) => r.favorite);
  document.getElementById('resCount').textContent = list.length;
  if (list.length === 0) {
    resListEl.innerHTML = `<div class="empty-panel">${
      favoriteOnly
        ? 'お気に入りに登録された資料はまだありません。'
        : audienceFilter === 'all'
          ? 'まだ資料が登録されていません。<br>右上の「＋ 資料を追加」から登録できます。'
          : '該当する対象の資料はまだありません。'
    }</div>`;
    return;
  }
  resListEl.innerHTML = list
    .map((r) => {
      const meta = TYPE_META[r.type];
      const aud = AUDIENCE_META[r.audience] || AUDIENCE_META.patient;
      const icon = r.type === 'paper' ? '📦' : r.storagePath ? '📄' : '🌐';
      let detail = '';
      let action = '';
      let printBtn = '';
      let previewBtn = '';
      if (r.type === 'web') {
        action = `<a href="${escapeHtml(r.url || '#')}" target="_blank" rel="noopener">開く ↗</a>`;
        printBtn = `<button data-action="print" data-url="${escapeHtml(r.url || '')}">🖨️ 印刷</button>`;
        previewBtn = `<button data-action="preview" data-url="${escapeHtml(r.url || '')}">🔍 拡大</button>`;
        if (r.storagePath) {
          detail = `<div class="res-detail">📎 アプリ内に保存したPDF(外部サイトの状態に関わらず開けます)</div>`;
        }
      } else {
        const contactIsUrl = /^https?:\/\//i.test(r.paperContact || '');
        detail =
          `${r.paperFrom ? `<div class="res-detail"><span class="k">取り寄せ先</span>${escapeHtml(r.paperFrom)}</div>` : ''}` +
          (contactIsUrl ? '' : `<div class="res-detail"><span class="k">連絡方法</span>${escapeHtml(r.paperContact || '')}</div>`);
        action = contactIsUrl
          ? `<a href="${escapeHtml(r.paperContact)}" target="_blank" rel="noopener">📦 紙資材を取り寄せ ↗</a>`
          : `<button data-action="copy" data-text="${escapeHtml(r.paperContact || '')}">連絡先をコピー</button>`;
      }
      return `<div class="res-card" style="--tab-color:${meta.color};--tab-tint:${meta.tint}">
        <div class="res-top">
          <span class="res-icon">${icon}</span>
          <div class="res-title">${escapeHtml(r.title)}</div>
          <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;flex-shrink:0;">
            <button class="fav-btn ${r.favorite ? 'is-fav' : ''}" data-action="favorite" data-id="${r.id}" title="お気に入り">${r.favorite ? '★' : '☆'}</button>
            <span class="res-type-chip">${meta.label}</span>
            <span class="aud-chip" style="--aud-color:${aud.color};--aud-tint:${aud.tint}">${aud.label}</span>
          </div>
        </div>
        ${detail}
        ${r.memo ? `<div class="res-memo">💬 ${escapeHtml(r.memo)}</div>` : ''}
        <div class="res-actions">
          ${action}
          ${printBtn}
          ${previewBtn}
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
  if (action === 'print') printResourceUrl(btn.dataset.url);
  if (action === 'preview') openPreview(btn.dataset.url);
  if (action === 'favorite') {
    const target = resources.find((x) => x.id === btn.dataset.id);
    await updateResource(btn.dataset.id, { favorite: !target?.favorite });
  }
});

document.getElementById('favOnlyBtn').addEventListener('click', (e) => {
  favoriteOnly = !favoriteOnly;
  e.currentTarget.classList.toggle('active', favoriteOnly);
  e.currentTarget.textContent = favoriteOnly ? '★ お気に入りのみ' : '☆ お気に入りのみ';
  renderResources();
});

/* ---------------- PRINT / PREVIEW ---------------- */
function printResourceUrl(url) {
  if (!url) return;
  const win = window.open(url, '_blank');
  if (!win) {
    showToast('ポップアップがブロックされました。ブラウザの設定をご確認ください');
    return;
  }
  let printed = false;
  const tryPrint = () => {
    if (printed) return;
    printed = true;
    try {
      win.focus();
      win.print();
    } catch (e) {
      // クロスオリジンの制約等で失敗した場合は何もしない(タブは開いたままなので手動で印刷できる)
    }
  };
  win.addEventListener('load', tryPrint);
  setTimeout(tryPrint, 1500); // loadイベントが発火しないPDFビューア等へのフォールバック
}

const previewModal = document.getElementById('previewModal');
const previewFrame = document.getElementById('previewFrame');
function openPreview(url) {
  if (!url) return;
  previewFrame.src = url;
  previewModal.classList.add('open');
}
function closePreview() {
  previewModal.classList.remove('open');
  previewFrame.src = 'about:blank';
}
document.getElementById('previewCloseBtn').addEventListener('click', closePreview);
previewModal.addEventListener('click', (e) => {
  if (e.target === previewModal) closePreview();
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
          <div class="site-name">${escapeHtml(s.name)}</div>
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
  const AUD_LABEL = { patient: '患者向け', hcp: '医療向け', disease: '疾患向け' };
  excelPreview.innerHTML = `<table>
    <thead><tr><th>薬剤名</th><th>YJコード</th><th>資料(対象:タイトル)</th></tr></thead>
    <tbody>${sampleDrugs
      .map((d) => {
        const res = sampleResources.filter((r) => r.tempDrugId === d.id);
        const resSummary =
          res.length === 0
            ? '—'
            : res
                .map((r) =>
                  r.type === 'paper'
                    ? `紙資材取り寄せ:${escapeHtml(r.title || '(無題)')}`
                    : `${AUD_LABEL[r.audience] || r.audience}:${escapeHtml(r.title || '(無題)')}`,
                )
                .join('<br>');
        return `<tr><td>${escapeHtml(d.name)}</td><td>${escapeHtml(d.yj || '')}</td><td>${resSummary}</td></tr>`;
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
  const { drugs: incomingDrugs, resources: incomingResources } = buildImportPlan(excelState.rows, excelState.mapping);

  // 採用医薬品リストは「完全同期」:最新の取込内容に薬剤一覧を合わせる。
  // 取込内容にない既存の薬は削除し、その薬に紐づく登録済み資料も一緒に削除する。
  const drugPlan = planDrugSync(drugs, incomingDrugs);
  const drugsToDeleteResourceCount = drugPlan.toDelete.reduce(
    (sum, d) => sum + resources.filter((r) => r.drugId === d.id).length,
    0,
  );

  const confirmMsg =
    `薬剤: 追加${drugPlan.toAdd.length}件・更新${drugPlan.toUpdate.length}件・削除${drugPlan.toDelete.length}件\n` +
    (drugPlan.toDelete.length > 0 ? `(削除される薬剤に紐づく資料も${drugsToDeleteResourceCount}件削除されます)\n` : '') +
    `この内容で採用医薬品リストを更新しますか?`;
  if (!window.confirm(confirmMsg)) return;

  const importBtn = document.getElementById('excelImportBtn');
  importBtn.disabled = true;
  importBtn.innerHTML = `<span class="spinner-inline"></span>取り込み中…`;
  try {
    const newDrugIds = drugPlan.toAdd.length > 0 ? await addDrugsBatch(drugPlan.toAdd) : [];
    if (drugPlan.toUpdate.length > 0) await updateDrugsBatch(drugPlan.toUpdate);
    const drugIdMap = drugPlan.resolveIds(newDrugIds);

    // 削除される薬に紐づく資料と、アップロード済みPDFファイルを削除する
    const deleteDrugIds = drugPlan.toDelete.map((d) => d.id);
    if (deleteDrugIds.length > 0) {
      const resourcesToDelete = resources.filter((r) => deleteDrugIds.includes(r.drugId));
      await Promise.all(resourcesToDelete.filter((r) => r.storagePath).map((r) => deleteResourceFile(r.storagePath)));
      if (resourcesToDelete.length > 0) await deleteResourcesBatch(resourcesToDelete.map((r) => r.id));
      await deleteDrugsBatch(deleteDrugIds);
      if (deleteDrugIds.includes(selectedDrugId)) {
        selectedDrugId = null;
        document.getElementById('resultZone').classList.remove('open');
        document.getElementById('emptyHero').style.display = 'block';
      }
    }

    // 資料側(Excelの資料列から来たもの)は、type・URL(紙の場合は連絡方法)が一致すれば「同じ資料」とみなす。
    // 一致した場合、タイトル/メモがExcel側と違えば最新の内容(D/F/H列など)に更新する。
    // これにより、旧仕様の取込で自動生成タイトルのままになっている資料も、再取込するだけで直る。
    const existingByKey = new Map(
      resources.map((r) => [`${r.drugId}|${r.type}|${r.type === 'paper' ? r.paperContact : r.url}`, r]),
    );
    const seenKeys = new Set();
    const resourcesToAdd = [];
    const resourcesToUpdate = [];
    incomingResources.forEach((r) => {
      const localDrugId = drugIdMap.get(r.tempDrugId);
      if (!localDrugId) return;
      const isPaper = r.type === 'paper';
      const title = (r.title && r.title.trim()) || (isPaper ? '紙資材の取り寄せ' : titleFromUrl(r.url));
      const memo = r.memo || '';
      const key = `${localDrugId}|${r.type}|${isPaper ? r.paperContact : r.url}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      const existing = existingByKey.get(key);
      if (existing) {
        if (existing.title !== title || (existing.memo || '') !== memo) {
          resourcesToUpdate.push({ id: existing.id, fields: { title, memo } });
        }
        return;
      }
      resourcesToAdd.push(
        isPaper
          ? { drugId: localDrugId, type: 'paper', paperFrom: r.paperFrom || '', paperContact: r.paperContact, audience: r.audience, memo, title }
          : { drugId: localDrugId, type: 'web', url: r.url, audience: r.audience, memo, title },
      );
    });
    if (resourcesToAdd.length > 0) await addResourcesBatch(resourcesToAdd);
    if (resourcesToUpdate.length > 0) await updateResourcesBatch(resourcesToUpdate);

    excelModal.classList.remove('open');
    showToast(
      `採用医薬品リストを更新しました:追加${drugPlan.toAdd.length}件・更新${drugPlan.toUpdate.length}件・削除${drugPlan.toDelete.length}件、資料+${resourcesToAdd.length}件・資料タイトル更新${resourcesToUpdate.length}件`,
    );
    excelState = null;
  } catch (err) {
    console.error('Excel取込エラー:', err);
    showToast(`取り込みに失敗しました: ${err && err.message ? err.message : err}`);
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
