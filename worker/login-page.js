/**
 * ログイン画面の HTML（ログイン前は CSS ファイルも読めないので、見た目はこの中に書く）
 */
function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function renderLoginPage({ next = '/', error = false } = {}) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>ログイン - POP作成システム</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Meiryo", sans-serif;
         background: #f1f5f9; color: #1e293b; }
  form { width: min(22rem, calc(100% - 2rem)); padding: 2rem; background: #fff; border-radius: .75rem;
         border-top: 6px solid #312e81; box-shadow: 0 10px 15px -3px rgba(0,0,0,.1); }
  h1 { margin: 0 0 1.5rem; font-size: 1.25rem; text-align: center; color: #312e81; }
  label { display: block; margin-bottom: 1rem; font-size: .875rem; font-weight: 700; color: #475569; }
  input { display: block; width: 100%; margin-top: .25rem; padding: .625rem .75rem; font-size: 1rem;
          border: 1px solid #cbd5e1; border-radius: .5rem; }
  input:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px #c7d2fe; }
  button { width: 100%; margin-top: .5rem; padding: .75rem; font-size: 1rem; font-weight: 700; color: #fff;
           background: #4f46e5; border: 0; border-radius: .5rem; cursor: pointer; }
  button:hover { background: #4338ca; }
  .error { margin: 0 0 1rem; padding: .625rem .75rem; font-size: .875rem; color: #991b1b;
           background: #fee2e2; border: 1px solid #f87171; border-radius: .5rem; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>POP作成システム</h1>
  ${error ? '<p class="error">ID またはパスワードが違います。</p>' : ''}
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <label>ID<input type="text" name="user" autocomplete="username" required autofocus></label>
  <label>パスワード<input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">ログイン</button>
</form>
</body>
</html>`;
}
