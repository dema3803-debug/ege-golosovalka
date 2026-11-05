import { redis, hasDb } from "./_redis.js";

// Принимает ответы одного человека и сохраняет их целиком (повторная отправка заменяет старые).
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const voter = body && body.voter;
  const answers = body && body.answers;
  if (typeof voter !== "string" || !/^[a-z0-9]{12,40}$/.test(voter)) return res.status(400).json({ error: "Неверный id" });
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return res.status(400).json({ error: "Нет ответов" });
  const clean = {};
  const keys = Object.keys(answers);
  if (keys.length > 40) return res.status(400).json({ error: "Слишком много вопросов" });
  for (const k of keys) {
    const v = answers[k];
    if (!/^[a-z]{2,20}$/.test(k) || !Array.isArray(v) || v.length > 12) return res.status(400).json({ error: "Неверный формат" });
    const ints = [...new Set(v)].filter(i => Number.isInteger(i) && i >= 0 && i < 12);
    if (ints.length) clean[k] = ints;
  }
  try {
    if (Object.keys(clean).length) await redis("HSET", "answers", voter, JSON.stringify(clean));
    else await redis("HDEL", "answers", voter);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Не удалось сохранить" });
  }
}
