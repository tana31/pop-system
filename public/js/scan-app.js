/**
 * スキャン・印刷キュー管理アプリケーション
 * マスタの取得・解析・検索は Web Worker (master-worker.js) が担当し、
 * このファイル（メインスレッド）は画面操作だけを行う。
 */
const MASTER_WORKER_URL = '/js/master-worker.js';
const QUEUE_STORAGE_KEY = 'pop_print_queue';

let popQueue = [];
let globalOptionsVisible = false;

// ---- ユーティリティ ----
function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const getName = item => item['品名'] || item['商品名'] || '';
const getJan = item => item['JANコード'] || item['JAN'] || item['jan'] || '';
const getPrice = item => Number(item['販売価格(税込)'] || item['税込価格'] || 0);

document.addEventListener('DOMContentLoaded', () => {
  // DOM要素取得
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

  // ============================================================
  // マスタ Worker との通信
  // ============================================================
  const masterWorker = new Worker(MASTER_WORKER_URL);
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

  const STATUS_CLASSES = {
    loading: 'text-xs bg-amber-500 text-slate-900 px-3 py-1.5 rounded-full font-bold flex items-center gap-1.5',
    ready: 'text-xs bg-emerald-800 text-white px-3 py-1.5 rounded-full border border-emerald-700 font-bold',
    warn: 'text-xs bg-amber-600 text-white px-3 py-1.5 rounded-full font-bold',
    error: 'text-xs bg-red-600 text-white px-3 py-1.5 rounded-full font-bold'
  };

  function setStatus(kind, text) {
    if (!masterStatus) return;
    masterStatus.className = STATUS_CLASSES[kind];
    masterStatus.textContent = text;
  }

  function handleMasterStatus(msg) {
    const count = (msg.count || 0).toLocaleString();
    switch (msg.state) {
      case 'loading':
        setStatus('loading', `⏳ ${msg.message}`);
        break;
      case 'ready':
        setStatus('ready', msg.source === 'cache'
          ? `マスタ読込: ${count}件（最新を確認中…）`
          : `マスタ同期完了: ${count}件`);
        enableInputs();
        break;
      case 'verified':
        setStatus('ready', `マスタ同期完了: ${count}件`);
        break;
      case 'updated':
        setStatus('ready', `マスタ更新済み: ${count}件`);
        break;
      case 'stale':
        setStatus('warn', `⚠️ サーバー接続不可・保存済みマスタ使用中: ${count}件`);
        break;
      case 'error':
        setStatus('error', `⚠️ ${msg.message}`);
        break;
    }
  }

  let inputsEnabled = false;
  function enableInputs() {
    if (inputsEnabled) return;
    inputsEnabled = true;
    if (janInput) janInput.disabled = false;
    if (searchNameInput) searchNameInput.disabled = false;
    // 商品名検索に入力中でなければスキャン欄にフォーカス
    if (janInput && document.activeElement !== searchNameInput) janInput.focus();
  }

  // ============================================================
  // 印刷待機リストの保存・復元（ブラウザバック対策）
  // ============================================================
  function restoreQueue() {
    try {
      const saved = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY) || '[]');
      popQueue = Array.isArray(saved) ? saved.filter(q => q && q.item && q.counts) : [];
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
  // 初期化
  // ============================================================
  restoreQueue();
  renderQueueList();
  masterWorker.postMessage({ type: 'init' });

  // ============================================================
  // イベントリスナー
  // ============================================================
  if (janInput) {
    janInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();

      const jan = janInput.value.trim();
      janInput.value = '';          // 連続スキャンに備えて即クリア
      if (!jan) return;

      const item = await askMaster('lookup', { jan });
      if (item) {
        addItemToQueue(item);
        showScanNotice(`「${getName(item)}」を追加しました`);
      } else {
        showScanNotice(`JAN ${jan} はマスタに見つかりませんでした`, true);
      }
    });
  }

  if (searchNameInput) {
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

  if (toggleAllOptionsBtn) {
    toggleAllOptionsBtn.addEventListener('click', () => {
      globalOptionsVisible = !globalOptionsVisible;
      popQueue.forEach(q => q.showOptions = globalOptionsVisible);
      renderQueueList();
    });
  }

  if (clearQueueBtn) {
    clearQueueBtn.addEventListener('click', () => {
      if (confirm('印刷リストをクリアしますか？')) {
        popQueue = [];
        renderQueueList();
      }
    });
  }

  if (generatePopBtn) {
    generatePopBtn.addEventListener('click', () => {
      if (popQueue.length === 0) {
        alert('印刷待機リストに商品がありません。');
        return;
      }
      saveQueue();
      window.location.href = 'preview.html';
    });
  }

  // ============================================================
  // 画面描画
  // ============================================================
  let noticeTimer = null;
  function showScanNotice(text, isError = false) {
    if (!scanNotice || !scanNoticeText) return;
    const subText = scanNotice.lastElementChild;

    scanNoticeText.textContent = text;
    scanNotice.className = isError
      ? 'bg-red-100 border border-red-400 text-red-800 px-4 py-2 rounded-lg text-sm font-bold flex justify-between items-center'
      : 'bg-emerald-100 border border-emerald-400 text-emerald-800 px-4 py-2 rounded-lg text-sm font-bold flex justify-between items-center';
    if (subText && subText !== scanNoticeText) {
      subText.textContent = isError ? '' : 'リスト先頭に追加しました';
    }

    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => scanNotice.classList.add('hidden'), isError ? 4000 : 2500);
  }

  function renderSuggestions(list) {
    if (!searchSuggestions) return;
    if (!list || list.length === 0) {
      searchSuggestions.classList.add('hidden');
      return;
    }

    searchSuggestions.innerHTML = list.map((item, idx) => `
      <div data-idx="${idx}" class="suggestion-item p-3 hover:bg-indigo-50 cursor-pointer border-b text-sm flex justify-between items-center">
        <div>
          <div class="font-bold text-slate-800">${escapeHtml(getName(item))}</div>
          <div class="text-xs text-slate-500">${escapeHtml(item['製造メーカー'] || '')} / JAN: ${escapeHtml(getJan(item))}</div>
        </div>
        <div class="font-bold text-red-600">¥${getPrice(item).toLocaleString()}</div>
      </div>
    `).join('');

    searchSuggestions.classList.remove('hidden');

    searchSuggestions.querySelectorAll('.suggestion-item').forEach((el) => {
      el.addEventListener('click', () => {
        addItemToQueue(list[Number(el.dataset.idx)]);
        searchSuggestions.classList.add('hidden');
        if (searchNameInput) searchNameInput.value = '';
        if (janInput) janInput.focus();
      });
    });
  }

  function addItemToQueue(item) {
    const jan = getJan(item);
    const existingIdx = popQueue.findIndex(q => getJan(q.item) === jan);

    if (existingIdx >= 0) {
      popQueue[existingIdx].counts.a8 += 1;
      const target = popQueue.splice(existingIdx, 1)[0];
      popQueue.unshift(target);
    } else {
      popQueue.unshift({
        item: item,
        counts: { a9: 0, a8: 1, a6half: 0, a6: 0, a5: 0, a4: 0 },
        showOptions: globalOptionsVisible
      });
    }

    renderQueueList();
  }

  function renderQueueList() {
    saveQueue();
    if (!queueListContainer) return;

    if (queueCount) queueCount.textContent = `${popQueue.length}件`;

    if (popQueue.length === 0) {
      queueListContainer.innerHTML = '';
      if (emptyQueueMessage) queueListContainer.appendChild(emptyQueueMessage);
      return;
    }

    queueListContainer.innerHTML = '';

    popQueue.forEach((q, idx) => {
      const item = q.item;
      const jan = escapeHtml(getJan(item));
      const name = escapeHtml(getName(item));
      const maker = escapeHtml(item['製造メーカー'] || item['メーカー'] || '');
      const price = getPrice(item).toLocaleString();

      const card = document.createElement('div');
      card.className = 'bg-slate-50 border border-slate-200 rounded-xl p-4 shadow-sm hover:border-indigo-300 transition space-y-3';

      card.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="min-w-[240px] flex-1">
            <div class="flex items-center gap-2 text-xs text-slate-500 font-bold">
              <span class="font-mono bg-slate-200 px-1.5 py-0.5 rounded">${jan}</span>
              <span>${maker}</span>
            </div>
            <h3 class="font-bold text-slate-900 text-base leading-tight mt-0.5">${name}</h3>
            <div class="text-sm font-bold text-red-600 mt-0.5">¥${price} <span class="text-xs text-slate-500 font-normal">(税込)</span></div>
          </div>

          <!-- 主要3サイズ入力フォーム -->
          <div class="flex items-center gap-2 bg-white p-2 rounded-lg border border-slate-300 shadow-inner">
            <div class="text-center w-16">
              <label class="block text-[10px] font-bold text-indigo-900">A9タテ</label>
              <input type="number" min="0" value="${q.counts.a9}" data-idx="${idx}" data-field="a9" class="count-input w-full text-center font-bold text-base border rounded py-0.5 focus:ring-2 focus:ring-indigo-400">
            </div>
            <div class="text-center w-16">
              <label class="block text-[10px] font-bold text-indigo-900">A8ヨコ</label>
              <input type="number" min="0" value="${q.counts.a8}" data-idx="${idx}" data-field="a8" class="count-input w-full text-center font-bold text-base border-2 border-indigo-500 rounded py-0.5 focus:ring-2 focus:ring-indigo-400 bg-indigo-50">
            </div>
            <div class="text-center w-16">
              <label class="block text-[10px] font-bold text-indigo-900">A6ハーフ</label>
              <input type="number" min="0" value="${q.counts.a6half}" data-idx="${idx}" data-field="a6half" class="count-input w-full text-center font-bold text-base border rounded py-0.5 focus:ring-2 focus:ring-indigo-400">
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button data-action="toggle-opt" data-idx="${idx}" class="text-xs bg-slate-200 hover:bg-slate-300 text-slate-700 px-2.5 py-2 rounded font-bold transition flex items-center gap-1">
              <span>⚙️ 他サイズ</span>
              <span class="text-[10px]">${q.showOptions ? '▲' : '▼'}</span>
            </button>
            <button data-action="remove" data-idx="${idx}" class="text-xs text-red-500 hover:text-red-700 hover:bg-red-50 px-2 py-2 rounded font-bold">
              🗑️
            </button>
          </div>
        </div>

        <!-- オプションサイズ（A6, A5, A4ヨコ） -->
        <div class="${q.showOptions ? 'block' : 'hidden'} border-t border-slate-200 pt-3 mt-2 bg-indigo-50/50 p-3 rounded-lg">
          <div class="text-xs font-bold text-slate-500 mb-2">【オプションサイズ指定】</div>
          <div class="flex flex-wrap items-center gap-4">
            <div class="flex items-center gap-2 bg-white px-3 py-1.5 rounded border border-slate-300">
              <span class="text-xs font-bold text-slate-700">A6ヨコ:</span>
              <input type="number" min="0" value="${q.counts.a6}" data-idx="${idx}" data-field="a6" class="count-input w-16 text-center font-bold text-sm border rounded py-0.5">
            </div>
            <div class="flex items-center gap-2 bg-white px-3 py-1.5 rounded border border-slate-300">
              <span class="text-xs font-bold text-slate-700">A5ヨコ:</span>
              <input type="number" min="0" value="${q.counts.a5}" data-idx="${idx}" data-field="a5" class="count-input w-16 text-center font-bold text-sm border rounded py-0.5">
            </div>
            <div class="flex items-center gap-2 bg-white px-3 py-1.5 rounded border border-slate-300">
              <span class="text-xs font-bold text-slate-700">A4ヨコ:</span>
              <input type="number" min="0" value="${q.counts.a4}" data-idx="${idx}" data-field="a4" class="count-input w-16 text-center font-bold text-sm border rounded py-0.5">
            </div>
          </div>
        </div>
      `;

      queueListContainer.appendChild(card);
    });

    // イベントバインディング（枚数変更・削除・トグル）
    queueListContainer.querySelectorAll('.count-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        const field = e.target.dataset.field;
        const val = Math.max(0, parseInt(e.target.value, 10) || 0);
        popQueue[idx].counts[field] = val;
        saveQueue();
      });
    });

    queueListContainer.querySelectorAll('[data-action="toggle-opt"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.idx, 10);
        popQueue[idx].showOptions = !popQueue[idx].showOptions;
        renderQueueList();
      });
    });

    queueListContainer.querySelectorAll('[data-action="remove"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.idx, 10);
        popQueue.splice(idx, 1);
        renderQueueList();
      });
    });
  }
});
