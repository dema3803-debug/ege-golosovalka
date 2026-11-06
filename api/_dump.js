// Выгрузка и загрузка всех данных - для переезда на другой сервер.
import { redis } from "./_redis.js";

// всё, без чего нельзя восстановиться: входы по почте, приглашения, награды, ссылки на карточки (файлы не выгружаем - они тяжёлые)
const HASHES = ["answers", "plans", "users", "refs", "invited", "pioneers", "share:made", "share:opens"];
const STR = /^(app:[a-z0-9]{16,40}|share:[a-z0-9]{8}|ref:[a-z0-9]{6}|refcode:[a-z0-9]{16,40})$/;
const pairs = flat => { const o = {}; for (let i = 0; i + 1 < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1]; return o; };

export async function dumpAll() {
  const out = { version: 1, at: new Date().toISOString(), hashes: {}, lists: {}, strings: {} };
  for (const h of HASHES) out.hashes[h] = pairs(await redis("HGETALL", h));
  out.lists.giga_log = (await redis("LRANGE", "giga_log", 0, -1)) || [];
  let cursor = "0";
  do {
    const [next, keys] = await redis("SCAN", cursor, "COUNT", "500");
    for (const k of keys || []) {
      if (STR.test(k)) out.strings[k] = await redis("GET", k);
      else if (/^(seen|shares):[a-z0-9]{16,40}$/.test(k)) (out.sets ||= {})[k] = (await redis("SMEMBERS", k)) || [];
    }
    cursor = String(next);
  } while (cursor !== "0");
  return out;
}

// Загрузка. План человека не затирается более старой версией (по номеру rev).
export async function loadAll(d) {
  const res = { answers: 0, plans: 0, users: 0, apps: 0, other: 0, skipped: 0, log: 0 };
  for (const h of HASHES) {
    for (const [f, v] of Object.entries(d?.hashes?.[h] || {})) { await redis("HSET", h, f, String(v)); res[h] = (res[h] || 0) + 1; }
  }
  for (const [k, v] of Object.entries(d?.sets || {})) {
    if (!/^(seen|shares):[a-z0-9]{16,40}$/.test(k) || !Array.isArray(v)) continue;
    for (const x of v) await redis("SADD", k, String(x));
  }
  for (const [k, v] of Object.entries(d?.strings || {})) {
    if (!STR.test(k) || typeof v !== "string") continue;
    if (!k.startsWith("app:")) { await redis("SET", k, v); res.other++; continue; }
    const cur = await redis("GET", k);
    const rev = s => { try { return JSON.parse(s).rev || 0; } catch { return -1; } };
    if (cur && rev(cur) > rev(v)) { res.skipped++; continue; }
    await redis("SET", k, v); res.apps++;
  }
  const log = (d?.lists?.giga_log || []).slice(0, 30);
  if (log.length) { await redis("DEL", "giga_log"); for (const x of [...log].reverse()) await redis("LPUSH", "giga_log", x); res.log = log.length; }
  return res;
}
