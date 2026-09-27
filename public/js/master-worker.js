/**
 * 商品マスタ専用 Web Worker
 *  - マスタの取得・JSON解析・索引作成をすべてここで行う（画面は固まらない）
 *  - 取得したマスタは IndexedDB に保存し、次回以降は即座に利用
 *  - 裏でサーバーにバージョン確認し、変わっていれば自動で差し替え
 *
 * メインスレッドとのメッセージ:
 *   受信: {type:'init'} / {type:'lookup', id, jan} / {type:'search', id, keyword, limit}
 *   送信: {type:'status', state, ...} / {type:'result', id, data}
 */
const API_URL = '/api/master';
const DB_NAME = 'pop-master-cache';
const DB_VERSION = 1;
const STORE = 'master';
const RECORD_KEY = 'current';

const JAN_COLUMNS = ['JAN', 'JANコード', 'jan'];
const NAME_COLUMNS = ['品名', '商品名'];

let headers = [];
let rows = [];
let janIndex = new Map();   // JAN → 行番号
let nameIndex = [];         // 正規化済み商品名（検索用）
let janCols = [];
let nameCols = [];

let initialized = false;
let resolveReady;
const ready = new Promise(r => { resolveReady = r; });

self.onmessage = async (e) => {
  const msg = e.data || {};
  switch (msg.type) {
    case 'init':
      if (!initialized) { initialized = true; init(); }
      break;
    case 'lookup':
      await ready;
      reply(msg.id, lookup(msg.jan));
      break;
    case 'search':
      await ready;
      reply(msg.id, search(msg.keyword, msg.limit || 20));
      break;
  }
};

function reply(id, data) {
  self.postMessage({ type: 'result', id, data });
}

function postStatus(state, extra = {}) {
  self.postMessage({ type: 'status', state, ...extra });
}

// ------------------------------------------------------------
// 初期化：キャッシュ → 即利用、その後サーバーで最新確認
// ------------------------------------------------------------
async function init() {
  let cached = null;
  try {
    cached = await idbGet();
  } catch (err) {
    console.warn('[master-worker] IndexedDB読み込み失敗', err);
  }

  if (cached && Array.isArray(cached.headers) && Array.isArray(cached.rows)) {
    buildIndex(cached);
    resolveReady();
    postStatus('ready', { source: 'cache', count: rows.length });
  } else {
    cached = null;
    postStatus('loading', { message: 'マスタをダウンロード中...' });
  }

  try {
    const reqHeaders = {};
    if (cached && cached.version) reqHeaders['If-None-Match'] = cached.version;

    const res = await fetch(API_URL, { cache: 'no-store', headers: reqHeaders });

    if (res.status === 304) {
      postStatus('verified', { count: rows.length });
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (!cached) postStatus('loading', { message: 'マスタを解析中...' });

    const data = await res.json();
    if (!Array.isArray(data.headers) || !Array.isArray(data.rows)) {
      throw new Error('マスタの形式が不正です');
    }

    buildIndex(data);
    resolveReady();
    postStatus(cached ? 'updated' : 'ready', { source: 'network', count: rows.length });

    idbPut(data).catch(err => console.warn('[master-worker] IndexedDB保存失敗', err));

  } catch (err) {
    console.error('[master-worker]', err);
    if (cached) {
      postStatus('stale', { count: rows.length, message: err.message });
    } else {
      postStatus('error', { message: 'マスタ読み込み失敗' });
    }
  }
}

// ------------------------------------------------------------
// 索引作成
// ------------------------------------------------------------
function normalize(s) {
  // 全角英数・半角カナなどを揃えて、大文字小文字を区別しない
  return String(s ?? '').normalize('NFKC').toLowerCase();
}

function findCols(names) {
  return names.map(n => headers.indexOf(n)).filter(i => i >= 0);
}

function firstValue(row, cols) {
  for (const c of cols) {
    const v = row[c];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function buildIndex(data) {
  headers = data.headers;
  rows = data.rows;
  janCols = findCols(JAN_COLUMNS);
  nameCols = findCols(NAME_COLUMNS);

  const newJanIndex = new Map();
  const newNameIndex = new Array(rows.length);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const jan = firstValue(row, janCols);
    if (jan) newJanIndex.set(jan, i);
    newNameIndex[i] = normalize(firstValue(row, nameCols));
  }

  janIndex = newJanIndex;
  nameIndex = newNameIndex;
}

function toObject(i) {
  const row = rows[i];
  const obj = {};
  for (let c = 0; c < headers.length; c++) obj[headers[c]] = row[c] ?? '';
  return obj;
}

// ------------------------------------------------------------
// 検索
// ------------------------------------------------------------
function lookup(jan) {
  const key = String(jan ?? '').trim();
  if (!key) return null;
  const idx = janIndex.get(key);
  return idx === undefined ? null : toObject(idx);
}

function search(keyword, limit) {
  const kw = normalize(keyword).trim();
  if (!kw) return [];
  const out = [];
  for (let i = 0; i < nameIndex.length && out.length < limit; i++) {
    if (nameIndex[i].includes(kw)) out.push(toObject(i));
  }
  return out;
}

// ------------------------------------------------------------
// IndexedDB ヘルパー
// ------------------------------------------------------------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(RECORD_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function idbPut(data) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, RECORD_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
