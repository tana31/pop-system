/**
 * データ読み込み（印刷キュー・デザイン一覧）
 */
import { QUEUE_STORAGE_KEY, THEMES_URL } from './constants.js';

/** スキャン画面から受け取った印刷キューを読み込む */
export function loadQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    const queue = raw ? JSON.parse(raw) : [];
    return Array.isArray(queue) ? queue : [];
  } catch (e) {
    console.error('Data parse error:', e);
    return [];
  }
}

/** 枚数指定を整数に変換（不正値は0） */
export function toCount(value) {
  return Math.max(0, parseInt(value, 10) || 0);
}

/** 印刷合計枚数 */
export function countTotalPops(queue) {
  return queue.reduce((sum, q) => {
    if (!q.counts) return sum;
    return sum + Object.values(q.counts).reduce((s, c) => s + toCount(c), 0);
  }, 0);
}

/** デザイン（テーマ）一覧を取得 */
export async function fetchThemes() {
  const response = await fetch(THEMES_URL);
  if (!response.ok) throw new Error('デザイン一覧の取得に失敗しました');
  const list = await response.json();
  return Array.isArray(list) ? list : [];
}
