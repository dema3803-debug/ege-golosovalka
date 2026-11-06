// Счётчики-ограничения и отметки активности.
import { redis } from "./_redis.js";
import { mskToday } from "./_fromForm.js";

// true, если лимит превышен. ttl - сколько секунд живёт счётчик.
export async function overLimit(key, max, ttl) {
  const n = Number(await redis("INCR", key));
  if (n === 1) await redis("EXPIRE", key, ttl);
  return n > max;
}
export const AI_PER_DAY = Number(process.env.AI_PER_DAY) || 60;
export async function aiOverLimit(u) { return overLimit(`lim:ai:${u}:${mskToday()}`, AI_PER_DAY, 2 * 86400); }
export async function markSeen(u) { try { await redis("SADD", `seen:${u}`, mskToday()); } catch {} }
