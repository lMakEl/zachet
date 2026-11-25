// Только для разработки: страница на localhost отдаёт готовые данные серверу tools/dev-server.mjs.
// На опубликованном сайте сервера нет, и функция ничего не делает.
import { synth } from './voice.js';

const isLocal = () => ['localhost', '127.0.0.1'].includes(location.hostname);
const put = (name, body, dir = 'demo') => fetch(`/__save?dir=${dir}&name=${encodeURIComponent(name)}`, { method: 'POST', body });

export async function saveDemo(state) {
  if (!isLocal()) return 'только на localhost';
  const L = state.lecture, pickQ = q => ({ kind: q.kind, text: q.text, ...(q.options ? { options: q.options } : {}), answer: q.answer, fact: q.fact, page: q.page, quote: q.quote, image: q.image, why: q.why, check: { ok: q.check.ok } });
  const scenes = [];
  const src = state.scenes.full || state.scenes.short;
  for (let i = 0; i < src.length; i++) {
    const frs = [];
    for (let k = 0; k < src[i].fragments.length; k++) {
      const f = src[i].fragments[k], snd = f.blob ? f : await synth(f.say, L.lang), name = `s${i + 1}f${k + 1}.wav`;
      await put(name, snd.blob, 'local');
      frs.push({ kind: f.kind, show: f.show, note: f.note, image: f.image, say: f.say, page: f.page, anchor: f.anchor, audio: name.replace('.wav', '.mp3'), seconds: +snd.seconds.toFixed(2) });
    }
    scenes.push({ title: src[i].title, pages: src[i].pages, fragments: frs });
  }
  const data = { name: 'Как работает нейросеть.pdf', lang: L.lang, facts: L.facts, mcq: state.quizzes.mcq.items.map(pickQ), tf: state.quizzes.tf.items.map(pickQ), scenes };
  await put('demo.json', JSON.stringify(data, null, 1));
  return `${data.mcq.length}/${data.tf.length}/${scenes.length}`;
}
