import crypto from "node:crypto";
import { redis, hasDb } from "./_redis.js";
import { readBody } from "./_store.js";
import { normEmail, hashPassword } from "./signup.js";
import { overLimit } from "./_limits.js";

// Вход: POST {email, password} → {u}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const b = readBody(req) || {};
  const email = normEmail(b.email);
  if (!email || !b.password) return res.status(400).json({ error: "Введи почту и пароль." });
  if (await overLimit(`lim:login:${email}`, 10, 900)) return res.status(429).json({ error: "Слишком много попыток. Подожди 15 минут." });
  const raw = await redis("HGET", "users", email);
  const fail = () => res.status(401).json({ error: "Неверная почта или пароль." });
  if (!raw) return fail();
  let user; try { user = JSON.parse(raw); } catch { return fail(); }
  const { hash } = hashPassword(String(b.password), user.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"))) return fail();
  res.status(200).json({ ok: true, u: user.u });
}
