/**
 * スキャン・印刷キュー管理（スキャン画面）
 * マスタの取得・解析・検索は Web Worker (master-worker.js) が担当し、
 * このファイルは画面操作だけを行う。Worker から届くのは変換済みの商品データ
 * （{ jan, name, maker, price, ... }、形は master-schema.js 参照）なので、ここでは列名を扱わない。
 */
import { SIZE_CONFIGS, QUEUE_STORAGE_KEY, DEFAULT_SIZE_KEY, createDefaultCounts } from './pop-config.js';

const SIZE_LIST = Object.values(SIZE_CONFIGS);
const PRIMARY_SIZES = SIZE_LIST.filter(c => c.primary);
const OPTION_SIZES = SIZE_LIST.filter(c => !c.primary);

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
  try {
    const saved = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY) || '[]');
    const zero = Object.fromEntries(SIZE_LIST.map(c => [c.key, 0]));
    popQueue = Array.isArray(saved)
      ? saved
          .filter(q => q && q.item && typeof q.item.jan === 'string' && q.counts)
          .map(q => ({ ...q, counts: { ...zero, ...q.counts } })) // サイズ追加後も欄が欠けないように
      : [];
  } catch (e) {
    popQueue = [];
  }
}

function saveQueue() {
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(popQueue));
  } catch (e) {
    console.warn('印刷リストの保存に失敗しました', e);
  }
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

// 枚数変更・削除・トグル（リスト全体で1つのリスナー）
queueListContainer.addEventListener('change', (e) => {
  const input = e.target.closest('.count-input');
  if (!input) return;
  const idx = Number(input.dataset.idx);
  popQueue[idx].counts[input.dataset.field] = Math.max(0, parseInt(input.value, 10) || 0);
  saveQueue();
});

queueListContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  if (btn.dataset.action === 'toggle-opt') {
    popQueue[idx].showOptions = !popQueue[idx].showOptions;
  } else if (btn.dataset.action === 'remove') {
    popQueue.splice(idx, 1);
  }
  renderQueueList();
});

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

  queueListContainer.innerHTML = popQueue.map((q, idx) => {
    const item = q.item;
    return `
      <div class="queue-card">
        <div class="queue-card__row">
          <div class="queue-card__info">
            <div class="queue-card__meta">
              <span class="jan-chip">${escapeHtml(item.jan)}</span>
              <span>${escapeHtml(item.maker)}</span>
            </div>
            <h3 class="queue-card__name">${escapeHtml(item.name)}</h3>
            <div class="queue-card__price">¥${item.price.toLocaleString()} <small>(税込)</small></div>
          </div>

          <div class="count-group">
            ${PRIMARY_SIZES.map(c => primaryFieldHtml(c, q, idx)).join('')}
          </div>

          <div class="card-actions">
            <button type="button" data-action="toggle-opt" data-idx="${idx}" class="btn-chip">
              <span>⚙️ 他サイズ</span>
              <span class="btn-chip__arrow">${q.showOptions ? '▲' : '▼'}</span>
            </button>
            <button type="button" data-action="remove" data-idx="${idx}" class="btn-icon-danger" aria-label="この行を削除">🗑️</button>
          </div>
        </div>

        <div class="option-sizes${q.showOptions ? '' : ' hidden'}">
          <div class="option-sizes__title">【オプションサイズ指定】</div>
          <div class="option-sizes__fields">
            ${OPTION_SIZES.map(c => optionFieldHtml(c, q, idx)).join('')}
          </div>
        </div>
      </div>`;
  }).join('');
}

// ============================================================
// 初期化（type="module" は DOM 構築後に実行されるので DOMContentLoaded 不要）
// ============================================================
restoreQueue();
renderQueueList();
masterWorker.postMessage({ type: 'init' });
