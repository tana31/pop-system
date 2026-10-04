/**
 * CSV の解析（ブラウザ側で共有。マスタWorker と、今後の商品リスト CSV アップロードで使う）
 * ダブルクォート・カンマ入りフィールド・改行コード混在に対応。
 * 戻り値: { headers: string[], rows: string[][] }（1行目を見出しとし、各行を見出しの列数にそろえる）
 */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM除去

  const records = [];
  const n = text.length;
  let row = [];
  let i = 0;

  while (i < n) {
    let value;

    if (text[i] === '"') {
      // クォート付きフィールド
      let j = i + 1;
      let buf = '';
      while (true) {
        const q = text.indexOf('"', j);
        if (q === -1) { buf += text.slice(j); i = n; break; }
        buf += text.slice(j, q);
        if (text[q + 1] === '"') { buf += '"'; j = q + 2; }   // "" → "
        else { i = q + 1; break; }
      }
      value = buf;
      // 閉じクォートの後ろに余計な文字があれば区切りまで読み飛ばす
      while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') i++;
    } else {
      let j = i;
      while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j++;
      value = text.slice(i, j);
      i = j;
    }

    row.push(value.trim());

    if (i >= n) { records.push(row); row = null; break; }

    if (text[i] === ',') {
      i++;
      if (i >= n) { row.push(''); records.push(row); row = null; }
      continue;
    }

    // 改行（\r\n / \n / \r）
    if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
    else i++;
    records.push(row);
    row = [];
  }

  const nonEmpty = records.filter(r => !(r.length === 1 && r[0] === ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = nonEmpty[0];
  const rows = [];
  for (let r = 1; r < nonEmpty.length; r++) {
    const src = nonEmpty[r];
    const out = new Array(headers.length);
    for (let c = 0; c < headers.length; c++) out[c] = src[c] ?? '';
    rows.push(out);
  }
  return { headers, rows };
}
