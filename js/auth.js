import { CONFIG } from './config.js';
// Ключ живёт в sessionStorage; в localStorage — только если пользователь поставил галочку «запомнить».
const KEY = 'zachet.key', VER = 'zachet.pkce', STATE = 'zachet.state', REM = 'zachet.remember';
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = n => b64(crypto.getRandomValues(new Uint8Array(n)));

export const getKey = () => sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || '';
export const hasKey = () => !!getKey();
export function setKey(key, remember) {
  sessionStorage.setItem(KEY, key);
  if (remember) localStorage.setItem(KEY, key); else localStorage.removeItem(KEY);
}
export function logout() { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); }

export async function startLogin(remember) {
  const verifier = rand(32), state = rand(16);
  sessionStorage.setItem(VER, verifier);
  sessionStorage.setItem(STATE, state);
  sessionStorage.setItem(REM, remember ? '1' : '');
  const challenge = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const u = new URL('https://openrouter.ai/auth');
  u.search = new URLSearchParams({
    callback_url: location.origin + location.pathname, code_challenge: challenge, code_challenge_method: 'S256',
    key_label: CONFIG.oauth.keyLabel, limit: CONFIG.oauth.limit, expiration: CONFIG.oauth.expiration, state,
  });
  location.assign(u);
}

// Возврат с OpenRouter. Отдаёт null (не возврат), {ok:true} или {error}.
export async function finishLogin() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code'), state = q.get('state');
  if (!code && !q.get('error')) return null;
  history.replaceState(null, '', location.pathname + location.hash);
  const verifier = sessionStorage.getItem(VER), expected = sessionStorage.getItem(STATE), remember = sessionStorage.getItem(REM) === '1';
  [VER, STATE, REM].forEach(k => sessionStorage.removeItem(k));
  if (q.get('error')) return { error: 'OpenRouter не подтвердил вход. Нажмите «Войти» ещё раз.' };
  if (!verifier || !expected || state !== expected) return { error: 'Вход не подтверждён: ответ пришёл не на этот запрос. Нажмите «Войти» ещё раз.' };
  try {
    const r = await fetch(CONFIG.api + '/auth/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    if (!r.ok) return { error: `OpenRouter не выдал ключ (код ${r.status}). Нажмите «Войти» ещё раз.` };
    const { key } = await r.json();
    if (!key) return { error: 'OpenRouter не выдал ключ. Нажмите «Войти» ещё раз.' };
    setKey(key, remember);
    return { ok: true };
  } catch { return { error: 'Нет связи с OpenRouter. Проверьте интернет и войдите ещё раз.' }; }
}
