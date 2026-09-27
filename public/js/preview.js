/**
 * A4面付けPDFプレビュー画面（エントリポイント）
 *
 * js/preview/
 *   constants.js   … 共有定数・pop-config.js への窓口
 *   data.js        … 印刷キュー・デザイン一覧の読み込み
 *   imposition.js  … 面付け計算（DOM非依存）
 *   pop-cell.js    … POPセル1枚のDOM生成
 *   page-render.js … A4ページのDOM生成
 *   pdf-export.js  … PDF出力
 */
import { sizeConfigs, mixedGrid } from './preview/constants.js';
import { loadQueue, countTotalPops, fetchThemes } from './preview/data.js';
import { buildSeparatedPages, buildMixedPages } from './preview/imposition.js';
import { renderPage, renderEmptyState } from './preview/page-render.js';
import { exportPagesToPdf } from './preview/pdf-export.js';

const DOWNLOAD_LABEL = '<span>⬇️ A4-PDFファイルを直接ダウンロード</span>';
const DOWNLOAD_BUSY_LABEL = '⏳ PDF生成中...';

const els = {
  renderArea:  document.getElementById('pdfRenderArea'),
  themeSelect: document.getElementById('themeSelect'),
  modeSelect:  document.getElementById('modeSelect'),
  downloadBtn: document.getElementById('downloadPdfBtn'),
  statusInfo:  document.getElementById('statusInfo')
};

const state = {
  queue: [],
  themesById: {}
};

init();

function init() {
  state.queue = loadQueue();
  renderStatus();

  els.themeSelect.addEventListener('change', rebuildPreview);
  els.modeSelect.addEventListener('change', rebuildPreview);
  els.downloadBtn.addEventListener('click', handleDownloadPdf);

  setupThemes(); // 読み込み完了後にプレビューを描画
}

function renderStatus() {
  els.statusInfo.innerHTML =
    `受領データ件数: <strong>${state.queue.length} 件</strong> / ` +
    `印刷合計枚数: <strong>${countTotalPops(state.queue)} 枚</strong>`;
}

async function setupThemes() {
  try {
    const themes = await fetchThemes();
    state.themesById = Object.fromEntries(themes.map(t => [t.id, t]));
    els.themeSelect.replaceChildren(...themes.map(t => new Option(t.name || t.id, t.id)));
    if (themes.length > 0) els.themeSelect.value = themes[0].id;
  } catch (err) {
    console.error(err);
    els.themeSelect.replaceChildren(new Option('⚠️ デザイン読み込み失敗', ''));
  } finally {
    rebuildPreview();
  }
}

function rebuildPreview() {
  const theme = state.themesById[els.themeSelect.value] || {};
  const pages = els.modeSelect.value === 'separated'
    ? buildSeparatedPages(state.queue, sizeConfigs)
    : buildMixedPages(state.queue, sizeConfigs, mixedGrid);

  els.renderArea.replaceChildren(
    ...(pages.length > 0 ? pages.map(page => renderPage(page, theme)) : [renderEmptyState()])
  );
}

async function handleDownloadPdf() {
  const pageElements = els.renderArea.querySelectorAll('.a4-page');
  if (pageElements.length === 0) {
    alert('ダウンロード対象の印刷データがありません。');
    return;
  }

  setDownloadBusy(true);
  try {
    await exportPagesToPdf(pageElements, `POP_Print_${new Date().toISOString().slice(0, 10)}.pdf`);
  } catch (err) {
    console.error('PDF Export Error:', err);
    alert(`PDF出力エラー: ${err.message || '生成処理で失敗しました。'}`);
  } finally {
    setDownloadBusy(false);
  }
}

function setDownloadBusy(busy) {
  els.downloadBtn.disabled = busy;
  if (busy) {
    els.downloadBtn.textContent = DOWNLOAD_BUSY_LABEL;
  } else {
    els.downloadBtn.innerHTML = DOWNLOAD_LABEL;
  }
}
