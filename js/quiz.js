import { h, $, plural } from './util.js';
import { selfCheck } from './generate.js';

const L = ['А', 'Б', 'В', 'Г'];
const opts = q => (q.kind === 'mcq' ? q.options : ['Правильно', 'Неправильно']);
const rightIndex = q => (q.kind === 'mcq' ? q.answer : q.answer ? 0 : 1);
const mark = (q, i) => (q.kind === 'mcq' ? L[i] : i ? '−' : '+');

function source(q, lecture) {
  const p = lecture.pages.find(x => x.id === q.page);
  const where = p ? (lecture.docs.length > 1 ? lecture.docs[p.doc].name + ', ' : '') + p.label : '';
  if (q.extra) return h('p', { class: 'src' }, h('span', { class: 'tag' }, 'сверх лекции'), 'Вопрос по теме: в самой лекции этого нет');
  return h('figure', { class: 'quote' }, h('blockquote', { text: q.quote }), h('figcaption', {}, q.image ? h('span', { class: 'tag' }, 'по изображению') : null, where));
}

// Бланк ответов: строка на вопрос, кружок на вариант.
function sheet(quiz, answers, cur, jump) {
  const el = h("div", { class: "sheet " + quiz.kind }, quiz.items.map((q, i) => h('button', { type: 'button', class: 'srow' + (i === cur ? ' cur' : ''), 'aria-label': `Вопрос ${i + 1}`, onclick: () => jump(i) },
    h('span', { class: 'sn' }, String(i + 1)),
    opts(q).map((_, k) => {
      const a = answers[i], shown = a && a.shown;
      return h('i', { class: 'bub' + (a && a.pick === k ? (shown ? (k === rightIndex(q) ? ' ok' : ' bad') : ' fill') : shown && k === rightIndex(q) ? ' ring' : '') }, mark(q, k));
    }))));
  el.style.setProperty('--n', quiz.items.length);
  return el;
}

export function runQuiz(root, quiz, lecture, { onExit, title }) {
  const answers = new Array(quiz.items.length).fill(null); let cur = 0, instant = true, finished = false;
  const onKey = e => {
    if (!root.isConnected || !root.contains(box) || finished || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const n = Number(e.key); const q = quiz.items[cur];
    if (n >= 1 && n <= opts(q).length) { e.preventDefault(); pick(n - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
  };
  document.addEventListener('keydown', onKey);
  const box = h('div', { class: 'quiz' }); root.replaceChildren(box);
  const left = () => answers.filter(a => !a).length;
  function pick(k) {
    const a = answers[cur]; if (a && a.shown) return;
    answers[cur] = { pick: k, shown: instant }; draw();
  }
  function move(d) { const n = cur + d; if (n < 0) return; if (n >= quiz.items.length) return; cur = n; draw(true); }
  function draw(focusTop) {
    const q = quiz.items[cur], a = answers[cur], shown = a && a.shown, r = rightIndex(q);
    const score = answers.filter((x, i) => x && x.shown && x.pick === rightIndex(quiz.items[i])).length, checked = answers.filter(x => x && x.shown).length;
    box.replaceChildren(
      h('aside', { class: 'side' }, sheet(quiz, answers, cur, i => { cur = i; draw(true); })),
      h('section', { class: 'card' },
        h('div', { class: 'qhead' }, h('p', { class: 'qnum' }, h('b', {}, String(cur + 1)), ` из ${quiz.items.length}`), instant ? h('p', { class: 'qscore' }, `Верно ${score} из ${checked}`) : null,
          h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: instant, onchange: e => { instant = e.target.checked; draw(); } }), 'Сразу показывать ответ')),
        h('h2', { class: 'qtext', tabindex: '-1', text: q.text }),
        h('div', { class: 'opts ' + q.kind }, opts(q).map((o, k) => h('button', { type: 'button', disabled: !!shown, class: 'opt' + (a && a.pick === k ? ' picked' : '') + (shown ? (k === r ? ' right' : a.pick === k ? ' wrong' : ' dim') : ''), onclick: () => pick(k) }, h('i', { class: 'bub big' + (a && a.pick === k ? ' fill' : '') }, mark(q, k)), h('span', { text: o }), shown && k === r ? h('em', {}, 'верный ответ') : shown && a.pick === k ? h('em', {}, 'ваш ответ') : null))),
        shown ? h('div', { class: 'why' }, h('p', { class: 'verdict ' + (a.pick === r ? 'ok' : 'bad') }, a.pick === r ? 'Верно' : 'Ошибка'), h('p', { class: 'expl', text: q.why }), source(q, lecture)) : null,
        h('div', { class: 'qnav' },
          h('button', { class: 'btn ghost', type: 'button', disabled: cur === 0, onclick: () => move(-1) }, 'Назад'),
          cur < quiz.items.length - 1 ? h('button', { class: 'btn', type: 'button', onclick: () => move(1) }, a ? 'Дальше' : 'Пропустить') : null,
          cur === quiz.items.length - 1 || !left() ? h('button', { class: 'btn' + (cur < quiz.items.length - 1 ? ' ghost' : ''), type: 'button', onclick: finish }, left() ? `Завершить, без ответа ${left()}` : 'Завершить тест') : null)));
    if (focusTop) { $('.qtext', box).focus({ preventScroll: true }); if (box.getBoundingClientRect().top < -40) box.scrollIntoView(); }
    $('.srow.cur', box)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function finish() {
    finished = true; document.removeEventListener('keydown', onKey);
    answers.forEach((a, i) => { answers[i] = a ? { ...a, shown: true } : { pick: null, shown: true }; });
    const ok = answers.filter((a, i) => a.pick === rightIndex(quiz.items[i])).length, n = quiz.items.length;
    let only = ok < n;
    const list = h('div', { class: 'review' });
    const fill = () => list.replaceChildren(...quiz.items.map((q, i) => {
      const a = answers[i], r = rightIndex(q), good = a.pick === r;
      if (only && good) return null;
      return h('article', { class: 'rev ' + (good ? 'ok' : 'bad') },
        h('p', { class: 'rn' }, String(i + 1)), h('div', {}, h('h3', { text: q.text }),
          good ? null : h('p', { class: 'ryour' }, a.pick == null ? 'Без ответа' : ['Ваш ответ: ', h('s', { text: opts(q)[a.pick] })]),
          h('p', { class: 'rright' }, 'Верно: ', h('b', { text: opts(q)[r] })), h('p', { class: 'expl', text: q.why }), source(q, lecture)));
    }).filter(Boolean));
    fill();
    const pct = Math.round(ok / n * 100);
    box.className = 'result';
    box.replaceChildren(
      h('section', { class: 'score' }, h('div', { class: 'scoretxt' }, h('p', { class: 'big' }, `${ok} из ${n}`), h('p', { class: 'mean' }, `${pct} % верных. ${pct >= 90 ? 'Отлично, можно идти на зачёт.' : pct >= 70 ? 'Хорошо. Разберите ошибки, и будет отлично.' : pct >= 50 ? 'Зачёт есть, но тему стоит повторить.' : 'Пока рано: послушайте лекцию и попробуйте снова.'}`),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => runQuiz(root, quiz, lecture, { onExit, title }) }, 'Пройти ещё раз'), h('button', { class: 'btn ghost', type: 'button', onclick: onExit }, 'К лекции'))),
        sheet(quiz, answers, -1, i => { only = false; chk.checked = false; fill(); list.children[i]?.scrollIntoView({ behavior: 'smooth', block: 'center' }); })),
      checkPanel(quiz, lecture),
      h('div', { class: 'revhead' }, h('h2', {}, ok === n ? 'Разбор' : `Разбор: ${n - ok} ${plural(n - ok, 'ошибка', 'ошибки', 'ошибок')}`), h('label', { class: 'chk' }, '')),
      list);
    const chk = h('input', { type: 'checkbox', checked: only, onchange: e => { only = e.target.checked; fill(); } });
    $('.revhead .chk', box).replaceChildren(chk, 'Только ошибки');
    root.scrollIntoView();
  }
  draw();
  return { destroy() { document.removeEventListener('keydown', onKey); } };
}

export function checkPanel(quiz, lecture) {
  const rows = selfCheck(quiz, lecture), bad = rows.filter(r => !r.ok).length;
  return h('details', { class: 'selfcheck' }, h('summary', {}, bad ? `Самопроверка теста: замечаний ${bad}` : 'Самопроверка теста пройдена'),
    h('table', {}, h('tbody', {}, rows.map(r => h('tr', { class: r.ok ? '' : 'no' }, h('th', { scope: 'row' }, r.name), h('td', {}, r.value), h('td', { class: 'st' }, r.ok ? 'да' : 'нет'))))),
    quiz.stats ? h('p', { class: 'hint' }, `Составлено ${quiz.stats.written}, слепая проверка разошлась с ключом у ${quiz.stats.firstMismatch ?? 0}, переделано ${quiz.stats.redone}, отброшено ${quiz.stats.rejected ?? 0}, дописано ${quiz.stats.replaced}.`) : null);
}
