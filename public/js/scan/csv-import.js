/**
 * 商品リスト CSV の読み込み（スキャン画面の「CSVから読み込み」で使う。DOM には触らない）
 *
 * ルール:
 *  - 見出し行の列名で列を探す（並び順は自由、使わない列は省略可。全角・空白の違いは無視）
 *  - 商品情報は項目ごとに「CSV に値があれば CSV、空欄（列が無い場合も）ならマスタ（画面の店舗の価格）」
 *    で決める。JAN だけの CSV なら、商品情報はすべてマスタの値になる
 *  - 税込価格が空欄のときは、税抜価格もマスタならマスタの税込価格、税抜価格を CSV で書いたなら
 *    「税抜 × 税率（切り捨て）」で計算する（税率が無ければ計算できないので 0 円＋注意）
 *  - JAN は空欄でもよい（「〇〇 各種」の POP。バーコードは印字せず、マスタでも補わない）。
 *    JAN の列そのものが無くてもよい
 *  - マスタに無い JAN は CSV の値だけで作る（空欄は空欄のまま。注意を出す）。
 *    ただし CSV にも商品情報が1つも無い行はエラー
 *  - ミックスマッチ・デザインID・枚数はマスタに無いので、CSV の値だけで決まる
 *  - 医薬品区分と税率は常にマスタから取る（マスタに無い商品は空欄・税率なし）
 *  - 枚数の列が1つも無い・枚数がすべて空欄か 0 の行は、既定のサイズ（DEFAULT_SIZE_KEY）1枚にする
 *  - ミックスマッチを表示しないサイズ（A9タテ）の枚数があっても注意は出さない（通常の価格だけで印刷）
 *  - コメント（CSV・マスタのどちらの値でも）が、枚数が1枚以上のサイズの上限（pop-sizes.js の commentMax）を
 *    超える行は注意を出す（そのサイズの POP にはコメントが出ない）
 *  - エラーの行は読み込まない。注意（警告）の行は読み込む
 *  - エラー・注意の文言には行ごとの値（JAN や価格）を入れない。同じ内容を1つにまとめ、行番号を並べて表示するため
 *    （groupMessages）
 *
 * 商品データには、マスタの形（master-schema.js 冒頭）に次の2つが加わる:
 *   mix:     { qty, priceExcl, price } | null   ミックスマッチ（◯個の価格）
 *   themeId: string                             デザインID（空なら画面で選んだデザイン）
 */
import { parseCsv } from '../shared/csv.js';
import { SIZE_CONFIGS, createDefaultCounts, commentHiddenSizes } from '../shared/pop-sizes.js';
import { calcPriceIncl } from '../shared/price.js';
import { normalizeJan } from './master-schema.js';

// 商品情報の列（空欄ならマスタの値を使う）。候補の先頭がテンプレートに使う名前
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

// マスタに無い列（CSV の値だけで決まる）
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
// 文字の商品情報（空欄ならマスタの値）
const TEXT_KEYS = ['name', 'maker', 'comment', 'qty1', 'qty2'];

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
 * @returns { entries, errors: [{line, message}], warnings: [{line, message}], notInMaster }
 *          errors・warnings は行ごと。画面には groupMessages で同じ内容をまとめて出す
 *          notInMaster は読み込める行のうち、JAN がマスタに無かった件数
 */
export async function importProductCsv(text, { lookup, themeIds = null }) {
  const result = { entries: [], errors: [], warnings: [], notInMaster: 0 };
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
  if (Object.keys(INFO_COLUMNS).every(k => cols[k] === undefined)) {
    result.errors.push({ line: 1, message: '商品情報の列がありません（「JAN」か「商品名」などの列が必要です）。' });
    return result;
  }
  if (unknown.length) {
    result.warnings.push({ line: 1, message: `使われない列があります: ${unknown.join('、')}` });
  }

  const countKeys = Object.keys(SIZE_CONFIGS).filter(k => cols[`count:${k}`] !== undefined);
  const get = (row, key) => (cols[key] === undefined ? '' : String(row[cols[key]] ?? '').trim());

  // --- マスタはまとめて引く（空欄の補完・医薬品区分・税率に使う） ---
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
      err('JAN が指数表記などに変わっています（Excel で JAN の列を「文字列」にしてから入力してください）');
    } else if (!jan) {
      // JAN は空欄でよい（バーコードなし・マスタで補わない）
    } else if (!isJanFormat(jan)) {
      err('JAN は 8・12・13 桁の数字で入力してください');
    } else if (!isValidCheckDigit(jan)) {
      warn('JAN のチェックデジットが合わないため、バーコードは印字されません');
    }
    const master = masters[i];

    // 商品情報（項目ごとに CSV → マスタの順で値を探す）
    let item = null;
    const notInMaster = !!jan && isJanFormat(jan) && !master;
    if (errors.length === 0) {
      const hasCsvInfo = Object.keys(INFO_COLUMNS).some(k => k !== 'jan' && get(row, k) !== '');
      if (!master && !hasCsvInfo) {
        err(jan
          ? 'JAN がマスタに登録されておらず、ほかの商品情報も空です'
          : '商品情報が空です（JAN か商品名などを入力してください）');
      } else {
        if (notInMaster) {
          warn('JAN がマスタに登録されていないため、CSV の値だけで作ります（医薬品区分・税率は空）');
        }
        const taxRate = master?.taxRate ?? null;
        const { priceExcl, price } = readPrices(row, get, master, taxRate, err, warn);
        item = {
          jan,
          ...Object.fromEntries(TEXT_KEYS.map(k => [k, get(row, k) || master?.[k] || ''])),
          priceExcl,
          price,
          taxRate,
          risk: master?.risk ?? ''
        };
        checkTax(item.priceExcl, item.price, item.taxRate, '', warn);
        if (!item.name) warn('商品名が空です');
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
      warn('デザインIDが登録されていません（画面で選んだデザインで印刷します）');
    }

    // 枚数
    let counts = createDefaultCounts();
    if (countKeys.length > 0) {
      counts = Object.fromEntries(Object.keys(SIZE_CONFIGS).map(k => [k, 0]));
      for (const key of countKeys) {
        const v = toHalfWidth(get(row, `count:${key}`));
        if (v === '') continue;
        if (!/^\d+$/.test(v)) err(`${SIZE_CONFIGS[key].label}の枚数は 0 以上の整数で入力してください`);
        else counts[key] = Number(v);
      }
      // 枚数がすべて空欄か 0 なら、スキャン時と同じ既定のサイズ1枚にする
      if (Object.values(counts).every(c => c === 0)) counts = createDefaultCounts();
    }

    // コメントの長さ（枚数が決まってから、印刷するサイズだけで確かめる）
    if (item) {
      const hidden = commentHiddenSizes(item.comment, counts);
      if (hidden.length) warn(`コメントが長いため、${hidden.map(c => c.label).join('・')}ではコメントが表示されません`);
    }

    result.errors.push(...errors);
    if (errors.length > 0) return;
    result.warnings.push(...warnings);
    if (notInMaster) result.notInMaster++;
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

/**
 * 行ごとのエラー・注意を、同じ内容ごとにまとめる（最初に出てきた順）。
 * @param list [{line, message}]
 * @returns [{message, lines: number[]}]   lines は重複なしの行番号
 */
export function groupMessages(list) {
  const groups = new Map();
  for (const { line, message } of list) {
    if (!groups.has(message)) groups.set(message, []);
    const lines = groups.get(message);
    if (!lines.includes(line)) lines.push(line);
  }
  return [...groups].map(([message, lines]) => ({ message, lines }));
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
    err(`${label}は数字で入力してください`);
    return 0;
  }
  return Number(s);
}

/**
 * 税抜・税込価格を決める。
 *  - CSV に書いてあれば CSV の値
 *  - 税抜が空欄ならマスタの税抜（マスタに無ければ 0 円＋注意）
 *  - 税込が空欄なら、税抜もマスタの値のときはマスタの税込をそのまま使い、
 *    税抜を CSV で書いたときは「税抜 × 税率（切り捨て）」で計算する
 */
function readPrices(row, get, master, taxRate, err, warn) {
  const exclText = get(row, 'priceExcl');
  const inclText = get(row, 'price');

  let priceExcl;
  if (exclText !== '') priceExcl = readPrice(exclText, '税抜価格', err, warn);
  else if (master) priceExcl = master.priceExcl;
  else priceExcl = readPrice('', '税抜価格', err, warn);

  let price;
  if (inclText !== '') {
    price = readPrice(inclText, '税込価格', err, warn);
  } else if (exclText === '' && master) {
    price = master.price;
  } else if (exclText !== '' && taxRate != null) {
    price = calcPriceIncl(priceExcl, taxRate) ?? 0;
  } else if (exclText !== '') {
    warn('税込価格が空で、税率が無いため計算できません（0円で表示されます）');
    price = 0;
  } else {
    price = readPrice('', '税込価格', err, warn);
  }
  return { priceExcl, price };
}

/** マスタの税率がある商品は、税込 = 税抜 × 税率（切り捨て）になっているか確かめる */
function checkTax(priceExcl, price, taxRate, prefix, warn) {
  if (taxRate == null || !priceExcl || !price) return;
  const expected = calcPriceIncl(priceExcl, taxRate);
  if (expected !== null && expected !== price) {
    warn(`${prefix}税込価格が「${prefix}税抜価格 × 税率（切り捨て）」と合いません`);
  }
}
