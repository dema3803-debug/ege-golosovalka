import crypto from "node:crypto";
import { redis, hasDb } from "./_redis.js";
import { validU, loadState, readBody } from "./_store.js";
import { hashPassword, normEmail } from "./signup.js";
import { overLimit } from "./_limits.js";

// Удаление аккаунта и всех данных (отзыв согласия): POST {u, password, action:"delete"}
// Для плана с почтой нужен пароль, для старого плана без почты - слово «УДАЛИТЬ».
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const b = readBody(req) || {};
  if (!validU(b.u) || b.action !== "delete") return res.status(400).json({ error: "Неверные данные" });
  if (await overLimit(`lim:del:${b.u}`, 10, 900)) return res.status(429).json({ error: "Слишком много попыток. Подожди 15 минут." });
  const s = await loadState(b.u);
  if (!s) return res.status(404).json({ error: "Аккаунт не найден" });
  const email = normEmail(s.email || "");
  let userRaw = email ? await redis("HGET", "users", email) : null;
  if (userRaw) {
    let user; try { user = JSON.parse(userRaw); } catch { user = null; }
    if (!user || user.u !== b.u) userRaw = null;
    else {
      const { hash } = hashPassword(String(b.password || ""), user.salt);
      if (!crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"))) return res.status(401).json({ error: "Неверный пароль." });
    }
  }
  if (!userRaw && String(b.password || "").trim().toUpperCase() !== "УДАЛИТЬ") return res.status(401).json({ error: "Напиши слово УДАЛИТЬ, чтобы подтвердить." });

  const u = b.u;
  const del = async (...keys) => { for (const k of keys) { try { await redis("DEL", k); } catch {} } };
  const hdel = async (h, f) => { try { await redis("HDEL", h, f); } catch {} };
  // файлы
  for (const id of (await redis("SMEMBERS", `files:${u}`)) || []) await del(`file:${u}:${id}`);
  // наборы карточек, которыми делился
  for (const id of (await redis("SMEMBERS", `shares:${u}`)) || []) { await del(`share:${id}`); await hdel("share:opens", id); }
  // приглашения
  const code = await redis("GET", `refcode:${u}`);
  if (code) await del(`ref:${code}`);
  // жалобы на карточки с этим пользователем
  try { for (const x of (await redis("LRANGE", "reports", 0, -1)) || []) { try { if (JSON.parse(x).u === u) await redis("LREM", "reports", 0, x); } catch {} } } catch {}
  await del(`app:${u}`, `seen:${u}`, `files:${u}`, `shares:${u}`, `refcode:${u}`);
  for (const h of ["refs", "invited", "pioneers", "share:made"]) await hdel(h, u);
  await hdel("plans", "signup-" + u);
  if (email) await hdel("users", email);
  try { await redis("INCR", "stats:deleted"); } catch {}
  console.log(`account: удалён аккаунт ${u.slice(0, 6)}…`);
  res.status(200).json({ ok: true });
}
