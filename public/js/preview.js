let queueData = [];

document.addEventListener('DOMContentLoaded', () => {
  const pdfRenderArea = document.getElementById('pdfRenderArea');
  const themeSelect = document.getElementById('themeSelect');
  const modeSelect = document.getElementById('modeSelect');
  const downloadPdfBtn = document.getElementById('downloadPdfBtn');
  const statusInfo = document.getElementById('statusInfo');

  loadQueueData();
  buildA4Pages();

  themeSelect.addEventListener('change', buildA4Pages);
  modeSelect.addEventListener('change', buildA4Pages);
  downloadPdfBtn.addEventListener('click', handleDownloadPdf);

  function loadQueueData() {
    try {
      const rawData = localStorage.getItem('pop_print_queue');
      queueData = rawData ? JSON.parse(rawData) : [];
    } catch (e) {
      console.error("Data parse error:", e);
      queueData = [];
    }

    let totalPops = 0;
    queueData.forEach(q => {
      if (q.counts) {
        Object.values(q.counts).forEach(c => totalPops += Number(c) || 0);
      }
    });

    if (statusInfo) {
      statusInfo.innerHTML = `受領データ件数: <strong>${queueData.length} 件</strong> / 印刷合計枚数: <strong>${totalPops} 枚</strong>`;
    }
  }

  function buildA4Pages() {
    if (!pdfRenderArea) return;
    pdfRenderArea.innerHTML = '';
    const theme = themeSelect.value;
    const mode = modeSelect.value;
    let renderedPages = 0;

    if (mode === 'separated') {
      Object.keys(SIZE_CONFIGS).forEach(sizeKey => {
        const conf = SIZE_CONFIGS[sizeKey];
        const perPage = conf.cols * conf.rows;

        let itemsForThisSize = [];
        queueData.forEach(q => {
          const count = q.counts ? (parseInt(q.counts[sizeKey], 10) || 0) : 0;
          for (let i = 0; i < count; i++) itemsForThisSize.push(q.item);
        });

        if (itemsForThisSize.length === 0) return;

        for (let p = 0; p < itemsForThisSize.length; p += perPage) {
          const pageItems = itemsForThisSize.slice(p, p + perPage);
          pdfRenderArea.appendChild(createSeparatedPage(conf, pageItems, theme));
          renderedPages++;
        }
      });
    } else {
      let allPops = [];
      queueData.forEach(q => {
        if (!q.counts) return;
        Object.keys(q.counts).forEach(sizeKey => {
          const count = parseInt(q.counts[sizeKey], 10) || 0;
          for (let i = 0; i < count; i++) {
            allPops.push({ sizeKey, conf: SIZE_CONFIGS[sizeKey], item: q.item });
          }
        });
      });

      if (allPops.length > 0) {
        allPops.sort((a, b) => b.conf.blocks - a.conf.blocks);

        const GRID_COLS = 8;
        const GRID_ROWS = 4;
        const ITEM_DIMS = {
          a4:     { w: 8, h: 4 },
          a5:     { w: 4, h: 4 },
          a6:     { w: 4, h: 2 },
          a6half: { w: 4, h: 1 },
          a8:     { w: 2, h: 1 },
          a9:     { w: 1, h: 1 }
        };

        let pages = [];
        let currentPageGrid = createEmptyGrid(GRID_ROWS, GRID_COLS);
        let currentPageItems = [];

        allPops.forEach(pop => {
          const dim = ITEM_DIMS[pop.sizeKey] || { w: 1, h: 1 };
          let pos = findFreeSpot(currentPageGrid, dim.w, dim.h, GRID_ROWS, GRID_COLS);

          if (!pos) {
            pages.push(currentPageItems);
            currentPageGrid = createEmptyGrid(GRID_ROWS, GRID_COLS);
            currentPageItems = [];
            pos = findFreeSpot(currentPageGrid, dim.w, dim.h, GRID_ROWS, GRID_COLS);
          }

          if (pos) {
            markGrid(currentPageGrid, pos.r, pos.c, dim.w, dim.h);
            currentPageItems.push({
              ...pop,
              gridPos: { colStart: pos.c + 1, colSpan: dim.w, rowStart: pos.r + 1, rowSpan: dim.h }
            });
          }
        });

        if (currentPageItems.length > 0) {
          pages.push(currentPageItems);
        }

        pages.forEach(pageItems => {
          pdfRenderArea.appendChild(createMixedGridPage(pageItems, theme));
          renderedPages++;
        });
      }
    }

    if (renderedPages === 0) {
      pdfRenderArea.innerHTML = `
        <div class="bg-white p-12 rounded-xl text-center space-y-4 shadow max-w-xl mx-auto">
          <div class="text-4xl">⚠️</div>
          <div class="text-lg font-bold text-slate-800">印刷プレビュー対象の枚数が指定されていません</div>
          <p class="text-sm text-slate-500">スキャン画面で枚数を指定してから進んでください。</p>
          <div>
            <button onclick="location.href='index.html'" class="bg-indigo-600 text-white font-bold px-6 py-2 rounded-lg text-sm">
              スキャン画面に戻る
            </button>
          </div>
        </div>
      `;
    }
  }

  function createEmptyGrid(rows, cols) {
    const grid = [];
    for (let r = 0; r < rows; r++) {
      grid.push(new Array(cols).fill(false));
    }
    return grid;
  }

  function findFreeSpot(grid, w, h, maxRows, maxCols) {
    for (let r = 0; r <= maxRows - h; r++) {
      for (let c = 0; c <= maxCols - w; c++) {
        let fit = true;
        for (let dr = 0; dr < h; dr++) {
          for (let dc = 0; dc < w; dc++) {
            if (grid[r + dr][c + dc]) {
              fit = false;
              break;
            }
          }
          if (!fit) break;
        }
        if (fit) return { r, c };
      }
    }
    return null;
  }

  function markGrid(grid, r, c, w, h) {
    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        grid[r + dr][c + dc] = true;
      }
    }
  }

  function createSeparatedPage(conf, items, theme) {
    const page = document.createElement('div');
    page.className = `a4-page ${conf.isLandscapePage ? 'landscape' : 'portrait'}`;

    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = `repeat(${conf.cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${conf.rows}, 1fr)`;
    grid.style.height = '100%';
    grid.style.width = '100%';

    items.forEach(item => {
      grid.appendChild(createPopCell(conf, item, theme));
    });

    page.appendChild(grid);
    return page;
  }

  function createMixedGridPage(pageItems, theme) {
    const page = document.createElement('div');
    page.className = 'a4-page landscape';

    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(8, 1fr)';
    grid.style.gridTemplateRows = 'repeat(4, 1fr)';
    grid.style.height = '100%';
    grid.style.width = '100%';

    pageItems.forEach(pop => {
      const cell = createPopCell(pop.conf, pop.item, theme);
      cell.style.gridColumn = `${pop.gridPos.colStart} / span ${pop.gridPos.colSpan}`;
      cell.style.gridRow = `${pop.gridPos.rowStart} / span ${pop.gridPos.rowSpan}`;
      grid.appendChild(cell);
    });

    page.appendChild(grid);
    return page;
  }

  // 【全サイズ共通】1カラム縦積みPOPセル生成関数
  function createPopCell(conf, item, theme) {
    const cell = document.createElement('div');
    const layoutClass = conf.isVertical ? 'pop-layout-top' : 'pop-layout-left';
    cell.className = `pop-cell ${conf.cssClass} ${layoutClass}`;
    if (theme === 'sale') cell.classList.add('theme-sale');

    const comment  = item['コメント'] || item['アピール文'] || '';
    const maker    = item['製造メーカー'] || item['メーカー'] || '';
    const name     = item['品名'] || item['商品名'] || '';
    const qty1     = item['数量1'] || item['内容量'] || '';
    const qty2     = item['数量2'] || item['規格'] || '';
    const risk     = item['リスク分類'] || item['医薬品区分'] || '';
    const imageUrl = item['画像URL'] || item['画像'] || item['image'] || item['画像パス'] || '';

    const priceTaxIncl = Number(item['販売価格(税込)'] || item['税込価格'] || 0);
    const priceTaxExcl = item['販売価格(税抜)'] || item['税抜価格'] 
      ? Number(item['販売価格(税抜)'] || item['税抜価格'])
      : Math.round(priceTaxIncl / 1.1);

    let priceClass = theme === 'simple' ? 'price-simple' : 'price-standard';
    const imageHtml = imageUrl ? `<div class="pop-image-container"><img src="${imageUrl}" alt=""></div>` : '';

    cell.innerHTML = `
      ${imageHtml}
      <div class="pop-content">
        <div class="pop-comment">${comment}</div>
        <div class="pop-maker">${maker}</div>
        <div class="pop-name">${name}</div>
        <div class="pop-qty-group">
          <span class="truncate">${qty1}</span>
          <span class="truncate">${qty2}</span>
        </div>
        <div class="pop-tax-excl-container">
          <span class="pop-tax-badge-black">税抜</span>
          <div class="pop-price-excl ${priceClass}">
            ${priceTaxExcl.toLocaleString()}<span class="unit">円</span>
          </div>
        </div>
        <div class="pop-divider"></div>
        <div class="pop-tax-incl">(税込) ${priceTaxIncl.toLocaleString()}円</div>
        <div class="pop-risk-tag">${risk}</div>
      </div>
    `;

    return cell;
  }

  async function handleDownloadPdf() {
    const pageElements = document.querySelectorAll('.a4-page');
    if (pageElements.length === 0) {
      alert('ダウンロード対象の印刷データがありません。');
      return;
    }

    downloadPdfBtn.disabled = true;
    downloadPdfBtn.textContent = '⏳ PDF生成中...';

    try {
      const jsPDF = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : window.jsPDF;
      if (!jsPDF || typeof html2canvas !== 'function') {
        throw new Error('PDF生成ライブラリの読み込みに失敗しました。');
      }

      let pdf = null;

      for (let i = 0; i < pageElements.length; i++) {
        const pageEl = pageElements[i];
        const isLandscape = pageEl.classList.contains('landscape');
        const orientation = isLandscape ? 'l' : 'p';

        const canvas = await html2canvas(pageEl, { 
          scale: 2, 
          useCORS: true,
          logging: false 
        });
        const imgData = canvas.toDataURL('image/jpeg', 0.98);

        if (i === 0) {
          pdf = new jsPDF(orientation, 'mm', 'a4');
        } else {
          pdf.addPage('a4', orientation);
        }

        const pdfWidth = isLandscape ? 297 : 210;
        const pdfHeight = isLandscape ? 210 : 297;

        pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, pdfHeight);
      }

      pdf.save(`POP_Print_${new Date().toISOString().slice(0,10)}.pdf`);
    } catch (err) {
      console.error("PDF Export Error:", err);
      alert(`PDF出力エラー: ${err.message || '生成処理で失敗しました。'}`);
    } finally {
      downloadPdfBtn.disabled = false;
      downloadPdfBtn.innerHTML = '<span>⬇️ A4-PDFファイルを直接ダウンロード</span>';
    }
  }
});
