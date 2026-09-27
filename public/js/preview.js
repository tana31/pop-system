/**
 * プレビュー画面のエントリポイント
 * 印刷キュー読込 → テーマ取得 → 面付け計算 → DOM描画。モードかデザインを変えるたびに面付けからやり直す
 */
import { sizeConfigs, mixedGrid } from './preview/constants.js';
import { loadQueue, countTotalPops, fetchThemes } from './preview/data.js';
import { buildSeparatedPages, buildMixedPages } from './preview/imposition.js';
import { renderPage, renderEmptyState } from './preview/page-render.js';
import { exportPagesToPdf } from './preview/pdf-export.js';

const modeSelect = document.getElementById('modeSelect');
const themeSelect = document.getElementById('themeSelect');
const downloadBtn = document.getElementById('downloadPdfBtn');
const statusInfo = document.getElementById('statusInfo');
const renderArea = document.getElementById('pdfRenderArea');

const queue = loadQueue();
const totalPops = countTotalPops(queue);
let themes = [];

init();

async function init() {
  if (totalPops === 0) {
    statusInfo.textContent = '印刷対象のPOPがありません。';
    renderArea.replaceChildren(renderEmptyState());
    modeSelect.disabled = themeSelect.disabled = downloadBtn.disabled = true;
    return;
  }

  try {
    themes = await fetchThemes();
  } catch (err) {
    console.error(err);
    statusInfo.textContent = `⚠️ ${err.message}（標準の配色で表示します）`;
  }

  themeSelect.innerHTML = themes.length
    ? themes.map(t => `<option value="${escapeAttr(t.id)}">${escapeAttr(t.name || t.id)}</option>`).join('')
    : '<option value="">標準</option>';

  modeSelect.addEventListener('change', render);
  themeSelect.addEventListener('change', render);
  downloadBtn.addEventListener('click', downloadPdf);

  render();
}

function currentTheme() {
  return themes.find(t => String(t.id) === themeSelect.value) || themes[0] || {};
}

function render() {
  const pages = modeSelect.value === 'mixed'
    ? buildMixedPages(queue, sizeConfigs, mixedGrid)
    : buildSeparatedPages(queue, sizeConfigs);

  const theme = currentTheme();
  renderArea.replaceChildren(...pages.map(p => renderPage(p, theme)));

  // テーマ取得エラーの表示中は上書きしない
  if (!statusInfo.textContent.startsWith('⚠️')) {
    statusInfo.textContent = `商品 ${queue.length}件 ／ POP 合計 ${totalPops}枚 ／ A4 ${pages.length}ページ`;
  }
}

async function downloadPdf() {
  const pages = [...renderArea.querySelectorAll('.a4-page')];
  if (pages.length === 0) return;

  const label = downloadBtn.textContent;
  downloadBtn.disabled = true;
  downloadBtn.textContent = '⏳ PDFを作成中...';
  try {
    await exportPagesToPdf(pages, `POP_Print_${todayLocal()}.pdf`);
  } catch (err) {
    console.error(err);
    alert(`PDFの作成に失敗しました。\n${err.message}`);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = label;
  }
}

/** 端末の現地時刻（日本なら日本時間）で YYYY-MM-DD を返す（toISOString は UTC なので使わない） */
function todayLocal() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function escapeAttr(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
