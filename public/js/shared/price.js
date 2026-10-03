/**
 * 価格の計算（スキャン画面の修正フォームで使う）
 *
 * 税込 = 税抜 × (100 + 税率) ÷ 100 の切り捨て（基幹システムのマスタと同じ計算）
 * 税率は商品ごとにマスタの値を使う。税率が無い商品は計算しない（既定の税率は設けない）。
 */

/**
 * 税抜価格と税率（%）から税込価格を計算する。
 * 税率が無い（null・空）ときは null を返す（＝自動計算しない）
 */
export function calcPriceIncl(priceExcl, taxRate) {
  if (taxRate == null || taxRate === '') return null;
  const rate = Number(taxRate);
  if (!Number.isFinite(rate) || rate < 0) return null;
  return Math.floor((Number(priceExcl) || 0) * (100 + rate) / 100);
}
