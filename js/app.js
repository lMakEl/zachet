import { CONFIG } from './config.js';
import { $, h, questionsWord, plural, LANG } from './util.js';
import * as auth from './auth.js';
import { onSpend, keyInfo, spend } from './api.js';
import { extractFile, FileError } from './extract.js';
import { buildFacts, buildQuiz, balance } from './generate.js';
import { planLecture } from './lecture.js';
import { runQuiz, checkPanel } from './quiz.js';
import { Player } from './player.js';
import { saveDemo } from './devtools.js';

const app = $('#app');
const state = { lecture: null, files: [], quizzes: {}, scenes: {}, pick: { mcq: 20, tf: 20, voice: 'short' }, jobs: {}, errors: {}, short: {}, notice: '', demoBank: null };
let current = null;
window.zachet = { state, get current() { return current; }, spend, saveDemo: () => saveDemo(state) };

const fresh = () => { Object.assign(state, { lecture: null, quizzes: {}, scenes: {}, jobs: {}, errors: {}, short: {}, notice: '', demoBank: null }); };
const isDemo = () => !!(state.lecture && state.lecture.demo);

/* ---------- шапка ---------- */
async function drawAccount() {
  const box = $('#account');
  if (!auth.hasKey()) { box.replaceChildren(h('span', { class: 'muted' }, 'Ключ не подключён')); return; }
  const info = h('span', {}, 'Ключ подключён');
  box.replaceChildren(info, h('button', { class: 'txt', type: 'button', onclick: () => { auth.logout(); drawAccount(); home(); } }, 'Выйти'));
  const k = await keyInfo();
  if (k && k.bad) { info.textContent = 'Ключ не действует'; info.className = 'bad'; }
  else if (k && k.left != null) info.textContent = `На ключе осталось $${k.left.toFixed(2)}`;
  if (k && !k.bad) window.zachet.keyUsed = k.used;
}
let spendTimer;
onSpend(s => {
  const el = $('#spend'); el.hidden = false;
  el.textContent = `Потрачено $${s.total.toFixed(3)}`;
  el.title = `Текст: $${s.text.toFixed(4)} по счёту OpenRouter. Голос: около $${s.voice.toFixed(4)}, оценка по длительности.`;
  clearTimeout(spendTimer); spendTimer = setTimeout(drawAccount, 4000);
});

/* ---------- главный экран ---------- */
const FONT = { 'З': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'], 'А': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], 'Ч': ['10001', '10001', '10001', '01111', '00001', '00001', '00001'], 'Ё': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], 'Т': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'] };
function hero() {
  const NS = 'http://www.w3.org/2000/svg', cols = 31, rows = 11, W = 26, H = 20;
  const on = new Set(); [...'ЗАЧЁТ'].forEach((ch, i) => FONT[ch].forEach((r, y) => [...r].forEach((b, x) => { if (b === '1') on.add(`${1 + i * 6 + x},${3 + y}`); })));
  on.add('20,1'); on.add('22,1');
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', `0 0 ${cols * W} ${rows * H}`); s.setAttribute('class', 'omr'); s.setAttribute('role', 'img'); s.setAttribute('aria-label', 'Бланк ответов, на котором закрашено слово «Зачёт»');
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const e = document.createElementNS(NS, 'ellipse'); const f = on.has(`${x},${y}`);
    e.setAttribute('cx', x * W + W / 2); e.setAttribute('cy', y * H + H / 2); e.setAttribute('rx', f ? 10.6 : 9); e.setAttribute('ry', f ? 8.4 : 6.6);
    if (f) { e.setAttribute('class', 'f'); e.style.animationDelay = 120 + x * 34 + ((x * 7 + y * 13) % 9) * 14 + 'ms'; }
    s.append(e);
  }
  return s;
}

function radios(name, list, value, set) {
  return h('div', { class: 'radios', role: 'radiogroup' }, list.map(([v, label]) => h('label', { class: 'rad' }, h('input', { type: 'radio', name, value: String(v), checked: v === value, onchange: () => set(v) }), h('i', { class: 'bub' }), h('span', {}, label))));
}

function home() {
  if (current) { current.destroy(); current = null; }
  const L = state.lecture;
  const input = h('input', { type: 'file', id: 'file', multiple: true, accept: '.pdf,.pptx,.ppsx,.docx', class: 'vh', onchange: e => { addFiles([...e.target.files]); e.target.value = ''; } });
  const drop = h('label', { class: 'drop', for: 'file' }, input, h('b', {}, L && !L.demo ? 'Добавить ещё лекцию' : 'Выбрать лекцию'), h('span', {}, 'или перетащить сюда: PDF, PPTX, PPSX, DOCX'));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  const demoBtn = h('button', { class: 'btn ghost', type: 'button', onclick: openDemo }, 'Открыть демо без ключа');

  const intro = !L ? h('section', { class: 'intro' }, hero(),
    h('div', { class: 'intro-t' }, h('h1', {}, 'Загрузите лекцию и проверьте себя до зачёта'), h('p', { class: 'lead' }, 'Нейросеть прочитает файл, составит тест с вариантами ответов, тест «правильно / неправильно» и расскажет лекцию голосом. К каждому вопросу есть пояснение и цитата.'), CONFIG.demoReady ? h('div', { class: 'row' }, demoBtn) : null)) : null;

  const files = L ? h('ul', { class: 'files' }, L.docs.map((d, i) => h('li', {}, h('b', { text: d.name }), h('span', {}, d.info), L.demo ? null : h('button', { class: 'txt', type: 'button', 'aria-label': 'Убрать ' + d.name, onclick: () => removeDoc(i) }, 'Убрать')))) : null;

  app.replaceChildren(...[
    intro,
    state.notice ? h('p', { class: 'notice', role: 'status', text: state.notice }) : null,
    h('section', { class: 'blank' + (L ? ' has' : '') },
      !auth.hasKey() && !isDemo() ? h('div', { class: 'brow' }, h('div', { class: 'bl' }, h('h2', {}, 'Ключ'), h('p', {}, 'Нужен, чтобы составлять тесты по своей лекции. Потолок расходов $5, срок 30 дней.')), loginBox()) : null,
      h('div', { class: 'brow' }, h('div', { class: 'bl' }, h('h2', {}, 'Лекция'), h('p', { id: 'readstate' }, L ? lectureInfo(L) : 'Одна или несколько сразу.')), h('div', { class: 'br' }, files, L && L.demo ? h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => { fresh(); home(); } }, 'Закрыть демо и загрузить свою лекцию')) : drop)),
      L ? quizRow('mcq', 'Тест с вариантами', 'Четыре варианта, один верный.') : null,
      L ? quizRow('tf', 'Правильно / неправильно', 'Утверждения, половина ложные.') : null,
      L ? voiceRow() : null)].filter(Boolean));
}

function loginBox() {
  const rem = h('input', { type: 'checkbox' });
  const field = h('input', { type: 'password', class: 'field', placeholder: 'Ключ OpenRouter', autocomplete: 'off', 'aria-label': 'Ключ OpenRouter' });
  const save = () => { const v = field.value.trim(); if (v.length < 20) { state.notice = 'Это не похоже на ключ OpenRouter.'; home(); return; } auth.setKey(v, rem.checked); state.notice = ''; drawAccount(); home(); };
  return h('div', { class: 'br' },
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', id: 'login', onclick: () => auth.startLogin(rem.checked) }, 'Войти через OpenRouter'), h('label', { class: 'chk' }, rem, 'Запомнить на этом компьютере')),
    h('details', { class: 'own' }, h('summary', {}, 'Вставить готовый ключ'), h('form', { class: 'row', onsubmit: e => { e.preventDefault(); save(); } }, field, h('button', { class: 'btn ghost', type: 'submit' }, 'Сохранить ключ'))));
}

function lectureInfo(L) {
  const p = L.pages.length, chars = L.pages.reduce((s, x) => s + x.text.length, 0), im = L.pages.filter(x => x.visual.length).length;
  return [`${p} ${plural(p, 'страница', 'страницы', 'страниц')}, ${chars.toLocaleString('ru-RU')} ${plural(chars, 'знак', 'знака', 'знаков')}`, im ? `${im} ${plural(im, 'страница', 'страницы', 'страниц')} картинкой` : '', L.facts ? `${L.facts.length} ${plural(L.facts.length, 'факт', 'факта', 'фактов')}` : '', L.lang ? 'язык ' + LANG[L.lang].ru : ''].filter(Boolean).join(', ');
}

function jobBox(key) {
  const j = state.jobs[key], e = state.errors[key];
  if (j) { const total = j.total || 0; return h('div', { class: 'job', role: 'status' }, h('p', {}, j.text + (total ? ` (${j.done} из ${total})` : '…')), h('div', { class: 'bubbar' + (total ? '' : ' wait') }, Array.from({ length: 12 }, (_, i) => h('i', { class: total && i < Math.round(j.done / total * 12) ? 'on' : '' })))); }
  if (e) return h('div', { class: 'err', role: 'alert' }, h('p', { text: e.message }), h('button', { class: 'btn', type: 'button', onclick: e.again }, 'Повторить'));
  return null;
}

function quizRow(kind, name, about) {
  const q = state.quizzes[kind], busy = !!state.jobs[kind], short = state.short[kind];
  return h('div', { class: 'brow', id: 'row-' + kind }, h('div', { class: 'bl' }, h('h2', {}, name), h('p', {}, about)),
    h('div', { class: 'br' },
      h('div', { class: 'row' }, radios('n-' + kind, CONFIG.counts.map(n => [n, String(n)]), state.pick[kind], v => { state.pick[kind] = v; state.short[kind] = null; }),
        h('button', { class: 'btn' + (q ? ' ghost' : ''), type: 'button', disabled: busy, onclick: () => makeQuiz(kind) }, isDemo() ? 'Начать тест' : q ? 'Составить заново' : 'Составить тест')),
      jobBox(kind),
      short && !busy ? h('div', { class: 'short', role: 'alert' }, h('p', {}, `В лекции хватает материала на ${questionsWord(short.have)}, а выбрано ${short.want}. Добавьте ещё лекцию или выберите:`), h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => makeQuiz(kind, { n: short.have }) }, `Сделать ${short.have}`),
        short.canExtra ? h('button', { class: 'btn ghost', type: 'button', onclick: () => makeQuiz(kind, { extra: true }) }, `Дополнить до ${short.want} сверх лекции, с пометкой`) : null)) : null,
      q && !busy && !isDemo() ? h('div', { class: 'ready' }, h('div', { class: 'row' }, h('p', {}, h('b', {}, `Готово: ${questionsWord(q.items.length)}`)), h('button', { class: 'btn', type: 'button', onclick: () => openQuiz(kind) }, 'Пройти тест')), q.items.length < q.asked ? h('p', { class: 'hint' }, `Проверку прошли ${q.items.length} из ${q.asked}: остальные вопросы вторая модель сочла спорными, они убраны.`) : null, checkPanel(q, state.lecture)) : null));
}

function voiceRow() {
  const L = state.lecture, sc = state.scenes[state.pick.voice];
  const pptx = L.docs.some(d => d.kind === 'pptx');
  return h('div', { class: 'brow', id: 'row-voice' }, h('div', { class: 'bl' }, h('h2', {}, 'Лекция с голосом'), h('p', {}, 'Слайды оживают, голос объясняет.')),
    h('div', { class: 'br' }, h('div', { class: 'row' }, L.demo ? null : radios('size', [['short', 'коротко, 2–4 минуты'], ['full', 'подробно, 5–9 минут']], state.pick.voice, v => { state.pick.voice = v; home(); }),
      h('button', { class: 'btn', type: 'button', disabled: !!state.jobs.voice, onclick: openLecture }, sc ? 'Слушать снова' : 'Слушать лекцию')),
      jobBox('voice'),
      pptx ? h('p', { class: 'hint' }, 'Слайды PPTX пересобираются в конспект. Чтобы показать их в исходном виде, сохраните презентацию в PDF.') : null));
}

/* ---------- файлы ---------- */
async function addFiles(list) {
  if (!list.length) return;
  if (isDemo()) fresh();
  const docs = state.lecture ? [...state.lecture.docs] : [], pages = state.lecture ? [...state.lecture.pages] : [], errs = [];
  state.notice = 'Читаю файлы…'; home();
  for (const f of list) {
    try {
      const r = await extractFile(f, docs.length, pages.reduce((m, p) => Math.max(m, p.id), 0) + 1, (a, b) => { const el = $('#readstate'); if (el) el.textContent = `${f.name}: ${a} из ${b}`; });
      r.doc.info = `${r.doc.pages} ${plural(r.doc.pages, 'страница', 'страницы', 'страниц')}`;
      docs.push(r.doc); pages.push(...r.pages);
    } catch (e) { errs.push(e instanceof FileError ? e.message : `«${f.name}» не прочитался.`); if (!(e instanceof FileError)) console.error(e); }
  }
  const pick = state.pick;
  if (docs.length) { fresh(); state.lecture = { docs, pages, facts: null, lang: null }; }
  state.pick = pick; state.notice = errs.join(' '); home();
}
function removeDoc(i) {
  const L = state.lecture, docs = L.docs.filter((_, k) => k !== i);
  const pages = L.pages.filter(p => p.doc !== i); pages.forEach(p => { if (p.doc > i) p.doc--; });
  fresh(); if (docs.length) state.lecture = { docs, pages, facts: null, lang: null };
  home();
}

/* ---------- задания ---------- */
function progress(key) { return (text, done, total) => { state.jobs[key] = { text, done, total }; if (!current) redrawJob(key); }; }
function redrawJob(key) {
  const row = $('#row-' + key); if (!row) return;
  const old = $('.job', row), el = jobBox(key); if (old && el) old.replaceWith(el); else home();
}
async function job(key, fn, again) {
  if (!auth.hasKey()) { state.notice = 'Чтобы работать со своей лекцией, войдите через OpenRouter.' + (CONFIG.demoReady ? ' Демо работает без ключа.' : ''); home(); window.scrollTo(0, 0); return; }
  state.errors[key] = null; state.short[key] = null; state.notice = ''; state.jobs[key] = { text: 'Начинаю' }; const L = state.lecture; home();
  try { await fn(L, progress(key)); }
  catch (e) { if (state.lecture === L) { console.warn(e); state.errors[key] = { message: e.message || 'Что-то пошло не так.', again }; } }
  finally { if (state.lecture === L) { state.jobs[key] = null; if (!current) home(); } }
}
async function facts(L, say) {
  if (L.facts) return;
  L.factsJob ||= buildFacts(L, (d, t) => say('Читаю лекцию и выписываю факты', d, t)).finally(() => { L.factsJob = null; });
  say('Читаю лекцию и выписываю факты');
  await L.factsJob;
}
function makeQuiz(kind, opt = {}) {
  const n = opt.n || state.pick[kind];
  if (isDemo()) { state.quizzes[kind] = { kind, asked: n, n, items: balance(kind, state.demoBank[kind], n), lang: state.lecture.lang }; openQuiz(kind); return; }
  return job(kind, async (L, say) => {
    await facts(L, say);
    if (!L.facts.length) throw new Error('В лекции не нашлось фактов для вопросов. Проверьте, что файл читается.');
    if (L.facts.length < n && !opt.extra) { state.short[kind] = { have: L.facts.length, want: n, canExtra: true }; return; }
    const q = await buildQuiz(kind, n, L, { extra: !!opt.extra }, say);
    if (!q.items.length) throw new Error('Ни один вопрос не прошёл проверку. Повторите.');
    state.quizzes[kind] = q;
  }, () => makeQuiz(kind, opt));
}
function enter(node) { app.replaceChildren(node); window.scrollTo(0, 0); return node; }
function backBar(title) { return h('div', { class: 'back' }, h('button', { class: 'txt', type: 'button', onclick: home }, 'К лекции'), h('p', { text: title })); }

function openQuiz(kind) {
  const q = state.quizzes[kind], box = h('div', {});
  enter(h('div', { class: 'screen' }, backBar((kind === 'mcq' ? 'Тест с вариантами: ' : 'Правильно или неправильно: ') + state.lecture.docs.map(d => d.name).join(', ')), box));
  current = runQuiz(box, q, state.lecture, { onExit: home });
}
async function openLecture() {
  const L = state.lecture, size = state.pick.voice;
  const show = scenes => {
    const box = h('div', {});
    enter(h('div', { class: 'screen wide' }, backBar(L.docs.map(d => d.name).join(', ')), box));
    const p = new Player(box, L, scenes, { view: L.docs.every(d => d.view === 'original') ? 'original' : 'notes', onExit: home });
    current = p; p.start();
  };
  if (isDemo()) { show(state.demoBank.scenes); return; }
  if (state.scenes[size]) { show(state.scenes[size]); return; }
  return job('voice', async (L, say) => {
    await facts(L, say); say('Составляю план лекции');
    const plan = await planLecture(L, size);
    if (!plan.length) throw new Error('План лекции не сложился. Повторите.');
    state.scenes[size] = plan;
    // Первую сцену пишем заранее: плеер откроется уже с материалом.
    say('Пишу первую сцену');
    const { writeScene } = await import('./lecture.js');
    plan[0].fragments = (await writeScene(L, plan, 0)).fragments;
    show(plan);
  }, openLecture);
}

/* ---------- демо ---------- */
async function openDemo() {
  state.notice = 'Открываю демо…'; home();
  try {
    const [d, f] = await Promise.all([fetch('demo/demo.json').then(r => { if (!r.ok) throw 0; return r.json(); }), fetch('demo/lecture.pdf').then(r => { if (!r.ok) throw 0; return r.blob(); })]);
    const r = await extractFile(new File([f], d.name), 0, 1);
    r.doc.info = `${r.doc.pages} слайдов, пример внутри сайта`;
    fresh();
    state.lecture = { demo: true, docs: [r.doc], pages: r.pages, facts: d.facts, lang: d.lang };
    state.demoBank = { mcq: d.mcq, tf: d.tf, scenes: d.scenes.map(s => ({ ...s, fragments: s.fragments.map(x => ({ ...x, url: x.audio ? 'demo/' + x.audio : null })) })) };
  } catch { state.notice = 'Демо не загрузилось. Обновите страницу.'; }
  home();
}

/* ---------- запуск ---------- */
$('#logo').addEventListener('click', e => { e.preventDefault(); home(); });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => e.preventDefault());
(async () => {
  home();
  const r = await auth.finishLogin();
  if (r) { state.notice = r.error || 'Вход выполнен. Теперь добавьте лекцию.'; home(); }
  drawAccount();
})();
