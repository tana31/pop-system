/**
 * プレビュー画面の入口（preview.html から読み込む唯一のスクリプト）
 * 印刷キュー読込 → テーマ取得 → 面付け計算 → DOM描画。モードかデザインを変えるたびに面付けからやり直す
 *
 * 各 A4 ページの上には「1 / 3」のページ番号を付ける（.page-label。PDF には入らない）。
 * PDF の作成結果やエラーは、スキャン画面と同じく画面左下の通知で知らせる。
 */
import { SIZE_CONFIGS, MIXED_GRID } from '../shared/pop-sizes.js';
import { loadQueue, countTotalPops } from '../shared/print-queue.js';
import { fetchThemes } from './themes.js';
import { buildSeparatedPages, buildMixedPages } from './imposition.js';
import { renderPage, renderEmptyState } from './page-render.js';
import { fitPopText } from './pop-cell.js';
import { exportPagesToPdf } from './pdf-export.js';

const modeSelect = document.getElementById('modeSelect');
const themeSelect = document.getElementById('themeSelect');
const downloadBtn = document.getElementById('downloadPdfBtn');
const statusInfo = document.getElementById('statusInfo');
const renderArea = document.getElementById('pdfRenderArea');
const notice = document.getElementById('previewNotice');
const noticeText = document.getElementById('previewNoticeText');

const queue = loadQueue();
const totalPops = countTotalPops(queue);
let themes = [];
let themeWarning = '';   // テーマを取得できなかったときの文言（集計の代わりに出し続ける）

init();

async function init() {
  if (totalPops === 0) {
    setStatus('印刷するPOPがありません');
    renderArea.replaceChildren(renderEmptyState());
    modeSelect.disabled = themeSelect.disabled = downloadBtn.disabled = true;
    return;
  }

  try {
    themes = await fetchThemes();
  } catch (err) {
    console.error(err);
    themeWarning = `デザインを読み込めませんでした（標準の配色で表示します）: ${err.message}`;
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

/** 商品ごとのデザイン：CSV でデザインIDが指定されていればそれ、無ければ（または未登録なら）画面で選んだもの */
function themeResolver() {
  const selected = currentTheme();
  const byId = new Map(themes.map(t => [String(t.id), t]));
  return (item) => (item.themeId && byId.get(String(item.themeId))) || selected;
}

function render() {
  const pages = modeSelect.value === 'mixed'
    ? buildMixedPages(queue, SIZE_CONFIGS, MIXED_GRID)
    : buildSeparatedPages(queue, SIZE_CONFIGS);

  const getTheme = themeResolver();
  const n = pages.length;
  // ページ番号はページの外（.a4-page の前）に置くので、PDF には写らない
  renderArea.replaceChildren(...pages.flatMap((p, i) => [pageLabel(i + 1, n), renderPage(p, getTheme)]));
  fitPopText(renderArea);

  if (themeWarning) {
    setStatus(themeWarning, true);
  } else {
    setStatus(`商品 ${queue.length}件 ／ POP ${totalPops}枚 ／ A4 ${n}ページ`);
  }
}

function pageLabel(no, total) {
  const el = document.createElement('div');
  el.className = 'page-label';
  el.textContent = `${no} / ${total}`;
  return el;
}

function setStatus(text, isWarn = false) {
  statusInfo.textContent = text;
  statusInfo.classList.toggle('status-info--warn', isWarn);
}

async function downloadPdf() {
  const pages = [...renderArea.querySelectorAll('.a4-page')];
  if (pages.length === 0) return;

  const label = downloadBtn.textContent;
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'PDFを作成中…';
  const fileName = `POP_Print_${todayLocal()}.pdf`;
  try {
    await exportPagesToPdf(pages, fileName);
    showNotice(`${fileName} をダウンロードしました`);
  } catch (err) {
    console.error(err);
    showNotice(`PDFを作成できませんでした: ${err.message}`, true);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = label;
  }
}

let noticeTimer = null;

/** 画面左下に通知を出す（スキャン画面の通知と同じ見た目） */
function showNotice(text, isError = false) {
  noticeText.textContent = text;
  notice.className = `toast${isError ? ' toast--error' : ''}`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.add('hidden'), isError ? 8000 : 3000);
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
