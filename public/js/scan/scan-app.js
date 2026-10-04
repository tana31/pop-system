/**
 * スキャン画面の入口（index.html から読み込む唯一のスクリプト）
 * マスタの取得・解析・検索は Web Worker (master-worker.js) が担当し、
 * このファイルは画面操作だけを行う。Worker から届くのは変換済みの商品データ
 * （{ jan, name, maker, price, ... }、形は master-schema.js 参照）なので、ここでは列名を扱わない。
 *
 * 印刷待機リストは1商品2行の表で、各項目はその場で修正でき、修正内容は印刷キューに保存されてプレビュー・PDFに反映される。
 * 修正はこのリスト内だけのもので、商品マスタ（R2のCSV）は変更しない。
 *
 * 店舗番号はヘッダーで入力し、この端末に記憶する（localStorage の STORE_STORAGE_KEY）。
 * マスタWorker には検索のたびに店舗番号を渡し、その店舗の価格（例外価格が無ければ標準価格）を受け取る。
 *
 * マスタに無い商品や「〇〇 各種」のような複数商品向けの POP は「手入力で追加」で作る（source: 'manual'）。
 * 手入力の行は JAN・税率も入力でき、JAN は空欄でもよい（空欄ならバーコードを印字しない）。
 * マスタから追加した行も「JANを印字しない」（item.noBarcode）にすれば、バーコード無しの POP にできる。
 *
 * 画面右上のメニュー（ハンバーガー）に、マスタの同期状態と CSV テンプレートをまとめている。
 * 通知は画面左下に重ねて出す（リストの位置を動かさないため）。
 */
import { SIZE_CONFIGS, DEFAULT_SIZE_KEY, createDefaultCounts } from '../shared/pop-sizes.js';
import { calcPriceIncl } from '../shared/price.js';
import { loadQueue, saveQueue as storeQueue, toCount } from '../shared/print-queue.js';
import { importProductCsv, decodeCsvFile, buildTemplateCsv } from './csv-import.js';
import { normalizeJan } from './master-schema.js';

const SIZE_LIST = Object.values(SIZE_CONFIGS);

// 印刷待機リストは「1商品＝2行」の表。列の並び（左から）:
//   状態アイコン ／ 商品名・JAN・メーカー・コメント ／ 数量1・2 ／ 区分・税率 ／ 税抜・税込
//   ／ ミックスマッチ（ある行が1つでもあるときだけ）／ サイズ別の枚数 ／ 操作
// マスタ・CSV の行の JAN は同一商品の判定と「マスタの値に戻す」に使うため修正不可（手入力の行だけ入力欄にする）
//
// サイズ別の枚数列は、主要サイズ（pop-sizes.js の primary）を常に出し、それ以外は
// 「どれかの行で 1枚以上」か「見出しの ＋ で開いた」ときだけ出す（列ごと全行まとめて出し入れする）。

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
const menuBtn = document.getElementById('menuBtn');
const appMenu = document.getElementById('appMenu');
const menuDot = document.getElementById('menuDot');
const queueTotal = document.getElementById('queueTotal');
const storeInput = document.getElementById('storeInput');
const janInput = document.getElementById('janInput');
const searchNameInput = document.getElementById('searchNameInput');
const searchSuggestions = document.getElementById('searchSuggestions');
const queueListContainer = document.getElementById('queueListContainer');
const emptyQueueMessage = document.getElementById('emptyQueueMessage');
const queueCount = document.getElementById('queueCount');
const clearQueueBtn = document.getElementById('clearQueueBtn');
// 枚数列の出し入れは表の見出しの ＋／− で行う。このボタンは無くてもよい（置けば同じ動きをする）
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
  setStatus('error', 'マスタ処理でエラーが発生しました');
};

// Worker の state → [状態の種類, 表示文, 入力を有効にするか]
// 状態の種類は loading / ready / warn / error の4つ（メニュー内の表示とメニューボタンの点に使う）
const STATUS_VIEW = {
  loading:  (m)     => ['loading', m.message || 'マスタ読み込み中…', false],
  checking: (_, n)  => ['ready', `${n}件（最新を確認中…）`, true],
  synced:   (_, n)  => ['ready', `同期済み・${n}件`, true],
  updated:  (_, n)  => ['ready', `更新済み・${n}件`, true],
  offline:  (_, n)  => ['warn', `サーバーに接続できません。保存済みのマスタ（${n}件）を使用中`, true],
  error:    (m)     => ['error', m.message || 'マスタを読み込めませんでした', false]
};

// マスタが使えない間だけ JAN 欄に理由を出す（使えるようになったら空にする）
const JAN_PLACEHOLDER = {
  loading: 'マスタ読み込み中…',
  error: 'マスタを読み込めません（右上のメニューを確認）'
};

function setStatus(kind, text) {
  masterStatus.className = `master-status master-status--${kind}`;
  masterStatus.textContent = text;
  menuDot.className = `menu-btn__dot menu-btn__dot--${kind}`;
  menuBtn.setAttribute('aria-label', kind === 'ready' ? 'メニュー' : `メニュー（マスタ: ${text}）`);
  if (!inputsEnabled) janInput.placeholder = JAN_PLACEHOLDER[kind] ?? '';
}

function handleMasterStatus(msg) {
  const view = STATUS_VIEW[msg.state];
  if (!view) return;
  const [kind, text, enable] = view(msg, (msg.count || 0).toLocaleString());
  if (enable) enableInputs();
  setStatus(kind, text);
}

let inputsEnabled = false;
function enableInputs() {
  if (inputsEnabled) return;
  inputsEnabled = true;
  janInput.disabled = false;
  janInput.placeholder = '';
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
    const added = addItemToQueue(item);
    showScanNotice(`「${item.name}」を${added ? '追加しました' : '1枚追加しました'}`);
  } else {
    const code = normalizeJan(jan);
    showScanNotice(`JAN ${jan} はマスタにありません`, true, '', {
      label: 'このJANで手入力',
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

/** 主要サイズ以外の枚数列をまとめて出し入れする（表の見出しの ＋／− ボタン） */
function toggleAllOptions() {
  globalOptionsVisible = !globalOptionsVisible;
  renderQueueList();
}
toggleAllOptionsBtn?.addEventListener('click', toggleAllOptions);

clearQueueBtn.addEventListener('click', () => {
  if (confirm('印刷待機リストをすべて削除しますか？')) {
    popQueue = [];
    renderQueueList();
  }
  focusJan();
});

generatePopBtn.addEventListener('click', () => {
  if (popQueue.length === 0) {
    alert('印刷待機リストに商品がありません。');
    return;
  }
  saveQueue();
  window.location.href = 'preview.html';
});

// 枚数変更・商品情報の修正（リスト全体で1つのリスナー）
queueListContainer.addEventListener('change', (e) => {
  const countInput = e.target.closest('.count-input');
  if (countInput) {
    const idx = Number(countInput.dataset.idx);
    const n = toCount(countInput.value);
    popQueue[idx].counts[countInput.dataset.field] = n;
    countInput.value = n;
    countInput.classList.toggle('is-zero', n === 0);
    saveQueue();
    renderQueueTotal();
    return;
  }

  const itemInput = e.target.closest('.item-input');
  if (itemInput) {
    updateItemField(Number(itemInput.dataset.idx), itemInput.dataset.key, itemInput.value);
  }
});

// 修正欄で Enter → 確定してスキャン欄へ戻す（次のスキャンが修正欄に入力されるのを防ぐ）
queueListContainer.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.closest('.item-input, .count-input')) return;
  e.preventDefault();
  e.target.blur();          // change イベントが先に発生して内容が保存される
  focusJan();
});

// 枚数欄はクリックしたら中身を全選択（そのまま数字を打てるように）
queueListContainer.addEventListener('focusin', (e) => {
  if (e.target.classList.contains('count-input')) e.target.select();
});

queueListContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  switch (btn.dataset.action) {
    case 'toggle-sizes':
      toggleAllOptions();
      break;
    case 'remove':
      popQueue.splice(idx, 1);
      renderQueueList();
      break;
    case 'row-menu':
      openRowMenu(idx, btn);
      break;
  }
});

// ============================================================
// 行のメニュー（︙）：JANを印字しない・マスタの値に戻す
// ============================================================
const rowMenu = document.createElement('div');
rowMenu.className = 'menu-panel row-menu hidden';
rowMenu.setAttribute('role', 'menu');
document.body.append(rowMenu);
let rowMenuIdx = -1;
let rowMenuButton = null;

function rowMenuItems(q) {
  const items = [];
  if (q.item.jan) {
    items.push({ action: 'toggle-barcode', label: 'JANを印字しない', checked: !!q.item.noBarcode });
  }
  if (q.edited && q.source !== 'manual' && q.item.jan) {
    items.push({ action: 'reset', label: 'マスタの値に戻す' });
  }
  return items;
}

function openRowMenu(idx, button) {
  if (rowMenuIdx === idx && !rowMenu.classList.contains('hidden')) {
    closeRowMenu(true);
    return;
  }
  const items = rowMenuItems(popQueue[idx]);
  if (!items.length) return;
  rowMenuIdx = idx;
  rowMenuButton = button;
  rowMenu.innerHTML = items.map(it => (
    it.checked === undefined
      ? `<button type="button" class="menu-item" role="menuitem" data-row-action="${it.action}">${it.label}</button>`
      : `<button type="button" class="menu-item menu-item--check" role="menuitemcheckbox" aria-checked="${it.checked}" data-row-action="${it.action}">${it.label}</button>`
  )).join('');
  rowMenu.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');

  // ボタンの左下に出す（右端からはみ出さないように右揃え）
  const r = button.getBoundingClientRect();
  rowMenu.style.top = `${r.bottom + window.scrollY + 4}px`;
  rowMenu.style.left = `${Math.max(8, r.right + window.scrollX - rowMenu.offsetWidth)}px`;
  rowMenu.querySelector('.menu-item')?.focus();
}

function closeRowMenu(restoreFocus = false) {
  if (rowMenu.classList.contains('hidden')) return;
  rowMenu.classList.add('hidden');
  rowMenuButton?.setAttribute('aria-expanded', 'false');
  rowMenuIdx = -1;
  rowMenuButton = null;
  if (restoreFocus) focusJan();
}

rowMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-row-action]');
  if (!btn) return;
  const idx = rowMenuIdx;
  const q = popQueue[idx];
  closeRowMenu(true);
  if (!q) return;
  if (btn.dataset.rowAction === 'toggle-barcode') {
    q.item.noBarcode = !q.item.noBarcode;
    if (q.source !== 'manual') q.edited = true;
    saveQueue();
    refreshCardState(idx);
  } else if (btn.dataset.rowAction === 'reset') {
    if (!confirm('この商品の修正を取り消して、マスタの値に戻しますか？')) return;
    await resetItemToMaster(idx);
    renderQueueList();
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.row-menu, [data-action="row-menu"]')) closeRowMenu();
});
window.addEventListener('resize', () => closeRowMenu());

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

/** 修正後の行の表示（状態アイコン・JAN・価格・税率）だけを更新（入力中のフォーカスを保つため描き直さない） */
function refreshCardState(idx) {
  const row = queueListContainer.querySelector(`.queue-row[data-idx="${idx}"]`);
  if (!row) return;
  const q = popQueue[idx];
  row.className = rowClassName(q);

  row.querySelector('.q-icons--line2').innerHTML = editedIconHtml(q);
  const jan = row.querySelector('.jan-text');
  if (jan) jan.outerHTML = janTextHtml(q.item);
  const janField = row.querySelector('.item-input[data-key="jan"]');
  if (janField) janField.value = q.item.jan;
  const excl = row.querySelector('.item-input[data-key="priceExcl"]');
  if (excl) excl.value = q.item.priceExcl;
  const incl = row.querySelector('.item-input[data-key="price"]');
  if (incl) incl.value = q.item.price;
  const rate = row.querySelector('.tax-text');
  if (rate) rate.textContent = taxRateText(q.item);
  row.querySelector('[data-action="row-menu"]')?.classList.toggle('is-hidden', !rowMenuItems(q).length);
}

// ============================================================
// 画面描画
// ============================================================
let noticeTimer = null;
let noticeAction = null;

/**
 * 通知を画面左下に出す。action（{ label, run }）を渡すと通知にボタンを付ける（押せるよう長めに表示する）
 * リストの上ではなく画面に重ねて出すので、スキャンのたびにリストがずれない。
 */
function showScanNotice(text, isError = false, sub = '', action = null) {
  scanNoticeText.textContent = text;
  scanNoticeSub.textContent = isError ? '' : sub;
  scanNotice.className = `toast${isError ? ' toast--error' : ''}`;

  noticeAction = action ? action.run : null;
  scanNoticeAction.textContent = action ? action.label : '';
  scanNoticeAction.classList.toggle('hidden', !action);

  clearTimeout(noticeTimer);
  const ms = action ? 8000 : (isError ? 5000 : 2500);
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

  const isNew = existingIdx < 0;
  if (!isNew) {
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
  flashCard(0);
  return isNew;
}

/** 追加・枚数加算した行を一瞬強調する */
function flashCard(idx) {
  const card = queueListContainer.querySelector(`.queue-row[data-idx="${idx}"]`);
  if (!card) return;
  card.classList.remove('is-flash');
  void card.offsetWidth;   // 連続スキャンでもアニメーションをやり直すため
  card.classList.add('is-flash');
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
  flashCard(0);
  queueListContainer.querySelector('.queue-row[data-idx="0"] .item-input[data-key="name"]')?.focus();
  showScanNotice('手入力の行を追加しました', false, '商品名と価格を入力してください');
}

// ---- アイコン（絵文字は環境で形が変わるため SVG） ----
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const TRASH_ICON = svg('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>');
const DOTS_ICON = svg('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>');
const ICON_CSV = svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h8"/>');
const ICON_MANUAL = svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>');
const ICON_EDITED = svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>');

/** 1段目：取り込み元（CSV・手入力）、2段目：修正済み */
function sourceIconHtml(q) {
  if (q.source === 'csv') return `<span class="q-icon" title="CSVから読み込み" aria-label="CSVから読み込み" role="img">${ICON_CSV}</span>`;
  if (q.source === 'manual') return `<span class="q-icon" title="手入力" aria-label="手入力" role="img">${ICON_MANUAL}</span>`;
  return '';
}
function editedIconHtml(q) {
  return q.edited ? `<span class="q-icon q-icon--edited" title="修正済み" aria-label="修正済み" role="img">${ICON_EDITED}</span>` : '';
}

/** 行のクラス（修正済み・手入力・JAN あり） */
function rowClassName(q) {
  const classes = ['queue-row'];
  if (q.edited) classes.push('is-edited');
  if (q.source === 'manual') classes.push('is-manual');
  if (q.item.jan) classes.push('has-jan');
  return classes.join(' ');
}

/** JAN の表示（「JANを印字しない」は取り消し線） */
function janTextHtml(item) {
  if (!item.jan) return '<span class="jan-text jan-text--none">JANなし</span>';
  const off = item.noBarcode ? ' jan-text--off' : '';
  const title = item.noBarcode ? ' title="JANを印字しない"' : '';
  return `<span class="jan-text${off}"${title}>${escapeHtml(item.jan)}</span>`;
}

function taxRateText(item) {
  return item.taxRate == null ? '税率なし' : `${item.taxRate}%`;
}

/** 入力欄1つ。列名をプレースホルダー（薄いグレー）と読み上げ用の名前に使う */
function inputHtml(q, idx, key, label, cls = '') {
  const price = key === 'priceExcl' || key === 'price';
  const attrs = price ? 'type="number" min="0" step="1" inputmode="numeric"'
    : `type="text"${key === 'jan' ? ' inputmode="numeric"' : ''}`;
  let value = q.item[key] ?? '';
  // 手入力の行で価格が未入力（0）のときは空欄にして、プレースホルダーを見せる
  if (price && q.source === 'manual' && !value) value = '';
  return `<input ${attrs} class="item-input${price ? ' item-input--price' : ''}${cls}" placeholder="${label}" aria-label="${label}"
    data-idx="${idx}" data-key="${key}" value="${escapeHtml(value)}" autocomplete="off">`;
}

/** 税率の選択欄（手入力の行だけ） */
function taxSelectHtml(q, idx) {
  const current = q.item.taxRate == null ? '' : String(q.item.taxRate);
  const options = TAX_RATE_OPTIONS.map(o => (
    `<option value="${o.value}"${String(o.value) === current ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
  )).join('');
  return `<select class="item-input item-input--select" aria-label="税率" data-idx="${idx}" data-key="taxRate">${options}</select>`;
}

/** ミックスマッチ（CSV で指定したときだけ）。税抜・税込の右に同じ2段で出す */
function mixHtml(item) {
  const mix = item.mix;
  if (!mix) return ['<div class="q-cell"></div>', '<div class="q-cell"></div>'];
  return [
    `<div class="q-cell q-mix" title="ミックスマッチ：${mix.qty}個 税抜${mix.priceExcl}円（税込${mix.price}円）"><span class="q-mix__qty">${mix.qty}個</span>${mix.priceExcl.toLocaleString()}</div>`,
    `<div class="q-cell q-mix q-mix--incl">${mix.price.toLocaleString()}</div>`
  ];
}

/** 表示する枚数列（主要サイズ＋「1枚以上の行がある」か「＋で開いた」その他のサイズ） */
function visibleSizes() {
  return SIZE_LIST.filter(c => c.primary || globalOptionsVisible
    || popQueue.some(q => toCount(q.counts[c.key]) > 0));
}

/** 列の幅（CSS の grid-template-columns）。ミックスマッチ列は使う行があるときだけ */
function gridColumns(sizes, hasMix) {
  return [
    'var(--q-col-icon)', 'minmax(var(--q-col-item-min), 1fr)', 'var(--q-col-qty)', 'var(--q-col-risk)',
    'var(--q-col-price)', hasMix ? 'var(--q-col-mix)' : '0', `repeat(${sizes.length}, var(--q-col-count))`, 'var(--q-col-act)'
  ].join(' ');
}

function headerHtml(sizes, hasHidden, hasMix) {
  const allOptionalForced = !globalOptionsVisible && !hasHidden;
  const toggle = allOptionalForced ? '' : `
    <button type="button" class="q-size-toggle" data-action="toggle-sizes"
      aria-label="${globalOptionsVisible ? '使っていないサイズの列を隠す' : 'ほかのサイズの列を表示'}"
      title="${globalOptionsVisible ? '使っていないサイズの列を隠す' : 'ほかのサイズの列を表示'}">${globalOptionsVisible ? '−' : '＋'}</button>`;
  return `
    <div class="queue-head" role="row">
      <span></span>
      <span>商品名 ／ JAN・メーカー・コメント</span>
      <span>数量</span>
      <span>区分 ／ 税率</span>
      <span class="q-num">税抜 ／ 税込</span>
      <span class="q-num q-mix-head">${hasMix ? 'ミックスマッチ' : ''}</span>
      ${sizes.map(c => `<span class="q-count-head${c.key === DEFAULT_SIZE_KEY ? ' is-main' : ''}" title="${escapeHtml(c.label)}">${escapeHtml(shortSizeLabel(c))}</span>`).join('')}
      <span class="q-act-head">${toggle}</span>
    </div>`;
}

/** 列見出し用の短い名前（「A9タテ」→「A9」、「A6ハーフ」→「A6H」） */
function shortSizeLabel(c) {
  return String(c.label).replace('ハーフ', 'H').replace(/タテ|ヨコ/g, '');
}

function rowHtml(q, idx, sizes) {
  const manual = q.source === 'manual';
  const [mix1, mix2] = mixHtml(q.item);
  const hasMenu = rowMenuItems(q).length > 0;
  const counts = sizes.map(c => {
    const n = toCount(q.counts[c.key]);
    const cls = `count-input${c.key === DEFAULT_SIZE_KEY ? ' count-input--main' : ''}${n === 0 ? ' is-zero' : ''}`;
    return `<div class="q-count"><input type="number" min="0" inputmode="numeric" class="${cls}" value="${n}"
      data-idx="${idx}" data-field="${c.key}" aria-label="${escapeHtml(c.label)}の枚数"></div>`;
  }).join('');
  const themeTag = q.item.themeId ? `<span class="q-tag" title="デザインID">${escapeHtml(q.item.themeId)}</span>` : '';

  return `
    <div class="${rowClassName(q)}" data-idx="${idx}" role="row">
      <div class="q-icons">${sourceIconHtml(q)}</div>
      <div class="q-cell">${inputHtml(q, idx, 'name', '商品名', ' item-input--name')}</div>
      <div class="q-cell">${inputHtml(q, idx, 'qty1', '数量1')}</div>
      <div class="q-cell">${inputHtml(q, idx, 'risk', '医薬品区分')}</div>
      <div class="q-cell">${inputHtml(q, idx, 'priceExcl', '税抜')}</div>
      ${mix1}
      ${counts}
      <div class="q-act"><button type="button" class="btn-row" data-action="remove" data-idx="${idx}" aria-label="この行を削除" title="この行を削除">${TRASH_ICON}</button></div>

      <div class="q-icons q-icons--line2">${editedIconHtml(q)}</div>
      <div class="q-cell q-detail">
        ${manual ? inputHtml(q, idx, 'jan', 'JAN', ' item-input--jan') : janTextHtml(q.item)}
        ${inputHtml(q, idx, 'maker', 'メーカー', ' item-input--maker')}
        ${inputHtml(q, idx, 'comment', 'コメント', ' item-input--comment')}
        ${themeTag}
      </div>
      <div class="q-cell">${inputHtml(q, idx, 'qty2', '数量2')}</div>
      <div class="q-cell">${manual ? taxSelectHtml(q, idx) : `<span class="tax-text">${taxRateText(q.item)}</span>`}</div>
      <div class="q-cell">${inputHtml(q, idx, 'price', '税込', ' item-input--incl')}</div>
      ${mix2}
      <div class="q-act"><button type="button" class="btn-row${hasMenu ? '' : ' is-hidden'}" data-action="row-menu" data-idx="${idx}"
        aria-label="この行のメニュー" title="JANを印字しない・マスタの値に戻す" aria-haspopup="true" aria-expanded="false">${DOTS_ICON}</button></div>
    </div>`;
}

function footerHtml(sizes) {
  return `
    <div class="queue-foot" role="row">
      <span></span><span>サイズ別の合計</span><span></span><span></span><span></span><span></span>
      ${sizes.map(c => `<span class="q-count-total" data-size="${c.key}"></span>`).join('')}
      <span></span>
    </div>`;
}

/** 画面下の「合計◯枚」と、表の最下行のサイズ別合計 */
function renderQueueTotal() {
  let total = 0;
  const bySize = {};
  for (const q of popQueue) {
    for (const [key, n] of Object.entries(q.counts)) {
      const c = toCount(n);
      total += c;
      bySize[key] = (bySize[key] || 0) + c;
    }
  }
  queueTotal.innerHTML = popQueue.length ? `合計 <strong>${total.toLocaleString()}</strong> 枚` : '';
  queueListContainer.querySelectorAll('.q-count-total').forEach(el => {
    const n = bySize[el.dataset.size] || 0;
    el.textContent = n.toLocaleString();
    el.classList.toggle('is-zero', n === 0);
  });
}

function renderQueueList() {
  closeRowMenu();
  saveQueue();
  queueCount.textContent = `${popQueue.length}件`;
  clearQueueBtn.disabled = popQueue.length === 0;   // 空のときは押せないようにする

  if (popQueue.length === 0) {
    queueListContainer.className = 'queue-list';
    queueListContainer.replaceChildren(emptyQueueMessage);
    renderQueueTotal();
    return;
  }

  const sizes = visibleSizes();
  const hasHidden = sizes.length < SIZE_LIST.length;
  const hasMix = popQueue.some(q => q.item.mix);
  queueListContainer.className = `queue-list queue-table${hasMix ? ' has-mix' : ''}`;
  queueListContainer.style.setProperty('--q-cols', gridColumns(sizes, hasMix));
  queueListContainer.innerHTML = `<div class="queue-table__inner" role="table" aria-label="印刷待機リスト">
    ${headerHtml(sizes, hasHidden, hasMix)}
    ${popQueue.map((q, idx) => rowHtml(q, idx, sizes)).join('')}
    ${footerHtml(sizes)}
  </div>`;
  renderQueueTotal();
}

// ============================================================
// 商品リスト CSV の読み込み（読み込み結果を確認してから、リストを置き換える）
// ============================================================
const CSV_MESSAGE_LIMIT = 100;   // 画面に並べるエラー・注意の最大数
let pendingCsvEntries = null;

csvImportBtn.addEventListener('click', () => csvFileInput.click());

csvTemplateBtn.addEventListener('click', () => {
  closeMenu();
  focusJan();
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
// メニュー（右上のハンバーガー）
// スキャナーはフォーカスのある欄に入力するので、メニューを閉じたら JAN 欄に戻す
// ============================================================
function openMenu() {
  appMenu.classList.remove('hidden');
  menuBtn.setAttribute('aria-expanded', 'true');
  appMenu.querySelector('.menu-item')?.focus();
}

function closeMenu() {
  appMenu.classList.add('hidden');
  menuBtn.setAttribute('aria-expanded', 'false');
}

function isMenuOpen() {
  return !appMenu.classList.contains('hidden');
}

function focusJan() {
  if (!janInput.disabled) janInput.focus();
}

menuBtn.addEventListener('click', () => {
  if (isMenuOpen()) {
    closeMenu();
    focusJan();
  } else {
    openMenu();
  }
});

// メニューの外をクリックしたら閉じる（クリックした欄のフォーカスは奪わない）
document.addEventListener('click', (e) => {
  if (isMenuOpen() && !e.target.closest('.menu')) closeMenu();
});

// Esc で閉じる・上下キーで項目を移動
function menuArrowKeys(menu) {
  return (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menu.querySelectorAll('.menu-item:not(:disabled)')];
    const pos = items.indexOf(document.activeElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(pos + step + items.length) % items.length]?.focus();
  };
}
rowMenu.addEventListener('keydown', menuArrowKeys(rowMenu));
appMenu.addEventListener('keydown', (e) => {
  const items = [...appMenu.querySelectorAll('.menu-item:not(:disabled)')];
  const pos = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(pos + step + items.length) % items.length]?.focus();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!rowMenu.classList.contains('hidden')) {
    closeRowMenu(true);
  } else if (isMenuOpen()) {
    closeMenu();
    focusJan();
  }
});

// ============================================================
// 初期化（type="module" は DOM 構築後に実行されるので DOMContentLoaded 不要）
// ============================================================
setStatus('loading', 'マスタ読み込み中…');
renderStoreInput();
restoreQueue();
renderQueueList();
masterWorker.postMessage({ type: 'init' });
