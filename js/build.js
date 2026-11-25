// Сборка демо на готовом примере: оба теста по 35 и озвученная лекция.
// Каждый шаг сохраняется в браузере, поэтому после сбоя сборка продолжается с того же места.
import { CONFIG } from './config.js';
import { $, h, pool, keepAwake, plural } from './util.js';
import * as auth from './auth.js';
import * as store from './store.js';
import { onSpend, spend } from './api.js';
import { extractFile, jszip } from './extract.js';
import { buildFacts, buildQuiz, balance, selfCheck } from './generate.js';
import { planLecture, writeScene } from './lecture.js';
import { synth } from './voice.js';

const app = $('#app'), N = 35, LIMIT = 2, P = 'build.';
const NAME = 'Как работает нейросеть.pdf';
let before = 0, running = false, error = '', steps = [];
window.zachetBuild = { get state() { return { running, error, steps }; } };

const total = () => before + spend.total;
onSpend(() => { $('#spend').textContent = `Потрачено $${total().toFixed(3)}`; store.put(P + 'spend', total()); });

async function cached(key, make) {
  const old = await store.get(P + key);
  if (old !== undefined) return old;
  if (total() > LIMIT) throw new Error(`Сборка остановлена: потрачено больше $${LIMIT}.`);
  const v = await make();
  await store.put(P + key, v);
  return v;
}

let lameP;
function lame() {
  lameP ||= new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'vendor/lamejs/lame.min.js'; s.onload = () => ok(window.lamejs); s.onerror = () => no(new Error('Не загрузился кодировщик звука.')); document.head.append(s); });
  return lameP;
}
async function toMp3(wav) {
  const L = await lame(), pcm = new Int16Array(await wav.slice(44).arrayBuffer());
  const enc = new L.Mp3Encoder(1, CONFIG.voice.sampleRate, 64), out = [];
  for (let i = 0; i < pcm.length; i += 1152) { const b = enc.encodeBuffer(pcm.subarray(i, i + 1152)); if (b.length) out.push(new Uint8Array(b)); }
  const e = enc.flush(); if (e.length) out.push(new Uint8Array(e));
  return new Blob(out, { type: 'audio/mpeg' });
}

// Две попытки по лекции; удачные вопросы складываются, на один факт остаётся один вопрос.
async function quiz(kind, L, say) {
  const byFact = new Map();
  for (let i = 0; i < 3; i++) {
    const extra = i === 2;
    const q = await buildQuiz(kind, N, L, { extra }, say);
    q.items.forEach(x => { const k = x.extra ? x.text : x.fact; if (!byFact.has(k)) byFact.set(k, x); });
    const items = balance(kind, [...byFact.values()], N);
    const res = { kind, asked: N, n: items.length, items };
    if (selfCheck(res, L).every(r => r.ok)) return res;
    if (i === 2) return res;
    say('Добираю вопросы');
  }
}

async function build() {
  running = true; error = ''; draw(); keepAwake(true);
  try {
    const step = (i, text, done) => { steps[i] = { ...steps[i], text, done }; draw(); };
    steps = ['Факты', 'Тест с вариантами', 'Правильно / неправильно', 'Сценарий лекции', 'Озвучка'].map(name => ({ name }));
    const f = await fetch('demo/lecture.pdf').then(r => { if (!r.ok) throw new Error('Не загрузился пример лекции.'); return r.blob(); });
    const ex = await extractFile(new File([f], NAME), 0, 1);
    const L = { docs: [ex.doc], pages: ex.pages, facts: null, lang: 'ru' };
    const prog = i => (t, d, n) => step(i, t + (n ? ` (${d} из ${n})` : ''));
    step(0, 'Читаю лекцию');
    const fx = await cached('facts', async () => { await buildFacts(L, (d, n) => step(0, `Читаю лекцию (${d} из ${n})`)); if (L.facts.length < N) throw new Error(`Фактов всего ${L.facts.length}. Повторите.`); return { facts: L.facts, lang: L.lang }; });
    L.facts = fx.facts; L.lang = fx.lang; step(0, `${L.facts.length}`, true);
    const mcq = await cached('mcq', () => quiz('mcq', L, prog(1))); step(1, `${mcq.items.length} из ${N}`, true);
    const tf = await cached('tf', () => quiz('tf', L, prog(2))); step(2, `${tf.items.length} из ${N}`, true);
    step(3, 'Составляю план');
    const plan = await cached('plan', () => planLecture(L, 'full'));
    let ready = 0; step(3, `Пишу сцены (0 из ${plan.length})`);
    const scenes = await pool(plan, 3, async (_, i) => { const s = await cached('scene' + i, () => writeScene(L, plan, i)); step(3, `Пишу сцены (${++ready} из ${plan.length})`); return s; });
    step(3, `${scenes.length} ${plural(scenes.length, "сцена", "сцены", "сцен")}`, true);
    const list = scenes.flatMap((s, i) => s.fragments.map((fr, k) => ({ fr, name: `s${i + 1}f${k + 1}.mp3` })));
    let said = 0; step(4, `Фраза 0 из ${list.length}`);
    const audio = {}; let bad = 0, seconds = 0;
    await pool(list, CONFIG.voiceParallel, async ({ fr, name }) => {
      const a = await cached('audio.' + name, async () => { const r = await synth(fr.say, L.lang); URL.revokeObjectURL(r.url); return { blob: await toMp3(r.blob), seconds: +r.seconds.toFixed(2), rms: Math.round(r.rms), plausible: r.plausible }; });
      fr.audio = name; fr.seconds = a.seconds; audio[name] = a.blob; seconds += a.seconds; if (!a.plausible) bad++;
      step(4, `Фраза ${++said} из ${list.length}`);
    });
    const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
    step(4, `${list.length} фраз, ${m} мин ${s} с` + (bad ? `, странной длины ${bad}` : ''), true);
    const item = q => ({ kind: q.kind, text: q.text, ...(q.options ? { options: q.options } : {}), answer: q.answer, fact: q.fact, page: q.page, quote: q.quote, image: q.image, extra: q.extra, why: q.why, check: { ok: q.check.ok } });
    const data = { name: NAME, lang: L.lang, facts: L.facts, mcq: mcq.items.map(item), tf: tf.items.map(item), scenes: scenes.map(x => ({ title: x.title, pages: x.pages, fragments: x.fragments.map(({ kind, show, note, image, say, page, anchor, audio: au, seconds: sec }) => ({ kind, show, note, image, say, page, anchor, audio: au, seconds: sec })) })) };
    await store.put('demo', { data, audio, spent: total(), at: Date.now() });
    navigator.storage?.persist?.().catch(() => {});
    done = { mcq: selfCheck(mcq, L), tf: selfCheck(tf, L) };
  } catch (e) { console.warn(e); error = e.message || 'Что-то пошло не так.'; }
  finally { running = false; keepAwake(false); draw(); }
}
let done = null;

async function makeFile() {
  const d = await store.get('demo'), Z = await jszip(), z = new Z();
  z.file('demo.json', JSON.stringify(d.data, null, 1)); z.file('spent.txt', String(d.spent));
  for (const [n, b] of Object.entries(d.audio)) z.file(n, b, { compression: 'STORE' });
  return new File([await z.generateAsync({ type: 'blob' })], 'zachet-demo.zip', { type: 'application/zip' });
}
async function save() {
  const f = await makeFile(), a = h('a', { href: URL.createObjectURL(f), download: f.name });
  document.body.append(a); a.click(); a.remove();
}

const table = (name, rows) => h('div', { class: 'selfcheck' }, h('h2', {}, name), h('table', {}, h('tbody', {}, rows.map(r => h('tr', { class: r.ok ? '' : 'no' }, h('th', { scope: 'row' }, r.name), h('td', {}, r.value), h('td', { class: 'st' }, r.ok ? 'да' : 'нет'))))));

function login() {
  const rem = h('input', { type: 'checkbox' }), field = h('input', { type: 'password', class: 'field', placeholder: 'Ключ OpenRouter', autocomplete: 'off', 'aria-label': 'Ключ OpenRouter' });
  return h('div', { class: 'br' }, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => auth.startLogin(rem.checked) }, 'Войти через OpenRouter'), h('label', { class: 'chk' }, rem, 'Запомнить на этом устройстве')),
    h('details', { class: 'own' }, h('summary', {}, 'Вставить готовый ключ'), h('form', { class: 'row', onsubmit: e => { e.preventDefault(); const v = field.value.trim(); if (v.length < 20) { error = 'Это не похоже на ключ OpenRouter.'; } else { auth.setKey(v, rem.checked); error = ''; } draw(); } }, field, h('button', { class: 'btn ghost', type: 'submit' }, 'Сохранить ключ'))));
}
const row = (name, about, ...kids) => h('div', { class: 'brow' }, h('div', { class: 'bl' }, h('h2', {}, name), about ? h('p', {}, about) : null), h('div', { class: 'br' }, kids));

async function draw() {
  const has = await store.get('demo').catch(() => null);
  app.replaceChildren(h('section', { class: 'blank' },
    !auth.hasKey() ? h('div', { class: 'brow' }, h('div', { class: 'bl' }, h('h2', {}, 'Ключ'), h('p', {}, 'Тот же, что на главной странице.')), login()) : null,
    row('Сборка демо', 'Пять–десять минут. Не закрывайте страницу и не сворачивайте браузер.',
      steps.length ? h('ul', { class: 'files' }, steps.map(s => h('li', {}, h('b', {}, (s.done ? '● ' : '○ ') + s.name), h('span', {}, s.text || '')))) : null,
      running ? h('div', { class: 'job', role: 'status' }, h('div', { class: 'bubbar wait' }, Array.from({ length: 12 }, () => h('i')))) : null,
      error ? h('div', { class: 'err', role: 'alert' }, h('p', { text: error })) : null,
      !running && auth.hasKey() ? h('div', { class: 'row' }, h('button', { class: 'btn' + (has && !error ? ' ghost' : ''), id: 'go', type: 'button', onclick: async () => { if (done) { await store.drop(P); before = 0; done = null; } build(); } }, error ? 'Повторить' : has ? 'Собрать заново' : 'Собрать')) : null),
    has && !running ? row('Демо готово', 'Сохранено на этом устройстве.', h('div', { class: 'row' }, h('a', { class: 'btn', href: './#demo' }, 'Открыть демо'), h('button', { class: 'btn ghost', type: 'button', onclick: save }, 'Сохранить файл')),
      done ? [table('Тест с вариантами', done.mcq), table('Правильно / неправильно', done.tf)] : null) : null));
}

(async () => {
  const r = await auth.finishLogin(); if (r && r.error) error = r.error;
  before = (await store.get(P + 'spend').catch(() => 0)) || 0;
  if (before) $('#spend').textContent = `Потрачено $${before.toFixed(3)}`;
  draw();
})();
