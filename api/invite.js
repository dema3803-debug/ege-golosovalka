import crypto from "node:crypto";
import { redis, hasDb } from "./_redis.js";
import { validU, loadState, readBody } from "./_store.js";

// Приглашение друга: POST {u} → {code, friends}. Ссылка: /start?ref=<code>.
// Код хранится отдельно от плана (refcode:<u> и ref:<code>), чтобы не менять версию плана.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const b = readBody(req) || {};
  if (!validU(b.u)) return res.status(400).json({ error: "Неверные данные" });
  if (!(await loadState(b.u))) return res.status(404).json({ error: "План не найден" });
  let code = await redis("GET", "refcode:" + b.u);
  if (!code) {
    code = crypto.randomBytes(6).toString("base64").replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(6, "k").slice(0, 6);
    await redis("SET", "ref:" + code, b.u);
    await redis("SET", "refcode:" + b.u, code);
  }
  const friends = Number(await redis("HGET", "refs", b.u)) || 0;
  res.status(200).json({ code, friends });
}
