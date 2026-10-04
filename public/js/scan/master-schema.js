/**
 * 商品マスタの列定義と、マスタの行 →「商品データ」への変換（★列名はこのファイルだけで管理する★）
 *
 * 列定義と行の変換を使うのはマスタWorker（master-worker.js）だけ。CSV 読み込み（csv-import.js）と
 * スキャン画面（scan-app.js、手入力の JAN）は normalizeJan などの正規化だけを使う。
 * 画面側（スキャン画面・プレビュー画面）は列名を知らず、変換済みの商品データだけを扱う。
 *
 * マスタは軽量化バッチ（pop-master-batch.ps1）が作る次の形の CSV で、/api/master が
 * { version, headers, rows } に変換して返す:
 *   type,jan,store,taxRate,priceExcl,price,maker,name,qty1,qty2,comment,risk
 *   I 行 … 1商品1行。共通項目と標準価格（store は空）
 *   P 行 … 標準価格と違う店舗だけの例外価格（jan・store・priceExcl・price だけが入る）
 * 列の並びが変わっても見出しの名前で探すので動く。列名を変えるときはバッチ・Worker（index.js の
 * MASTER_HEADER）・このファイルの COLUMNS を揃えて変える。
 *
 * 商品データの形（画面に渡す・印刷キューに保存する形）:
 *   {
 *     jan: string,        // 正規化済み（全角→半角、空白・ハイフン除去）
 *     name, maker, comment, qty1, qty2, risk: string,  // risk は「通常商品」なら空
 *     priceExcl: number,  // 税抜価格（店舗の例外価格があればそちら）
 *     price: number,      // 税込価格（同上）
 *     taxRate: number|null // 税率（%）。null なら修正フォームで税込を自動計算しない
 *   }
 * マスタから作る商品データの jan は必ず入っている。手入力・CSV の商品は jan が空のことがあり、
 * 印刷キューでは noBarcode（true なら JAN を印字しない）が加わることがある（shared/print-queue.js 冒頭）
 */

export const COLUMNS = {
  type:      'type',
  jan:       'jan',
  store:     'store',
  taxRate:   'taxRate',
  priceExcl: 'priceExcl',
  price:     'price',
  maker:     'maker',
  name:      'name',
  qty1:      'qty1',
  qty2:      'qty2',
  comment:   'comment',
  risk:      'risk'
};

/** 行の種別 */
export const ROW_TYPE = { ITEM: 'I', PRICE: 'P' };

// 必須列（1つでも無ければマスタの形式が違うとみなす）
export const REQUIRED_KEYS = Object.keys(COLUMNS);

// POP に表示しない医薬品区分の値（医薬品以外の商品）
export const HIDDEN_RISK_LABELS = ['通常商品'];

/** JAN: 全角数字→半角、空白・ハイフン除去 */
export function normalizeJan(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\s-]/g, '');
}

/** 店舗番号: 全角数字→半角、空白除去（先頭の 0 は残す） */
export function normalizeStore(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s/g, '');
}

/** 価格: 「1,000」「¥1000」「１０００円」なども数値に変換（変換できなければ 0） */
export function parsePrice(value) {
  const s = String(value ?? '').normalize('NFKC').replace(/[¥￥,円\s]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** 税率: 空や数字でなければ null */
function parseTaxRate(value) {
  const s = String(value ?? '').normalize('NFKC').replace(/[%\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 見出しに無い必須列のキーを返す */
export function findMissingRequired(headers) {
  return REQUIRED_KEYS.filter(key => !headers.includes(COLUMNS[key]));
}

/**
 * 見出し行から「行 → 値」の読み取り関数を作る。
 * 列番号の検索は最初に1回だけ行い、以後は行ごとに番号で読むだけにする（10万件でも速い）
 */
export function createRowReader(headers) {
  const cols = {};
  for (const key of Object.keys(COLUMNS)) cols[key] = headers.indexOf(COLUMNS[key]);

  const read = (row, key) => {
    const c = cols[key];
    if (c < 0) return '';
    const v = row[c];
    return v == null ? '' : String(v).trim();
  };

  return {
    type:  row => read(row, 'type'),
    jan:   row => normalizeJan(read(row, 'jan')),
    store: row => normalizeStore(read(row, 'store')),
    name:  row => read(row, 'name'),

    /**
     * 商品行（I 行）を商品データに変換する。
     * priceRow に店舗の例外価格行（P 行）を渡すと、価格だけそちらを使う
     */
    toItem(row, priceRow = null) {
      const p = priceRow || row;
      const risk = read(row, 'risk');
      return {
        jan:       normalizeJan(read(row, 'jan')),
        name:      read(row, 'name'),
        maker:     read(row, 'maker'),
        priceExcl: parsePrice(read(p, 'priceExcl')),
        price:     parsePrice(read(p, 'price')),
        taxRate:   parseTaxRate(read(row, 'taxRate')),
        comment:   read(row, 'comment'),
        qty1:      read(row, 'qty1'),
        qty2:      read(row, 'qty2'),
        risk:      HIDDEN_RISK_LABELS.includes(risk) ? '' : risk
      };
    }
  };
}
