/**
 * 商品リスト CSV の読み込み（スキャン画面の「CSVから読み込み」で使う。DOM には触らない）
 *
 * ルール:
 *  - 見出し行の列名で列を探す（並び順は自由、使わない列は省略可。全角・空白の違いは無視）
 *  - 商品情報の列が JAN だけなら「JAN のみ」とみなし、商品情報はマスタ（画面の店舗の価格）から取る。
 *    それ以外は CSV の値だけを使い、未記入の欄は空欄のまま（マスタで補わない）
 *  - ミックスマッチ・デザインID・枚数の列は「JAN のみ」の判定に含めず、どちらでも使える
 *  - 医薬品区分と税率は常にマスタから取る（マスタに無い商品は空欄・税率なし）
 *  - 枚数の列が1つも無ければ、全商品を既定のサイズ（DEFAULT_SIZE_KEY）1枚にする
 *  - エラーの行は読み込まない。注意（警告）の行は読み込む
 *
 * 商品データには、マスタの形（master-schema.js 冒頭）に次の2つが加わる:
 *   mix:     { qty, priceExcl, price } | null   ミックスマッチ（◯個の価格）
 *   themeId: string                             デザインID（空なら画面で選んだデザイン）
 */
import { parseCsv } from '../shared/csv.js';
import { SIZE_CONFIGS, createDefaultCounts } from '../shared/pop-sizes.js';
import { calcPriceIncl } from '../shared/price.js';
import { normalizeJan } from './master-schema.js';

// 商品情報の列（JAN 以外が1つも無ければ「JAN のみ」）。候補の先頭がテンプレートに使う名前
const INFO_COLUMNS = {
  jan:       ['JAN', 'JANコード'],
  name:      ['商品名'],
  maker:     ['メーカー', 'メーカー名'],
  priceExcl: ['税抜価格'],
  price:     ['税込価格'],
  qty1:      ['数量1'],
  qty2:      ['数量2'],
  comment:   ['コメント']
};

// 「JAN のみ」の判定に含めない列
const EXTRA_COLUMNS = {
  mixQty:       ['ミックス数量'],
  mixPriceExcl: ['ミックス税抜価格'],
  mixPrice:     ['ミックス税込価格'],
  themeId:      ['デザインID']
};

// 枚数の列（例: 「A9タテ枚数」または「A9枚数」）
const COUNT_COLUMNS = Object.fromEntries(Object.entries(SIZE_CONFIGS).map(([key, conf]) => (
  [`count:${key}`, [`${conf.label}枚数`, `${key.toUpperCase()}枚数`]]
)));

const ALL_COLUMNS = { ...INFO_COLUMNS, ...EXTRA_COLUMNS, ...COUNT_COLUMNS };
const MIX_KEYS = ['mixQty', 'mixPriceExcl', 'mixPrice'];

/** テンプレート CSV（見出し行だけ）。UTF-8 の BOM 付きなので Excel でそのまま開ける */
export function buildTemplateCsv() {
  return '\uFEFF' + Object.values(ALL_COLUMNS).map(names => names[0]).join(',') + '\r\n';
}

/** ファイルの中身を文字列にする（UTF-8 の BOM があれば UTF-8、無ければ Shift-JIS） */
export function decodeCsvFile(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength));
  const isUtf8 = b.length === 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
  return new TextDecoder(isUtf8 ? 'utf-8' : 'shift_jis').decode(buffer);
}

/**
 * CSV の文字列を読み、印刷キューの行に変換する。
 * @param text     CSV の文字列
 * @param lookup   (jan) => Promise<商品データ|null>   画面の店舗の価格でマスタを引く
 * @param themeIds Set<string> | null                 登録済みのデザインID（null なら確認しない）
 * @returns { entries, errors: [{line, message}], warnings: [{line, message}], janOnly }
 */
export async function importProductCsv(text, { lookup, themeIds = null }) {
  const result = { entries: [], errors: [], warnings: [], janOnly: false };
  const { headers, rows } = parseCsv(text);
  if (headers.length === 0) {
    result.errors.push({ line: 1, message: 'CSV が空です。' });
    return result;
  }

  // --- 見出しから列を探す ---
  const cols = {};
  const unknown = [];
  headers.forEach((h, i) => {
    const key = Object.keys(ALL_COLUMNS).find(k => ALL_COLUMNS[k].some(name => normalizeHeader(name) === normalizeHeader(h)));
    if (key && cols[key] === undefined) cols[key] = i;
    else if (h !== '') unknown.push(h);
  });
  if (cols.jan === undefined) {
    result.errors.push({ line: 1, message: '「JAN」の列がありません。' });
    return result;
  }
  if (unknown.length) {
    result.warnings.push({ line: 1, message: `使われない列があります: ${unknown.join('、')}` });
  }

  result.janOnly = Object.keys(INFO_COLUMNS).every(k => k === 'jan' || cols[k] === undefined);
  const countKeys = Object.keys(SIZE_CONFIGS).filter(k => cols[`count:${k}`] !== undefined);
  const get = (row, key) => (cols[key] === undefined ? '' : String(row[cols[key]] ?? '').trim());

  // --- マスタはまとめて引く（医薬品区分・税率は全行で使う） ---
  const jans = rows.map(row => normalizeJan(get(row, 'jan')));
  const masters = await Promise.all(jans.map(jan => (isJanFormat(jan) ? lookup(jan) : null)));

  rows.forEach((row, i) => {
    const line = i + 2;   // 見出しが1行目
    if (row.every(v => String(v ?? '').trim() === '')) return;   // 空行（Excel の「,,,,」）

    const errors = [];
    const warnings = [];
    const err = message => errors.push({ line, message });
    const warn = message => warnings.push({ line, message });

    // JAN
    const rawJan = get(row, 'jan');
    const jan = jans[i];
    if (/[eE][+-]?\d+$/.test(rawJan) || rawJan.includes('.')) {
      err(`JAN「${rawJan}」が指数表記などに変わっています（Excel で JAN の列を「文字列」にしてから入力してください）`);
    } else if (!jan) {
      err('JAN が空です');
    } else if (!isJanFormat(jan)) {
      err(`JAN「${rawJan}」は 8・12・13 桁の数字で入力してください`);
    } else if (!isValidCheckDigit(jan)) {
      warn(`JAN「${jan}」のチェックデジットが合わないため、バーコードは印字されません`);
    }
    const master = masters[i];

    // 商品情報
    let item = null;
    if (errors.length === 0) {
      if (result.janOnly) {
        if (!master) err(`JAN「${jan}」はマスタに登録されていません`);
        else item = { ...master };
      } else {
        const priceExcl = readPrice(get(row, 'priceExcl'), '税抜価格', err, warn);
        const price = readPrice(get(row, 'price'), '税込価格', err, warn);
        item = {
          jan,
          name:      get(row, 'name'),
          maker:     get(row, 'maker'),
          priceExcl,
          price,
          taxRate:   master?.taxRate ?? null,
          comment:   get(row, 'comment'),
          qty1:      get(row, 'qty1'),
          qty2:      get(row, 'qty2'),
          risk:      master?.risk ?? ''
        };
        checkTax(item.priceExcl, item.price, item.taxRate, '', warn);
      }
    }

    // ミックスマッチ
    let mix = null;
    if (MIX_KEYS.some(k => get(row, k) !== '')) {
      const qtyText = toHalfWidth(get(row, 'mixQty'));
      const qty = /^\d+$/.test(qtyText) ? Number(qtyText) : NaN;
      if (!(qty >= 2)) err('ミックス数量は 2 以上の整数で入力してください');
      const mixExcl = readPrice(get(row, 'mixPriceExcl'), 'ミックス税抜価格', err, null);
      const mixIncl = readPrice(get(row, 'mixPrice'), 'ミックス税込価格', err, null);
      if (item && errors.length === 0) {
        mix = { qty, priceExcl: mixExcl, price: mixIncl };
        checkTax(mixExcl, mixIncl, item.taxRate, 'ミックス', warn);
      }
    }

    // デザインID
    const themeId = get(row, 'themeId');
    if (themeId && themeIds && !themeIds.has(themeId)) {
      warn(`デザインID「${themeId}」は登録されていません（画面で選んだデザインで印刷します）`);
    }

    // 枚数
    let counts = createDefaultCounts();
    if (countKeys.length > 0) {
      counts = Object.fromEntries(Object.keys(SIZE_CONFIGS).map(k => [k, 0]));
      for (const key of countKeys) {
        const v = toHalfWidth(get(row, `count:${key}`));
        if (v === '') continue;
        if (!/^\d+$/.test(v)) err(`${SIZE_CONFIGS[key].label}の枚数「${v}」は 0 以上の整数で入力してください`);
        else counts[key] = Number(v);
      }
      if (Object.values(counts).every(c => c === 0)) warn('枚数がすべて 0 のため、印刷されません');
    }
    if (mix) {
      const notShown = Object.keys(counts).filter(k => counts[k] > 0 && !SIZE_CONFIGS[k].mixMatch);
      if (notShown.length) {
        warn(`${notShown.map(k => SIZE_CONFIGS[k].label).join('・')}ではミックスマッチは表示されません（通常の価格だけ）`);
      }
    }

    result.errors.push(...errors);
    if (errors.length > 0) return;
    result.warnings.push(...warnings);
    result.entries.push({
      item: { ...item, mix, themeId },
      counts,
      // 常時表示でないサイズに枚数があれば、カードの「他サイズ」を開いておく
      showOptions: Object.keys(counts).some(k => counts[k] > 0 && !SIZE_CONFIGS[k].primary),
      source: 'csv'
    });
  });

  return result;
}

// ------------------------------------------------------------
// 補助
// ------------------------------------------------------------
function normalizeHeader(s) {
  return String(s ?? '').normalize('NFKC').replace(/\s/g, '').toUpperCase();
}

function toHalfWidth(s) {
  return String(s ?? '').normalize('NFKC').trim();
}

function isJanFormat(jan) {
  return /^(\d{8}|\d{12}|\d{13})$/.test(jan);
}

function isValidCheckDigit(jan) {
  let sum = 0;
  for (let i = 0; i < jan.length - 1; i++) {
    const digit = Number(jan[jan.length - 2 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10 === Number(jan[jan.length - 1]);
}

/** 価格を読む。空なら 0（warn があれば注意）、数字でなければエラー */
function readPrice(text, label, err, warn) {
  const s = toHalfWidth(text).replace(/[¥￥,円\s]/g, '');
  if (s === '') {
    if (warn) warn(`${label}が空です（0円で表示されます）`);
    else err(`${label}を入力してください`);
    return 0;
  }
  if (!/^\d+$/.test(s)) {
    err(`${label}「${text}」は数字で入力してください`);
    return 0;
  }
  return Number(s);
}

/** マスタの税率がある商品は、税込 = 税抜 × 税率（切り捨て）になっているか確かめる */
function checkTax(priceExcl, price, taxRate, prefix, warn) {
  if (taxRate == null || !priceExcl || !price) return;
  const expected = calcPriceIncl(priceExcl, taxRate);
  if (expected !== null && expected !== price) {
    warn(`${prefix}税込価格 ${price}円 が税抜価格と合いません（税率 ${taxRate}% なら ${expected}円）`);
  }
}
