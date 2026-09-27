/**
 * A4ページ要素をPDFに変換してダウンロード（html-to-image + jsPDF）
 *
 * 以前は html2canvas を使っていたが、html2canvas は CSS を自前で解釈して描き直すため、
 * 文字の位置・サイズが画面（プレビュー）とずれる。html-to-image はブラウザ自身の描画
 * （SVG foreignObject）で画像化するので、プレビューと同じ見た目になる。
 * 回転配置（A5ヨコの混載）もブラウザがそのまま描くので、別撮影・回転処理は不要。
 */
import { PAGE_MM } from './imposition.js';
import { ROTATE_INNER_CLASS } from './page-render.js';
import { BARCODE_BARS_CLASS, toBars } from './barcode.js';

const PIXEL_RATIO = 2;      // 画像の解像度（2 で約190dpi。文字をより鮮明にしたい場合は 3）
const JPEG_QUALITY = 0.95;

// Safari は1回目の描画で画像やフォントが欠けることがあるため、2回描画して2回目を使う
const IS_SAFARI = /^((?!chrome|chromium|crios|android).)*safari/i.test(navigator.userAgent);

export async function exportPagesToPdf(pageElements, fileName) {
  const jsPDF = window.jspdf?.jsPDF || window.jsPDF;
  const htmlToImage = window.htmlToImage;
  if (!jsPDF || !htmlToImage) {
    throw new Error('PDF生成ライブラリの読み込みに失敗しました。');
  }

  // Webフォント・画像の読み込み完了を待ってから描画
  if (document.fonts?.ready) await document.fonts.ready;
  await waitForImages(pageElements);

  // Webフォントの埋め込み用CSSは全ページ共通なので、最初に1回だけ作る
  let fontEmbedCSS;
  try {
    fontEmbedCSS = await htmlToImage.getFontEmbedCSS(pageElements[0]);
  } catch (err) {
    console.warn('フォント埋め込みCSSの事前作成に失敗しました（ページごとに作成します）', err);
  }

  // バーコードの線は画像にせず、あとからベクターで描く（JPEG化によるにじみで読めなくなるのを防ぐ）。
  // 要素を取り除くと下の数字が上に詰まってずれるため、場所は残したまま見えなくする
  const restoreBars = hideBarcodeBars(pageElements);

  let pdf = null;
  try {
    for (const pageEl of pageElements) {
      const orientation = pageEl.classList.contains('landscape') ? 'landscape' : 'portrait';
      const { w, h } = PAGE_MM[orientation];
      const pdfOrientation = orientation === 'landscape' ? 'l' : 'p';

      if (!pdf) {
        pdf = new jsPDF(pdfOrientation, 'mm', 'a4');
      } else {
        pdf.addPage('a4', pdfOrientation);
      }

      const canvas = await capturePage(htmlToImage, pageEl, fontEmbedCSS);
      pdf.addImage(canvas.toDataURL('image/jpeg', JPEG_QUALITY), 'JPEG', 0, 0, w, h);

      // 最後にバーコードの線をベクターで重ねる
      drawBarcodes(pdf, pageEl, w);
    }
  } finally {
    restoreBars();
  }

  pdf.save(fileName);
}

/** 1ページをブラウザの描画のまま canvas にする */
async function capturePage(htmlToImage, pageEl, fontEmbedCSS) {
  const options = {
    pixelRatio: PIXEL_RATIO,
    backgroundColor: '#ffffff',
    // 画面表示用に縮小（transform）していても、本来のA4寸法で撮影する
    width: pageEl.offsetWidth,
    height: pageEl.offsetHeight,
    style: { transform: 'none', margin: '0', boxShadow: 'none' },
    ...(fontEmbedCSS ? { fontEmbedCSS } : {})
  };

  if (IS_SAFARI) await htmlToImage.toCanvas(pageEl, options);
  return htmlToImage.toCanvas(pageEl, options);
}

/** ページ内の画像（テーマ画像）の読み込みを待つ。失敗した画像は待たない */
function waitForImages(pageElements) {
  const images = pageElements.flatMap(p => [...p.querySelectorAll('img')]);
  return Promise.all(images.map(img => (img.complete
    ? null
    : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }))));
}

/** バーコードの線を一時的に非表示にし、元に戻す関数を返す（レイアウトは変わらない） */
function hideBarcodeBars(pageElements) {
  const svgs = pageElements.flatMap(p => [...p.querySelectorAll(`.${BARCODE_BARS_CLASS}`)]);
  const previous = svgs.map(svg => svg.style.visibility);
  svgs.forEach(svg => { svg.style.visibility = 'hidden'; });
  return () => svgs.forEach((svg, i) => { svg.style.visibility = previous[i]; });
}

/**
 * ページ内のバーコードを PDF にベクターの黒い長方形として描く。
 * 位置は画面上の配置から求める。回転配置（A5ヨコの混載）の中にあるものは
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
