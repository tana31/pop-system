/**
 * ログイン（全社共通の ID・パスワード1組）と、バッチ用トークンの確認
 *
 * 設定値（Cloudflare では LOGIN_* と SESSION_SECRET・UPLOAD_TOKEN はシークレット、SESSION_DAYS は vars）:
 *   LOGIN_USER      … ログイン ID
 *   LOGIN_PASSWORD  … パスワード（変えると全端末のログインが切れる）
 *   SESSION_SECRET  … ログイン状態の Cookie に付ける署名の鍵（長いランダムな文字列）
 *   SESSION_DAYS    … ログインの有効日数（既定 30。1〜365）
 *   UPLOAD_TOKEN    … バッチからのアップロード用トークン
 *
 * ログイン状態は署名付き Cookie（JavaScript から読めない・HTTPS のみ）で持つ。
 * 中身は「有効期限」と「パスワードから作った目印」で、パスワードを変えると目印が合わなくなる。
 */
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';

const COOKIE_NAME = 'pop_session';
const DEFAULT_SESSION_DAYS = 30;
const MAX_SESSION_DAYS = 365;

export function createAuth(getEnv) {
  const settings = (c) => ({
    user:     getEnv(c, 'LOGIN_USER') || '',
    password: getEnv(c, 'LOGIN_PASSWORD') || '',
    secret:   getEnv(c, 'SESSION_SECRET') || '',
    days:     sessionDays(getEnv(c, 'SESSION_DAYS'))
  });

  return {
    /** ログインに必要な設定がそろっているか */
    isConfigured(c) {
      const s = settings(c);
      return !!(s.user && s.password && s.secret);
    },

    /** ID・パスワードが正しければ Cookie を発行して true */
    async login(c, user, password) {
      const s = settings(c);
      if (!s.user || !s.password || !s.secret) return false;
      // どちらが違っても同じ時間がかかるよう、両方とも必ず比べる
      const okUser = await safeEqual(user, s.user);
      const okPassword = await safeEqual(password, s.password);
      if (!(okUser && okPassword)) return false;

      const expires = Date.now() + s.days * 86400 * 1000;
      await setSignedCookie(c, COOKIE_NAME, `${expires}_${await passwordTag(s)}`, s.secret, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: s.days * 86400
      });
      return true;
    },

    /** 有効なログイン状態か */
    async isLoggedIn(c) {
      const s = settings(c);
      if (!s.user || !s.password || !s.secret) return false;
      const value = await getSignedCookie(c, s.secret, COOKIE_NAME);
      if (!value) return false;
      const [expiresText, tag] = String(value).split('_');
      const expires = Number(expiresText);
      if (!Number.isFinite(expires) || expires < Date.now()) return false;
      return tag === await passwordTag(s);
    },

    logout(c) {
      deleteCookie(c, COOKIE_NAME, { path: '/', secure: true });
    },

    /** Authorization: Bearer のトークンが UPLOAD_TOKEN と一致するか。未設定なら null */
    async checkUploadToken(c) {
      const expected = getEnv(c, 'UPLOAD_TOKEN') || '';
      if (!expected) return null;
      const m = (c.req.header('Authorization') || '').match(/^Bearer\s+(.+)$/);
      if (!m) return false;
      return safeEqual(m[1].trim(), expected);
    }
  };
}

function sessionDays(value) {
  const n = parseInt(String(value ?? ''), 10);
  return n >= 1 && n <= MAX_SESSION_DAYS ? n : DEFAULT_SESSION_DAYS;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** 内容や長さで処理時間が変わらない比較（ハッシュにして長さをそろえてから全バイト比べる） */
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** パスワードから作る目印（パスワードを変えると以前の Cookie が無効になる） */
async function passwordTag(s) {
  const h = await sha256(`${s.user}\n${s.password}`);
  return Array.from(h.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}
