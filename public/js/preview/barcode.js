/**
 * JANコード（EAN-13 / EAN-8）のバーコード：符号化と、POPに入れるDOMの生成（外部ライブラリなし）
 *
 * encodeJan(jan) は次の形を返す。バーコードにできない場合は null
 *   { type: 'EAN-13' | 'EAN-8', text: 表示用の数字, bits: '1010...' }
 *   bits は1モジュール（最小の線幅）ごとの 1=黒 / 0=白。EAN-13 は 95 文字、EAN-8 は 67 文字
 *   左右のクワイエットゾーン（余白）は含まない（EAN-13 は左11・右7モジュール、EAN-8 は左右7モジュール必要）
 *
 * 対応する入力:
 *   13桁 … チェックデジットが正しければ EAN-13
 *   12桁 … UPC-A として正しければ先頭に 0 を付けて EAN-13
 *   8桁  … チェックデジットが正しければ EAN-8
 *   それ以外（桁数違い・チェックデジット誤り・数字以外）… null（POPには数字だけを表示する）
 */

// 左側 奇数パリティ（L）・偶数パリティ（G）、右側（R）の符号
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = L.map(code => code.replace(/./g, b => (b === '1' ? '0' : '1')));

// EAN-13 の先頭1桁で決まる、左6桁のパリティの並び
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

const START = '101';
const CENTER = '01010';
const END = '101';

/** モジュラス10・ウェイト3-1 のチェックデジット（body はチェックデジットを除いた数字） */
export function calcCheckDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

function isValid(code) {
  return calcCheckDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

export function encodeJan(jan) {
  const code = String(jan ?? '').trim();
  if (!/^\d+$/.test(code)) return null;

  if (code.length === 13 && isValid(code)) return encodeEan13(code);
  if (code.length === 12 && isValid(code)) return encodeEan13('0' + code);
  if (code.length === 8 && isValid(code)) return encodeEan8(code);
  return null;
}

function encodeEan13(code) {
  const parity = PARITY[Number(code[0])];
  let bits = START;
  for (let i = 1; i <= 6; i++) {
    bits += (parity[i - 1] === 'L' ? L : G)[Number(code[i])];
  }
  bits += CENTER;
  for (let i = 7; i <= 12; i++) bits += R[Number(code[i])];
  bits += END;
  return { type: 'EAN-13', text: code, bits };
}

function encodeEan8(code) {
  let bits = START;
  for (let i = 0; i < 4; i++) bits += L[Number(code[i])];
  bits += CENTER;
  for (let i = 4; i < 8; i++) bits += R[Number(code[i])];
  bits += END;
  return { type: 'EAN-8', text: code, bits };
}

/** bits を黒い線の並び [{ start, width }]（モジュール単位）にまとめる */
export function toBars(bits) {
  const bars = [];
  let i = 0;
  while (i < bits.length) {
    if (bits[i] === '1') {
      const start = i;
      while (i < bits.length && bits[i] === '1') i++;
      bars.push({ start, width: i - start });
    } else {
      i++;
    }
  }
  return bars;
}

// ------------------------------------------------------------
// DOM生成
// ------------------------------------------------------------

// バーコードの線（SVG）の目印クラス。PDF出力（pdf-export.js）ではここだけ画像にせず、ベクターで描き直す
export const BARCODE_BARS_CLASS = 'pop-barcode-bars';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * JANバーコードの要素（線は SVG、数字は文字）。バーコードにできないJANは数字だけ表示する。
 * 線は PDF 出力時にベクターで描き直すため、1モジュール=1単位の viewBox と data-bits（1=黒/0=白）を持たせる
 */
export function createBarcodeElement(jan) {
  const box = document.createElement('div');
  box.className = 'pop-barcode';

  const encoded = encodeJan(jan);
  if (encoded) {
    box.classList.add(encoded.type === 'EAN-8' ? 'is-ean8' : 'is-ean13');

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', BARCODE_BARS_CLASS);
    svg.setAttribute('viewBox', `0 0 ${encoded.bits.length} 1`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    svg.dataset.bits = encoded.bits;

    for (const bar of toBars(encoded.bits)) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', bar.start);
      rect.setAttribute('y', 0);
      rect.setAttribute('width', bar.width);
      rect.setAttribute('height', 1);
      svg.appendChild(rect);
    }
    box.appendChild(svg);
  } else {
    box.classList.add('is-text-only');
  }

  const text = document.createElement('div');
  text.className = 'pop-barcode-text';
  text.textContent = jan || '';
  box.appendChild(text);
  return box;
}
