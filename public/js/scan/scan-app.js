/**
 * スキャン画面の入口（index.html から読み込む唯一のスクリプト）
 * マスタの取得・解析・検索は Web Worker (master-worker.js) が担当し、
 * このファイルは画面操作だけを行う。Worker から届くのは変換済みの商品データ
 * （{ jan, name, maker, price, ... }、形は master-schema.js 参照）なので、ここでは列名を扱わない。
 *
 * 印刷待機リストの各項目はフォームで修正でき、修正内容は印刷キューに保存されてプレビュー・PDFに反映される。
 * 修正はこのリスト内だけのもので、商品マスタ（R2のCSV）は変更しない。
 */
import { SIZE_CONFIGS, DEFAULT_SIZE_KEY, createDefaultCounts } from '../shared/pop-sizes.js';
import { calcPriceExcl } from '../shared/price.js';
import { loadQueue, saveQueue as storeQueue, toCount } from '../shared/print-queue.js';

const SIZE_LIST = Object.values(SIZE_CONFIGS);
const PRIMARY_SIZES = SIZE_LIST.filter(c => c.primary);
const OPTION_SIZES = SIZE_LIST.filter(c => !c.primary);

// 印刷待機リストで修正できる項目（span は 12分割グリッドでの幅）
// JAN は同一商品の判定と「マスタの値に戻す」に使うため修正不可
const EDIT_FIELDS = [
  { key: 'name',      label: '商品名',     span: 6 },
  { key: 'maker',     label: 'メーカー',   span: 3 },
  { key: 'comment',   label: 'コメント',   span: 3 },
  { key: 'qty1',      label: '数量1',      span: 2 },
  { key: 'qty2',      label: '数量2',      span: 2 },
  { key: 'risk',      label: '医薬品区分', span: 2 },
  { key: 'price',     label: '税込価格',   span: 3, price: true },
  { key: 'priceExcl', label: '税抜価格',   span: 3, price: true }
];

let popQueue = [];
let globalOptionsVisible = false;

// ---- DOM要素 ----
const masterStatus = document.getElementById('masterStatus');
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

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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

  const item = await askMaster('lookup', { jan });
  if (item) {
    addItemToQueue(item);
    showScanNotice(`「${item.name}」を追加しました`);
  } else {
    showScanNotice(`JAN ${jan} はマスタに見つかりませんでした`, true);
  }
});

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
      const matches = await askMaster('search', { keyword, limit: 20 });
      if (seq !== searchSeq) return; // 古い検索結果は表示しない
      renderSuggestions(matches);
    }, 150);
  });
}

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

  if (key === 'price') {
    item.price = toPrice(value);
    if (item.priceExclAuto) item.priceExcl = calcPriceExcl(item.price);
  } else if (key === 'priceExcl') {
    // 空欄にすると「税込から自動計算」に戻る
    item.priceExclAuto = value === '';
    item.priceExcl = item.priceExclAuto ? calcPriceExcl(item.price) : toPrice(value);
  } else {
    item[key] = value;
  }

  q.edited = true;
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
  const fresh = await askMaster('lookup', { jan: q.item.jan });
  if (!fresh) {
    showScanNotice(`JAN ${q.item.jan} はマスタに見つからないため、元に戻せませんでした`, true);
    return;
  }
  q.item = fresh;
  q.edited = false;
}

/** 修正後のカード表示（修正済みバッジ・税抜の自動計算表示）だけを更新 */
function refreshCardState(idx) {
  const card = queueListContainer.querySelector(`.queue-card[data-idx="${idx}"]`);
  if (!card) return;
  const q = popQueue[idx];
  card.classList.toggle('is-edited', !!q.edited);

  const exclInput = card.querySelector('.item-input[data-key="priceExcl"]');
  if (exclInput) {
    exclInput.placeholder = exclPlaceholder(q.item);
    exclInput.value = q.item.priceExclAuto ? '' : q.item.priceExcl;
  }
  const priceInput = card.querySelector('.item-input[data-key="price"]');
  if (priceInput) priceInput.value = q.item.price;
}

// ============================================================
// 画面描画
// ============================================================
let noticeTimer = null;
function showScanNotice(text, isError = false) {
  scanNoticeText.textContent = text;
  scanNoticeSub.textContent = isError ? '' : 'リスト先頭に追加しました';
  scanNotice.className = `notice ${isError ? 'notice--error' : 'notice--success'}`;

  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => scanNotice.classList.add('hidden'), isError ? 4000 : 2500);
}

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
  const existingIdx = popQueue.findIndex(q => q.item.jan === item.jan);

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

/** 税抜価格欄の案内（空欄＝自動計算であることを示す） */
function exclPlaceholder(item) {
  return `自動: ${calcPriceExcl(item.price).toLocaleString()}`;
}

/** 商品情報の修正欄 */
function itemFieldHtml(f, item, idx) {
  let value = item[f.key] ?? '';
  let extra = '';
  if (f.key === 'priceExcl') {
    if (item.priceExclAuto) value = '';
    extra = ` placeholder="${escapeHtml(exclPlaceholder(item))}"`;
  }
  const inputAttrs = f.price
    ? `type="number" min="0" step="1" inputmode="numeric"`
    : `type="text"`;
  return `
    <label class="item-field item-field--span${f.span}">
      <span class="item-field__label">${f.label}${f.price ? '（円）' : ''}</span>
      <input ${inputAttrs} class="item-input${f.price ? ' item-input--price' : ''}${f.key === 'price' ? ' item-input--incl' : ''}"
        data-idx="${idx}" data-key="${f.key}" value="${escapeHtml(value)}"${extra} autocomplete="off">
    </label>`;
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
      <div class="queue-card${q.edited ? ' is-edited' : ''}" data-idx="${idx}">
        <div class="queue-card__head">
          <div class="queue-card__meta">
            <span class="jan-chip">${escapeHtml(q.item.jan)}</span>
            <span class="edited-badge">✏️ 修正済み</span>
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
            ${EDIT_FIELDS.map(f => itemFieldHtml(f, q.item, idx)).join('')}
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

// ============================================================
// 初期化（type="module" は DOM 構築後に実行されるので DOMContentLoaded 不要）
// ============================================================
restoreQueue();
renderQueueList();
masterWorker.postMessage({ type: 'init' });
