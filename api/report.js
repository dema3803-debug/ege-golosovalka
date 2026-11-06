import { redis, hasDb } from "./_redis.js";
import { validU, loadState, readBody } from "./_store.js";
import { overLimit } from "./_limits.js";

// «Здесь ошибка» в карточке тренажёра: POST {u, card, subject, q, given, text}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const b = readBody(req) || {};
  if (!validU(b.u) || !/^[a-z]{2}-\d{3}$/.test(String(b.card || ""))) return res.status(400).json({ error: "Неверные данные" });
  const s = await loadState(b.u);
  if (!s) return res.status(404).json({ error: "План не найден" });
  if (await overLimit(`lim:report:${b.u}`, 30, 86400)) return res.status(429).json({ error: "Слишком много сообщений за день. Спасибо, мы всё прочитаем!" });
  const clip = (x, n) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const item = { at: new Date().toISOString(), u: b.u, name: s.name || "", card: b.card, subject: clip(b.subject, 40), q: clip(b.q, 160), given: clip(b.given, 120), text: clip(b.text, 500) };
  await redis("LPUSH", "reports", JSON.stringify(item));
  await redis("LTRIM", "reports", 0, 999);
  res.status(200).json({ ok: true });
}
