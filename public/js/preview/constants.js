/**
 * プレビュー画面で共有する定数
 */

// pop-config.js（従来型スクリプト）で定義されたグローバル設定をモジュールから参照する窓口
// ※ preview.html で pop-config.js を preview.js より先に読み込むこと
export const sizeConfigs = SIZE_CONFIGS;
export const mixedGrid = MIXED_GRID;

// A4用紙の寸法（mm）
export const PAGE_MM = {
  landscape: { w: 297, h: 210 },
  portrait:  { w: 210, h: 297 }
};

// データ取得先
export const QUEUE_STORAGE_KEY = 'pop_print_queue';
export const THEMES_URL = '/api/themes';
export const THEME_IMAGE_BASE_URL = '/api/theme-image/';

// 専用画像（例: sale_a9.png）を使うサイズ
export const SIZES_WITH_DEDICATED_IMAGE = ['a9'];

// 回転配置（A5ヨコの混載）の目印クラス。ページ描画とPDF出力で共有
export const ROTATE_SLOT_CLASS = 'pop-rotate-slot';
export const ROTATE_INNER_CLASS = 'pop-rotate-inner';
