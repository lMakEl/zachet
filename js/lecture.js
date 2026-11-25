import { CONFIG } from './config.js';
import { chatJson } from './api.js';
import { pagesContent } from './generate.js';
import * as P from './prompts.js';
import { findQuote } from './util.js';

const { author } = CONFIG.models;
const factsOf = (lecture, pages) => lecture.facts.filter(f => pages.some(p => p.id === f.page)).map(f => `- [страница ${f.page}] ${f.fact}`).join('\n');

export async function planLecture(lecture, size) {
  const pages = lecture.pages.filter(p => p.text.trim().length > 15 || p.visual.length);
  const target = size === 'short' ? 4 : Math.min(10, Math.max(6, Math.round(pages.length * 0.6)));
  const d = await chatJson({
    model: author, name: 'plan', schema: P.planSchema, system: P.planSystem(lecture.lang), maxTokens: 4000,
    content: [...pagesContent(pages, false), { type: 'text', text: `Факты лекции:\n${factsOf(lecture, pages)}\n\nСоставь план на ${target} ${target < 5 ? 'сцены: только самое главное' : 'сцен'}.` }],
  });
  const ids = new Set(lecture.pages.map(p => p.id));
  return d.scenes.map(s => ({ title: s.title, goal: s.goal, pages: [...new Set(s.pages)].filter(x => ids.has(x)).slice(0, 5) })).filter(s => s.pages.length).slice(0, target + 2);
}

export async function writeScene(lecture, plan, i) {
  const s = plan[i], pages = lecture.pages.filter(p => s.pages.includes(p.id));
  const images = pages.flatMap(p => p.images).slice(0, 4);
  const outline = plan.map((x, k) => `${k + 1}. ${x.title}${k === i ? '  ← эта сцена' : ''}`).join('\n');
  const content = [...pagesContent(pages)];
  const shown = new Set(pages.flatMap(p => p.visual.map(v => v.dataUrl)));
  for (const im of images) if (!shown.has(im.dataUrl)) content.push({ type: 'text', text: `Картинка ${im.id}:` }, { type: 'image_url', image_url: { url: im.dataUrl } });
  content.push({ type: 'text', text: `Факты этих страниц:\n${factsOf(lecture, pages) || '—'}\n\nКартинки, которые можно показать (image): ${images.length ? images.map(im => `${im.id} (страница ${im.id.split('-')[0]})`).join(', ') : 'нет'}\n\nПлан лекции:\n${outline}\n\nНапиши сцену ${i + 1} из ${plan.length}: «${s.title}». Цель: ${s.goal}${i === 0 ? ' Это начало лекции: в первой фразе поприветствуй слушателей и назови тему.' : ''}${i === plan.length - 1 ? ' Это последняя сцена: в последней фразе подведи итог лекции.' : ''}` });
  const d = await chatJson({ model: author, name: 'scene', schema: P.sceneSchema, system: P.sceneSystem(lecture.lang), maxTokens: 4000, content });
  const okIm = new Map(images.map(im => [im.id, im]));
  let seenIm = false;
  const frags = d.fragments.filter(f => f.say && f.say.trim()).map(f => {
    const page = pages.find(p => p.id === f.page) || pages[0];
    const im = f.kind === 'image' && !seenIm ? okIm.get(f.image) : null;
    if (im) seenIm = true;
    return { kind: f.kind === 'image' && !im ? 'point' : f.kind, show: f.show.trim(), note: f.kind === 'term' ? f.note.trim() : '', image: im ? im.id : '', say: f.say.trim(), page: page.id, anchor: f.anchor && findQuote(page.text, f.anchor, 8) ? f.anchor : '' };
  }).slice(0, 7);
  frags.forEach((f, k) => { if (k === 0) { f.kind = 'title'; f.show ||= s.title; f.image = ''; } else if (f.kind === 'title') f.kind = 'point'; });
  return { title: s.title, pages: s.pages, fragments: frags };
}
