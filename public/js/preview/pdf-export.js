/**
 * A4ページ要素をPDFに変換してダウンロード（html2canvas + jsPDF）
 */
import { PAGE_MM } from './imposition.js';
import { ROTATE_SLOT_CLASS, ROTATE_INNER_CLASS } from './page-render.js';
import { BARCODE_BARS_CLASS, toBars } from './barcode.js';

const CAPTURE_OPTIONS = { scale: 2, useCORS: true, logging: false };
const JPEG_QUALITY = 0.98;

// バーコードの線は画像にせず、あとからベクターで描く（JPEG化によるにじみで読めなくなるのを防ぐ）
const isBarcodeBars = el => el.classList?.contains(BARCODE_BARS_CLASS);

export async function exportPagesToPdf(pageElements, fileName) {
  const jsPDF = window.jspdf?.jsPDF || window.jsPDF;
  if (!jsPDF || typeof window.html2canvas !== 'function') {
    throw new Error('PDF生成ライブラリの読み込みに失敗しました。');
  }

  // Webフォントの読み込み完了を待ってから描画（文字幅ずれ防止）
  if (document.fonts?.ready) await document.fonts.ready;

  let pdf = null;

  for (const pageEl of pageElements) {
    const orientation = pageEl.classList.contains('landscape') ? 'landscape' : 'portrait';
    const { w, h } = PAGE_MM[orientation];
    const pdfOrientation = orientation === 'landscape' ? 'l' : 'p';

    if (!pdf) {
      pdf = new jsPDF(pdfOrientation, 'mm', 'a4');
    } else {
      pdf.addPage('a4', pdfOrientation);
    }

    // ページ全体を撮影（回転POPの中身はここでは描かず、後から画像で貼る）
    const canvas = await window.html2canvas(pageEl, {
      ...CAPTURE_OPTIONS,
      ignoreElements: el => el.classList?.contains(ROTATE_INNER_CLASS) || isBarcodeBars(el)
    });
    pdf.addImage(toJpeg(canvas), 'JPEG', 0, 0, w, h);

    // 回転配置のPOP（A5ヨコ）を回転済み画像として所定位置に貼り付け
    for (const slot of pageEl.querySelectorAll(`.${ROTATE_SLOT_CLASS}`)) {
      const inner = slot.querySelector(`.${ROTATE_INNER_CLASS}`);
      if (!inner) continue;
      const rotated = await captureRotatedCell(inner);
      const { x, y, w: slotW, h: slotH } = slot.dataset;
      pdf.addImage(toJpeg(rotated), 'JPEG', Number(x), Number(y), Number(slotW), Number(slotH));
    }

    // 最後にバーコードの線をベクターで重ねる
    drawBarcodes(pdf, pageEl, w);
  }

  pdf.save(fileName);
}

/**
 * 回転配置のPOPを「回転前の状態」で撮影し、-90°回転したcanvasを返す
 * （html2canvas は transform + overflow:hidden の組み合わせで描画が崩れるため）
 */
async function captureRotatedCell(innerEl) {
  const src = await window.html2canvas(innerEl, {
    ...CAPTURE_OPTIONS,
    backgroundColor: '#ffffff',
    ignoreElements: isBarcodeBars,
    onclone: (doc, clonedEl) => {
      clonedEl.style.transform = 'none';
      clonedEl.style.left = '0';
      clonedEl.style.top = '0';
    }
  });

  const dst = document.createElement('canvas');
  dst.width = src.height;
  dst.height = src.width;
  const ctx = dst.getContext('2d');
  ctx.translate(0, dst.height);
  ctx.rotate(-Math.PI / 2); // CSSの rotate(-90deg) と同じ向き
  ctx.drawImage(src, 0, 0);
  return dst;
}

/**
 * ページ内のバーコードを PDF にベクターの黒い長方形として描く。
 * 位置は画面上の配置（mm単位のCSS）から求める。回転配置（A5ヨコの混載）の中にあるものは
 * -90°回転しているので、元の「左→右」が「下→上」になる
 */
function drawBarcodes(pdf, pageEl, pageWidthMm) {
  const pageRect = pageEl.getBoundingClientRect();
  const mmPerPx = pageWidthMm / pageRect.width;
  pdf.setFillColor(0, 0, 0);

  for (const svg of pageEl.querySelectorAll(`.${BARCODE_BARS_CLASS}`)) {
    const bits = svg.dataset.bits;
    if (!bits) continue;

    const r = svg.getBoundingClientRect();
    const x = (r.left - pageRect.left) * mmPerPx;
    const y = (r.top - pageRect.top) * mmPerPx;
    const w = r.width * mmPerPx;
    const h = r.height * mmPerPx;
    const rotated = !!svg.closest(`.${ROTATE_INNER_CLASS}`);

    for (const bar of toBars(bits)) {
      if (rotated) {
        const unit = h / bits.length;
        pdf.rect(x, y + h - (bar.start + bar.width) * unit, w, bar.width * unit, 'F');
      } else {
        const unit = w / bits.length;
        pdf.rect(x + bar.start * unit, y, bar.width * unit, h, 'F');
      }
    }
  }
}

function toJpeg(canvas) {
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}
