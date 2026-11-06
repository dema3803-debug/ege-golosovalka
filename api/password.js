import crypto from "node:crypto";
import { redis, hasDb } from "./_redis.js";
import { validU, loadState, readBody } from "./_store.js";
import { normEmail, validEmail, hashPassword } from "./signup.js";
import { overLimit } from "./_limits.js";

// POST {u, old, password} — сменить пароль; POST {u, email, password} — привязать почту к плану без входа (как у Веры).
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const b = readBody(req) || {};
  if (!validU(b.u)) return res.status(400).json({ error: "Неверная ссылка" });
  const state = await loadState(b.u);
  if (!state) return res.status(404).json({ error: "План не найден" });
  const password = String(b.password || "");
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: "Пароль — минимум 8 символов." });
  if (await overLimit(`lim:pass:${b.u}`, 10, 900)) return res.status(429).json({ error: "Слишком много попыток. Подожди 15 минут." });

  // найти почту этого плана
  let email = null, user = null;
  const flat = (await redis("HGETALL", "users")) || [];
  for (let i = 0; i + 1 < flat.length; i += 2) { try { const x = JSON.parse(flat[i + 1]); if (x.u === b.u) { email = flat[i]; user = x; break; } } catch {} }

  if (user) {
    const { hash } = hashPassword(String(b.old || ""), user.salt);
    if (!crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"))) return res.status(401).json({ error: "Старый пароль не подходит." });
    const np = hashPassword(password);
    await redis("HSET", "users", email, JSON.stringify({ ...user, salt: np.salt, hash: np.hash, changedAt: new Date().toISOString() }));
    return res.status(200).json({ ok: true });
  }
  const ne = normEmail(b.email);
  if (!validEmail(ne)) return res.status(400).json({ error: "Проверь почту — похоже, в ней опечатка." });
  const np = hashPassword(password);
  const ok = await redis("HSETNX", "users", ne, JSON.stringify({ u: b.u, salt: np.salt, hash: np.hash, created: state.created || null, linkedAt: new Date().toISOString() }));
  if (Number(ok) !== 1) return res.status(409).json({ error: "Эта почта уже занята другим планом." });
  res.status(200).json({ ok: true, email: ne });
}
