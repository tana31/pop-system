/**
 * スキャン画面の入口（index.html から読み込む唯一のスクリプト）
 * マスタの取得・解析・検索は Web Worker (master-worker.js) が担当し、
 * このファイルは画面操作だけを行う。Worker から届くのは変換済みの商品データ
 * （{ jan, name, maker, price, ... }、形は master-schema.js 参照）なので、ここでは列名を扱わない。
 *
 * 印刷待機リストの各項目はフォームで修正でき、修正内容は印刷キューに保存されてプレビュー・PDFに反映される。
 * 修正はこのリスト内だけのもので、商品マスタ（R2のCSV）は変更しない。
 *
 * 店舗番号はヘッダーで入力し、この端末に記憶する（localStorage の STORE_STORAGE_KEY）。
 * マスタWorker には検索のたびに店舗番号を渡し、その店舗の価格（例外価格が無ければ標準価格）を受け取る。
 *
 * マスタに無い商品や「じゃがりこ 各種」のような複数商品向けの POP は「手入力で追加」で作る（source: 'manual'）。
 * 手入力の行は JAN・税率も入力でき、JAN は空欄でもよい（空欄ならバーコードを印字しない）。
 * マスタから追加した行も「JANを印字しない」（item.noBarcode）にすれば、バーコード無しの POP にできる。
 */
import { SIZE_CONFIGS, DEFAULT_SIZE_KEY, createDefaultCounts } from '../shared/pop-sizes.js';
import { calcPriceIncl } from '../shared/price.js';
import { loadQueue, saveQueue as storeQueue, toCount } from '../shared/print-queue.js';
import { importProductCsv, decodeCsvFile, buildTemplateCsv } from './csv-import.js';
import { normalizeJan } from './master-schema.js';

const SIZE_LIST = Object.values(SIZE_CONFIGS);
const PRIMARY_SIZES = SIZE_LIST.filter(c => c.primary);
const OPTION_SIZES = SIZE_LIST.filter(c => !c.primary);

// 印刷待機リストで修正できる項目（span は 12分割グリッドでの幅）
// マスタ・CSV の行の JAN は同一商品の判定と「マスタの値に戻す」に使うため修正不可
const EDIT_FIELDS = [
  { key: 'name',      label: '商品名',     span: 6 },
  { key: 'maker',     label: 'メーカー',   span: 3 },
  { key: 'comment',   label: 'コメント',   span: 3 },
  { key: 'qty1',      label: '数量1',      span: 2 },
  { key: 'qty2',      label: '数量2',      span: 2 },
  { key: 'risk',      label: '医薬品区分', span: 2 },
  { key: 'priceExcl', label: '税抜価格',   span: 3, price: true },
  { key: 'price',     label: '税込価格',   span: 3, price: true }
];

// 手入力の行の項目（JAN と税率も入力できる。並びは 12分割で 3行に収まるようにしている）
const MANUAL_FIELDS = [
  { key: 'jan',       label: 'JAN（任意）', span: 3, placeholder: '空欄ならバーコードなし', numeric: true },
  { key: 'name',      label: '商品名',      span: 6, placeholder: '例: じゃがりこ 各種' },
  { key: 'maker',     label: 'メーカー',    span: 3 },
  { key: 'comment',   label: 'コメント',    span: 3 },
  { key: 'qty1',      label: '数量1',       span: 2 },
  { key: 'qty2',      label: '数量2',       span: 2 },
  { key: 'risk',      label: '医薬品区分',  span: 2 },
  { key: 'taxRate',   label: '税率',        span: 3 },
  { key: 'priceExcl', label: '税抜価格',    span: 3, price: true },
  { key: 'price',     label: '税込価格',    span: 3, price: true }
];

// 手入力の行の税率の選択肢。未選択のままなら税込価格は自動計算しない（手で入力する）
const TAX_RATE_OPTIONS = [
  { value: '',  label: '未選択' },
  { value: 8,   label: '8%（軽減）' },
  { value: 10,  label: '10%' }
];

// 店舗番号を記憶する localStorage のキー（印刷キューとは別に、この端末の設定として持つ）
const STORE_STORAGE_KEY = 'pop_store_code';

let popQueue = [];
let globalOptionsVisible = false;
let currentStore = loadStoreCode();

// ---- DOM要素 ----
const masterStatus = document.getElementById('masterStatus');
const storeInput = document.getElementById('storeInput');
const janInput = document.getElementById('janInput');
const searchNameInput = document.getElementById('searchNameInput');
const searchSuggestions = document.getElementById('searchSuggestions');
const queueListContainer = document.getElementById('queueListContainer');
const emptyQueueMessage = document.getElementById('emptyQueueMessage');
const queueCount = document.getElementById('queueCount');
const clearQueueBtn = document.getElementById('clearQueueBtn');
const toggleAllOptionsBtn = document.getElementById('toggleAllOptionsBtn');
const generatePopBtn = document.getElementById('generatePopBtn');
const scanNotice = document.getElementById('scanNotice');
const scanNoticeText = document.getElementById('scanNoticeText');
const scanNoticeSub = document.getElementById('scanNoticeSub');
const csvImportBtn = document.getElementById('csvImportBtn');
const csvTemplateBtn = document.getElementById('csvTemplateBtn');
const csvFileInput = document.getElementById('csvFileInput');
const csvResult = document.getElementById('csvResult');
const csvResultSummary = document.getElementById('csvResultSummary');
const csvResultList = document.getElementById('csvResultList');
const csvApplyBtn = document.getElementById('csvApplyBtn');
const csvCancelBtn = document.getElementById('csvCancelBtn');
const manualAddBtn = document.getElementById('manualAddBtn');
const scanNoticeAction = document.getElementById('scanNoticeAction');

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ============================================================
// 店舗番号（この端末に記憶する）
// ============================================================
function normalizeStoreInput(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s/g, '');
}

function loadStoreCode() {
  try {
    return normalizeStoreInput(localStorage.getItem(STORE_STORAGE_KEY));
  } catch {
    return '';
  }
}

function saveStoreCode(code) {
  try {
    if (code) localStorage.setItem(STORE_STORAGE_KEY, code);
    else localStorage.removeItem(STORE_STORAGE_KEY);
  } catch (err) {
    console.warn('[scan-app] 店舗番号を保存できませんでした', err);
  }
}

function renderStoreInput() {
  storeInput.value = currentStore;
  storeInput.classList.toggle('store-input--empty', !currentStore);
}

let repricing = false;

/** 店舗番号を切り替え、リストの未修正の商品をその店舗の価格に取り直す */
async function changeStore(rawValue) {
  const code = normalizeStoreInput(rawValue);
  if (code === currentStore || repricing) {
    renderStoreInput();
    return;
  }
  currentStore = code;
  saveStoreCode(code);
  renderStoreInput();

  // マスタが使えない間は取り直せない（lookup が終わらなくなるため）
  if (!inputsEnabled || popQueue.length === 0) return;

  repricing = true;
  storeInput.disabled = true;
  let kept = 0;
  try {
    for (const q of popQueue) {
      // 修正済みの行・CSV から読み込んだ行・手入力の行・JAN の無い行は、価格を取り直さない
      if (q.edited || q.source === 'csv' || q.source === 'manual' || !q.item.jan) { kept++; continue; }
      const fresh = await askMaster('lookup', { jan: q.item.jan, store: currentStore });
      if (fresh) q.item = fresh;
    }
  } finally {
    repricing = false;
    storeInput.disabled = false;
  }
  renderQueueList();
  const label = currentStore ? `店舗 ${currentStore}` : '標準価格';
  showScanNotice(`${label}の価格に切り替えました${kept ? `（修正済み・CSV・手入力の ${kept} 件はそのまま）` : ''}`, false, '');
}

// ============================================================
// マスタ Worker との通信
// ============================================================
const masterWorker = new Worker(new URL('./master-worker.js', import.meta.url), { type: 'module' });
let requestSeq = 0;
const pendingRequests = new Map();

function askMaster(type, payload = {}) {
  return new Promise((resolve) => {
    const id = ++requestSeq;
    pendingRequests.set(id, resolve);
    masterWorker.postMessage({ type, id, ...payload });
  });
}

masterWorker.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'result') {
    const resolve = pendingRequests.get(msg.id);
    if (resolve) {
      pendingRequests.delete(msg.id);
      resolve(msg.data);
    }
  } else if (msg.type === 'status') {
    handleMasterStatus(msg);
  }
};

masterWorker.onerror = (err) => {
  console.error(err);
  setStatus('error', '⚠️ マスタ処理でエラーが発生しました');
};

// Worker の state → [バッジの色, 表示文, 入力を有効にするか]
const STATUS_VIEW = {
  loading:  (m)     => ['loading', `<span class="spin">⏳</span> ${escapeHtml(m.message)}`, false],
  checking: (_, n)  => ['ready', `マスタ読込: ${n}件（最新を確認中…）`, true],
  synced:   (_, n)  => ['ready', `マスタ同期完了: ${n}件`, true],
  updated:  (_, n)  => ['ready', `マスタ更新済み: ${n}件`, true],
  offline:  (_, n)  => ['warn', `⚠️ サーバー接続不可・保存済みマスタ使用中: ${n}件`, true],
  error:    (m)     => ['error', `⚠️ ${escapeHtml(m.message)}`, false]
};

function setStatus(kind, html) {
  masterStatus.className = `status-badge status-badge--${kind}`;
  masterStatus.innerHTML = html;
}

function handleMasterStatus(msg) {
  const view = STATUS_VIEW[msg.state];
  if (!view) return;
  const [kind, html, enable] = view(msg, (msg.count || 0).toLocaleString());
  setStatus(kind, html);
  if (enable) enableInputs();
}

let inputsEnabled = false;
function enableInputs() {
  if (inputsEnabled) return;
  inputsEnabled = true;
  janInput.disabled = false;
  searchNameInput.disabled = false;
  csvImportBtn.disabled = false;
  // 商品名検索に入力中でなければスキャン欄にフォーカス
  if (document.activeElement !== searchNameInput) janInput.focus();
}

// ============================================================
// 印刷待機リストの保存・復元（ブラウザバック対策）
// ============================================================
function restoreQueue() {
  popQueue = loadQueue();
}

function saveQueue() {
  storeQueue(popQueue);
}

// bfcache から復元された場合も最新のリストを反映
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    restoreQueue();
    renderQueueList();
  }
});

// ============================================================
// イベントリスナー
// ============================================================
janInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();

  const jan = janInput.value.trim();
  janInput.value = '';          // 連続スキャンに備えて即クリア
  if (!jan) return;

  const item = await askMaster('lookup', { jan, store: currentStore });
  if (item) {
    addItemToQueue(item);
    showScanNotice(`「${item.name}」を追加しました`);
  } else {
    const code = normalizeJan(jan);
    showScanNotice(`JAN ${jan} はマスタに見つかりませんでした`, true, '', {
      label: '✏️ このJANで手入力のPOPを作る',
      run: () => addManualItem(code)
    });
  }
});

manualAddBtn.addEventListener('click', () => addManualItem());

{
  let searchTimer = null;
  let searchSeq = 0;

  searchNameInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const keyword = searchNameInput.value.trim();

    if (!keyword) {
      searchSeq++; // 実行中の検索結果を破棄
      searchSuggestions.classList.add('hidden');
      return;
    }

    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      const matches = await askMaster('search', { keyword, limit: 20, store: currentStore });
      if (seq !== searchSeq) return; // 古い検索結果は表示しない
      renderSuggestions(matches);
    }, 150);
  });
}

storeInput.addEventListener('change', () => changeStore(storeInput.value));

// 店舗番号欄で Enter → 確定してスキャン欄へ戻す
storeInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  storeInput.blur();        // change イベントが先に発生して店舗が切り替わる
  if (!janInput.disabled) janInput.focus();
});

toggleAllOptionsBtn.addEventListener('click', () => {
  globalOptionsVisible = !globalOptionsVisible;
  popQueue.forEach(q => q.showOptions = globalOptionsVisible);
  renderQueueList();
});

clearQueueBtn.addEventListener('click', () => {
  if (confirm('印刷リストをクリアしますか？')) {
    popQueue = [];
    renderQueueList();
  }
});

generatePopBtn.addEventListener('click', () => {
  if (popQueue.length === 0) {
    alert('印刷待機リストに商品がありません。');
    return;
  }
  saveQueue();
  window.location.href = 'preview.html';
});

// 枚数変更・商品情報の修正・削除・トグル（リスト全体で1つのリスナー）
queueListContainer.addEventListener('change', (e) => {
  const countInput = e.target.closest('.count-input');
  if (countInput) {
    const idx = Number(countInput.dataset.idx);
    popQueue[idx].counts[countInput.dataset.field] = toCount(countInput.value);
    saveQueue();
    return;
  }

  const itemInput = e.target.closest('.item-input');
  if (itemInput) {
    updateItemField(Number(itemInput.dataset.idx), itemInput.dataset.key, itemInput.value);
    return;
  }

  // 「JANを印字しない」
  const check = e.target.closest('.item-check');
  if (check) {
    const idx = Number(check.dataset.idx);
    const q = popQueue[idx];
    if (!q) return;
    q.item.noBarcode = check.checked;
    if (q.source !== 'manual') q.edited = true;
    saveQueue();
    refreshCardState(idx);
  }
});

// 修正欄で Enter → 確定してスキャン欄へ戻す（次のスキャンが修正欄に入力されるのを防ぐ）
queueListContainer.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.closest('.item-input, .count-input')) return;
  e.preventDefault();
  e.target.blur();          // change イベントが先に発生して内容が保存される
  if (!janInput.disabled) janInput.focus();
});

queueListContainer.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  switch (btn.dataset.action) {
    case 'toggle-opt':
      popQueue[idx].showOptions = !popQueue[idx].showOptions;
      break;
    case 'remove':
      popQueue.splice(idx, 1);
      break;
    case 'reset':
      if (!confirm('この商品の修正を取り消して、マスタの値に戻しますか？')) return;
      await resetItemToMaster(idx);
      break;
    default:
      return;
  }
  renderQueueList();
});

/** 修正欄の内容を印刷キューに反映（リスト全体は描き直さず、入力中のフォーカスを保つ） */
function updateItemField(idx, key, rawValue) {
  const q = popQueue[idx];
  if (!q) return;
  const item = q.item;
  const value = String(rawValue ?? '').trim();

  if (key === 'jan') {
    // 手入力の行だけ。空欄なら「JANを印字しない」も外す（印字するものが無いため）
    item.jan = normalizeJan(value);
    if (!item.jan) item.noBarcode = false;
  } else if (key === 'taxRate') {
    // 税率を選んだら、税抜から税込を計算し直す（未選択に戻した場合、税込はそのまま）
    item.taxRate = value === '' ? null : Number(value);
    const incl = calcPriceIncl(item.priceExcl, item.taxRate);
    if (incl !== null) item.price = incl;
  } else if (key === 'priceExcl') {
    // 税抜を直すと、その商品の税率で税込を計算し直す（税率が無ければ税込はそのまま）
    item.priceExcl = toPrice(value);
    const incl = calcPriceIncl(item.priceExcl, item.taxRate ?? null);
    if (incl !== null) item.price = incl;
  } else if (key === 'price') {
    item.price = toPrice(value);
  } else {
    item[key] = value;
  }

  // 手入力の行はマスタの値が無いので「修正済み」にしない
  if (q.source !== 'manual') q.edited = true;
  saveQueue();
  refreshCardState(idx);
}

/** 価格欄の値を 0 以上の整数に */
function toPrice(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

/** マスタから同じJANの商品を取り直して、修正を取り消す */
async function resetItemToMaster(idx) {
  const q = popQueue[idx];
  const fresh = await askMaster('lookup', { jan: q.item.jan, store: currentStore });
  if (!fresh) {
    showScanNotice(`JAN ${q.item.jan} はマスタに見つからないため、元に戻せませんでした`, true);
    return;
  }
  // CSV で指定したミックスマッチ・デザインは残す
  // （「JANを印字しない」は修正の一部なので取り消す）
  q.item = { ...fresh, mix: q.item.mix ?? null, themeId: q.item.themeId ?? '' };
  q.edited = false;
}

/** 修正後のカード表示（修正済みバッジ・JAN・価格欄）だけを更新 */
function refreshCardState(idx) {
  const card = queueListContainer.querySelector(`.queue-card[data-idx="${idx}"]`);
  if (!card) return;
  const q = popQueue[idx];
  card.className = cardClassName(q);

  const chip = card.querySelector('.jan-chip');
  if (chip) chip.outerHTML = janChipHtml(q.item);
  const check = card.querySelector('.item-check');
  if (check) check.checked = !!q.item.noBarcode;

  const janField = card.querySelector('.item-input[data-key="jan"]');
  if (janField) janField.value = q.item.jan;
  const exclInput = card.querySelector('.item-input[data-key="priceExcl"]');
  if (exclInput) exclInput.value = q.item.priceExcl;
  const priceInput = card.querySelector('.item-input[data-key="price"]');
  if (priceInput) {
    priceInput.value = q.item.price;
    const label = priceInput.parentElement.querySelector('.item-field__label');
    if (label) label.textContent = `税込価格${fieldNote({ key: 'price', price: true }, q.item)}`;
  }
}

// ============================================================
// 画面描画
// ============================================================
let noticeTimer = null;
let noticeAction = null;

/**
 * 通知を出す。action（{ label, run }）を渡すと通知にボタンを付ける（押せるよう長めに表示する）
 */
function showScanNotice(text, isError = false, sub = 'リスト先頭に追加しました', action = null) {
  scanNoticeText.textContent = text;
  scanNoticeSub.textContent = isError ? '' : sub;
  scanNotice.className = `notice ${isError ? 'notice--error' : 'notice--success'}`;

  noticeAction = action ? action.run : null;
  scanNoticeAction.textContent = action ? action.label : '';
  scanNoticeAction.classList.toggle('hidden', !action);

  clearTimeout(noticeTimer);
  const ms = action ? 8000 : (isError ? 4000 : 2500);
  noticeTimer = setTimeout(() => scanNotice.classList.add('hidden'), ms);
}

scanNoticeAction.addEventListener('click', () => {
  const run = noticeAction;
  clearTimeout(noticeTimer);
  scanNotice.classList.add('hidden');
  if (run) run();
});

function renderSuggestions(list) {
  if (!list || list.length === 0) {
    searchSuggestions.classList.add('hidden');
    return;
  }

  searchSuggestions.innerHTML = list.map((item, idx) => `
    <div data-idx="${idx}" class="suggestion-item">
      <div>
        <div class="suggestion-name">${escapeHtml(item.name)}</div>
        <div class="suggestion-meta">${escapeHtml(item.maker)} / JAN: ${escapeHtml(item.jan)}</div>
      </div>
      <div class="price-text">¥${item.price.toLocaleString()}</div>
    </div>
  `).join('');

  searchSuggestions.classList.remove('hidden');

  searchSuggestions.querySelectorAll('.suggestion-item').forEach((el) => {
    el.addEventListener('click', () => {
      addItemToQueue(list[Number(el.dataset.idx)]);
      searchSuggestions.classList.add('hidden');
      searchNameInput.value = '';
      janInput.focus();
    });
  });
}

function addItemToQueue(item) {
  // 同じ JAN の行があれば枚数を足す（手入力の行と「JANを印字しない」にした行は別物として扱う）
  const existingIdx = popQueue.findIndex(q => (
    q.source !== 'manual' && !q.item.noBarcode && q.item.jan === item.jan
  ));

  if (existingIdx >= 0) {
    const target = popQueue.splice(existingIdx, 1)[0];
    target.counts[DEFAULT_SIZE_KEY] += 1;
    popQueue.unshift(target);
  } else {
    popQueue.unshift({
      item,
      counts: createDefaultCounts(),
      showOptions: globalOptionsVisible
    });
  }

  renderQueueList();
}

/** 空の手入力の行をリストの先頭に追加し、商品名の欄にフォーカスする */
function addManualItem(jan = '') {
  popQueue.unshift({
    item: {
      jan,
      name: '',
      maker: '',
      priceExcl: 0,
      price: 0,
      taxRate: null,
      comment: '',
      qty1: '',
      qty2: '',
      risk: ''
    },
    counts: createDefaultCounts(),
    showOptions: globalOptionsVisible,
    source: 'manual'
  });
  renderQueueList();
  queueListContainer.querySelector('.queue-card[data-idx="0"] .item-input[data-key="name"]')?.focus();
  showScanNotice('手入力の行を追加しました', false, '商品名と価格を入力してください');
}

/** 修正欄の見出しの補足（税込価格には税率を示す） */
function fieldNote(f, item) {
  if (!f.price) return '';
  if (f.key !== 'price') return '（円）';
  const rate = item.taxRate ?? null;
  return rate === null ? '（円・税率なし）' : `（円・${rate}%）`;
}

/** 商品情報の修正欄 */
function itemFieldHtml(f, item, idx) {
  if (f.key === 'taxRate') return taxRateFieldHtml(f, item, idx);
  const value = item[f.key] ?? '';
  const inputAttrs = f.price
    ? `type="number" min="0" step="1" inputmode="numeric"`
    : `type="text"${f.numeric ? ' inputmode="numeric"' : ''}${f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : ''}`;
  return `
    <label class="item-field item-field--span${f.span}">
      <span class="item-field__label">${f.label}${escapeHtml(fieldNote(f, item))}</span>
      <input ${inputAttrs} class="item-input${f.price ? ' item-input--price' : ''}${f.key === 'price' ? ' item-input--incl' : ''}"
        data-idx="${idx}" data-key="${f.key}" value="${escapeHtml(value)}" autocomplete="off">
    </label>`;
}

/** 税率の選択欄（手入力の行だけ） */
function taxRateFieldHtml(f, item, idx) {
  const current = item.taxRate == null ? '' : String(item.taxRate);
  const options = TAX_RATE_OPTIONS.map(o => (
    `<option value="${o.value}"${String(o.value) === current ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
  )).join('');
  return `
    <label class="item-field item-field--span${f.span}">
      <span class="item-field__label">${f.label}</span>
      <select class="item-input item-input--select" data-idx="${idx}" data-key="taxRate">${options}</select>
    </label>`;
}

/** カードのクラス（修正済み・手入力・マスタに戻せない・JAN あり） */
function cardClassName(q) {
  const classes = ['queue-card'];
  if (q.edited) classes.push('is-edited');
  if (q.source === 'manual') classes.push('is-manual');
  if (q.source === 'manual' || !q.item.jan) classes.push('no-master');
  if (q.item.jan) classes.push('has-jan');
  return classes.join(' ');
}

/** カード見出しの JAN 表示 */
function janChipHtml(item) {
  if (!item.jan) return '<span class="jan-chip jan-chip--none">JANなし</span>';
  const off = item.noBarcode ? ' jan-chip--off' : '';
  return `<span class="jan-chip${off}">${escapeHtml(item.jan)}</span>`;
}

/** 主要サイズの枚数欄（常時表示） */
function primaryFieldHtml(conf, q, idx) {
  const highlight = conf.key === DEFAULT_SIZE_KEY ? ' count-input--main' : '';
  return `
    <div class="count-field">
      <label>${conf.label}</label>
      <input type="number" min="0" value="${q.counts[conf.key]}" data-idx="${idx}" data-field="${conf.key}" class="count-input${highlight}">
    </div>`;
}

/** オプションサイズの枚数欄（「⚙️ 他サイズ」内） */
function optionFieldHtml(conf, q, idx) {
  return `
    <div class="option-field">
      <span>${conf.label}:</span>
      <input type="number" min="0" value="${q.counts[conf.key]}" data-idx="${idx}" data-field="${conf.key}" class="count-input count-input--small">
    </div>`;
}

function renderQueueList() {
  saveQueue();
  queueCount.textContent = `${popQueue.length}件`;

  if (popQueue.length === 0) {
    queueListContainer.replaceChildren(emptyQueueMessage);
    return;
  }

  queueListContainer.innerHTML = popQueue.map((q, idx) => `
      <div class="${cardClassName(q)}" data-idx="${idx}">
        <div class="queue-card__head">
          <div class="queue-card__meta">
            ${janChipHtml(q.item)}
            <label class="nobarcode-toggle">
              <input type="checkbox" class="item-check" data-idx="${idx}"${q.item.noBarcode ? ' checked' : ''}>
              JANを印字しない
            </label>
            <span class="edited-badge">✏️ 修正済み</span>
            ${cardInfoChips(q)}
          </div>
          <div class="card-actions">
            <button type="button" data-action="reset" data-idx="${idx}" class="btn-reset">↺ マスタの値に戻す</button>
            <button type="button" data-action="toggle-opt" data-idx="${idx}" class="btn-chip">
              <span>⚙️ 他サイズ</span>
              <span class="btn-chip__arrow">${q.showOptions ? '▲' : '▼'}</span>
            </button>
            <button type="button" data-action="remove" data-idx="${idx}" class="btn-icon-danger" aria-label="この行を削除">🗑️</button>
          </div>
        </div>

        <div class="queue-card__body">
          <div class="item-form">
            ${(q.source === 'manual' ? MANUAL_FIELDS : EDIT_FIELDS).map(f => itemFieldHtml(f, q.item, idx)).join('')}
          </div>
          <div class="count-group">
            ${PRIMARY_SIZES.map(c => primaryFieldHtml(c, q, idx)).join('')}
          </div>
        </div>

        <div class="option-sizes${q.showOptions ? '' : ' hidden'}">
          <div class="option-sizes__title">【オプションサイズ指定】</div>
          <div class="option-sizes__fields">
            ${OPTION_SIZES.map(c => optionFieldHtml(c, q, idx)).join('')}
          </div>
        </div>
      </div>`).join('');
}

/** カード見出しの補足（手入力・CSV から読み込んだ行・ミックスマッチ・デザインID） */
function cardInfoChips(q) {
  const chips = [];
  if (q.source === 'manual') chips.push('✏️ 手入力');
  if (q.source === 'csv') chips.push('📄 CSV');
  const mix = q.item.mix;
  if (mix) chips.push(`${mix.qty}個 税抜${mix.priceExcl.toLocaleString()}円（税込${mix.price.toLocaleString()}円）`);
  if (q.item.themeId) chips.push(`デザイン: ${q.item.themeId}`);
  return chips.map(t => `<span class="info-chip">${escapeHtml(t)}</span>`).join('');
}

// ============================================================
// 商品リスト CSV の読み込み（読み込み結果を確認してから、リストを置き換える）
// ============================================================
const CSV_MESSAGE_LIMIT = 100;   // 画面に並べるエラー・注意の最大数
let pendingCsvEntries = null;

csvImportBtn.addEventListener('click', () => csvFileInput.click());

csvTemplateBtn.addEventListener('click', () => {
  const blob = new Blob([buildTemplateCsv()], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'POP商品リスト_テンプレート.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

csvFileInput.addEventListener('change', async () => {
  const file = csvFileInput.files[0];
  csvFileInput.value = '';   // 同じファイルをもう一度選べるように
  if (!file) return;

  csvImportBtn.disabled = true;
  try {
    const text = decodeCsvFile(await file.arrayBuffer());
    const result = await importProductCsv(text, {
      lookup: jan => askMaster('lookup', { jan, store: currentStore }),
      themeIds: await fetchThemeIds()
    });
    showCsvResult(file.name, result);
  } catch (err) {
    console.error(err);
    showScanNotice(`CSV を読み込めませんでした: ${err.message}`, true);
  } finally {
    csvImportBtn.disabled = false;
  }
});

/** 登録済みのデザインID（取得できなければ null ＝確認しない） */
async function fetchThemeIds() {
  try {
    const res = await fetch('/api/themes');
    if (!res.ok) return null;
    const list = await res.json();
    return Array.isArray(list) ? new Set(list.map(t => String(t.id))) : null;
  } catch {
    return null;
  }
}

function showCsvResult(fileName, result) {
  pendingCsvEntries = result.entries;
  const n = result.entries.length;
  const parts = [`「${fileName}」：読み込める商品 ${n}件`];
  if (result.janOnly) parts.push('（JAN のみ → 商品情報はマスタから取得）');
  if (result.errors.length) parts.push(`／エラー ${result.errors.length}件（その行は読み込みません）`);
  if (result.warnings.length) parts.push(`／注意 ${result.warnings.length}件`);
  if (n > 0 && popQueue.length > 0) parts.push(`。今のリスト（${popQueue.length}件）は消えて置き換わります。`);
  csvResultSummary.textContent = parts.join('');

  const messages = [
    ...result.errors.map(m => `❌ ${m.line}行目: ${m.message}`),
    ...result.warnings.map(m => `⚠️ ${m.line}行目: ${m.message}`)
  ];
  const shown = messages.slice(0, CSV_MESSAGE_LIMIT);
  if (messages.length > shown.length) shown.push(`ほか ${messages.length - shown.length}件`);
  csvResultList.innerHTML = shown.map(t => `<li>${escapeHtml(t)}</li>`).join('');

  csvApplyBtn.disabled = n === 0;
  csvResult.classList.remove('hidden');
}

function hideCsvResult() {
  pendingCsvEntries = null;
  csvResult.classList.add('hidden');
  csvResultList.innerHTML = '';
}

csvApplyBtn.addEventListener('click', () => {
  if (!pendingCsvEntries) return;
  popQueue = pendingCsvEntries;
  const n = popQueue.length;
  hideCsvResult();
  renderQueueList();
  showScanNotice(`CSV から ${n}件を読み込みました`, false, 'リストを置き換えました');
});

csvCancelBtn.addEventListener('click', hideCsvResult);

// ============================================================
// 初期化（type="module" は DOM 構築後に実行されるので DOMContentLoaded 不要）
// ============================================================
renderStoreInput();
restoreQueue();
renderQueueList();
masterWorker.postMessage({ type: 'init' });
