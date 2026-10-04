/**
 * 商品マスタ専用 Web Worker（モジュールWorker）
 *  - マスタの取得・索引作成・検索をすべてここで行う（画面は固まらない）
 *  - サーバー（/api/master）からは CSV がそのまま届くので、解析もここで行う
 *  - 解析したマスタは IndexedDB に保存し、次回以降は即座に利用
 *  - 裏でサーバーにバージョン確認し、変わっていれば自動で差し替え
 *  - 列名の解決はここで完結し、画面には変換済みの「商品データ」だけを渡す
 *  - 価格は「指定された店舗の例外価格（P 行）があればそれ、無ければ標準価格（I 行）」
 *
 * 起動: new Worker(new URL('./master-worker.js', import.meta.url), { type: 'module' })
 *
 * メッセージ:
 *   受信: {type:'init'} / {type:'lookup', id, jan, store} / {type:'search', id, keyword, limit, store}
 *         store は店舗番号（空なら標準価格）
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
import { normalizeJan, normalizeStore, createRowReader, findMissingRequired, COLUMNS, ROW_TYPE } from './master-schema.js';
import { parseCsv } from '../shared/csv.js';

const API_URL = '/api/master';
const DB_NAME = 'pop-master-cache';
const DB_VERSION = 1;
const STORE = 'master';
const RECORD_KEY = 'current';

let rows = [];
let reader = null;
let itemRowIdx = [];        // 商品行（I 行）の行番号。検索はこの順に行う
let janIndex = new Map();   // JAN → 商品行の行番号（同じJANが複数あれば後ろの行が優先）
let priceIndex = new Map(); // "店舗番号\tJAN" → 例外価格行（P 行）の行番号
let nameIndex = [];         // 正規化済み商品名（itemRowIdx と同じ並び。検索用）

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
      reply(msg.id, lookup(msg.jan, msg.store));
      break;
    case 'search':
      await ready;
      reply(msg.id, search(msg.keyword, msg.limit || 20, msg.store));
      break;
  }
};

function reply(id, data) {
  self.postMessage({ type: 'result', id, data });
}

function postStatus(state, extra = {}) {
  self.postMessage({ type: 'status', state, count: itemRowIdx.length, ...extra });
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
    if (res.status === 401) throw new Error('ログインの有効期限が切れました。画面を再読み込みしてください');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (!cached) postStatus('loading', { message: 'マスタを解析中...' });

    // ETag はサーバーが付けたバージョン。次回の確認（If-None-Match）にそのまま使う
    const data = { version: res.headers.get('ETag') || '', ...parseCsv(await res.text()) };
    if (!isValidMaster(data)) {
      const missing = Array.isArray(data?.headers) ? findMissingRequired(data.headers) : [];
      missing.forEach(key => {
        console.warn(`[master-worker] 「${COLUMNS[key]}」の列が見つかりません。master-schema.js の COLUMNS と index.js の MASTER_HEADER を確認してください。`);
      });
      throw new Error('マスタの形式が不正です');
    }

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

// 必須列がそろっていなければ使わない（旧形式のキャッシュもここで捨てられる）
function isValidMaster(data) {
  return !!data && Array.isArray(data.headers) && Array.isArray(data.rows)
    && findMissingRequired(data.headers).length === 0;
}

// ------------------------------------------------------------
// 索引作成
// ------------------------------------------------------------
function normalizeName(s) {
  // 全角英数・半角カナなどを揃えて、大文字小文字を区別しない
  return String(s ?? '').normalize('NFKC').toLowerCase();
}

function priceKey(store, jan) {
  return `${store}\t${jan}`;
}

function buildIndex(data) {
  const newReader = createRowReader(data.headers);
  const newRows = data.rows;
  const newItemRowIdx = [];
  const newJanIndex = new Map();
  const newPriceIndex = new Map();
  const newNameIndex = [];

  for (let i = 0; i < newRows.length; i++) {
    const row = newRows[i];
    const jan = newReader.jan(row);
    if (!jan) continue;
    const type = newReader.type(row);

    if (type === ROW_TYPE.ITEM) {
      newJanIndex.set(jan, i);
      newItemRowIdx.push(i);
      newNameIndex.push(normalizeName(newReader.name(row)));
    } else if (type === ROW_TYPE.PRICE) {
      const store = newReader.store(row);
      if (store) newPriceIndex.set(priceKey(store, jan), i);
    }
  }

  // 検索中に中途半端な状態が見えないよう、最後にまとめて差し替える
  rows = newRows;
  reader = newReader;
  itemRowIdx = newItemRowIdx;
  janIndex = newJanIndex;
  priceIndex = newPriceIndex;
  nameIndex = newNameIndex;
}

// ------------------------------------------------------------
// 検索（結果は商品データの形で返す）
// ------------------------------------------------------------
/** 商品行を、店舗の価格を当てはめた商品データにする */
function toItemForStore(rowIdx, store) {
  const row = rows[rowIdx];
  let priceRow = null;
  if (store) {
    const p = priceIndex.get(priceKey(store, reader.jan(row)));
    if (p !== undefined) priceRow = rows[p];
  }
  return reader.toItem(row, priceRow);
}

function lookup(jan, store) {
  const key = normalizeJan(jan);
  if (!key) return null;
  const idx = janIndex.get(key);
  return idx === undefined ? null : toItemForStore(idx, normalizeStore(store));
}

function search(keyword, limit, store) {
  const kw = normalizeName(keyword).trim();
  if (!kw) return [];
  const st = normalizeStore(store);
  const out = [];
  for (let i = 0; i < nameIndex.length && out.length < limit; i++) {
    if (nameIndex[i].includes(kw)) out.push(toItemForStore(itemRowIdx[i], st));
  }
  return out;
}

// ------------------------------------------------------------
// IndexedDB ヘルパー（解析結果 {version, headers, rows} を保存）
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
