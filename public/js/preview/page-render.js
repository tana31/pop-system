/**
 * ページ記述（imposition.js の出力）から A4ページのDOMを生成
 */
import { ROTATE_SLOT_CLASS, ROTATE_INNER_CLASS } from './constants.js';
import { createPopCell } from './pop-cell.js';

export function renderPage(pageDesc, theme) {
  const page = document.createElement('div');
  page.className = `a4-page ${pageDesc.orientation}`;

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  // 1fr だと中身に引っ張られてマス寸法がずれるため mm で固定
  grid.style.gridTemplateColumns = `repeat(${pageDesc.cols}, ${pageDesc.trackW}mm)`;
  grid.style.gridTemplateRows = `repeat(${pageDesc.rows}, ${pageDesc.trackH}mm)`;
  grid.style.width = '100%';
  grid.style.height = '100%';

  pageDesc.placements.forEach(pl => {
    const cell = createPopCell(pl.conf, pl.item, theme);
    const area = pl.rotate ? wrapRotatedCell(cell, pl, pageDesc) : cell;
    area.style.gridColumn = `${pl.col + 1} / span ${pl.colSpan}`;
    area.style.gridRow = `${pl.row + 1} / span ${pl.rowSpan}`;
    grid.appendChild(area);
  });

  page.appendChild(grid);
  return page;
}

/**
 * 横長POP（A5ヨコ）を縦長の枠へ -90°回転して収める。
 * PDF出力で回転画像を貼り付けるため、枠の位置・寸法（mm）を data 属性に持たせる
 */
function wrapRotatedCell(cell, pl, pageDesc) {
  const areaW = pl.colSpan * pageDesc.trackW;
  const areaH = pl.rowSpan * pageDesc.trackH;

  const wrapper = document.createElement('div');
  wrapper.className = ROTATE_SLOT_CLASS;
  wrapper.dataset.x = pl.col * pageDesc.trackW;
  wrapper.dataset.y = pl.row * pageDesc.trackH;
  wrapper.dataset.w = areaW;
  wrapper.dataset.h = areaH;
  Object.assign(wrapper.style, {
    position: 'relative',
    overflow: 'hidden',
    width: '100%',
    height: '100%'
  });

  // POP本来の向き（横長）で作り、枠の中心を軸に回転
  cell.classList.add(ROTATE_INNER_CLASS);
  Object.assign(cell.style, {
    position: 'absolute',
    width: `${areaH}mm`,
    height: `${areaW}mm`,
    left: `${(areaW - areaH) / 2}mm`,
    top: `${(areaH - areaW) / 2}mm`,
    transformOrigin: 'center center',
    transform: 'rotate(-90deg)'
  });

  wrapper.appendChild(cell);
  return wrapper;
}

/** 印刷対象が無いときの案内 */
export function renderEmptyState() {
  const box = document.createElement('div');
  box.className = 'bg-white p-12 rounded-xl text-center space-y-4 shadow max-w-xl mx-auto';
  box.innerHTML = `
    <div class="text-4xl">⚠️</div>
    <div class="text-lg font-bold text-slate-800">印刷プレビュー対象の枚数が指定されていません</div>
    <p class="text-sm text-slate-500">スキャン画面で枚数を指定してから進んでください。</p>
    <div>
      <a href="index.html" class="inline-block bg-indigo-600 text-white font-bold px-6 py-2 rounded-lg text-sm">
        スキャン画面に戻る
      </a>
    </div>
  `;
  return box;
}
