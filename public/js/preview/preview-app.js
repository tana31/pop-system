/**
 * プレビュー画面の入口（preview.html から読み込む唯一のスクリプト）
 * 印刷キュー読込 → テーマ取得 → 面付け計算 → DOM描画。モードかデザインを変えるたびに面付けからやり直す
 *
 * 各 A4 ページの上には「1 / 3」のページ番号を付ける（.page-label。PDF には入らない）。
 * PDF の作成結果やエラーは、スキャン画面と同じく画面左下の通知で知らせる。
 *
 * 「印刷・PDF保存」はブラウザの印刷機能を使う（用紙・余白は css/print.css の @page で決める）。
 * 文字もバーコードもベクターのまま PDF になる。「PDFを直接ダウンロード（旧）」は画像化する以前の方式。
 * ミシン目の点線は印刷しない。URL に ?cutlines を付けて開いたときだけ印刷する（テスト用）。
 *
 * コメントの上限は画像の有無で変わる（pop-sizes.js の commentMax・commentMaxImage）。スキャン画面ではデザインが
 * 決まっていないので画像なしの上限でしか確かめていない。そこで、選んだデザインでコメントが表示されない商品を
 * 白い帯の下に一覧で知らせる（renderCommentAlert）。
 */
import { SIZE_CONFIGS, MIXED_GRID, commentHiddenSizes } from '../shared/pop-sizes.js';
import { loadQueue, countTotalPops, toCount } from '../shared/print-queue.js';
import { fetchThemes, themeHasImage } from './themes.js';
import { buildSeparatedPages, buildMixedPages } from './imposition.js';
import { renderPage, renderEmptyState } from './page-render.js';
import { fitPopText } from './pop-cell.js';
import { exportPagesToPdf } from './pdf-export.js';

const modeSelect = document.getElementById('modeSelect');
const themeSelect = document.getElementById('themeSelect');
const downloadBtn = document.getElementById('downloadPdfBtn');
const printBtn = document.getElementById('printBtn');
const statusInfo = document.getElementById('statusInfo');
const renderArea = document.getElementById('pdfRenderArea');
const notice = document.getElementById('previewNotice');
const noticeText = document.getElementById('previewNoticeText');
const commentAlert = document.getElementById('commentAlert');
const commentAlertSummary = document.getElementById('commentAlertSummary');
const commentAlertList = document.getElementById('commentAlertList');

const queue = loadQueue();
const totalPops = countTotalPops(queue);
let themes = [];
let themeWarning = '';   // テーマを取得できなかったときの文言（集計の代わりに出し続ける）

// テスト用: preview.html?cutlines で開くと、ミシン目の点線も印刷する（css/print.css を参照）
if (new URLSearchParams(location.search).has('cutlines')) {
  document.body.classList.add('show-cut-lines');
}

init();

async function init() {
  if (totalPops === 0) {
    setStatus('印刷するPOPがありません');
    renderArea.replaceChildren(renderEmptyState());
    modeSelect.disabled = themeSelect.disabled = downloadBtn.disabled = printBtn.disabled = true;
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
  printBtn.addEventListener('click', () => window.print());
  // Ctrl+P で印刷したときも、保存するファイル名の初期値を日付入りにする
  window.addEventListener('beforeprint', setPrintTitle);
  window.addEventListener('afterprint', restoreTitle);

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
  renderCommentAlert(getTheme);

  if (themeWarning) {
    setStatus(themeWarning, true);
  } else {
    setStatus(`商品 ${queue.length}件 ／ POP ${totalPops}枚 ／ A4 ${n}ページ`);
  }
}

/**
 * 選んだデザイン（CSV でデザインIDを指定した商品はそのデザイン）で、コメントが長いため表示されない POP を一覧にする。
 * 商品の件数だけだと、画像なしでも表示されない商品ばかりのときにデザインを変えても数が変わらないので、
 * 表示されない POP の枚数と、そのうち「画像があるために表示されない」枚数を出す。
 * 一覧は閉じた状態で出し、開いた・閉じたはデザインを変えても保つ
 */
function renderCommentAlert(getTheme) {
  const rows = [];
  let hiddenPops = 0;
  let imagePops = 0;   // 画像のないデザインなら表示される枚数
  for (const q of queue) {
    const hasImage = themeHasImage(getTheme(q.item));
    const hidden = commentHiddenSizes(q.item.comment, q.counts, hasImage);
    if (!hidden.length) continue;
    const always = new Set(commentHiddenSizes(q.item.comment, q.counts, false).map(c => c.key));
    const sizes = hidden.map(c => {
      const n = toCount(q.counts[c.key]);
      hiddenPops += n;
      if (!always.has(c.key)) imagePops += n;
      return `${c.label} ${n}枚${always.has(c.key) ? '' : '（画像のため）'}`;
    });
    rows.push({ name: q.item.name || '（商品名なし）', comment: q.item.comment, sizes: sizes.join('・') });
  }
  commentAlert.classList.toggle('hidden', rows.length === 0);
  if (rows.length === 0) return;
  const imageNote = imagePops ? `。うち ${imagePops}枚は画像のないデザインなら表示されます` : '';
  commentAlertSummary.textContent = `コメントが長いため表示されない POP が ${hiddenPops}枚あります（${rows.length}商品${imageNote}）`;
  commentAlertList.innerHTML = rows.map(r => `
    <li><span class="comment-alert__name">${escapeAttr(r.name)}</span>
      <span class="comment-alert__sizes">${escapeAttr(r.sizes)}</span>
      <span class="comment-alert__comment">${escapeAttr(r.comment)}</span></li>`).join('');
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

/**
 * 「PDFに保存」のファイル名の初期値はページのタイトルになるので、印刷中だけ書き換える
 * （POP_Print_2026-10-11.pdf のようになる）
 */
const screenTitle = document.title;
function setPrintTitle() {
  document.title = `POP_Print_${todayLocal()}`;
}
function restoreTitle() {
  document.title = screenTitle;
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
