/**
 * 商品マスタの列定義・値の読み方（★列名はこのファイルだけで管理する★）
 *
 * 画面（scan-app.js / preview側）と Web Worker（master-worker.js）の両方から読み込まれる。
 *   - スキャン画面:   <script src="js/master-schema.js" defer></script>
 *   - プレビュー画面: <script src="js/master-schema.js"></script>（preview.js より前）
 *   - Worker: importScripts('/js/master-schema.js')
 *
 * 取得元のCSVの列名が変わったら、COLUMNS の候補に新しい列名を追加するだけでよい。
 * 候補は左から順に探し、最初に値が入っていた列を使う。
 */
(function (global) {
  const COLUMNS = {
    // --- スキャン画面・検索で使う列 ---
    jan:       ['JANコード', 'JAN', 'jan'],
    name:      ['品名', '商品名'],
    maker:     ['製造メーカー', 'メーカー'],
    price:     ['販売価格(税込)', '税込価格'],   // 税込価格

    // --- POP（プレビュー・PDF）に表示する列 ---
    priceExcl: ['販売価格(税抜)', '税抜価格'],   // 無ければ税込価格から計算
    comment:   ['コメント', 'アピール文'],
    qty1:      ['数量1', '内容量'],
    qty2:      ['数量2', '規格'],
    risk:      ['リスク分類', '医薬品区分']
  };

  // 候補列を順に見て、最初に値が入っているものを返す
  function pick(item, key) {
    if (!item) return '';
    const candidates = COLUMNS[key] || [];
    for (let i = 0; i < candidates.length; i++) {
      const v = item[candidates[i]];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  // JAN: 全角数字→半角、空白・ハイフン除去
  function normalizeJan(value) {
    return String(value ?? '').normalize('NFKC').replace(/[\s-]/g, '');
  }

  // 価格: 「1,000」「¥1000」「１０００円」なども数値に変換（変換できなければ 0）
  function parsePrice(value) {
    const s = String(value ?? '').normalize('NFKC').replace(/[¥￥,円\s]/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  global.MasterSchema = Object.freeze({
    COLUMNS,
    pick,
    normalizeJan,
    parsePrice,
    getJan:   item => normalizeJan(pick(item, 'jan')),
    getName:  item => pick(item, 'name'),
    getMaker: item => pick(item, 'maker'),
    getPrice: item => parsePrice(pick(item, 'price'))
  });
})(self);
