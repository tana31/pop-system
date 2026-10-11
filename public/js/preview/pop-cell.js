/**
 * POPセル（1枚分）のDOM生成
 * item はマスタWorkerが変換済みの商品データ（形は js/scan/master-schema.js 冒頭を参照）。
 * CSV から読み込んだ商品は mix（ミックスマッチ）と themeId を持つことがある（js/scan/csv-import.js 冒頭）
 * jan が空の商品（手入力・「〇〇 各種」）と noBarcode が true の商品は、バーコードを印字しない
 */
import { applyThemeColors, themeImageUrls } from './themes.js';
import { createBarcodeElement } from './barcode.js';

/** POPセルを生成 */
export function createPopCell(conf, item, theme) {
  const cell = document.createElement('div');
  const layoutClass = conf.isVertical ? 'pop-layout-top' : 'pop-layout-left';
  cell.className = `pop-cell ${conf.cssClass} ${layoutClass}`;

  applyThemeColors(cell, theme);

  const isMix = Boolean(item.mix && conf.mixMatch);
  cell.innerHTML = `
    <div class="pop-content">
      <div class="pop-comment">${escapeHtml(item.comment)}</div>
      <div class="pop-maker">${escapeHtml(item.maker)}</div>
      <div class="pop-name">${escapeHtml(item.name)}</div>
      <div class="pop-qty-group">
        <span class="pop-qty">${escapeHtml(item.qty1)}</span>
        <span class="pop-qty">${escapeHtml(item.qty2)}</span>
      </div>
      ${isMix ? mixPriceHtml(item) : normalPriceHtml(item)}
      <div class="pop-bottom">${isMix ? '' : taxInclHtml(item.price)}</div>
    </div>
  `;

  // POP の最下部に 税込価格（通常の価格のときだけ）・JAN バーコードと数字・医薬品リスク区分 を入れる。
  // 並べ方はサイズごとに CSS（--pop-bottom-areas）で決める。
  // リスク区分が未記入・「通常商品」（修正フォームや CSV で入力されたもの）でも、空の要素は作る。バーコードを印字しない商品も、空の要素で場所だけ空けておく
  // （価格の位置を他の POP とそろえる）
  const bottom = cell.querySelector('.pop-bottom');
  const barcode = createBarcodeElement(item.noBarcode ? '' : item.jan);
  const risk = document.createElement('div');
  risk.className = 'pop-risk-tag';
  risk.textContent = displayRisk(item.risk);
  bottom.append(barcode, risk);

  const image = themeImageUrls(theme, conf.key);
  if (!image) return cell;

  // riskUnderImage のサイズ（A8ヨコ・A6ハーフ）は、医薬品区分とバーコードを POP の最下段（.pop-foot）へ出し、
  // 医薬品区分を画像の下・バーコードを商品情報の下に置く。画像は商品情報と同じ高さに伸ばす（CSS の .pop-has-foot）
  let foot = null;
  if (conf.riskUnderImage && !conf.isVertical) {
    foot = document.createElement('div');
    foot.className = 'pop-foot';
    foot.append(risk, barcode);
    cell.appendChild(foot);
    cell.classList.add('pop-has-foot');
  }

  // 画像が読み込めずに消えたときは、画像なしの配置に戻す（左側に空白を残さない）。
  // 商品情報の欄が広がるので、描画時に縮めた価格の大きさも測り直す
  // （fitPopText は描画直後に呼ばれるため、画像が消える前の狭い欄で縮めたままになっている）
  cell.prepend(createImageContainer(image.src, image.fallback, () => {
    if (foot) {
      bottom.append(barcode, risk);
      foot.remove();
      cell.classList.remove('pop-has-foot');
    }
    if (cell.isConnected) fitPopText(cell);
  }));

  return cell;
}

/** 通常の価格（「税抜」＋大きな税抜価格、その下に赤い線）。税込価格は最下部（.pop-bottom）に置く */
function normalPriceHtml(item) {
  return `
      <div class="pop-price">
        ${priceRowHtml(item.priceExcl)}
        <div class="pop-divider"></div>
      </div>`;
}

/**
 * ミックスマッチの価格。「1個」と「◯個」の価格を左右に並べ、それぞれの左端に赤い楕円のバッジ、下に赤い線・税込価格を付ける。
 * 「◯個」は通常の価格と同じ大きさ、「1個」は少し小さく（CSS の --pop-mix-single-ratio）。
 * どちらも通常の価格と同じ部品（.pop-price-row）なので、fitPopText による文字の縮小もそのまま効く
 */
function mixPriceHtml(item) {
  const mix = item.mix;
  return `
      <div class="pop-price pop-mix">
        ${mixBlockHtml('is-single', '1', item.priceExcl, item.price)}
        ${mixBlockHtml('is-bundle', mix.qty, mix.priceExcl, mix.price)}
      </div>`;
}

function mixBlockHtml(className, qty, priceExcl, price) {
  return `
        <div class="pop-mix-block ${className}">
          ${priceRowHtml(priceExcl, `<span class="pop-mix-badge">${escapeHtml(qty)}個</span>`)}
          <div class="pop-divider"></div>
          ${taxInclHtml(price)}
        </div>`;
}

/** （ミックスマッチのバッジ＋）「税抜」＋税抜価格＋「円」の1行。バッジは行の左端に置く */
function priceRowHtml(priceExcl, badgeHtml = '') {
  return `<div class="pop-price-row">
          ${badgeHtml}<span class="pop-price-label"><span class="pop-price-tax">税抜</span></span>
          <span class="pop-price-excl">${yen(priceExcl)}</span><span class="unit">円</span>
        </div>`;
}

/** 税込価格（「税込」と「円」は数字より小さく） */
function taxInclHtml(price) {
  return `<div class="pop-tax-incl"><span class="label">税込</span>${yen(price)}<span class="unit">円</span></div>`;
}

function yen(value) {
  return (Number(value) || 0).toLocaleString();
}

/**
 * 税抜価格が「税抜」の文字と並んで1行に入り切らない場合（桁の多い価格・ミックスマッチで欄が狭いときなど）は、
 * 価格の数字だけを縮めて1行に収める（「税抜」と「円」は縮めない）。最小で元の50%（ミックスマッチは35%）。
 * 画面に配置した後（レイアウト確定後）に呼ぶこと
 */
export function fitPopText(root) {
  const rows = [...root.querySelectorAll('.pop-price-row')];
  for (const row of rows) {
    const price = row.querySelector('.pop-price-excl');
    if (price) price.style.fontSize = '';           // デザインを変えて描き直したときのためにリセット
  }
  // ミックスマッチは片方を縮めるともう片方の欄の幅が変わるため、全体を最大3回見直す
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const row of rows) {
      if (fitRow(row)) changed = true;
    }
    if (!changed) break;
  }
}

/** 1行分の価格を縮めて収める。縮めたら true */
function fitRow(row) {
  const price = row.querySelector('.pop-price-excl');
  if (!price) return false;
  const style = price.style.fontSize;
  price.style.fontSize = '';
  const original = parseFloat(getComputedStyle(price).fontSize);
  price.style.fontSize = style;
  // ミックスマッチは価格を2つ並べて欄が狭いので、通常の価格より小さくまで縮めてよい
  const minSize = original * (row.closest('.pop-mix') ? 0.35 : 0.5);

  let changed = false;
  // 文字の幅は大きさにぴったり比例しないため、収まるまで最大3回縮め直す
  for (let i = 0; i < 3; i++) {
    const overflow = row.scrollWidth - row.clientWidth;
    if (overflow <= 0) break;
    const width = price.offsetWidth;                // 回転配置でも回転前の幅を使う
    const size = parseFloat(getComputedStyle(price).fontSize);
    const next = Math.max(minSize, size * (width - overflow) / width * 0.97);
    if (next >= size) break;                        // これ以上は縮められない
    price.style.fontSize = `${next}px`;
    changed = true;
  }
  return changed;
}

/** 画像エリア。読み込み失敗時はフォールバック → それも無ければエリアごと削除して onRemove を呼ぶ */
function createImageContainer(src, fallback, onRemove) {
  const container = document.createElement('div');
  container.className = 'pop-image-container';

  const img = document.createElement('img');
  img.alt = '';
  let nextSrc = fallback;
  img.addEventListener('error', () => {
    if (nextSrc) {
      img.src = nextSrc;
      nextSrc = '';
    } else {
      container.remove();
      onRemove?.();
    }
  });
  img.src = src;

  container.appendChild(img);
  return container;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
