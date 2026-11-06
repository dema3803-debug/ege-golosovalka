import { redis, hasDb } from "./_redis.js";

// POST - сохраняет анкету для плана (повторная отправка заменяет прошлую).
// GET ?key=... - отдаёт все анкеты, только если ключ совпадает с ADMIN_KEY в настройках Vercel.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });

  if (req.method === "GET") {
    const key = process.env.ADMIN_KEY;
    if (!key) return res.status(403).json({ error: "Добавьте ADMIN_KEY в настройках Vercel" });
    if (req.query.key !== key) return res.status(403).json({ error: "Неверный ключ" });
    try {
      const flat = (await redis("HGETALL", "plans")) || [];
      const plans = [];
      for (let i = 1; i < flat.length; i += 2) { try { plans.push(JSON.parse(flat[i])); } catch {} }
      plans.sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
      return res.status(200).json({ count: plans.length, plans });
    } catch {
      return res.status(500).json({ error: "Не удалось загрузить анкеты" });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Только GET и POST" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const voter = body && body.voter;
  const form = body && body.form;
  if (typeof voter !== "string" || !/^[a-z0-9]{12,40}$/.test(voter)) return res.status(400).json({ error: "Неверный id" });
  if (!form || typeof form !== "object" || Array.isArray(form)) return res.status(400).json({ error: "Пустая анкета" });
  const text = JSON.stringify({ ...form, sentAt: Date.now() });
  if (text.length > 60000) return res.status(413).json({ error: "Анкета слишком большая" });
  try {
    await redis("HSET", "plans", voter, text);
    res.status(200).json({ ok: true });
  } catch {
    res.status(500).json({ error: "Не удалось сохранить" });
  }
}
