/**
 * 商品マスタ専用 Web Worker（モジュールWorker）
 *  - マスタの取得・索引作成・検索をすべてここで行う（画面は固まらない）
 *  - 取得したマスタは IndexedDB に保存し、次回以降は即座に利用
 *  - 裏でサーバーにバージョン確認し、変わっていれば自動で差し替え
 *  - 列名の解決はここで完結し、画面には変換済みの「商品データ」だけを渡す
 *
 * 起動: new Worker(new URL('./master-worker.js', import.meta.url), { type: 'module' })
 *
 * メッセージ:
 *   受信: {type:'init'} / {type:'lookup', id, jan} / {type:'search', id, keyword, limit}
 *   送信: {type:'status', state, count?, message?} / {type:'result', id, data}
 *
 * state の種類（画面の表示と1対1）:
 *   loading   … キャッシュが無く、初回ダウンロード・解析中
 *   checking  … キャッシュで利用開始、裏で最新を確認中
 *   synced    … 最新のマスタで利用中
 *   updated   … キャッシュが古かったので最新に差し替えた
 *   offline   … サーバーに接続できず、キャッシュで利用中
 *   error     … キャッシュも無く、取得にも失敗
 */
import { normalizeJan, createRowReader, findMissingRequired, COLUMNS } from './master-schema.js';

const API_URL = '/api/master';
const DB_NAME = 'pop-master-cache';
const DB_VERSION = 1;
const STORE = 'master';
const RECORD_KEY = 'current';

let rows = [];
let reader = null;
let janIndex = new Map();   // JAN → 行番号（同じJANが複数あれば後ろの行が優先）
let nameIndex = [];         // 正規化済み商品名（検索用）

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
  self.postMessage({ type: 'status', state, count: rows.length, ...extra });
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

  if (isValidMaster(cached)) {
    buildIndex(cached);
    resolveReady();
    postStatus('checking');
  } else {
    cached = null;
    postStatus('loading', { message: 'マスタをダウンロード中...' });
  }

  try {
    const reqHeaders = {};
    if (cached?.version) reqHeaders['If-None-Match'] = cached.version;

    const res = await fetch(API_URL, { cache: 'no-store', headers: reqHeaders });

    if (res.status === 304) {
      postStatus('synced');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (!cached) postStatus('loading', { message: 'マスタを解析中...' });

    const data = await res.json();
    if (!isValidMaster(data)) throw new Error('マスタの形式が不正です');

    findMissingRequired(data.headers).forEach(key => {
      console.warn(`[master-worker] 「${key}」の列が見つかりません。master-schema.js の COLUMNS.${key} を確認してください。候補: ${COLUMNS[key].join(', ')}`);
    });

    buildIndex(data);
    resolveReady();
    postStatus(cached ? 'updated' : 'synced');

    idbPut(data).catch(err => console.warn('[master-worker] IndexedDB保存失敗', err));

  } catch (err) {
    console.error('[master-worker]', err);
    if (cached) {
      postStatus('offline', { message: err.message });
    } else {
      postStatus('error', { message: 'マスタ読み込み失敗' });
    }
  }
}

function isValidMaster(data) {
  return !!data && Array.isArray(data.headers) && Array.isArray(data.rows);
}

// ------------------------------------------------------------
// 索引作成
// ------------------------------------------------------------
function normalizeName(s) {
  // 全角英数・半角カナなどを揃えて、大文字小文字を区別しない
  return String(s ?? '').normalize('NFKC').toLowerCase();
}

function buildIndex(data) {
  const newReader = createRowReader(data.headers);
  const newRows = data.rows;
  const newJanIndex = new Map();
  const newNameIndex = new Array(newRows.length);

  for (let i = 0; i < newRows.length; i++) {
    const row = newRows[i];
    const jan = newReader.jan(row);
    if (jan) newJanIndex.set(jan, i);
    newNameIndex[i] = normalizeName(newReader.name(row));
  }

  // 検索中に中途半端な状態が見えないよう、最後にまとめて差し替える
  rows = newRows;
  reader = newReader;
  janIndex = newJanIndex;
  nameIndex = newNameIndex;
}

// ------------------------------------------------------------
// 検索（結果は商品データの形で返す）
// ------------------------------------------------------------
function lookup(jan) {
  const key = normalizeJan(jan);
  if (!key) return null;
  const idx = janIndex.get(key);
  return idx === undefined ? null : reader.toItem(rows[idx]);
}

function search(keyword, limit) {
  const kw = normalizeName(keyword).trim();
  if (!kw) return [];
  const out = [];
  for (let i = 0; i < nameIndex.length && out.length < limit; i++) {
    if (nameIndex[i].includes(kw)) out.push(reader.toItem(rows[i]));
  }
  return out;
}

// ------------------------------------------------------------
// IndexedDB ヘルパー（サーバー応答 {version, headers, rows} をそのまま保存）
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
