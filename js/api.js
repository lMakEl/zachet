import { CONFIG } from './config.js';
import { getKey } from './auth.js';
import { sleep } from './util.js';

export class ApiError extends Error {
  constructor(kind, message, retry = true) { super(message); this.kind = kind; this.retry = retry; }
}

export const spend = { text: 0, voice: 0, calls: 0, get total() { return this.text + this.voice; } };
const listeners = new Set();
export const onSpend = fn => listeners.add(fn);
function addSpend(part, v) { if (v > 0) spend[part] += v; spend.calls++; listeners.forEach(f => f(spend)); }

function explain(status, body) {
  const msg = (body && body.error && body.error.message) || '';
  if (status === 401) return new ApiError('key', 'Ключ не подошёл или истёк. Выйдите и войдите через OpenRouter заново.', false);
  if (status === 402) return new ApiError('money', 'На ключе кончились деньги или исчерпан лимит. Пополните счёт OpenRouter или поднимите лимит ключа.');
  if (status === 403) return new ApiError('forbidden', 'OpenRouter отклонил запрос: ' + (msg || 'доступ запрещён'));
  if (status === 429) return new ApiError('rate', 'Слишком много запросов подряд. Подождите полминуты и повторите.');
  if (status === 408 || status === 504) return new ApiError('timeout', 'Модель не ответила вовремя. Повторите.');
  if (status >= 500) return new ApiError('server', 'Модель временно недоступна. Повторите чуть позже.');
  return new ApiError('request', `OpenRouter не принял запрос (код ${status})${msg ? ': ' + msg : ''}`);
}

async function request(path, payload, read) {
  const waits = [1500, 4000, 9000];
  for (let attempt = 0; ; attempt++) {
    const key = getKey();
    if (!key) throw new ApiError('key', 'Сначала войдите через OpenRouter.', false);
    let err, after = 0;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), CONFIG.timeoutMs);
    try {
      const r = await fetch(CONFIG.api + path, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'X-Title': 'Zachet' },
        body: JSON.stringify(payload),
      });
      if (r.ok) return await read(r);
      after = Number(r.headers.get('retry-after')) * 1000 || 0;
      err = explain(r.status, await r.json().catch(() => null));
    } catch (e) {
      if (e instanceof ApiError) err = e;
      else if (e.name === 'AbortError') err = new ApiError('timeout', 'Модель не ответила за три минуты. Повторите.');
      else err = new ApiError('network', 'Нет связи с OpenRouter. Проверьте интернет и повторите.');
    } finally { clearTimeout(timer); }
    const again = ['rate', 'server', 'network', 'timeout', 'cut', 'format'].includes(err.kind);
    const limit = ['cut', 'format', 'timeout'].includes(err.kind) ? 1 : waits.length;
    if (!again || attempt >= limit) throw err;
    await sleep(Math.min(20000, Math.max(after, waits[attempt])) + Math.random() * 400);
    if (err.kind === 'cut') payload = { ...payload, max_tokens: Math.round(payload.max_tokens * 1.8) };
  }
}

// Запрос к языковой модели со строгой схемой ответа. Возвращает разобранный JSON.
export function chatJson({ model, system, content, schema, name, maxTokens = 8000, effort = 'low' }) {
  const payload = {
    model, max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
    reasoning: { effort }, provider: { require_parameters: true }, usage: { include: true },
  };
  return request('/chat/completions', payload, async r => {
    const d = await r.json().catch(() => { throw new ApiError('network', 'Ответ пришёл не целиком. Повторите.'); });
    addSpend('text', Number(d.usage && d.usage.cost) || 0);
    const c = d.choices && d.choices[0];
    const e = d.error || (c && c.error);
    if (e) throw explain(Number(e.code) || 500, { error: e });
    if (!c) throw new ApiError('server', 'Модель вернула пустой ответ. Повторите.');
    if (c.finish_reason === 'length') throw new ApiError('cut', 'Ответ модели оборвался на полуслове. Повторите.');
    const text = ((c.message && c.message.content) || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    try { return JSON.parse(text); }
    catch { throw new ApiError('format', 'Модель ответила не в том виде. Повторите.'); }
  });
}

// Озвучка фразы: PCM 24 кГц, 16 бит, моно. Возвращает Int16Array.
export function speech(text, instructions) {
  return request('/audio/speech', { model: CONFIG.models.voice, input: text, voice: CONFIG.voiceName, response_format: 'pcm', instructions }, async r => {
    const type = r.headers.get('content-type') || '';
    if (type.includes('json')) throw explain(500, await r.json().catch(() => null));
    const buf = await r.arrayBuffer();
    const pcm = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
    addSpend('voice', pcm.length / CONFIG.voice.sampleRate * CONFIG.voicePrice.tokensPerSecond * CONFIG.voicePrice.perMillion / 1e6);
    return pcm;
  });
}

// Остаток и расход по ключу (по данным OpenRouter). null — если не удалось узнать.
export async function keyInfo() {
  try {
    const r = await fetch(CONFIG.api + '/key', { headers: { Authorization: 'Bearer ' + getKey() } });
    if (r.status === 401) return { bad: true };
    if (!r.ok) return null;
    const { data } = await r.json();
    return { limit: data.limit, left: data.limit_remaining, used: data.usage };
  } catch { return null; }
}
