/**
 * 面付け計算（DOMに依存しない純粋なロジック）
 *
 * どちらのモードも、次の形の「ページ記述」の配列を返す:
 * {
 *   orientation: 'landscape' | 'portrait',
 *   cols, rows,          // グリッドの列数・行数
 *   trackW, trackH,      // 1マスの幅・高さ（mm）
 *   placements: [{ conf, item, col, row, colSpan, rowSpan, rotate }]  // col/row は0始まり
 * }
 */
import { PAGE_MM } from './constants.js';
import { toCount } from './data.js';

/** 規格ごとに用紙を分けるモード */
export function buildSeparatedPages(queue, sizeConfigs) {
  const pages = [];

  Object.entries(sizeConfigs).forEach(([sizeKey, conf]) => {
    const items = [];
    queue.forEach(q => {
      const count = q.counts ? toCount(q.counts[sizeKey]) : 0;
      for (let i = 0; i < count; i++) items.push(q.item);
    });

    const perPage = conf.cols * conf.rows;
    const orientation = conf.isLandscapePage ? 'landscape' : 'portrait';
    const { w, h } = PAGE_MM[orientation];

    for (let p = 0; p < items.length; p += perPage) {
      pages.push({
        orientation,
        cols: conf.cols,
        rows: conf.rows,
        trackW: w / conf.cols,
        trackH: h / conf.rows,
        placements: items.slice(p, p + perPage).map((item, i) => ({
          conf,
          item,
          col: i % conf.cols,
          row: Math.floor(i / conf.cols),
          colSpan: 1,
          rowSpan: 1,
          rotate: false
        }))
      });
    }
  });

  return pages;
}

/** 1枚のA4ヨコに混載するモード（大きい規格から First Fit で詰める） */
export function buildMixedPages(queue, sizeConfigs, grid) {
  const pops = [];
  queue.forEach(q => {
    if (!q.counts) return;
    Object.keys(q.counts).forEach(sizeKey => {
      const conf = sizeConfigs[sizeKey];
      if (!conf || !conf.mixed) return; // 未定義・混載非対応の規格は無視
      const count = toCount(q.counts[sizeKey]);
      for (let i = 0; i < count; i++) pops.push({ conf, item: q.item });
    });
  });

  // 大きい規格から配置（同サイズ内は元の順序を維持）
  pops.sort((a, b) => b.conf.blocks - a.conf.blocks);

  const pages = []; // { occupancy, placements }

  pops.forEach(({ conf, item }) => {
    const { w, h, rotate = false } = conf.mixed;

    let target = null;
    let pos = null;
    for (const page of pages) {
      pos = page.occupancy.findFreeSpot(w, h);
      if (pos) { target = page; break; }
    }

    if (!target) {
      const occupancy = new OccupancyGrid(grid.rows, grid.cols);
      pos = occupancy.findFreeSpot(w, h);
      if (!pos) return; // 用紙に収まらないサイズ（設定ミス）は配置しない
      target = { occupancy, placements: [] };
      pages.push(target);
    }

    target.occupancy.mark(pos.row, pos.col, w, h);
    target.placements.push({ conf, item, col: pos.col, row: pos.row, colSpan: w, rowSpan: h, rotate });
  });

  return pages.map(page => ({
    orientation: 'landscape',
    cols: grid.cols,
    rows: grid.rows,
    trackW: grid.cellW,
    trackH: grid.cellH,
    placements: page.placements
  }));
}

/** グリッドの使用状況を管理する */
class OccupancyGrid {
  constructor(rows, cols) {
    this.rows = rows;
    this.cols = cols;
    this.cells = Array.from({ length: rows }, () => new Array(cols).fill(false));
  }

  /** 左上から順に w×h が空いている位置を探す */
  findFreeSpot(w, h) {
    for (let row = 0; row <= this.rows - h; row++) {
      for (let col = 0; col <= this.cols - w; col++) {
        if (this.isFree(row, col, w, h)) return { row, col };
      }
    }
    return null;
  }

  isFree(row, col, w, h) {
    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        if (this.cells[row + dr][col + dc]) return false;
      }
    }
    return true;
  }

  mark(row, col, w, h) {
    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        this.cells[row + dr][col + dc] = true;
      }
    }
  }
}
