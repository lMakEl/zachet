export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Узел DOM: текст попадает только через textContent.
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

// Не даёт экрану погаснуть, пока идёт сборка или лекция.
let lock = null, wantLock = false;
export async function keepAwake(on) {
  wantLock = on;
  try {
    if (on && !lock && document.visibilityState === 'visible') { lock = await navigator.wakeLock?.request('screen'); lock?.addEventListener('release', () => { lock = null; }); }
    else if (!on && lock) { await lock.release(); lock = null; }
  } catch { /* экран погаснет по обычным настройкам */ }
}
document.addEventListener('visibilitychange', () => { if (wantLock) keepAwake(true); });

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function shuffle(a) {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}

export function chunk(a, n) { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; }

// Параллельное выполнение с ограничением. Первая ошибка останавливает очередь.
export async function pool(items, limit, fn) {
  const out = new Array(items.length); let next = 0, failed = null;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { failed = failed || e; }
    }
  }));
  if (failed) throw failed;
  return out;
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many;
}
export const questionsWord = n => `${n} ${plural(n, 'вопрос', 'вопроса', 'вопросов')}`;

// Нормализация для поиска цитат: только буквы и цифры, без регистра, ё=е, без мягких переносов.
export function normMap(text) {
  let norm = ''; const map = [];
  let i = 0;
  for (const ch of text) {
    const c = ch.normalize('NFKC').toLowerCase().replace(/ё/g, 'е');
    for (const d of c) if (/[\p{L}\p{N}]/u.test(d)) { norm += d; for (let k = 0; k < d.length; k++) map.push(i); }
    i += ch.length;
  }
  return { norm, map };
}
export const norm = t => normMap(t || '').norm;

// Положение цитаты в исходном тексте: {from, to} или null.
export function findQuote(text, quote, minLen = 12) {
  const q = norm(quote);
  if (q.length < minLen) return null;
  const { norm: n, map } = normMap(text);
  const at = n.indexOf(q);
  if (at < 0) return null;
  return { from: map[at], to: map[at + q.length - 1] + 1 };
}

export function detectLang(text) {
  const t = (text || '').slice(0, 60000).toLowerCase();
  const cyr = (t.match(/[а-яё]/g) || []).length, lat = (t.match(/[a-z]/g) || []).length, kk = (t.match(/[әғқңөұүһі]/g) || []).length;
  if (cyr + lat < 300) return null;
  if (cyr + kk < lat) return 'en';
  return kk / Math.max(1, cyr + kk) > 0.03 ? 'kk' : 'ru';
}
export const LANG = { ru: { ru: 'русский', on: 'русском', bcp: 'ru-RU' }, kk: { ru: 'казахский', on: 'казахском', bcp: 'kk-KZ' }, en: { ru: 'английский', on: 'английском', bcp: 'en-US' } };

const stems = t => new Set((t.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).map(w => w.slice(0, 5)));
export function similarity(a, b) {
  const x = stems(a), y = stems(b); if (!x.size || !y.size) return 0;
  let c = 0; for (const w of x) if (y.has(w)) c++;
  return c / (x.size + y.size - c);
}
