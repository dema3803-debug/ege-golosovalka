// Выгрузка и загрузка всех данных — для переезда на другой сервер.
import { redis } from "./_redis.js";

const pairs = flat => { const o = {}; for (let i = 0; i + 1 < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1]; return o; };

export async function dumpAll() {
  const out = { version: 1, at: new Date().toISOString(), hashes: {}, lists: {}, strings: {} };
  for (const h of ["answers", "plans"]) out.hashes[h] = pairs(await redis("HGETALL", h));
  out.lists.giga_log = (await redis("LRANGE", "giga_log", 0, -1)) || [];
  let cursor = "0";
  do {
    const [next, keys] = await redis("SCAN", cursor, "MATCH", "app:*", "COUNT", "500");
    for (const k of keys || []) out.strings[k] = await redis("GET", k);
    cursor = String(next);
  } while (cursor !== "0");
  return out;
}

// Загрузка. План человека не затирается более старой версией (по номеру rev).
export async function loadAll(d) {
  const res = { answers: 0, plans: 0, apps: 0, skipped: 0, log: 0 };
  for (const h of ["answers", "plans"]) {
    for (const [f, v] of Object.entries(d?.hashes?.[h] || {})) { await redis("HSET", h, f, v); res[h]++; }
  }
  for (const [k, v] of Object.entries(d?.strings || {})) {
    if (!/^app:[a-z0-9]{16,40}$/.test(k) || typeof v !== "string") continue;
    const cur = await redis("GET", k);
    const rev = s => { try { return JSON.parse(s).rev || 0; } catch { return -1; } };
    if (cur && rev(cur) > rev(v)) { res.skipped++; continue; }
    await redis("SET", k, v); res.apps++;
  }
  const log = (d?.lists?.giga_log || []).slice(0, 30);
  if (log.length) { await redis("DEL", "giga_log"); for (const x of [...log].reverse()) await redis("LPUSH", "giga_log", x); res.log = log.length; }
  return res;
}
