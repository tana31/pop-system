/**
 * POPセル（1枚分）のDOM生成
 */
import { THEME_IMAGE_BASE_URL, SIZES_WITH_DEDICATED_IMAGE } from './constants.js';

// 商品データの項目名の揺れ（先に見つかったものを採用）
const FIELD_ALIASES = {
  comment:   ['コメント', 'アピール文'],
  maker:     ['製造メーカー', 'メーカー'],
  name:      ['品名', '商品名'],
  qty1:      ['数量1', '内容量'],
  qty2:      ['数量2', '規格'],
  risk:      ['リスク分類', '医薬品区分'],
  priceIncl: ['販売価格(税込)', '税込価格'],
  priceExcl: ['販売価格(税抜)', '税抜価格']
};

// テーマの設定項目 → CSS変数
const THEME_CSS_VARS = {
  bgColor:      '--pop-bg-standard',
  commentColor: '--pop-color-comment',
  priceColor:   '--pop-color-price-red'
};

const TAX_RATE = 1.1;

/** POPセルを生成 */
export function createPopCell(conf, rawItem, theme) {
  const cell = document.createElement('div');
  const layoutClass = conf.isVertical ? 'pop-layout-top' : 'pop-layout-left';
  cell.className = `pop-cell ${conf.cssClass} ${layoutClass}`;

  applyThemeColors(cell, theme);

  const d = normalizeItem(rawItem);
  cell.innerHTML = `
    <div class="pop-content">
      <div class="pop-comment">${escapeHtml(d.comment)}</div>
      <div class="pop-maker">${escapeHtml(d.maker)}</div>
      <div class="pop-name">${escapeHtml(d.name)}</div>
      <div class="pop-qty-group">
        <span class="truncate">${escapeHtml(d.qty1)}</span>
        <span class="truncate">${escapeHtml(d.qty2)}</span>
      </div>
      <div class="pop-tax-excl-container">
        <span class="pop-tax-badge-black">税抜</span>
        <div class="pop-price-excl">
          ${d.priceExcl.toLocaleString()}<span class="unit">円</span>
        </div>
      </div>
      <div class="pop-divider"></div>
      <div class="pop-tax-incl">(税込) ${d.priceIncl.toLocaleString()}円</div>
      <div class="pop-risk-tag">${escapeHtml(d.risk)}</div>
    </div>
  `;

  const image = resolveImageUrls(theme, conf.key);
  if (image) cell.prepend(createImageContainer(image.src, image.fallback));

  return cell;
}

/** 項目名の揺れを吸収し、価格を数値化 */
function normalizeItem(item = {}) {
  const pick = key => {
    for (const field of FIELD_ALIASES[key]) {
      if (item[field]) return item[field];
    }
    return '';
  };

  const priceIncl = Number(pick('priceIncl') || 0);
  const rawExcl = pick('priceExcl');
  const priceExcl = rawExcl ? Number(rawExcl) : Math.round(priceIncl / TAX_RATE);

  return {
    comment: pick('comment'),
    maker:   pick('maker'),
    name:    pick('name'),
    qty1:    pick('qty1'),
    qty2:    pick('qty2'),
    risk:    pick('risk'),
    priceIncl,
    priceExcl
  };
}

function applyThemeColors(cell, theme) {
  Object.entries(THEME_CSS_VARS).forEach(([themeKey, cssVar]) => {
    if (theme[themeKey]) cell.style.setProperty(cssVar, theme[themeKey]);
  });
}

/**
 * 画像URLを決定。専用画像があるサイズ（A9タテ）は sale.png → sale_a9.png を優先し、
 * 読み込めなければ通常画像にフォールバック
 */
function resolveImageUrls(theme, sizeKey) {
  if (!theme.image) return null;
  const baseUrl = THEME_IMAGE_BASE_URL + theme.image;

  if (SIZES_WITH_DEDICATED_IMAGE.includes(sizeKey)) {
    return { src: THEME_IMAGE_BASE_URL + toSizeVariantName(theme.image, sizeKey), fallback: baseUrl };
  }
  return { src: baseUrl, fallback: '' };
}

/** ファイル名の拡張子の前にサイズ名を付ける（sale.png → sale_a9.png） */
export function toSizeVariantName(fileName, sizeKey) {
  const dot = fileName.lastIndexOf('.');
  const slash = fileName.lastIndexOf('/');
  if (dot <= slash + 1) return `${fileName}_${sizeKey}`; // 拡張子なし
  return `${fileName.slice(0, dot)}_${sizeKey}${fileName.slice(dot)}`;
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
