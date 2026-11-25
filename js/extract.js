import { CONFIG } from './config.js';
import { findQuote } from './util.js';

const BASE = new URL('..', import.meta.url).href;
let pdfjsP;
function pdfjs() {
  pdfjsP ||= import('../vendor/pdfjs/pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = BASE + 'vendor/pdfjs/pdf.worker.min.mjs'; return m; });
  return pdfjsP;
}
let zipP;
function jszip() {
  zipP ||= new Promise((ok, no) => {
    if (window.JSZip) return ok(window.JSZip);
    const s = document.createElement('script'); s.src = BASE + 'vendor/jszip/jszip.min.js';
    s.onload = () => ok(window.JSZip); s.onerror = () => no(new Error('Не загрузилась библиотека для чтения файла.'));
    document.head.append(s);
  });
  return zipP;
}

export class FileError extends Error {}

// Страница: {id, doc, n, label, text, lines, images, visual, w, h, render}
export async function extractFile(file, docIndex, firstId, onProgress) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'ppt' || ext === 'doc') throw new FileError(`«${file.name}» — старый формат. Сохраните файл как ${ext === 'ppt' ? 'PPTX' : 'DOCX'} или PDF.`);
  if (!['pdf', 'pptx', 'ppsx', 'docx'].includes(ext)) throw new FileError(`«${file.name}»: нужен PDF, PPTX, PPSX или DOCX.`);
  const buf = await file.arrayBuffer();
  let res;
  try {
    res = ext === 'pdf' ? await fromPdf(buf, onProgress) : ext === 'docx' ? await fromDocx(buf) : await fromPptx(buf, onProgress);
  } catch (e) {
    if (e instanceof FileError) throw e;
    console.warn(e);
    throw new FileError(e && e.name === 'PasswordException' ? `«${file.name}» закрыт паролем. Снимите пароль и загрузите снова.` : `«${file.name}» не открылся: файл повреждён или это не ${ext.toUpperCase()}.`);
  }
  res.pages.forEach((p, i) => { p.id = firstId + i; p.doc = docIndex; p.images.forEach((im, k) => { im.id = `${p.id}-${k + 1}`; }); });
  if (!res.pages.some(p => p.text.trim().length > 20 || p.visual.length)) throw new FileError(`В «${file.name}» не нашлось ни текста, ни картинок.`);
  return { doc: { name: file.name, kind: ext === 'ppsx' ? 'pptx' : ext, view: res.view, pages: res.pages.length }, pages: res.pages };
}

/* ---------- PDF ---------- */
async function fromPdf(buf, onProgress) {
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: buf, cMapUrl: BASE + 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'vendor/pdfjs/standard_fonts/', wasmUrl: BASE + 'vendor/pdfjs/wasm/', isEvalSupported: false }).promise;
  const pages = []; let landscape = 0;
  for (let n = 1; n <= pdf.numPages; n++) {
    if (onProgress) onProgress(n, pdf.numPages);
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) { if (rows.length && it.str) rows[rows.length - 1].text += ' '; continue; }
      const [, , , d, e, f] = lib.Util.transform(vp.transform, it.transform);
      const hgt = Math.abs(d) || it.height || 10;
      const box = { x: e, y: f - hgt, w: it.width, h: hgt * 1.2 };
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.base - f) < hgt * 0.45 && e >= last.x - 2) {
        if (e - (last.x + last.w) > hgt * 0.18 && !/\s$/.test(last.text)) last.text += ' ';
        last.text += it.str; last.w = Math.max(last.w, e + it.width - last.x); last.h = Math.max(last.h, box.h); last.y = Math.min(last.y, box.y);
      } else rows.push({ text: it.str, base: f, ...box });
    }
    let text = ''; const lines = [];
    for (const r of rows) {
      const t = r.text.replace(/\s+/g, ' ').trim(); if (!t) continue;
      const hyph = /[\p{L}]­$/u.test(text);
      const from = text.length + (text && !hyph ? 1 : 0);
      text += (text && !hyph ? '\n' : '') + t;
      lines.push({ from, to: text.length, x: r.x / vp.width, y: r.y / vp.height, w: r.w / vp.width, h: r.h / vp.height });
    }
    if (vp.width > vp.height * 1.1) landscape++;
    const p = { n, label: `стр. ${n}`, text, lines, images: [], visual: [], w: vp.width, h: vp.height };
    p.render = async (canvas, width) => {
      const v = page.getViewport({ scale: width / vp.width });
      canvas.width = Math.round(v.width); canvas.height = Math.round(v.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: v, background: '#ffffff' }).promise;
    };
    if (text.length < CONFIG.visualTextLimit) {
      const c = document.createElement('canvas');
      await p.render(c, CONFIG.imageSide);
      if (!isBlank(c)) p.visual = [{ dataUrl: c.toDataURL('image/jpeg', 0.82), w: c.width, h: c.height }];
      c.width = c.height = 0;
    }
    pages.push(p);
  }
  return { pages, view: landscape > pdf.numPages / 2 ? 'original' : 'notes' };
}

function isBlank(c) {
  const t = document.createElement('canvas'); t.width = t.height = 32;
  const g = t.getContext('2d'); g.drawImage(c, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data; let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) { min = Math.min(min, d[i]); max = Math.max(max, d[i]); }
  return max - min < 6;
}

// Строки страницы PDF, в которых лежит цитата (доли ширины и высоты).
export function quoteBoxes(page, quote) {
  if (!page || !page.lines || !page.lines.length) return [];
  const at = findQuote(page.text, quote, 8);
  return at ? page.lines.filter(l => l.to > at.from && l.from < at.to) : [];
}

/* ---------- Office ---------- */
const xml = async (zip, path) => { const f = zip.file(path); return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null; };
const local = (root, name) => root ? [...root.getElementsByTagNameNS('*', name)] : [];
const kid = (el, name) => [...el.children].find(c => c.localName === name);
function resolve(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const s of target.split('/')) { if (s === '..') parts.pop(); else if (s !== '.') parts.push(s); }
  return parts.join('/');
}
async function rels(zip, part) {
  const i = part.lastIndexOf('/');
  const d = await xml(zip, part.slice(0, i) + '/_rels' + part.slice(i) + '.rels');
  const m = {};
  for (const r of local(d, 'Relationship')) if (r.getAttribute('TargetMode') !== 'External') m[r.getAttribute('Id')] = { path: resolve(part, r.getAttribute('Target')) };
  return m;
}
const embedId = el => el.getAttribute('r:embed') || el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');

async function shrink(zip, path) {
  const f = zip.file(path); if (!f) return null;
  const ext = path.split('.').pop().toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext)) return null;
  try {
    const bmp = await createImageBitmap(new Blob([await f.async('uint8array')], { type: 'image/' + (ext === 'jpg' ? 'jpeg' : ext) }));
    if (bmp.width < 90 || bmp.height < 60) return null;
    const k = Math.min(1, CONFIG.imageSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return isBlank(c) ? null : { dataUrl: c.toDataURL('image/jpeg', 0.82), w: c.width, h: c.height };
  } catch { return null; }
}

function paraText(p) {
  let s = '';
  for (const el of p.getElementsByTagName('*')) {
    if (el.localName === 't') s += el.textContent;
    else if (el.localName === 'tab' && el.parentNode.localName === 'r') s += ' ';
    else if (el.localName === 'br' || el.localName === 'cr') s += '\n';
  }
  return s.replace(/[ \t ]+/g, ' ').trim();
}
const tableText = (tbl, row, cell) => local(tbl, row).map(r => [...r.children].filter(c => c.localName === cell).map(c => local(c, 'p').map(paraText).filter(Boolean).join(' ')).join(' | ')).filter(t => t.replace(/[|\s]/g, '')).join('\n');

async function fromPptx(buf, onProgress) {
  const zip = await (await jszip()).loadAsync(buf);
  const pres = await xml(zip, 'ppt/presentation.xml');
  if (!pres) throw new Error('no presentation.xml');
  const prel = await rels(zip, 'ppt/presentation.xml');
  const size = local(pres, 'sldSz')[0];
  const w = Number(size && size.getAttribute('cx')) || 16, hh = Number(size && size.getAttribute('cy')) || 9;
  const parts = local(pres, 'sldId').map(s => prel[s.getAttribute('r:id')]?.path).filter(Boolean);
  const raw = [], uses = {};
  for (const part of parts) {
    const doc = await xml(zip, part); if (!doc || doc.documentElement.getAttribute('show') === '0') continue;
    const rel = await rels(zip, part);
    const blocks = [], pics = []; let title = '';
    const walk = async el => {
      for (const c of [...el.children]) {
        const n = c.localName;
        if (n === 'grpSp') await walk(c);
        else if (n === 'AlternateContent') { const ch = kid(c, 'Choice') || kid(c, 'Fallback'); if (ch) await walk(ch); }
        else if (n === 'sp') {
          const ph = local(c, 'ph')[0], type = ph && ph.getAttribute('type');
          const fill = kid(c, 'spPr') && local(kid(c, 'spPr'), 'blip')[0]; if (fill) pics.push(rel[embedId(fill)]?.path);
          if (['sldNum', 'dt', 'ftr'].includes(type)) continue;
          const body = kid(c, 'txBody'); if (!body) continue;
          const t = [...body.children].filter(p => p.localName === 'p').map(paraText).filter(Boolean).join('\n');
          if (!t) continue;
          if ((type === 'title' || type === 'ctrTitle') && !title) { title = t; blocks.unshift(t); } else blocks.push(t);
        } else if (n === 'pic') { const b = local(c, 'blip')[0]; if (b) pics.push(rel[embedId(b)]?.path); }
        else if (n === 'graphicFrame') {
          const tbl = local(c, 'tbl')[0]; if (tbl) blocks.push(tableText(tbl, 'tr', 'tc'));
          const dgm = local(c, 'relIds')[0];
          const dm = dgm && rel[dgm.getAttribute('r:dm')];
          if (dm) { const d = await xml(zip, dm.path); const t = local(d, 'p').map(paraText).filter(Boolean).join('\n'); if (t) blocks.push(t); }
          if (!tbl && !dgm) local(c, 'blip').forEach(b => pics.push(rel[embedId(b)]?.path));
        }
      }
    };
    const tree = local(doc, 'spTree')[0]; if (tree) await walk(tree);
    const uniq = [...new Set(pics.filter(Boolean))];
    uniq.forEach(p => { uses[p] = (uses[p] || 0) + 1; });
    raw.push({ text: blocks.filter(Boolean).join('\n'), title, pics: uniq });
  }
  const cache = {}; const pages = [];
  for (let i = 0; i < raw.length; i++) {
    if (onProgress) onProgress(i + 1, raw.length);
    const s = raw[i], images = [];
    for (const p of s.pics) {
      if (uses[p] > 2 && uses[p] >= raw.length * 0.3) continue; // фон и логотипы
      if (!(p in cache)) cache[p] = await shrink(zip, p);
      if (cache[p]) images.push({ ...cache[p] });
    }
    images.sort((a, b) => b.w * b.h - a.w * a.h);
    pages.push({ n: i + 1, label: `слайд ${i + 1}`, text: s.text, images, visual: s.text.length < CONFIG.visualTextLimit ? images.slice(0, 3) : [], w, h: hh });
  }
  return { pages, view: 'notes' };
}

async function fromDocx(buf) {
  const zip = await (await jszip()).loadAsync(buf);
  const doc = await xml(zip, 'word/document.xml'); if (!doc) throw new Error('no document.xml');
  const rel = await rels(zip, 'word/document.xml');
  const blocks = [];
  const walk = async el => {
    for (const c of [...el.children]) {
      if (c.localName === 'p') {
        const style = local(c, 'pStyle')[0]?.getAttribute('w:val') || '';
        const pics = []; for (const b of local(c, 'blip')) { const im = await shrink(zip, rel[embedId(b)]?.path || ''); if (im) pics.push(im); }
        const t = paraText(c);
        if (t || pics.length) blocks.push({ t, pics, head: /^(heading|заголовок|\d$)/i.test(style) });
      } else if (c.localName === 'tbl') { const t = tableText(c, 'tr', 'tc'); if (t) blocks.push({ t, pics: [] }); }
      else if (c.localName === 'sdt') { const s = kid(c, 'sdtContent'); if (s) await walk(s); }
    }
  };
  await walk(local(doc, 'body')[0]);
  const pages = []; let cur = null;
  for (const b of blocks) {
    if (!cur || (cur.text.length + b.t.length > 2200 && cur.text.length > 600) || (b.head && cur.text.length > 900)) {
      cur = { n: pages.length + 1, label: `часть ${pages.length + 1}`, text: '', images: [], visual: [], w: 4, h: 3 }; pages.push(cur);
    }
    if (b.t) cur.text += (cur.text ? '\n' : '') + b.t;
    cur.images.push(...b.pics);
  }
  pages.forEach(p => { if (p.text.length < CONFIG.visualTextLimit) p.visual = p.images.slice(0, 3); });
  return { pages, view: 'notes' };
}
