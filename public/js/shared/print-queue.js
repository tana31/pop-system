/**
 * 印刷キュー（スキャン画面 → プレビュー画面の受け渡し）
 * localStorage を読み書きするのはこのファイルだけ。
 *
 * キューの形:
 *   [{ item: 商品データ（形は scan/master-schema.js 冒頭）,
 *      counts: { a9: 枚数, a8: 枚数, ... },
 *      showOptions: boolean,   // スキャン画面で「他サイズ」を開いているか
 *      edited?: boolean,       // スキャン画面で商品情報を修正したか
 *      source?: 'csv' | 'manual' }]  // 追加元（無ければマスタ。manual は手入力でマスタの値を持たない）
 *
 * item.jan は空文字でもよい（手入力・「〇〇 各種」の POP）。JAN が空の行や item.noBarcode が true の行は
 * バーコードを印字しない。以前の形式（jan が必ず入っている）もそのまま読めるので、キーの番号は変えていない
 */
import { SIZE_CONFIGS } from './pop-sizes.js';

// ※ キューの中身の形式を変えたら末尾の番号を上げる（古い形式は読まれなくなる）
export const QUEUE_STORAGE_KEY = 'pop_print_queue_v2';

/** 枚数指定を整数に変換（不正値は0） */
export function toCount(value) {
  return Math.max(0, parseInt(value, 10) || 0);
}

/** 保存済みのキューを読み込む（壊れた行は除き、サイズ追加後も欠けた枚数欄を 0 で補う） */
export function loadQueue() {
  try {
    const saved = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    const zero = Object.fromEntries(Object.keys(SIZE_CONFIGS).map(key => [key, 0]));
    return saved
      .filter(q => q && q.item && typeof q.item.jan === 'string' && q.counts)
      .map(q => ({ ...q, counts: { ...zero, ...q.counts } }));
  } catch (err) {
    console.error('印刷キューの読み込みに失敗しました', err);
    return [];
  }
}

/** キューを保存する */
export function saveQueue(queue) {
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
  } catch (err) {
    console.warn('印刷キューの保存に失敗しました', err);
  }
}

/** 印刷合計枚数 */
export function countTotalPops(queue) {
  return queue.reduce((sum, q) => sum + Object.values(q.counts || {}).reduce((s, c) => s + toCount(c), 0), 0);
}
