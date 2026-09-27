/**
 * POP規格・面付け設定オブジェクト（正寸規格・面付け定義）
 */
const SIZE_CONFIGS = {
  a9: {
    key: 'a9',
    name: 'A9タテ (32面)',
    cols: 8, rows: 4,
    isLandscapePage: true,  // A4ヨコ置き用紙（297mm × 210mm）
    isVertical: true,       // 縦長デザイン（上部画像）
    blocks: 1,
    cssClass: 'pop-size-a9'
  },
  a8: {
    key: 'a8',
    name: 'A8ヨコ (16面)',
    cols: 4, rows: 4,
    isLandscapePage: true,  // A4ヨコ置き用紙
    isVertical: false,      // 横長デザイン（左側画像）
    blocks: 2,
    cssClass: 'pop-size-a8'
  },
  a6half: {
    key: 'a6half',
    name: 'A6ハーフ (8面)',
    cols: 2, rows: 4,
    isLandscapePage: true,  // A4ヨコ置き用紙
    isVertical: false,      // 横長デザイン（左側画像）
    blocks: 4,
    cssClass: 'pop-size-a6half'
  },
  a6: {
    key: 'a6',
    name: 'A6ヨコ (4面)',
    cols: 2, rows: 2,
    isLandscapePage: true,  // A4ヨコ置き用紙
    isVertical: false,      // 横長デザイン（左側画像）
    blocks: 8,
    cssClass: 'pop-size-a6'
  },
  a5: {
    key: 'a5',
    name: 'A5ヨコ (2面)',
    cols: 1, rows: 2,
    isLandscapePage: false, // A4タテ置き用紙（210mm × 297mm）で切り取ると「幅210mm × 高さ148.5mm」の美しい横長POPになります
    isVertical: false,      // 横長デザイン（左側画像）
    blocks: 16,
    cssClass: 'pop-size-a5'
  },
  a4: {
    key: 'a4',
    name: 'A4ヨコ (1面)',
    cols: 1, rows: 1,
    isLandscapePage: true,  // A4ヨコ置き用紙
    isVertical: false,      // 横長デザイン（左側画像）
    blocks: 32,
    cssClass: 'pop-size-a4'
  }
};
