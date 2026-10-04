/**
 * Cloudflare Workers 用の入口。
 * サーバー本体（src/app.js）は実行環境に依存しない。Cloudflare 固有のもの（R2・画面ファイルの配信・
 * 設定値の読み方）はここで渡すだけにしている。
 *
 * 他の環境（Node.js・Render など）に移すときは、この入口と src/storage/ の部品だけを作り直す。
 */
import { createApp } from './app.js';
import { createR2Storage } from './storage/r2.js';

export default createApp({
  getStorage: (c) => createR2Storage(c.env.MY_R2_BUCKET),
  serveAsset: (c) => c.env.ASSETS.fetch(c.req.raw),
  getEnv: (c, name) => c.env?.[name]
});
