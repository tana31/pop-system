export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // GET /api/master → 商品マスタCSVをJSONで返す
    if (path === '/api/master') {
      return handleMaster(env);
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

    // ここに来るのは /api/* のうち上記どれにも一致しないパスのみ。
    // 静的ファイル（/, /preview.html, /js/*, /css/* など）はWorkerに来る前に
    // assetsバインディングが自動で配信してくれるので、ここでは扱わない。
    return new Response('Not Found', { status: 404 });
  }
};

// ============================================================
// /api/master （旧 functions/api/master.js）
// ============================================================
async function handleMaster(env) {
  try {
    // 1. R2バケットからCSVファイルを取得
    const object = await env.MY_R2_BUCKET.get('masters/item_master.csv');

    if (!object) {
      return new Response(JSON.stringify({ error: '商品マスタCSVが見つかりません。' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    // 2. バイナリデータを取得し、TextDecoderでShift_JISをUTF-8文字列にデコード
    const arrayBuffer = await object.arrayBuffer();
    const decoder = new TextDecoder('shift-jis');
    const csvText = decoder.decode(arrayBuffer);

    // 3. CSV文字列をパースしてJSONオブジェクト配列に変換
    const items = parseCsvToJson(csvText);

    // 4. JSONとしてフロントエンドへ返却
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}

// 簡易CSVパース関数
function parseCsvToJson(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());
  const result = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = lines[i].split(',').map(v => v.trim());
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    result.push(row);
  }

  return result;
}

// ============================================================
// /api/themes （旧 functions/api/themes.js）
// ============================================================
async function handleThemes(env) {
  try {
    const object = await env.MY_R2_BUCKET.get('themes/manifest.json');

    if (!object) {
      return new Response(JSON.stringify({ error: 'デザインマニフェスト(themes/manifest.json)が見つかりません。' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const text = await object.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'マニフェストJSONの形式が不正です。' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}

// ============================================================
// /api/theme-image/:filename （旧 functions/api/theme-image/[filename].js）
// ============================================================
async function handleThemeImage(filename, env) {
  // ディレクトリトラバーサル対策：単純なファイル名のみ許可（サブパス指定不可）
  if (!filename || /[\/\\]/.test(filename) || filename.includes('..')) {
    return new Response('Bad Request', { status: 400 });
  }

  try {
    const object = await env.MY_R2_BUCKET.get(`themes/${filename}`);

    if (!object) {
      return new Response('Not Found', { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers); // Content-Type等をR2のメタデータから引き継ぐ
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=86400'); // 画像は1日キャッシュ

    return new Response(object.body, { status: 200, headers });

  } catch (err) {
    return new Response('Internal Server Error', { status: 500 });
  }
}
