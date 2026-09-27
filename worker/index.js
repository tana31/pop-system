const MASTER_KEY = 'masters/item_master.csv';
// レスポンス形式を変えたらここを上げる（クライアントのキャッシュが自動で無効化される）
const MASTER_FORMAT = 'v2';

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
// /api/master
//   - R2オブジェクトのETagをバージョンとして使用
//   - If-None-Match が一致すれば 304（本文なし）を返す
//   - 変換結果はエッジキャッシュに保存し、CSV更新時のみ再変換
// ============================================================
async function handleMaster(request, env, ctx) {
  try {
    // 1. まずメタデータだけ取得（本文は読まないので軽い）
    const head = await env.MY_R2_BUCKET.head(MASTER_KEY);
    if (!head) {
      return jsonResponse({ error: '商品マスタCSVが見つかりません。' }, 404);
    }

    const version = `"${MASTER_FORMAT}-${head.etag}"`;
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

    // 4. キャッシュがなければ R2 から取得して変換
    const object = await env.MY_R2_BUCKET.get(MASTER_KEY);
    if (!object) {
      return jsonResponse({ error: '商品マスタCSVが見つかりません。' }, 404);
    }

    const arrayBuffer = await object.arrayBuffer();
    const csvText = new TextDecoder('shift-jis').decode(arrayBuffer);
    const { headers, rows } = parseCsv(csvText);

    // head と get の間にファイルが更新された場合に備え、実際に読んだオブジェクトのETagを使う
    const actualVersion = `"${MASTER_FORMAT}-${object.etag}"`;
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
