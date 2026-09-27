/**
 * 価格の計算（マスタWorker・スキャン画面で共有）
 */

// 税率（税抜価格が空のとき 税込 ÷ TAX_RATE を四捨五入して補う）
export const TAX_RATE = 1.1;

/** 税込価格から税抜価格を計算 */
export function calcPriceExcl(priceIncl) {
  return Math.round((Number(priceIncl) || 0) / TAX_RATE);
}
