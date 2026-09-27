/**
 * 商品マスタの列定義と、CSVの1行 →「商品データ」への変換（★列名はこのファイルだけで管理する★）
 *
 * 使うのはマスタWorker（master-worker.js）だけ。
 * 画面側（スキャン画面・プレビュー画面）は列名を知らず、変換済みの商品データだけを扱う。
 *
 * 取得元のCSVの列名が変わったら、COLUMNS の候補に新しい列名を追加するだけでよい。
 * 候補は左から順に探し、最初に値が入っていた列を使う。
 *
 * 商品データの形（画面に渡す・印刷キューに保存する形）:
 *   {
 *     jan: string,        // 正規化済み（全角→半角、空白・ハイフン除去）
 *     name, maker, comment, qty1, qty2, risk: string,
 *     price: number,      // 税込価格
 *     priceExcl: number   // 税抜価格（列が空なら 税込 ÷ 1.1 を四捨五入）
 *   }
 */

export const COLUMNS = {
  jan:       ['JANコード', 'JAN', 'jan'],
  name:      ['品名', '商品名'],
  maker:     ['製造メーカー', 'メーカー'],
  price:     ['販売価格(税込)', '税込価格'],
  priceExcl: ['販売価格(税抜)', '税抜価格'],
  comment:   ['コメント', 'アピール文'],
  qty1:      ['数量1', '内容量'],
  qty2:      ['数量2', '規格'],
  risk:      ['リスク分類', '医薬品区分']
};

// 必須列（見つからなければコンソールに警告）
export const REQUIRED_KEYS = ['jan', 'name', 'price'];

const TAX_RATE = 1.1;

/** JAN: 全角数字→半角、空白・ハイフン除去 */
export function normalizeJan(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\s-]/g, '');
}

/** 価格: 「1,000」「¥1000」「１０００円」なども数値に変換（変換できなければ 0） */
export function parsePrice(value) {
  const s = String(value ?? '').normalize('NFKC').replace(/[¥￥,円\s]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** CSVの見出しに無い必須列のキーを返す */
export function findMissingRequired(headers) {
  return REQUIRED_KEYS.filter(key => !COLUMNS[key].some(col => headers.includes(col)));
}

/**
 * 見出し行から「行 → 値」の読み取り関数を作る。
 * 列番号の検索は最初に1回だけ行い、以後は行ごとに番号で読むだけにする（10万件でも速い）
 */
export function createRowReader(headers) {
  const cols = {};
  for (const key of Object.keys(COLUMNS)) {
    cols[key] = COLUMNS[key].map(n => headers.indexOf(n)).filter(i => i >= 0);
  }

  const read = (row, key) => {
    for (const c of cols[key]) {
      const v = row[c];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };

  return {
    jan:  row => normalizeJan(read(row, 'jan')),
    name: row => read(row, 'name'),

    /** 1行を商品データに変換 */
    toItem(row) {
      const price = parsePrice(read(row, 'price'));
      const rawExcl = read(row, 'priceExcl');
      return {
        jan:       normalizeJan(read(row, 'jan')),
        name:      read(row, 'name'),
        maker:     read(row, 'maker'),
        price,
        priceExcl: rawExcl ? parsePrice(rawExcl) : Math.round(price / TAX_RATE),
        comment:   read(row, 'comment'),
        qty1:      read(row, 'qty1'),
        qty2:      read(row, 'qty2'),
        risk:      read(row, 'risk')
      };
    }
  };
}
