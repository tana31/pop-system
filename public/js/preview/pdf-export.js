/**
 * A4ページ要素をPDFに変換してダウンロード（html2canvas + jsPDF）
 */
import { PAGE_MM, ROTATE_SLOT_CLASS, ROTATE_INNER_CLASS } from './constants.js';

const CAPTURE_OPTIONS = { scale: 2, useCORS: true, logging: false };
const JPEG_QUALITY = 0.98;

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
      ignoreElements: el => el.classList?.contains(ROTATE_INNER_CLASS)
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

function toJpeg(canvas) {
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}
