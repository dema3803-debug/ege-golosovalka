import { hasDb } from "./_redis.js";
import { loadAll } from "./_dump.js";

// Приём данных при переезде. POST с заголовком X-Admin-Key = ADMIN_KEY и телом из /api/export.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  if (!process.env.ADMIN_KEY || req.headers["x-admin-key"] !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Неверный ключ" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || body.version !== 1) return res.status(400).json({ error: "Не похоже на выгрузку Кози" });
  try { res.status(200).json({ ok: true, loaded: await loadAll(body) }); }
  catch (e) { res.status(500).json({ error: "Не удалось загрузить: " + e.message }); }
}
