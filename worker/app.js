/**
 * POP作成システムのサーバー本体（Hono）。実行環境に依存しない。
 *
 * 実行環境ごとの違いは、入口ファイル（Cloudflare なら src/index.js）が渡す platform に閉じ込める:
 *   platform.getStorage(c)   … ストレージ部品（形は src/storage/r2.js 参照）
 *   platform.serveAsset(c)   … 画面ファイル（HTML・JS・CSS・画像）を返す
 *   platform.getEnv(c, name) … 設定値・シークレットを読む
 *
 * URL（ログインが必要なのは /login・/logout・/api/admin/master 以外のすべて）:
 *   GET  /login, POST /login, GET /logout … ログイン・ログアウト
 *   PUT  /api/admin/master                … 軽量化バッチからのマスタ受け取り（ログインの代わりにトークン）
 *   GET  /api/master                      … マスタ CSV をそのまま返す（解析はブラウザのマスタWorker）
 *   GET  /api/themes                      … デザインのマニフェスト（themes/manifest.json）
 *   GET  /api/theme-image/:filename       … デザイン用画像（images/ 以下）
 *   上記以外の GET                        … 画面ファイル
 *
 * /api/master の約束事（★マスタWorker はこれだけを前提にしている★）:
 *   - 本文は軽量化バッチが作った UTF-8 の CSV そのまま（1行目が MASTER_HEADER）
 *   - ETag ヘッダーにバージョンを入れ、If-None-Match が一致したら 304（本文なし）を返す
 */
import { Hono } from 'hono';
import { createAuth } from './auth.js';
import { renderLoginPage } from './login-page.js';

// 応答の形を変えたらここを上げる（各端末のキャッシュが自動で入れ替わる）
const MASTER_FORMAT = 'v4';

// マスタの置き場所（設定値 MASTER_STORAGE_KEY で上書き可能）
const DEFAULT_MASTER_KEY = 'masters/pop-master.csv';

// 軽量化バッチが出力するマスタの見出し行（バッチ・js/scan/master-schema.js と揃える）
const MASTER_HEADER = 'type,jan,store,taxRate,priceExcl,price,maker,name,qty1,qty2,comment,risk';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const BACKUP_PREFIX = 'masters/backup/';
const BACKUP_KEEP = 7;
const THEME_MANIFEST_KEY = 'themes/manifest.json';
const THEME_IMAGE_PREFIX = 'images/';
const LOGIN_FAIL_DELAY_MS = 1000;   // 総当たり対策：ログイン失敗時に待たせる時間
const CSV_TYPE = 'text/csv; charset=utf-8';
const NO_STORE = { 'Cache-Control': 'no-store' };

export function createApp(platform) {
  const app = new Hono();
  const getEnv = (c, name) => platform.getEnv(c, name);
  const auth = createAuth(getEnv);
  const masterKey = (c) => getEnv(c, 'MASTER_STORAGE_KEY') || DEFAULT_MASTER_KEY;

  // ============================================================
  // ログインの確認（すべての URL の入口）
  // ============================================================
  const PUBLIC_PATHS = new Set(['/login', '/logout', '/api/admin/master']);

  app.use('*', async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path) || await auth.isLoggedIn(c)) return next();

    // ログインしていない：ストレージには触れず、小さな応答だけを返す
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'ログインが必要です。画面を再読み込みしてください。' }, 401, NO_STORE);
    }
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  });

  // ============================================================
  // ログイン・ログアウト
  // ============================================================
  app.get('/login', (c) => {
    return c.html(renderLoginPage({
      next: safeNext(c.req.query('next')),
      error: c.req.query('error') === '1'
    }), 200, NO_STORE);
  });

  app.post('/login', async (c) => {
    if (!auth.isConfigured(c)) {
      return c.text('ログインの設定（LOGIN_USER・LOGIN_PASSWORD・SESSION_SECRET）がされていません。', 503, NO_STORE);
    }
    const form = await c.req.parseBody();
    const next = safeNext(form.next);
    if (await auth.login(c, String(form.user ?? ''), String(form.password ?? ''))) {
      return c.redirect(next, 303);
    }
    await sleep(LOGIN_FAIL_DELAY_MS);
    return c.redirect(`/login?error=1&next=${encodeURIComponent(next)}`, 303);
  });

  app.get('/logout', (c) => {
    auth.logout(c);
    return c.redirect('/login', 302);
  });

  // ============================================================
  // PUT /api/admin/master（軽量化バッチからのアップロード）
  // ============================================================
  app.put('/api/admin/master', async (c) => {
    const authorized = await auth.checkUploadToken(c);
    if (authorized === null) {
      return c.json({ error: 'アップロード用トークン（UPLOAD_TOKEN）が設定されていません。' }, 503, NO_STORE);
    }
    if (!authorized) return c.json({ error: '認証に失敗しました。' }, 401, NO_STORE);

    const tooLarge = () => c.json({ error: `ファイルが大きすぎます（上限 ${MAX_UPLOAD_BYTES} バイト）。` }, 413, NO_STORE);
    if (Number(c.req.header('Content-Length') || 0) > MAX_UPLOAD_BYTES) return tooLarge();

    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) return c.json({ error: '本文が空です。' }, 400, NO_STORE);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return tooLarge();

    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return c.json({ error: 'UTF-8 の CSV ではありません。' }, 400, NO_STORE);
    }
    const summary = summarizeMasterCsv(text);
    if (summary.error) return c.json({ error: summary.error }, 400, NO_STORE);

    const storage = platform.getStorage(c);
    const key = masterKey(c);
    await backupCurrentMaster(storage, key);
    await storage.put(key, bytes, CSV_TYPE);

    return c.json({ ok: true, items: summary.items, exceptions: summary.exceptions, bytes: bytes.byteLength }, 200, NO_STORE);
  });

  app.all('/api/admin/master', (c) => c.json({ error: 'PUT で送信してください。' }, 405, { ...NO_STORE, Allow: 'PUT' }));

  // ============================================================
  // GET /api/master（CSV をそのまま返す）
  // ============================================================
  app.get('/api/master', async (c) => {
    const storage = platform.getStorage(c);
    const key = masterKey(c);
    const toVersion = (etag) => `"${MASTER_FORMAT}-${etag}"`;

    // 1. 本文を読まずにバージョンだけ確認し、端末が最新版を持っていれば 304
    const head = await storage.head(key);
    if (!head) return c.json({ error: '商品マスタが見つかりません。' }, 404, NO_STORE);
    const version = toVersion(head.etag);
    if (normalizeEtag(c.req.header('If-None-Match')) === version) {
      return c.body(null, 304, { ETag: version, 'Cache-Control': 'private, no-cache' });
    }

    // 2. 本文はストレージから流すだけ（サーバーでは解析しない）
    const obj = await storage.get(key);
    if (!obj) return c.json({ error: '商品マスタが見つかりません。' }, 404, NO_STORE);
    return c.body(obj.body, 200, {
      'Content-Type': CSV_TYPE,
      ETag: toVersion(obj.etag),   // 1 と 2 の間に更新された場合に備え、実際に読んだ版を使う
      'Cache-Control': 'private, no-cache'
    });
  });

  // ============================================================
  // GET /api/themes・/api/theme-image/:filename
  // ============================================================
  app.get('/api/themes', async (c) => {
    const obj = await platform.getStorage(c).get(THEME_MANIFEST_KEY);
    if (!obj) {
      return c.json({ error: `デザインマニフェスト(${THEME_MANIFEST_KEY})が見つかりません。` }, 404, NO_STORE);
    }
    let parsed;
    try {
      parsed = JSON.parse(await new Response(obj.body).text());
    } catch {
      return c.json({ error: 'マニフェストJSONの形式が不正です。' }, 500, NO_STORE);
    }
    return c.json(parsed, 200, { 'Cache-Control': 'private, no-cache' });
  });

  app.get('/api/theme-image/:filename', async (c) => {
    const filename = c.req.param('filename');
    // images/ 以外のファイルを読まれないよう、区切り文字や .. を含む名前は拒否する
    if (!filename || /[\/\\]/.test(filename) || filename.includes('..')) {
      return c.text('Bad Request', 400);
    }
    const obj = await platform.getStorage(c).get(THEME_IMAGE_PREFIX + filename);
    if (!obj) return c.text('Not Found', 404);

    const headers = { ETag: `"${obj.etag}"`, 'Cache-Control': 'private, max-age=86400' };
    if (obj.contentType) headers['Content-Type'] = obj.contentType;
    return c.body(obj.body, 200, headers);
  });

  // ============================================================
  // 画面ファイル（HTML・JS・CSS・画像）
  // ============================================================
  app.get('*', (c) => platform.serveAsset(c));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'サーバーでエラーが発生しました。' }, 500, NO_STORE);
  });

  return app;
}

// ------------------------------------------------------------
// 補助
// ------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** ログイン後の移動先：同じサイト内のパスだけを許す（外部サイトへ飛ばされないように） */
function safeNext(value) {
  const s = String(value ?? '');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || s.startsWith('/login')) return '/';
  return s;
}

// 圧縮時に ETag が弱い ETag(W/"...") に変わることがあるため、比較時は W/ を無視する
function normalizeEtag(value) {
  return String(value || '').trim().replace(/^W\//, '');
}

/** 見出し行と各行の種別を確認し、件数を返す。問題があれば { error } */
function summarizeMasterCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== MASTER_HEADER) {
    return { error: `見出し行が想定と違います: ${lines[0].slice(0, 200)}` };
  }
  let items = 0;
  let exceptions = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    if (line.startsWith('I,')) items++;
    else if (line.startsWith('P,')) exceptions++;
    else return { error: `${i + 1} 行目の種別が I でも P でもありません。` };
  }
  if (items === 0) return { error: '商品行（I 行）がありません。' };
  return { items, exceptions };
}

/** 現在のマスタを退避し、古いバックアップを削除する（新しい順に BACKUP_KEEP 件を残す） */
async function backupCurrentMaster(storage, key) {
  const current = await storage.get(key);
  if (!current) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await storage.put(`${BACKUP_PREFIX}pop-master-${stamp}.csv`, await new Response(current.body).arrayBuffer(), CSV_TYPE);

  const keys = (await storage.list(BACKUP_PREFIX)).sort();   // 名前に日時が入っているので名前順＝古い順
  await storage.delete(keys.slice(0, Math.max(0, keys.length - BACKUP_KEEP)));
}
