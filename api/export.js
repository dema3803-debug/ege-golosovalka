import { hasDb } from "./_redis.js";
import { dumpAll } from "./_dump.js";

// Резервная копия всех данных. Открывать: /api/export?key=ADMIN_KEY
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Неверный ключ" });
  res.setHeader("Content-Disposition", `attachment; filename="kozya-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.status(200).json(await dumpAll());
}
