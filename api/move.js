import { hasDb } from "./_redis.js";
import { dumpAll, loadAll } from "./_dump.js";

// Переезд и резервные копии - одна функция (на бесплатном Vercel их не больше 12).
//   /api/move?do=export&key=ADMIN_KEY                       - скачать копию всех данных
//   /api/move?do=migrate&key=ADMIN_KEY&to=https://домен.ru  - перенести всё на новый сервер (открывать на СТАРОМ сайте)
//   POST /api/move?do=import  + заголовок X-Admin-Key        - приём данных на НОВОМ сервере
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const key = process.env.ADMIN_KEY;
  const action = req.query.do;

  if (action === "import") {
    if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
    if (!key || req.headers["x-admin-key"] !== key) return res.status(403).json({ error: "Неверный ключ" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || body.version !== 1) return res.status(400).json({ error: "Не похоже на выгрузку Кози" });
    try { return res.status(200).json({ ok: true, loaded: await loadAll(body) }); }
    catch (e) { return res.status(500).json({ error: "Не удалось загрузить: " + e.message }); }
  }

  if (!key || req.query.key !== key) return res.status(403).json({ error: "Неверный ключ" });

  if (action === "export") {
    res.setHeader("Content-Disposition", `attachment; filename="kozya-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.status(200).json(await dumpAll());
  }

  if (action === "migrate") {
    let to;
    try { to = new URL(req.query.to); if (to.protocol !== "https:") throw 0; } catch { return res.status(400).json({ error: "Укажи новый адрес: &to=https://твой-домен.ru" }); }
    const dump = await dumpAll();
    const sent = { answers: Object.keys(dump.hashes.answers).length, plans: Object.keys(dump.hashes.plans).length, apps: Object.keys(dump.strings).length };
    try {
      const target = new URL("/api/move?do=import", to);
      const r = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": key }, body: JSON.stringify(dump) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: "Новый сервер не принял данные", status: r.status, answer: j, sent });
      return res.status(200).json({ ok: true, sent, newServer: j.loaded, итог: "ДАННЫЕ ПЕРЕНЕСЕНЫ ✅" });
    } catch (e) {
      return res.status(502).json({ error: "Не достучалась до нового сервера: " + e.message, sent });
    }
  }

  res.status(400).json({ error: "Укажи действие: ?do=export или ?do=migrate" });
}
