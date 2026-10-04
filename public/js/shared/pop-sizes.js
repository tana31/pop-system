/**
 * POP規格（サイズ）の定義（スキャン画面・プレビュー画面で共有。DOMには触らない）
 *
 * ★ POP のサイズを追加するときは、ここに1件追加し、
 *    css/pop-styles.css に .pop-size-* を追加するだけでよい
 *    （スキャン画面の枚数欄はこの定義から自動で作られる）
 *
 * label:   スキャン画面の枚数欄に出す名前
 * primary: true ならスキャン画面で常時表示、false なら「⚙️ 他サイズ」の中
 * mixed:   混載モード（A4ヨコ 8列×4行グリッド）で占有するマス数
 *          1マス = 幅 37.125mm × 高さ 52.5mm（＝A9タテ1枚分）
 *          rotate: true の場合、POPを90°回転させて配置（A5ヨコ用）
 * mixMatch: true ならミックスマッチ（◯個の価格）を表示する。false のサイズは通常の価格だけ
 */

// スキャン・検索で追加したときに 1枚 を入れるサイズ（同じJANの再スキャンでもこのサイズが +1）
export const DEFAULT_SIZE_KEY = 'a9';

export const MIXED_GRID = {
  cols: 8,
  rows: 4,
  cellW: 37.125, // mm (297 / 8)
  cellH: 52.5    // mm (210 / 4)
};

export const SIZE_CONFIGS = {
  a9: {
    key: 'a9',
    label: 'A9タテ',
    name: 'A9タテ (32面)',
    primary: true,
    cols: 8, rows: 4,
    isLandscapePage: true,  // A4ヨコ置き用紙（297mm × 210mm）
    isVertical: true,       // 縦長デザイン（上部画像）
    blocks: 1,
    mixed: { w: 1, h: 1 },  // 37.125mm × 52.5mm
    cssClass: 'pop-size-a9',
    mixMatch: false         // 幅が狭いので表示しない
  },
  a8: {
    key: 'a8',
    label: 'A8ヨコ',
    name: 'A8ヨコ (16面)',
    primary: true,
    cols: 4, rows: 4,
    isLandscapePage: true,
    isVertical: false,      // 横長デザイン（左側画像）
    blocks: 2,
    mixed: { w: 2, h: 1 },  // 74.25mm × 52.5mm
    cssClass: 'pop-size-a8',
    mixMatch: true
  },
  a6half: {
    key: 'a6half',
    label: 'A6ハーフ',
    name: 'A6ハーフ (8面)',
    primary: true,
    cols: 2, rows: 4,
    isLandscapePage: true,
    isVertical: false,
    blocks: 4,
    mixed: { w: 4, h: 1 },  // 148.5mm × 52.5mm
    cssClass: 'pop-size-a6half',
    mixMatch: true
  },
  a6: {
    key: 'a6',
    label: 'A6ヨコ',
    name: 'A6ヨコ (4面)',
    primary: false,
    cols: 2, rows: 2,
    isLandscapePage: true,
    isVertical: false,
    blocks: 8,
    mixed: { w: 4, h: 2 },  // 148.5mm × 105mm
    cssClass: 'pop-size-a6',
    mixMatch: true
  },
  a5: {
    key: 'a5',
    label: 'A5ヨコ',
    name: 'A5ヨコ (2面)',
    primary: false,
    cols: 1, rows: 2,
    isLandscapePage: false, // A4タテ置き用紙（210mm × 297mm）を半分に切って 210mm × 148.5mm の横長POPにする
    isVertical: false,
    blocks: 16,
    mixed: { w: 4, h: 4, rotate: true }, // 148.5mm × 210mm の枠に90°回転して配置
    cssClass: 'pop-size-a5',
    mixMatch: true
  },
  a4: {
    key: 'a4',
    label: 'A4ヨコ',
    name: 'A4ヨコ (1面)',
    primary: false,
    cols: 1, rows: 1,
    isLandscapePage: true,
    isVertical: false,
    blocks: 32,
    mixed: { w: 8, h: 4 },  // 297mm × 210mm
    cssClass: 'pop-size-a4',
    mixMatch: true
  }
};

/** 新しく追加する商品の初期枚数（DEFAULT_SIZE_KEY だけ 1、他は 0） */
export function createDefaultCounts() {
  const counts = {};
  for (const key of Object.keys(SIZE_CONFIGS)) counts[key] = key === DEFAULT_SIZE_KEY ? 1 : 0;
  return counts;
}
