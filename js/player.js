import { h, $, $$, sleep, LANG } from './util.js';
import { quoteBoxes } from './extract.js';
import { writeScene } from './lecture.js';
import { synth, systemVoice } from './voice.js';

const ICON = {
  play: 'M7 4l14 8-14 8z', pause: 'M6 4h5v16H6zM14 4h5v16h-5z', prev: 'M18 5l-9 7 9 7zM6 5h2.5v14H6z', next: 'M6 5l9 7-9 7zM15.5 5H18v14h-2.5z',
  full: 'M4 4h6v2.5H6.5V10H4zM14 4h6v6h-2.5V6.5H14zM4 14h2.5v3.5H10V20H4zM17.5 14H20v6h-6v-2.5h3.5z',
};
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICON[name]); s.append(p); return s;
}

// Плеер лекции. scenes: [{title, pages, fragments|null}]; у фрагмента может быть готовый url звука (демо).
export class Player {
  constructor(root, lecture, scenes, { view, onExit }) {
    Object.assign(this, { root, lecture, scenes, view, onExit });
    this.s = 0; this.f = 0; this.token = 0; this.playing = false; this.speed = 1; this.subs = true; this.log = []; this.renders = new Map();
    this.audio = new Audio(); this.audio.preload = 'auto';
    this.hasOriginal = lecture.pages.some(p => p.render);
    if (!this.hasOriginal) this.view = 'notes';
    this.build();
    this.onKey = e => this.key(e);
    document.addEventListener('keydown', this.onKey);
    this.onResize = () => { if (this.view === 'original') this.zoom(false); else this.fit(); };
    addEventListener('resize', this.onResize);
    document.addEventListener('fullscreenchange', this.onResize);
  }
  note(ev, extra) { this.log.push({ t: Math.round(performance.now()), ev, s: this.s, f: this.f, ...extra }); }

  build() {
    const btn = (cls, label, ic, fn) => h('button', { class: 'pbtn ' + cls, type: 'button', title: label, 'aria-label': label, onclick: fn }, icon(ic));
    this.stage = h('div', { class: 'stage' });
    this.sub = h('p', { class: 'subs', 'aria-live': 'off' });
    this.wait = h('p', { class: 'stage-wait', hidden: true });
    this.playBtn = btn('main', 'Пауза или продолжить (пробел)', 'play', () => this.toggle());
    this.dots = h('div', { class: 'scene-nav', role: 'group', 'aria-label': 'Сцены' });
    this.viewBox = this.hasOriginal ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Вид' },
      ...[['original', 'Оригинал'], ['notes', 'Конспект']].map(([v, t]) => h('button', { type: 'button', dataset: { v }, 'aria-pressed': String(v === this.view), onclick: () => this.setView(v) }, t))) : null;
    const sp = h('select', { class: 'speed', 'aria-label': 'Скорость', onchange: e => { this.speed = Number(e.target.value); this.audio.playbackRate = this.speed; } },
      ...[0.75, 1, 1.25, 1.5].map(v => h('option', { value: String(v), selected: v === 1 }, String(v).replace('.', ',') + '×')));
    this.subBtn = h('button', { class: 'txt', type: 'button', 'aria-pressed': 'true', onclick: () => { this.subs = !this.subs; this.subBtn.setAttribute('aria-pressed', String(this.subs)); this.sub.hidden = !this.subs; } }, 'Субтитры');
    this.box = h('div', { class: 'player' },
      h('div', { class: 'stage-wrap' }, this.stage, this.wait, this.sub),
      h('div', { class: 'pbar' },
        h('div', { class: 'pgroup' }, btn('', 'Назад (стрелка влево)', 'prev', () => this.step(-1)), this.playBtn, btn('', 'Вперёд (стрелка вправо)', 'next', () => this.step(1))),
        this.dots,
        h('div', { class: 'pgroup' }, this.viewBox, sp, this.subBtn, btn('', 'Во весь экран', 'full', () => this.full()))));
    this.root.replaceChildren(this.box);
    this.drawNav();
  }
  drawNav() {
    this.dots.replaceChildren(...this.scenes.map((sc, i) => h('button', { type: 'button', class: 'mark' + (i < this.s ? ' done' : i === this.s ? ' now' : ''), title: sc.title, 'aria-label': `Сцена ${i + 1}: ${sc.title}`, onclick: () => this.go(i, 0) })));
  }
  setPlayIcon() { this.playBtn.replaceChildren(icon(this.playing ? 'pause' : 'play')); this.box.classList.toggle('is-playing', this.playing); }

  key(e) {
    if (!this.root.isConnected || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); if (e.target.tagName === 'BUTTON') e.target.blur(); this.toggle(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); this.step(1); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); this.step(-1); }
    else if (e.key === 'f' || e.key === 'а') this.full();
  }
  full() { if (document.fullscreenElement) document.exitFullscreen(); else this.box.requestFullscreen?.().catch(() => {}); }

  start() { this.playing = true; this.setPlayIcon(); this.go(0, 0); }
  toggle() {
    if (this.playing) {
      this.playing = false; this.setPlayIcon(); this.note('pause');
      if (this.mode === 'audio') this.audio.pause(); else { this.token++; window.speechSynthesis?.cancel(); }
    } else {
      this.playing = true; this.setPlayIcon();
      if (this.ended) { this.go(0, 0); return; }
      if (this.mode === 'audio' && this.audio.src && this.audio.paused && !this.audio.ended && this.ready) this.audio.play().catch(() => this.go(this.s, this.f));
      else this.go(this.s, this.f);
    }
  }
  step(d) {
    let { s, f } = this; f += d;
    const len = this.scenes[s].fragments?.length || 1;
    if (f >= len) { s++; f = 0; }
    if (f < 0) { s--; f = s >= 0 ? (this.scenes[s].fragments?.length || 1) - 1 : 0; }
    if (s < 0) { s = 0; f = 0; }
    if (s >= this.scenes.length) { this.finish(); return; }
    this.go(s, f);
  }
  stopSound() { this.audio.pause(); window.speechSynthesis?.cancel(); clearTimeout(this.timer); }
  destroy() {
    this.token++; this.playing = false; this.dead = true; this.stopSound();
    document.removeEventListener('keydown', this.onKey); removeEventListener('resize', this.onResize); document.removeEventListener('fullscreenchange', this.onResize);
    if (document.fullscreenElement) document.exitFullscreen();
  }
  busy(text) { this.wait.textContent = text || ''; this.wait.hidden = !text; }

  /* ---- подготовка ---- */
  scene(i) {
    const sc = this.scenes[i]; if (!sc) return Promise.resolve(null);
    if (sc.fragments) return Promise.resolve(sc);
    sc.job ||= writeScene(this.lecture, this.scenes, i).then(r => { sc.fragments = r.fragments; this.note('scene-ready', { scene: i }); return sc; }).catch(e => { sc.job = null; throw e; });
    return sc.job;
  }
  sound(fr) {
    if (fr.sound) return fr.sound;
    if (this.voiceOff && !fr.url) return Promise.resolve(null);
    fr.sound = fr.url ? Promise.resolve({ url: fr.url }) : synth(fr.say, this.lecture.lang).then(r => { Object.assign(fr, { seconds: r.seconds, rms: r.rms, plausible: r.plausible, blob: r.blob }); return r; })
      .catch(e => { fr.sound = null; fr.failed = (fr.failed || 0) + 1; this.note('voice-fail', { err: e.message }); if (e.kind && ['money', 'key', 'network', 'forbidden', 'request'].includes(e.kind)) { this.voiceOff = true; this.voiceWhy = e.message; } return null; });
    return fr.sound;
  }
  async prepare(i) {
    try { const sc = await this.scene(i); if (!sc || this.dead) return; sc.fragments.forEach(fr => this.sound(fr)); } catch { /* покажем при переходе к сцене */ }
  }

  /* ---- ход лекции ---- */
  async go(s, f) {
    const my = ++this.token; this.stopSound(); this.ended = false; this.ready = false; this.mode = null;
    const changed = s !== this.s || this.rendered == null;
    this.s = s; this.f = f; this.drawNav(); this.sub.textContent = '';
    let sc;
    try {
      if (!this.scenes[s].fragments) this.busy('Готовлю сцену…');
      sc = await this.scene(s);
    } catch (e) {
      if (my !== this.token) return;
      this.busy(''); this.problem(e.message, () => this.go(s, f)); return;
    }
    if (my !== this.token) return;
    this.busy('');
    this.prepare(s).then(() => { if (!this.dead) this.prepare(s + 1); });
    this.f = f = Math.min(f, sc.fragments.length - 1);
    if (changed || this.rendered !== s) this.renderScene();
    this.revealUpTo(f - 1);
    const fr = sc.fragments[f];
    if (this.view === 'original') await this.showPage(fr, my);
    if (my !== this.token) return;
    const slow = setTimeout(() => { if (my === this.token) this.busy('Записываю голос…'); }, 350);
    const snd = await this.sound(fr);
    clearTimeout(slow); if (my !== this.token) return;
    this.busy('');
    if (!this.playing) { this.reveal(f); this.sub.textContent = fr.say; return; }
    if (snd && snd.url) await this.playAudio(snd.url, fr, f, my);
    else this.playFallback(fr, f, my);
  }
  next(my) {
    if (my !== this.token || !this.playing) return;
    this.timer = setTimeout(() => { if (my === this.token && this.playing) this.step(1); }, 280);
  }
  async playAudio(url, fr, f, my) {
    this.mode = 'audio'; const a = this.audio;
    a.onplaying = () => {
      if (my !== this.token) return;
      if (!this.ready) { this.ready = true; this.note('audio-start', { dur: +(a.duration || 0).toFixed(2) }); this.reveal(f); this.sub.textContent = fr.say; }
    };
    a.onended = () => { if (my === this.token) { this.note('audio-end', { at: +a.currentTime.toFixed(2) }); this.next(my); } };
    a.onerror = () => { if (my === this.token) { this.note('audio-error'); this.playFallback(fr, f, my); } };
    a.src = url; a.playbackRate = this.speed;
    try { await a.play(); a.playbackRate = this.speed; } catch (e) {
      if (my !== this.token || e.name === 'AbortError') return;
      if (e.name === 'NotAllowedError') { this.playing = false; this.setPlayIcon(); this.busy('Нажмите пробел, чтобы включить звук'); }
    }
  }
  playFallback(fr, f, my) {
    const v = systemVoice(this.lecture.lang);
    this.reveal(f); this.sub.textContent = fr.say; this.ready = true;
    if (!this.told) { this.told = true; this.busy(v ? 'Голос из сети недоступен, читает системный голос' : 'Голоса нет, лекция идёт с субтитрами'); setTimeout(() => this.busy(''), 3500); }
    const byTimer = () => { this.mode = 'timer'; this.sub.hidden = false; this.note('timer'); this.timer = setTimeout(() => this.next(my), (1200 + fr.say.length * 62) / this.speed); };
    if (!v) { byTimer(); return; }
    this.mode = 'system'; this.note('system-voice');
    const u = new SpeechSynthesisUtterance(fr.say); u.voice = v; u.lang = v.lang; u.rate = this.speed;
    u.onend = () => this.next(my);
    u.onerror = e => { if (my === this.token && !['canceled', 'interrupted'].includes(e.error)) byTimer(); };
    speechSynthesis.speak(u);
  }
  finish() {
    this.token++; this.stopSound(); this.playing = false; this.ended = true; this.setPlayIcon(); this.note('finish'); this.sub.textContent = '';
    this.rendered = null;
    this.stage.replaceChildren(h('div', { class: 'stage-end' }, h('p', { class: 'stage-end-t' }, 'Лекция окончена'), h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => { this.playing = true; this.setPlayIcon(); this.go(0, 0); } }, 'Слушать сначала'), h('button', { class: 'btn ghost', type: 'button', onclick: () => this.onExit() }, 'К тестам'))));
  }
  problem(text, retry) {
    this.rendered = null;
    this.stage.replaceChildren(h('div', { class: 'stage-end' }, h('p', { class: 'stage-err' }, text), h('button', { class: 'btn', type: 'button', onclick: retry }, 'Повторить')));
  }

  /* ---- картинка ---- */
  setView(v) {
    if (v === this.view) return;
    this.view = v; $$('button', this.viewBox).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
    if (!this.scenes[this.s].fragments || this.ended) return;
    this.renderScene(); this.revealUpTo(this.f);
    if (v === 'original') this.showPage(this.scenes[this.s].fragments[this.f], this.token).then(() => this.reveal(this.f));
  }
  renderScene() {
    const sc = this.scenes[this.s]; this.rendered = this.s;
    if (this.view === 'original') {
      this.paper = h('div', { class: 'paper' }); this.curPage = null;
      this.stage.replaceChildren(h('div', { class: 'orig' }, this.paper));
      return;
    }
    const imgs = new Map(this.lecture.pages.flatMap(p => p.images).map(im => [im.id, im]));
    const el = (f, i) => {
      const d = { class: `frag ${f.kind}`, dataset: { i: String(i) } };
      if (f.kind === 'title') return h('h2', d, h('span', { text: f.show }));
      if (f.kind === 'term') return h('div', d, h('b', { text: f.show }), h('p', { text: f.note }));
      if (f.kind === 'image') return h('figure', d, h('img', { src: imgs.get(f.image)?.dataUrl, alt: f.show }), h('figcaption', { text: f.show }));
      return h('p', d, h('span', { text: f.show }));
    };
    const els = sc.fragments.map(el), im = sc.fragments.findIndex(f => f.kind === 'image');
    const list = els.filter((_, i) => i !== 0 && i !== im);
    this.stage.replaceChildren(h('div', { class: 'notes' + (im > 0 ? ' with-img' : '') }, els[0], h('div', { class: 'nbody' }, h('div', { class: 'nlist' }, list), im > 0 ? els[im] : null)));
    this.fit();
  }
  fit() {
    const n = $('.notes', this.stage); if (!n) return;
    const body = $('.nbody', n), list = $('.nlist', n);
    for (let k = 1; k > 0.55; k -= 0.05) { n.style.setProperty('--k', k.toFixed(2)); if (list.scrollHeight <= body.clientHeight + 2 && n.scrollHeight <= n.clientHeight + 2) break; }
  }
  revealUpTo(i) { $$('.frag', this.stage).forEach(e => { const k = Number(e.dataset.i); e.classList.toggle('on', k <= i); e.classList.toggle('now', false); }); }
  reveal(i) {
    if (this.view === 'original') { this.paper?.classList.add('lit'); this.zoom(true); this.note('show', { view: 'original', boxes: this.boxes?.length || 0 }); return; }
    $$('.frag', this.stage).forEach(e => { const k = Number(e.dataset.i); if (k === i) e.classList.add('on'); e.classList.toggle('now', k === i); });
    this.note('show', { view: 'notes', on: $$('.frag.on', this.stage).length });
  }
  async canvasOf(page) {
    if (!this.renders.has(page.id)) this.renders.set(page.id, (async () => { const c = document.createElement('canvas'); await page.render(c, Math.min(2200, Math.max(1400, Math.round(innerWidth * (page.w > page.h ? 1.25 : 1.1))))); return c; })());
    return this.renders.get(page.id);
  }
  async showPage(fr, my) {
    const page = this.lecture.pages.find(p => p.id === fr.page);
    this.paper.classList.remove('lit');
    if (!page || !page.render) return;
    if (this.curPage !== page.id) {
      const c = await this.canvasOf(page); if (my !== this.token) return;
      this.curPage = page.id; this.page = page;
      this.paper.replaceChildren(c); this.paper.classList.remove('swap'); void this.paper.offsetWidth; this.paper.classList.add('swap');
    }
    $$('.hl', this.paper).forEach(x => x.remove());
    this.boxes = fr.anchor ? quoteBoxes(page, fr.anchor) : [];
    this.boxes.forEach((b, i) => { const d = h('i', { class: 'hl' }); Object.assign(d.style, { left: b.x * 100 - 0.4 + '%', top: b.y * 100 + '%', width: b.w * 100 + 0.8 + '%', height: b.h * 100 + '%', transitionDelay: i * 160 + 'ms' }); this.paper.append(d); });
    this.place(false);
    this.canvasOf(this.lecture.pages[this.lecture.pages.indexOf(page) + 1] || page).catch(() => {});
  }
  // Размер листа в сцене и плавное приближение к строке.
  place(zoomed) {
    const box = this.stage.getBoundingClientRect(), p = this.page; if (!p || !this.paper) return;
    const k = Math.min(box.width / p.w, box.height / p.h), w = p.w * k, hh = p.h * k;
    Object.assign(this.paper.style, { width: w + 'px', height: hh + 'px' });
    let z = 1, cx = 0.5, cy = 0.5;
    if (zoomed && this.boxes?.length) {
      const x0 = Math.min(...this.boxes.map(b => b.x)), x1 = Math.max(...this.boxes.map(b => b.x + b.w)), y0 = Math.min(...this.boxes.map(b => b.y)), y1 = Math.max(...this.boxes.map(b => b.y + b.h));
      const want = 0.66 * box.width / Math.max(0.2 * w, (x1 - x0) * w), cap = p.w > p.h ? 1.7 : 0.97 * box.width / w;
      z = Math.max(1, Math.min(want, cap, 0.8 * box.height / Math.max(1, (y1 - y0) * hh))); cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
    }
    const lim = (full, view, c) => { const over = Math.max(0, (full * z - view) / 2); return Math.max(-over, Math.min(over, (0.5 - c) * full * z)); };
    this.paper.style.transform = `translate(-50%,-50%) translate(${lim(w, box.width, cx)}px,${lim(hh, box.height, cy)}px) scale(${z})`;
  }
  zoom(anim) { if (this.view !== 'original') return; this.paper?.classList.toggle('still', !anim); this.place(this.paper?.classList.contains('lit')); }
}
