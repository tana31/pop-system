/**
 * POP規格・面付け設定オブジェクト（正寸規格・面付け定義）
 *
 * mixed: 混載モード（A4ヨコ 8列×4行グリッド）で占有するマス数
 *   1マス = 幅 37.125mm × 高さ 52.5mm（＝A9タテ1枚分）
 *   rotate: true の場合、POPを90°回転させて配置（A5ヨコ用）
 */
const MIXED_GRID = {
  cols: 8,
  rows: 4,
  cellW: 37.125, // mm (297 / 8)
  cellH: 52.5    // mm (210 / 4)
};

const SIZE_CONFIGS = {
  a9: {
    key: 'a9',
    name: 'A9タテ (32面)',
    cols: 8, rows: 4,
    isLandscapePage: true,  // A4ヨコ置き用紙（297mm × 210mm）
    isVertical: true,       // 縦長デザイン（上部画像）
    blocks: 1,
    mixed: { w: 1, h: 1 },  // 37.125mm × 52.5mm
    cssClass: 'pop-size-a9'
  },
  a8: {
    key: 'a8',
    name: 'A8ヨコ (16面)',
    cols: 4, rows: 4,
    isLandscapePage: true,  // A4ヨコ置き用紙
    isVertical: false,      // 横長デザイン（左側画像）
    blocks: 2,
    mixed: { w: 2, h: 1 },  // 74.25mm × 52.5mm
    cssClass: 'pop-size-a8'
  },
  a6half: {
    key: 'a6half',
    name: 'A6ハーフ (8面)',
    cols: 2, rows: 4,
    isLandscapePage: true,  // A4ヨコ置き用紙
    isVertical: false,      // 横長デザイン（左側画像）
    blocks: 4,
    mixed: { w: 4, h: 1 },  // 148.5mm × 52.5mm
    cssClass: 'pop-size-a6half'
  },
  a6: {
    key: 'a6',
    name: 'A6ヨコ (4面)',
    cols: 2, rows: 2,
    isLandscapePage: true,  // A4ヨコ置き用紙
    isVertical: false,      // 横長デザイン（左側画像）
    blocks: 8,
    mixed: { w: 4, h: 2 },  // 148.5mm × 105mm
    cssClass: 'pop-size-a6'
  },
  a5: {
    key: 'a5',
    name: 'A5ヨコ (2面)',
    cols: 1, rows: 2,
    isLandscapePage: false, // A4タテ置き用紙（210mm × 297mm）で切り取ると「幅210mm × 高さ148.5mm」の美しい横長POPになります
    isVertical: false,      // 横長デザイン（左側画像）
    blocks: 16,
    mixed: { w: 4, h: 4, rotate: true }, // 148.5mm × 210mm の枠に90°回転して配置
    cssClass: 'pop-size-a5'
  },
  a4: {
    key: 'a4',
    name: 'A4ヨコ (1面)',
    cols: 1, rows: 1,
    isLandscapePage: true,  // A4ヨコ置き用紙
    isVertical: false,      // 横長デザイン（左側画像）
    blocks: 32,
    mixed: { w: 8, h: 4 },  // 297mm × 210mm
    cssClass: 'pop-size-a4'
  }
};
