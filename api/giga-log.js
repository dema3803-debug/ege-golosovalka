import { redis, hasDb } from "./_redis.js";

// Журнал последних ответов помощника. Открывать: /api/giga-log?key=ADMIN_KEY
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Неверный ключ" });
  const n = Math.min(30, Math.max(1, parseInt(req.query.n) || 5));
  const list = (await redis("LRANGE", "giga_log", 0, n - 1)) || [];
  res.status(200).json(list.map(x => { try { return JSON.parse(x); } catch { return x; } }));
}
