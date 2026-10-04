/**
 * ストレージ部品（Cloudflare R2 版）
 *
 * サーバー本体（src/app.js）はこの形だけを前提にしている。他のストレージに移すときは、
 * 同じ形の部品（例: S3 版・ローカルフォルダ版）を作って入口で差し替える。
 *
 *   head(key)                  → { etag } | null           本文を読まずに変更検知用の値を返す
 *   get(key)                   → { body, etag, contentType } | null   body は ReadableStream
 *   put(key, data, contentType)                             data は ArrayBuffer
 *   list(prefix)               → string[]                   キーの一覧
 *   delete(keys)                                            keys は string[]
 */
export function createR2Storage(bucket) {
  return {
    async head(key) {
      const o = await bucket.head(key);
      return o ? { etag: o.etag } : null;
    },

    async get(key) {
      const o = await bucket.get(key);
      if (!o) return null;
      return { body: o.body, etag: o.etag, contentType: o.httpMetadata?.contentType || '' };
    },

    async put(key, data, contentType) {
      await bucket.put(key, data, { httpMetadata: { contentType } });
    },

    async list(prefix) {
      const keys = [];
      let cursor;
      do {
        const res = await bucket.list({ prefix, cursor });
        res.objects.forEach(o => keys.push(o.key));
        cursor = res.truncated ? res.cursor : undefined;
      } while (cursor);
      return keys;
    },

    async delete(keys) {
      if (keys.length > 0) await bucket.delete(keys);
    }
  };
}
