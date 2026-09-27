/**
 * ============================================================
 * /api/master の約束事（★画面側はこれだけを前提にしている★）
 * ============================================================
 *  - 返す形: { version: string, headers: string[], rows: string[][] }
 *  - ETag ヘッダーにバージョンを入れる
 *  - If-None-Match がバージョンと一致したら 304（本文なし）を返す
 *
 * 取得元を R2 から社内サーバー等に切り替えても、この約束を守れば
 * scan-app.js / master-worker.js は変更不要。
 * 列名の扱いはフロント側の js/master-schema.js で管理している。
 */

// レスポンス形式や文字コード設定を変えたらここを上げる（各端末のキャッシュが自動で無効化される）
const MASTER_FORMAT = 'v2';

// CSVの文字コード（wrangler の vars で MASTER_ENCODING を指定すれば上書き可能）
// ※ ファイル先頭に UTF-8 の BOM がある場合は自動で UTF-8 として読む
const DEFAULT_MASTER_ENCODING = 'shift-jis';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // GET /api/master → 商品マスタを軽量JSON（headers + rows配列）で返す
    if (path === '/api/master') {
      return handleMaster(request, env, ctx);
    }

    // GET /api/themes → デザイン(テーマ)マニフェストを返す
    if (path === '/api/themes') {
      return handleThemes(env);
    }

    // GET /api/theme-image/:filename → デザイン用画像をR2から配信
    const themeImageMatch = path.match(/^\/api\/theme-image\/([^\/]+)$/);
    if (themeImageMatch) {
      return handleThemeImage(themeImageMatch[1], env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

// Cloudflareは圧縮時にETagを弱いETag(W/"...")に変換することがあるため、比較時は W/ を無視する
function normalizeEtag(value) {
  return String(value || '').trim().replace(/^W\//, '');
}

// ============================================================
// 商品マスタの取得元（データソース）
//
// 取得元は次の2つの関数を持つ部品として作る:
//   getVersion() … 本文を読まずにバージョン（変更検知用の文字列）を返す。無ければ null
//   getCsv()     … { version, bytes(ArrayBuffer) } を返す。無ければ null
//
// 将来、社内サーバー（Cloudflare Tunnel 経由）に切り替える場合は
// 同じ形の部品（例: createHttpMasterSource）を作り、createMasterSource で差し替える。
// ============================================================
function createMasterSource(env) {
  return createR2MasterSource(env);
}

function createR2MasterSource(env) {
  const key = env.MASTER_R2_KEY || 'masters/item_master.csv';
  return {
    async getVersion() {
      const head = await env.MY_R2_BUCKET.head(key);
      return head ? head.etag : null;
    },
    async getCsv() {
      const object = await env.MY_R2_BUCKET.get(key);
      if (!object) return null;
      return { version: object.etag, bytes: await object.arrayBuffer() };
    }
  };
}

// ============================================================
// /api/master（取得元に依存しない共通処理）
//   - If-None-Match が一致すれば 304（本文なし）を返す
//   - 変換結果はエッジキャッシュに保存し、CSV更新時のみ再変換
// ============================================================
async function handleMaster(request, env, ctx) {
  const source = createMasterSource(env);
  const toEtag = v => `"${MASTER_FORMAT}-${v}"`;

  try {
    // 1. バージョンだけ確認（本文は読まないので軽い）
    const sourceVersion = await source.getVersion();
    if (!sourceVersion) {
      return jsonResponse({ error: '商品マスタCSVが見つかりません。' }, 404);
    }

    const version = toEtag(sourceVersion);
    const versionHeaders = { 'ETag': version, 'Cache-Control': 'no-cache' };

    // 2. クライアントが最新版を持っていれば 304
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch && normalizeEtag(ifNoneMatch) === version) {
      return new Response(null, { status: 304, headers: versionHeaders });
    }

    // 3. エッジキャッシュに変換済みJSONがあればそれを返す
    //    ※ Cache API は workers.dev ドメインでは動作せず、カスタムドメインでのみ有効
    const cache = caches.default;
    const cacheKey = new Request(
      new URL(`/__cache/master/${encodeURIComponent(version)}`, request.url).toString()
    );
    const cached = await cache.match(cacheKey);
    if (cached) {
      return new Response(cached.body, {
        status: 200,
        headers: { ...JSON_HEADERS, ...versionHeaders, 'X-Master-Cache': 'HIT' }
      });
    }

    // 4. キャッシュがなければ取得元から読んで変換
    const csv = await source.getCsv();
    if (!csv) {
      return jsonResponse({ error: '商品マスタCSVが見つかりません。' }, 404);
    }

    const csvText = decodeCsvBytes(csv.bytes, env.MASTER_ENCODING || DEFAULT_MASTER_ENCODING);
    const { headers, rows } = parseCsv(csvText);

    // 1 と 4 の間にファイルが更新された場合に備え、実際に読んだデータのバージョンを使う
    const actualVersion = toEtag(csv.version);
    const body = JSON.stringify({ version: actualVersion, headers, rows });

    if (actualVersion === version) {
      ctx.waitUntil(
        cache.put(cacheKey, new Response(body, {
          headers: { ...JSON_HEADERS, 'Cache-Control': 'public, max-age=31536000' }
        }))
      );
    }

    return new Response(body, {
      status: 200,
      headers: {
        ...JSON_HEADERS,
        'ETag': actualVersion,
        'Cache-Control': 'no-cache',
        'X-Master-Cache': 'MISS'
      }
    });

  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// 文字コード変換（UTF-8 の BOM 付きなら自動で UTF-8 として読む）
function decodeCsvBytes(arrayBuffer, encoding) {
  const b = new Uint8Array(arrayBuffer, 0, Math.min(3, arrayBuffer.byteLength));
  const hasUtf8Bom = b.length === 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
  return new TextDecoder(hasUtf8Bom ? 'utf-8' : encoding).decode(arrayBuffer);
}

// ============================================================
// CSVパーサー（ダブルクォート・カンマ入りフィールド・改行コード混在に対応）
// 戻り値: { headers: string[], rows: string[][] }
// ============================================================
function parseCsv(text) {
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

// ============================================================
// /api/themes
// ============================================================
async function handleThemes(env) {
  try {
    const object = await env.MY_R2_BUCKET.get('themes/manifest.json');

    if (!object) {
      return jsonResponse({ error: 'デザインマニフェスト(themes/manifest.json)が見つかりません。' }, 404);
    }

    const text = await object.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return jsonResponse({ error: 'マニフェストJSONの形式が不正です。' }, 500);
    }

    return jsonResponse(parsed, 200, { 'Cache-Control': 'no-cache' });

  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ============================================================
// /api/theme-image/:filename
// ============================================================
async function handleThemeImage(filename, env) {
  if (!filename || /[\/\\]/.test(filename) || filename.includes('..')) {
    return new Response('Bad Request', { status: 400 });
  }

  try {
    const object = await env.MY_R2_BUCKET.get(`images/${filename}`);

    if (!object) {
      return new Response('Not Found', { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=86400');

    return new Response(object.body, { status: 200, headers });

  } catch (err) {
    return new Response('Internal Server Error', { status: 500 });
  }
}
