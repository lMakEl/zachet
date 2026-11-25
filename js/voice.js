import { CONFIG } from './config.js';
import { speech } from './api.js';
import { LANG } from './util.js';

const INSTR = {
  ru: 'Ты преподаватель, читаешь живую лекцию студентам. Говори тепло, ясно и увлечённо, в спокойном темпе, с естественными паузами и логическими ударениями. Произноси по-русски, без акцента.',
  kk: 'Сен студенттерге дәріс оқып тұрған оқытушысың. Жылы, анық, қызықты, баяу қарқынмен, табиғи кідіріспен сөйле. Қазақша таза айт.',
  en: 'You are a lecturer speaking live to students. Sound warm, clear and engaged, at a calm pace, with natural pauses and emphasis.',
};

export function wavBlob(pcm, rate = CONFIG.voice.sampleRate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
  const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

export function pcmStats(pcm) {
  let sum = 0, peak = 0;
  for (let i = 0; i < pcm.length; i += 4) { const a = Math.abs(pcm[i]); sum += a * a; if (a > peak) peak = a; }
  return { seconds: pcm.length / CONFIG.voice.sampleRate, rms: Math.sqrt(sum / Math.max(1, pcm.length / 4)), peak };
}
// Нужная длина: речь идёт примерно 8–22 знака в секунду.
export function plausible(text, st) {
  return st.rms > 150 && st.seconds > Math.max(0.6, text.length / 28) && st.seconds < text.length / 5 + 4;
}

let active = 0; const queue = [];
function slot(job) {
  return new Promise((ok, no) => { queue.push({ job, ok, no }); pump(); });
}
function pump() {
  while (active < CONFIG.voiceParallel && queue.length) {
    const { job, ok, no } = queue.shift(); active++;
    job().then(ok, no).finally(() => { active--; pump(); });
  }
}

// Звук одной фразы: {url, seconds, rms, blob}. Неправдоподобный звук запрашивается ещё раз.
export function synth(text, lang) {
  return slot(async () => {
    let best = null;
    for (let i = 0; i < 2; i++) {
      const pcm = await speech(text, INSTR[lang] || INSTR.ru), st = pcmStats(pcm);
      best = { pcm, st };
      if (plausible(text, st)) break;
      best.bad = true;
    }
    if (best.st.rms <= 150 || best.st.seconds < 0.4) throw new Error('Пустой звук');
    const blob = wavBlob(best.pcm);
    return { url: URL.createObjectURL(blob), blob, seconds: best.st.seconds, rms: best.st.rms, plausible: !best.bad };
  });
}

export function systemVoice(lang) {
  if (!('speechSynthesis' in window)) return null;
  const want = (LANG[lang] || LANG.ru).bcp.slice(0, 2);
  return speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(want)) || null;
}
if ('speechSynthesis' in window) speechSynthesis.getVoices();
