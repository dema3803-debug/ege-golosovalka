import { hasDb } from "./_redis.js";
import { validU, loadState, saveState, readBody } from "./_store.js";
import { markSeen } from "./_limits.js";

// GET ?u=... — план; PUT {u, state} — сохранить (с проверкой версии rev).
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (process.env.MOVED_TO) return res.status(410).json({ error: "Козя переехала", movedTo: process.env.MOVED_TO.replace(/\/$/, "") });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const u = req.method === "GET" ? req.query.u : readBody(req)?.u;
  if (!validU(u)) return res.status(400).json({ error: "Неверная ссылка" });
  try {
    const cur = await loadState(u);
    if (!cur) return res.status(404).json({ error: "План не найден. Проверь ссылку." });
    if (req.method === "GET") { await markSeen(u); return res.status(200).json({ state: cur }); }
    if (req.method !== "PUT") return res.status(405).json({ error: "Только GET и PUT" });
    const next = readBody(req)?.state;
    if (!next || typeof next !== "object" || !Array.isArray(next.tasks)) return res.status(400).json({ error: "Пустой план" });
    if (next.rev !== cur.rev) return res.status(409).json({ error: "План изменился на другом устройстве", state: cur });
    next.rev = cur.rev + 1;
    await saveState(u, next);
    await markSeen(u);
    res.status(200).json({ state: next });
  } catch (e) {
    res.status(500).json({ error: "Не удалось сохранить план" });
  }
}
