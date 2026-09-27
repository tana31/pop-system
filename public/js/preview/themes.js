/**
 * デザイン（テーマ）：一覧の取得・画像URL・配色
 * テーマは R2 の themes/manifest.json（形は技術ドキュメント参照）。/api/* は index.js が配信する
 */
const THEMES_URL = '/api/themes';
const THEME_IMAGE_BASE_URL = '/api/theme-image/';

// 専用画像（例: sale.png → sale_a9.png）を優先して使うサイズ
const SIZES_WITH_DEDICATED_IMAGE = ['a9'];

// テーマの設定項目 → POPに上書きする CSS 変数（css/pop-styles.css）
const THEME_CSS_VARS = {
  bgColor:      '--pop-bg-standard',
  commentColor: '--pop-color-comment',
  priceColor:   '--pop-color-price-red'
};

/** デザイン（テーマ）一覧を取得 */
export async function fetchThemes() {
  const response = await fetch(THEMES_URL);
  if (!response.ok) throw new Error('デザイン一覧の取得に失敗しました');
  const list = await response.json();
  return Array.isArray(list) ? list : [];
}

/** テーマの配色を要素（POPセル）に適用 */
export function applyThemeColors(el, theme) {
  Object.entries(THEME_CSS_VARS).forEach(([themeKey, cssVar]) => {
    if (theme[themeKey]) el.style.setProperty(cssVar, theme[themeKey]);
  });
}

/**
 * 画像URLを決定。専用画像があるサイズ（A9タテ）は sale.png → sale_a9.png を優先し、
 * 読み込めなければ fallback（通常画像）を使う。画像なしのテーマは null
 */
export function themeImageUrls(theme, sizeKey) {
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
