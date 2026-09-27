/**
 * スキャン・印刷キュー管理アプリケーション
 */
const R2_MASTER_URL = '/api/master'; // R2マスタデータAPIエンドポイント

let masterArray = [];
let masterJanMap = new Map();
let popQueue = [];
let globalOptionsVisible = false;

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

  // 初期化：R2からマスタを取得
  fetchMasterFromR2();

  // イベントリスナー設定
  if (janInput) {
    janInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const jan = janInput.value.trim();
        if (!jan) return;

        const item = masterJanMap.get(jan);
        if (item) {
          addItemToQueue(item);
          janInput.value = '';
          showScanNotice(`「${item['品名'] || item['商品名']}」を追加しました`);
        } else {
          alert('該当するJANコードが見つかりません。');
        }
      }
    });
  }

  if (searchNameInput) {
    searchNameInput.addEventListener('input', () => {
      const keyword = searchNameInput.value.trim().toLowerCase();
      if (!keyword || masterArray.length === 0) {
        searchSuggestions.classList.add('hidden');
        return;
      }

      const matches = [];
      for (let i = 0; i < masterArray.length; i++) {
        const name = String(masterArray[i]['品名'] || masterArray[i]['商品名'] || '').toLowerCase();
        if (name.includes(keyword)) {
          matches.push(masterArray[i]);
          if (matches.length >= 20) break;
        }
      }

      renderSuggestions(matches);
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
      localStorage.setItem('pop_print_queue', JSON.stringify(popQueue));
      window.location.href = 'preview.html';
    });
  }

  // --- R2マスタデータ読み込み ---
  async function fetchMasterFromR2() {
    try {
      const response = await fetch(R2_MASTER_URL);
      if (!response.ok) throw new Error('R2からのマスタデータ取得に失敗しました');

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        processMasterData(data);
      } else {
        const csvText = await response.text();
        if (window.Papa) {
          Papa.parse(csvText, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => processMasterData(results.data)
          });
        }
      }
    } catch (err) {
      console.error(err);
      if (masterStatus) {
        masterStatus.textContent = '⚠️ マスタ読み込み失敗';
        masterStatus.className = 'text-xs bg-red-600 text-white px-3 py-1.5 rounded-full font-bold';
      }
    }
  }

  function processMasterData(data) {
    masterArray = data;
    masterJanMap.clear();

    masterArray.forEach(item => {
      const jan = String(item['JAN'] || item['JANコード'] || item['jan'] || '').trim();
      if (jan) masterJanMap.set(jan, item);
    });

    if (masterStatus) {
      masterStatus.textContent = `マスタ同期完了: ${masterArray.length.toLocaleString()}件`;
      masterStatus.className = 'text-xs bg-emerald-800 text-white px-3 py-1.5 rounded-full border border-emerald-700 font-bold';
    }

    if (janInput) janInput.disabled = false;
    if (searchNameInput) searchNameInput.disabled = false;
    if (janInput) janInput.focus();
  }

  function showScanNotice(text) {
    if (!scanNotice || !scanNoticeText) return;
    scanNoticeText.textContent = text;
    scanNotice.classList.remove('hidden');
    setTimeout(() => scanNotice.classList.add('hidden'), 2500);
  }

  function renderSuggestions(list) {
    if (!searchSuggestions) return;
    if (list.length === 0) {
      searchSuggestions.classList.add('hidden');
      return;
    }

    searchSuggestions.innerHTML = list.map((item, idx) => `
      <div data-idx="${idx}" class="suggestion-item p-3 hover:bg-indigo-50 cursor-pointer border-b text-sm flex justify-between items-center">
        <div>
          <div class="font-bold text-slate-800">${item['品名'] || item['商品名']}</div>
          <div class="text-xs text-slate-500">${item['製造メーカー'] || ''} / JAN: ${item['JANコード'] || item['JAN'] || ''}</div>
        </div>
        <div class="font-bold text-red-600">¥${Number(item['販売価格(税込)'] || item['税込価格'] || 0).toLocaleString()}</div>
      </div>
    `).join('');

    searchSuggestions.classList.remove('hidden');

    document.querySelectorAll('.suggestion-item').forEach((el, index) => {
      el.addEventListener('click', () => {
        addItemToQueue(list[index]);
        searchSuggestions.classList.add('hidden');
        if (searchNameInput) searchNameInput.value = '';
        if (janInput) janInput.focus();
      });
    });
  }

  function addItemToQueue(item) {
    const jan = item['JANコード'] || item['JAN'];
    const existingIdx = popQueue.findIndex(q => (q.item['JANコード'] || q.item['JAN']) === jan);

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
      const jan = item['JANコード'] || item['JAN'] || '';
      const name = item['品名'] || item['商品名'] || '';
      const maker = item['製造メーカー'] || item['メーカー'] || '';
      const price = Number(item['販売価格(税込)'] || item['税込価格'] || 0).toLocaleString();

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
    document.querySelectorAll('.count-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        const field = e.target.dataset.field;
        const val = parseInt(e.target.value, 10) || 0;
        popQueue[idx].counts[field] = val;
      });
    });

    document.querySelectorAll('[data-action="toggle-opt"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.idx, 10);
        popQueue[idx].showOptions = !popQueue[idx].showOptions;
        renderQueueList();
      });
    });

    document.querySelectorAll('[data-action="remove"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.idx, 10);
        popQueue.splice(idx, 1);
        renderQueueList();
      });
    });
  }
});
