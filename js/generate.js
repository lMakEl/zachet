import { CONFIG } from './config.js';
import { chatJson } from './api.js';
import { pool, chunk, shuffle, findQuote, detectLang, similarity, norm } from './util.js';
import * as P from './prompts.js';

const { author, checker } = CONFIG.models;
const image = im => ({ type: 'image_url', image_url: { url: im.dataUrl } });
const pageTag = p => `<page id="${p.id}" label="${p.label}">\n${(p.text || '').replace(/<\/?page[^>]*>/g, '') || '(текста нет, см. картинку)'}\n</page>`;

// Текст страниц и картинки тех страниц, где текста почти нет.
export function pagesContent(pages, withImages = true) {
  const out = [{ type: 'text', text: '<lecture>\n' + pages.map(pageTag).join('\n') + '\n</lecture>' }];
  if (withImages) for (const p of pages) p.visual.forEach(im => out.push({ type: 'text', text: `Картинка со страницы ${p.id}:` }, image(im)));
  return out;
}

/* ---------- Карта фактов ---------- */
export async function buildFacts(lecture, onProgress = () => {}) {
  const all = lecture.pages.filter(p => p.text.trim().length > 15 || p.visual.length);
  const parts = []; let cur = [], chars = 0, imgs = 0;
  for (const p of all) {
    const len = p.text.length;
    if (cur.length && (chars + len > CONFIG.chunkChars || imgs + p.visual.length > CONFIG.chunkImages)) { parts.push(cur); cur = []; chars = imgs = 0; }
    cur.push(p); chars += len; imgs += p.visual.length;
  }
  if (cur.length) parts.push(cur);
  lecture.lang = detectLang(all.map(p => p.text).join('\n'));
  let done = 0; onProgress(0, parts.length);
  const weight = part => part.reduce((s, p) => s + p.text.length + p.visual.length * 700, 0);
  const total = parts.reduce((s, p) => s + weight(p), 0);
  const want = Math.min(140, Math.max(60, Math.round(total / 160)));
  const votes = [];
  const res = await pool(parts, CONFIG.parallel, async part => {
    const n = Math.max(6, Math.ceil(want * weight(part) / total));
    const d = await chatJson({
      model: author, name: 'facts', schema: P.factsSchema, system: P.factsSystem, maxTokens: 12000,
      content: [...pagesContent(part), { type: 'text', text: `Выпиши из этих страниц все существенные факты, ориентир — около ${n}, без повторов.` }],
    });
    votes.push(d.language); onProgress(++done, parts.length);
    return d.facts;
  });
  if (!lecture.lang) lecture.lang = ['ru', 'kk', 'en'].sort((a, b) => votes.filter(v => v === b).length - votes.filter(v => v === a).length)[0];
  const byId = new Map(lecture.pages.map(p => [p.id, p]));
  const facts = []; let dropped = 0, dup = 0;
  for (const f of res.flat()) {
    let page = byId.get(f.page);
    if (!f.fact || !page) { dropped++; continue; }
    let found = findQuote(page.text, f.quote);
    if (!found) {
      const other = all.find(p => findQuote(p.text, f.quote));
      if (other) { page = other; found = true; }
    }
    const fromImage = !found && page.visual.length > 0;
    if (!found && !fromImage) { dropped++; continue; }
    if (facts.some(x => similarity(x.fact, f.fact) > 0.72 || norm(x.fact) === norm(f.fact))) { dup++; continue; }
    facts.push({ id: 'f' + (facts.length + 1), page: page.id, topic: f.topic, fact: f.fact, quote: f.quote, image: fromImage });
  }
  lecture.facts = facts;
  lecture.factStats = { dropped, dup };
  return facts;
}

/* ---------- Факты сверх лекции ---------- */
async function extraFacts(lecture, n) {
  const d = await chatJson({
    model: author, name: 'extra', schema: P.extraSchema, system: P.extraSystem(lecture.lang), maxTokens: 6000,
    content: [...pagesContent(lecture.pages), { type: 'text', text: `Факты лекции:\n${lecture.facts.map(f => '- ' + f.fact).join('\n')}\n\nНазови ${n} фактов сверх лекции.` }],
  });
  return d.facts.filter(f => !lecture.facts.some(x => similarity(x.fact, f.fact) > 0.7)).map((f, i) => ({ id: 'x' + (i + 1), page: null, topic: f.topic, fact: f.fact, quote: '', image: false, extra: true }));
}

/* ---------- Тесты ---------- */
// Факты берём равномерно по лекции, чтобы тест не собирался из первых страниц.
function pickFacts(facts, n) {
  if (facts.length <= n) return facts;
  const groups = new Map();
  for (const f of facts) { if (!groups.has(f.page)) groups.set(f.page, []); groups.get(f.page).push(f); }
  const lists = [...groups.values()].map(shuffle), out = [];
  while (out.length < n) for (const l of shuffle(lists)) { if (l.length && out.length < n) out.push(l.pop()); }
  return out;
}

const factLine = (f, extra = '') => `<fact id="${f.id}"${f.extra ? ' note="сверх лекции"' : ''}${extra}>\n${f.fact}\nТема: ${f.topic}${f.quote ? `\nЦитата: ${f.quote}` : ''}\n</fact>`;

function lengthHint(q) {
  const longest = Math.max(...q.wrong.map(w => w.length));
  return q.correct.length > longest * 1.25 && q.correct.length - longest > 12;
}

async function write(kind, lecture, facts, remarks) {
  const ids = new Map(facts.map(f => [f.id, f]));
  const pages = lecture.pages.filter(p => facts.some(f => f.page === p.id));
  const topics = [...new Set(lecture.facts.map(f => f.topic))].join('; ');
  const lines = facts.map(f => factLine(f, kind === 'tf' ? ` make="${f.truth ? 'верное' : 'ложное'}"` : '') + (remarks && remarks.get(f.id) ? `\n<rejected fact="${f.id}">${remarks.get(f.id)}</rejected>` : ''));
  const d = await chatJson({
    model: author, name: kind, schema: kind === 'mcq' ? P.mcqSchema : P.tfSchema,
    system: kind === 'mcq' ? P.mcqSystem(lecture.lang) : P.tfSystem(lecture.lang), maxTokens: 9000,
    content: [...pagesContent(pages, false), { type: 'text', text: `Понятия лекции, откуда можно брать неверные варианты: ${topics}\n\n${remarks ? P.redoNote + '\n\n' : ''}Факты:\n${lines.join('\n')}` }],
  });
  const out = [];
  for (const q of kind === 'mcq' ? d.questions : d.statements) {
    const f = ids.get(q.fact_id); if (!f) continue;
    ids.delete(q.fact_id);
    const base = { fact: f.id, page: f.page, quote: f.quote, image: f.image, extra: !!f.extra, why: q.explanation };
    if (kind === 'mcq') {
      const wrong = [...new Set(q.wrong.map(s => s.trim()).filter(s => s && norm(s) !== norm(q.correct)))].slice(0, 3);
      if (!q.question || !q.correct || wrong.length < 3) continue;
      const pos = Math.floor(Math.random() * 4), options = shuffle(wrong); options.splice(pos, 0, q.correct.trim());
      out.push({ ...base, kind, text: q.question, options, answer: pos, long: lengthHint({ correct: q.correct, wrong }) });
    } else if (q.statement) out.push({ ...base, kind, text: q.statement, answer: f.truth, swap: f.truth ? null : [q.swap_from, q.swap_to] });
  }
  return out;
}

async function check(kind, lecture, qs) {
  const res = await pool(chunk(qs, 10), CONFIG.parallel, async batch => {
    const involved = new Set(batch.map(q => q.page));
    const imgs = lecture.pages.filter(p => involved.has(p.id) && p.visual.length);
    const list = batch.map((q, i) => `<item id="${i + 1}"${q.extra ? ' note="сверх лекции"' : ''}>\n${q.text}${kind === 'mcq' ? '\n' + q.options.map((o, k) => 'ABCD'[k] + ') ' + o).join('\n') : ''}\n</item>`).join('\n');
    const content = [{ type: 'text', text: pagesContent(lecture.pages, false)[0].text }];
    imgs.forEach(p => p.visual.forEach(im => content.push({ type: 'text', text: `Картинка со страницы ${p.id}:` }, image(im))));
    content.push({ type: 'text', text: `Реши задания:\n${list}` });
    const d = await chatJson({ model: checker, name: 'check', schema: kind === 'mcq' ? P.checkMcqSchema : P.checkTfSchema, system: P.checkSystem(kind), content, maxTokens: 6000 });
    const m = new Map(d.answers.map(a => [String(a.id), a]));
    batch.forEach((q, i) => {
      const a = m.get(String(i + 1));
      const given = a && (kind === 'mcq' ? 'ABCD'.indexOf(a.answer) : a.verdict === 'true');
      q.check = { ok: !!a && given === q.answer && !a.ambiguous, given: a ? given : null, ambiguous: !!(a && a.ambiguous), note: a ? a.reason : 'нет ответа' };
    });
  });
  return res;
}

const remark = q => {
  const shown = q.kind === 'mcq' ? `${q.text} Варианты: ${q.options.map((o, i) => (i === q.answer ? '[верный по ключу] ' : '') + o).join(' / ')}` : `${q.text} [по ключу ${q.answer ? 'верно' : 'неверно'}]`;
  const why = !q.check.ok
    ? (q.check.ambiguous ? 'эксперт считает задание неоднозначным: ' : `эксперт выбрал ${q.kind === 'mcq' ? '«' + q.options[q.check.given] + '»' : q.check.given ? '«верно»' : '«неверно»'}: `) + q.check.note
    : q.dupe ? 'задание повторяет другое задание этого теста' : 'верный вариант заметно длиннее неверных и этим себя выдаёт';
  return `${shown}\nЗамечание: ${why}`;
};

// Сколько вопросов можно сделать по лекции.
export const capacity = lecture => lecture.facts.length;

/*  opts: {extra: добавить факты сверх лекции}.  Возвращает {kind, n, items, stats} */
export async function buildQuiz(kind, n, lecture, opts, onProgress = () => {}) {
  const need = Math.ceil(n * (1 + CONFIG.reserve));
  let facts = pickFacts(lecture.facts, need);
  if (facts.length < n && opts.extra) {
    onProgress('Подбираю факты сверх лекции');
    facts = [...facts, ...(await extraFacts(lecture, need - facts.length + 2)).slice(0, need - facts.length)];
  }
  // Ложных — половина; какие именно, решает код.
  facts = shuffle(facts); facts.forEach((f, i) => { f.truth = i % 2 === 0; });
  facts = facts.map(f => ({ ...f }));
  const stats = { written: 0, redone: 0, replaced: 0 };
  let done = 0; const batches = chunk(facts, 5);
  onProgress('Пишу вопросы', 0, batches.length);
  let items = (await pool(batches, CONFIG.parallel, async b => {
    const r = await write(kind, lecture, b); onProgress('Пишу вопросы', ++done, batches.length); return r;
  })).flat();
  stats.written = items.length;
  onProgress('Вторая модель решает тест вслепую');
  await check(kind, lecture, items);
  markDupes(items);
  const bad = items.filter(q => !good(q));
  stats.firstMismatch = bad.filter(q => !q.check.ok).length;
  if (bad.length) {
    onProgress(`Переделываю спорные: ${bad.length}`);
    const byId = new Map(facts.map(f => [f.id, f])), notes = new Map(bad.map(q => [q.fact, remark(q)]));
    const again = (await pool(chunk(bad.map(q => byId.get(q.fact)), 5), CONFIG.parallel, b => write(kind, lecture, b, notes))).flat();
    await check(kind, lecture, again);
    stats.redone = again.length;
    items = [...items.filter(good), ...again];
    markDupes(items);
  }
  let pass = items.filter(good);
  // Не прошедшее даже после переделки заменяем: сначала запасом, затем нераспределёнными фактами.
  stats.rejected = items.length - pass.length;
  if (pass.length < n) {
    const used = new Set(facts.map(f => f.id));
    let rest = shuffle(lecture.facts.filter(f => !used.has(f.id))).slice(0, (n - pass.length) * 2);
    if (opts.extra && rest.length < n - pass.length) {
      const known = facts.filter(f => f.extra);
      const more = (await extraFacts(lecture, known.length + n - pass.length + 6)).filter(f => !known.some(k => similarity(k.fact, f.fact) > 0.6));
      rest = [...rest, ...more.slice(0, (n - pass.length) * 2).map((f, i) => ({ ...f, id: 'y' + (i + 1) }))];
    }
    if (rest.length) {
      onProgress('Дописываю недостающие');
      const tc = pass.filter(q => q.answer === true).length;
      rest.forEach((f, i) => { f.truth = kind === 'tf' ? (tc * 2 < pass.length ? i % 3 !== 0 : i % 3 === 0) : true; });
      const more = (await pool(chunk(rest, 5), CONFIG.parallel, b => write(kind, lecture, b))).flat();
      await check(kind, lecture, more); markDupes([...pass, ...more]);
      pass = [...pass, ...more.filter(good)]; stats.replaced = more.length;
    }
  }
  const final = balance(kind, pass, n);
  return { kind, n: final.length, asked: n, items: final, stats, lang: lecture.lang };
}

const good = q => q.check.ok && !q.long && !q.dupe;
function markDupes(items) {
  items.forEach((q, i) => {
    q.dupe = false;
    const key = q.kind === 'mcq' ? q.text + ' ' + q.options[q.answer] : q.text;
    for (let k = 0; k < i; k++) {
      const p = items[k]; if (p.dupe) continue;
      if (similarity(key, p.kind === 'mcq' ? p.text + ' ' + p.options[p.answer] : p.text) > 0.66) { q.dupe = true; break; }
    }
  });
}

// Ровно n вопросов: половина ложных, верные ответы поровну по позициям, соседние вопросы о разном.
export function balance(kind, pass, n) {
  let pickd;
  const pref = list => [...shuffle(list.filter(q => !q.extra)), ...shuffle(list.filter(q => q.extra))];
  if (kind === 'tf') {
    const t = pref(pass.filter(q => q.answer)), f = pref(pass.filter(q => !q.answer));
    let nf = Math.floor(n / 2) + (n % 2 && Math.random() < 0.5 ? 1 : 0);
    nf = Math.min(nf, f.length); const nt = Math.min(n - nf, t.length); nf = Math.min(n - nt, f.length);
    pickd = shuffle([...t.slice(0, nt), ...f.slice(0, nf)]);
  } else {
    pickd = shuffle(pref(pass).slice(0, n));
    const slots = shuffle(Array.from({ length: pickd.length }, (_, i) => i % 4));
    pickd = pickd.map((q, i) => {
      const right = q.options[q.answer], options = shuffle(q.options.filter((_, k) => k !== q.answer));
      options.splice(slots[i], 0, right);
      return { ...q, options, answer: slots[i] };
    });
  }
  return pickd;
}

/* ---------- Самопроверка ---------- */
export function selfCheck(quiz, lecture) {
  const it = quiz.items, rows = [];
  const add = (name, value, ok) => rows.push({ name, value, ok });
  add('Вопросов', `${it.length} из ${quiz.asked}`, it.length === quiz.asked);
  if (quiz.kind === 'tf') {
    const f = it.filter(q => !q.answer).length, pct = Math.round(f / it.length * 100);
    add('Ложных утверждений', `${f} (${pct}\u00a0%)`, pct >= 40 && pct <= 60);
  } else {
    const c = [0, 1, 2, 3].map(k => it.filter(q => q.answer === k).length);
    add('Верный ответ по позициям', 'АБВГ'.split('').map((l, i) => `${l}\u00a0${c[i]}`).join(', '), Math.max(...c) - Math.min(...c) <= 1);
    add('Вариантов у каждого вопроса', it.every(q => new Set(q.options).size === 4) ? '4 разных' : 'есть повторы', it.every(q => new Set(q.options).size === 4));
    const lg = it.filter(q => q.options[q.answer].length === Math.max(...q.options.map(o => o.length))).length;
    add('Верный вариант — самый длинный', `${lg} из ${it.length} (${Math.round(lg / it.length * 100)}\u00a0%)`, lg / it.length <= 0.5);
  }
  const byId = new Map(lecture.pages.map(p => [p.id, p]));
  const text = it.filter(q => !q.image && !q.extra);
  const found = text.filter(q => findQuote(byId.get(q.page)?.text || '', q.quote)).length;
  add('Текстовые цитаты найдены в лекции', `${found} из ${text.length}`, found === text.length);
  const im = it.filter(q => q.image).length; if (im) add('Вопросы по изображению', String(im), true);
  const ex = it.filter(q => q.extra).length; if (ex) add('Вопросы сверх лекции (с пометкой)', String(ex), true);
  const mis = it.filter(q => !q.check.ok).length;
  add('Расхождений со слепой проверкой', String(mis), mis === 0);
  const uniq = new Set(it.map(q => q.fact)).size; add('Вопросов на один факт', uniq === it.length ? 'не больше одного' : 'есть повторы', uniq === it.length);
  return rows;
}
