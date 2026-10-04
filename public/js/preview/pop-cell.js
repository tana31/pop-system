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

  cell.innerHTML = `
    <div class="pop-content">
      <div class="pop-comment">${escapeHtml(item.comment)}</div>
      <div class="pop-maker">${escapeHtml(item.maker)}</div>
      <div class="pop-name">${escapeHtml(item.name)}</div>
      <div class="pop-qty-group">
        <span class="pop-qty">${escapeHtml(item.qty1)}</span>
        <span class="pop-qty">${escapeHtml(item.qty2)}</span>
      </div>
      ${item.mix && conf.mixMatch ? mixPriceHtml(item) : normalPriceHtml(item)}
    </div>
  `;

  // POP下部に JAN バーコードと数字、その下に医薬品リスク区分（左寄せ）を配置。
  // リスク区分が未記入でも要素は作る（CSSで1行分の高さを確保し、POPごとに位置がずれないようにしている）。
  // バーコードを印字しない商品も、空の要素で場所だけ空けておく（価格の位置を他の POP とそろえる）
  const content = cell.querySelector('.pop-content');
  content.appendChild(createBarcodeElement(item.noBarcode ? '' : item.jan));
  const risk = document.createElement('div');
  risk.className = 'pop-risk-tag';
  risk.textContent = item.risk ?? '';
  content.appendChild(risk);

  const image = themeImageUrls(theme, conf.key);
  if (image) cell.prepend(createImageContainer(image.src, image.fallback));

  return cell;
}

/** 通常の価格（税抜を大きく、その下に税込） */
function normalPriceHtml(item) {
  return `
      <div class="pop-tax-excl-container">
        <span class="pop-tax-badge-black">税抜</span>
        <div class="pop-price-excl">
          ${yen(item.priceExcl)}<span class="unit">円</span>
        </div>
      </div>
      <div class="pop-divider"></div>
      <div class="pop-tax-incl">(税込) ${yen(item.price)}<span class="unit">円</span></div>`;
}

/**
 * ミックスマッチの価格。上に「1個」の価格を1行で小さく、その下に「◯個」の価格を通常の価格と同じ大きさで並べる。
 * 「◯個」の部分は通常の価格と同じ部品（クラス）なので、fitPopText による文字の縮小もそのまま効く
 */
function mixPriceHtml(item) {
  const mix = item.mix;
  return `
      <div class="pop-mix">
        <div class="pop-mix-single">1個 税抜${yen(item.priceExcl)}円 (税込${yen(item.price)}円)</div>
        <div class="pop-tax-excl-container">
          <span class="pop-mix-label">
            <span class="pop-mix-qty">${escapeHtml(mix.qty)}個</span>
            <span class="pop-mix-tax-label">税抜</span>
          </span>
          <div class="pop-price-excl">
            ${yen(mix.priceExcl)}<span class="unit">円</span>
          </div>
        </div>
        <div class="pop-divider"></div>
        <div class="pop-tax-incl">(税込) ${yen(mix.price)}<span class="unit">円</span></div>
      </div>`;
}

function yen(value) {
  return (Number(value) || 0).toLocaleString();
}

/**
 * 余白を広げたぶん欄が狭くなるため、税抜価格が「税抜」バッジと並んで入り切らない場合は
 * 価格の文字だけを縮めて1行に収める（桁数の多い価格でも切れないように）。
 * 画面に配置した後（レイアウト確定後）に呼ぶこと
 */
export function fitPopText(root) {
  for (const box of root.querySelectorAll('.pop-tax-excl-container')) {
    const price = box.querySelector('.pop-price-excl');
    if (!price) continue;
    price.style.fontSize = '';                      // デザインを変えて描き直したときのためにリセット
    const overflow = box.scrollWidth - box.clientWidth;
    if (overflow <= 0) continue;

    const width = price.offsetWidth;                // 回転配置でも回転前の幅を使う
    const scale = Math.max(0.5, (width - overflow) / width * 0.97);
    const size = parseFloat(getComputedStyle(price).fontSize);
    price.style.fontSize = `${size * scale}px`;
  }
}

/** 画像エリア。読み込み失敗時はフォールバック → それも無ければエリアごと削除 */
function createImageContainer(src, fallback) {
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
