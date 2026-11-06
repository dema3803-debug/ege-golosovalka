import { hasDb } from "./_redis.js";
import { dumpAll } from "./_dump.js";

// Перенос всех данных на новый сервер. Открывать на СТАРОМ сайте:
// /api/migrate?key=ADMIN_KEY&to=https://новый-домен.ru
// Пароль ADMIN_KEY на обоих серверах должен совпадать. Можно запускать повторно — свежие планы не затрутся.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Неверный ключ" });
  let to;
  try { to = new URL(req.query.to); if (to.protocol !== "https:") throw 0; } catch { return res.status(400).json({ error: "Укажи новый адрес: &to=https://твой-домен.ru" }); }
  const dump = await dumpAll();
  const counts = { answers: Object.keys(dump.hashes.answers).length, plans: Object.keys(dump.hashes.plans).length, apps: Object.keys(dump.strings).length };
  try {
    const r = await fetch(new URL("/api/import", to), { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": process.env.ADMIN_KEY }, body: JSON.stringify(dump) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: "Новый сервер не принял данные", status: r.status, answer: j, sent: counts });
    res.status(200).json({ ok: true, sent: counts, newServer: j.loaded, итог: "ДАННЫЕ ПЕРЕНЕСЕНЫ ✅" });
  } catch (e) {
    res.status(502).json({ error: "Не достучалась до нового сервера: " + e.message, sent: counts });
  }
}
