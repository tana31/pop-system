/**
 * A4ページ要素をPDFに変換してダウンロード（html-to-image + jsPDF）
 *
 * 以前は html2canvas を使っていたが、html2canvas は CSS を自前で解釈して描き直すため、
 * 文字の位置・サイズが画面（プレビュー）とずれる。html-to-image はブラウザ自身の描画
 * （SVG foreignObject）で画像化するので、プレビューと同じ見た目になる。
 * 回転配置（A5ヨコの混載）もブラウザがそのまま描くので、別撮影・回転処理は不要。
 *
 * 高速化のための工夫
 * - 中身がまったく同じページは1回だけ画像化し、PDF の中でも同じ画像を使い回す
 * - バーコードの線（SVG の中身）は画像化の対象から外す（あとでベクターで描くため不要）
 * - 1ページごとにブラウザへ処理を返し、進捗を onProgress で知らせる
 * - Webフォントは埋め込まない（skipFonts）。POP の文字は PC に入っているフォントで描く。
 *   Google Fonts の CSS は別サイトのため読み取れず、埋め込もうとすると毎ページ失敗して遅くなる。
 *   読み取れたとしても日本語フォントは数MBあり、ページごとに読み込むとかえって遅い
 */
import { PAGE_MM } from './imposition.js';
import { ROTATE_INNER_CLASS } from './page-render.js';
import { BARCODE_BARS_CLASS, toBars } from './barcode.js';

const PIXEL_RATIO = 2;      // 画像の解像度（2 で約190dpi。文字をより鮮明にしたい場合は 3）
const JPEG_QUALITY = 0.95;

// true にすると、処理ごとの所要時間をコンソールに表示する
const DEBUG_TIMING = true;

// Safari は1回目の描画で画像やフォントが欠けることがあるため、2回描画して2回目を使う
const IS_SAFARI = /^((?!chrome|chromium|crios|android).)*safari/i.test(navigator.userAgent);

/**
 * onProgress(done, total) は省略可。1ページ処理するごとに呼ばれる
 */
export async function exportPagesToPdf(pageElements, fileName, onProgress) {
  const jsPDF = window.jspdf?.jsPDF || window.jsPDF;
  const htmlToImage = window.htmlToImage;
  if (!jsPDF || !htmlToImage) {
    throw new Error('PDF生成ライブラリの読み込みに失敗しました。');
  }

  const timing = createTiming();
  const total = pageElements.length;

  // Webフォント・画像の読み込み完了を待ってから描画
  if (document.fonts?.ready) await document.fonts.ready;
  await waitForImages(pageElements);

  // バーコードの線は画像にせず、あとからベクターで描く（JPEG化によるにじみで読めなくなるのを防ぐ）。
  // 要素を取り除くと下の数字が上に詰まってずれるため、場所は残したまま見えなくする
  const restoreBars = hideBarcodeBars(pageElements);

  // ページの中身 → { dataUrl, alias }。同じ中身のページは画像を使い回す
  const pageImages = new Map();

  let pdf = null;
  try {
    for (let i = 0; i < total; i++) {
      const pageEl = pageElements[i];
      const orientation = pageEl.classList.contains('landscape') ? 'landscape' : 'portrait';
      const { w, h } = PAGE_MM[orientation];
      const pdfOrientation = orientation === 'landscape' ? 'l' : 'p';

      if (!pdf) {
        pdf = new jsPDF(pdfOrientation, 'mm', 'a4');
      } else {
        pdf.addPage('a4', pdfOrientation);
      }

      const key = `${orientation}|${pageEl.innerHTML}`;
      let image = pageImages.get(key);
      if (!image) {
        timing.start('capture');
        const canvas = await capturePage(htmlToImage, pageEl);
        timing.stop('capture');

        timing.start('jpeg');
        image = {
          dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY),
          alias: `page-image-${pageImages.size}`
        };
        timing.stop('jpeg');

        // 大きな canvas のメモリを早めに手放す
        canvas.width = 0;
        canvas.height = 0;
        pageImages.set(key, image);
      }

      // 同じ alias を渡すと、jsPDF は2回目以降は画像を埋め込み直さずに使い回す
      timing.start('addImage');
      pdf.addImage(image.dataUrl, 'JPEG', 0, 0, w, h, image.alias);
      timing.stop('addImage');

      // 最後にバーコードの線をベクターで重ねる
      timing.start('barcode');
      drawBarcodes(pdf, pageEl, w);
      timing.stop('barcode');

      onProgress?.(i + 1, total);
      // ブラウザに一度処理を返し、進捗表示を描き直せるようにする
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    restoreBars();
  }

  timing.start('save');
  pdf.save(fileName);
  timing.stop('save');

  timing.report({ pages: total, captured: pageImages.size });
}

/** 1ページをブラウザの描画のまま canvas にする */
async function capturePage(htmlToImage, pageEl) {
  const options = {
    // Webフォントは埋め込まない（PC に入っているフォントで描く）
    skipFonts: true,
    pixelRatio: PIXEL_RATIO,
    backgroundColor: '#ffffff',
    // 画面表示用に縮小（transform）していても、本来のA4寸法で撮影する
    width: pageEl.offsetWidth,
    height: pageEl.offsetHeight,
    style: { transform: 'none', margin: '0', boxShadow: 'none' },
    // バーコードの線（SVG の中身）は複製しない。SVG の枠は残るのでレイアウトは変わらない
    filter: node => !isInsideBarcodeBars(node)
  };

  if (IS_SAFARI) await htmlToImage.toCanvas(pageEl, options);
  return htmlToImage.toCanvas(pageEl, options);
}

/** バーコードの線の SVG の直下にある要素か（その要素ごと中身も複製対象から外れる） */
function isInsideBarcodeBars(node) {
  const parent = node.parentElement;
  return !!parent?.classList?.contains(BARCODE_BARS_CLASS);
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

/** 処理ごとの所要時間を合計し、最後にコンソールへ表で出す（DEBUG_TIMING が false なら何もしない） */
function createTiming() {
  const totals = {};
  const started = {};
  const begin = performance.now();
  return {
    start(name) {
      if (DEBUG_TIMING) started[name] = performance.now();
    },
    stop(name) {
      if (!DEBUG_TIMING) return;
      totals[name] = (totals[name] || 0) + (performance.now() - started[name]);
    },
    report(info) {
      if (!DEBUG_TIMING) return;
      const rows = Object.fromEntries(
        Object.entries(totals).map(([k, ms]) => [k, { 秒: +(ms / 1000).toFixed(2) }])
      );
      rows['合計'] = { 秒: +((performance.now() - begin) / 1000).toFixed(2) };
      console.log(`PDF出力: ${info.pages}ページ中 ${info.captured}ページを画像化`);
      console.table(rows);
    }
  };
}
