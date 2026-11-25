// Небольшое хранилище в IndexedDB: промежуточные результаты сборки демо и само демо.
// Ключ OpenRouter сюда не попадает.
function db() {
  return new Promise((ok, no) => {
    const r = indexedDB.open('zachet', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
}
async function run(mode, fn) {
  const d = await db();
  try {
    return await new Promise((ok, no) => {
      const t = d.transaction('kv', mode), q = fn(t.objectStore('kv'));
      t.oncomplete = () => ok(q && q.result); t.onerror = t.onabort = () => no(t.error);
    });
  } finally { d.close(); }
}
export const get = k => run('readonly', s => s.get(k));
export const put = (k, v) => run('readwrite', s => s.put(v, k));
export const keys = () => run('readonly', s => s.getAllKeys());
export const del = k => run('readwrite', s => s.delete(k));
export async function drop(prefix) { for (const k of await keys()) if (String(k).startsWith(prefix)) await del(k); }
