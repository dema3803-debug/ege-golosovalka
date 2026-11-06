import crypto from "node:crypto";
import { redis, hasDb } from "./_redis.js";
import { validU, loadState, readBody } from "./_store.js";
import { overLimit } from "./_limits.js";

// Обмен наборами карточек.
// POST {u, topicId} → {id} - сохранить карточки темы и получить код ссылки (живёт год)
// GET ?id=...       → {title, subject, by, cards:[{q,a}]} - посмотреть набор по ссылке
const YEAR = 365 * 86400;
const validId = id => /^[a-z0-9]{8}$/.test(String(id || ""));

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });

  if (req.method === "GET") {
    const id = new URL(req.url, "http://x").searchParams.get("id");
    if (!validId(id)) return res.status(400).json({ error: "Неверная ссылка" });
    const raw = await redis("GET", "share:" + id);
    if (!raw) return res.status(404).json({ error: "Набор не найден. Возможно, ссылка устарела." });
    await redis("HINCRBY", "share:opens", id, 1);
    return res.status(200).json(JSON.parse(raw));
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Только GET или POST" });
  const b = readBody(req) || {};
  if (!validU(b.u)) return res.status(400).json({ error: "Неверные данные" });
  const s = await loadState(b.u);
  if (!s) return res.status(404).json({ error: "План не найден" });
  const t = (s.topics || []).find(x => x.id === b.topicId);
  if (!t) return res.status(404).json({ error: "Тема не найдена" });
  const clip = (x, n) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const cards = (s.cards || []).filter(c => c.topicId === t.id).slice(0, 200).map(c => ({ q: clip(c.q, 300), a: clip(c.a, 300) })).filter(c => c.q && c.a);
  if (!cards.length) return res.status(400).json({ error: "В теме нет карточек - сначала добавь хотя бы одну." });
  if (await overLimit(`lim:share:${b.u}`, 30, 86400)) return res.status(429).json({ error: "Слишком много ссылок за день, попробуй завтра." });
  const id = crypto.randomBytes(8).toString("base64").replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(8, "x").slice(0, 8);
  const set = { title: clip(t.title, 80), subject: clip(t.subject, 40), by: clip(s.name, 40), byG: s.gender === "m" || s.gender === "f" ? s.gender : undefined, cards, created: new Date().toISOString() };
  await redis("SET", "share:" + id, JSON.stringify(set), "EX", YEAR);
  await redis("HINCRBY", "share:made", b.u, 1);
  await redis("SADD", "shares:" + b.u, id); // чтобы удалить при удалении аккаунта
  res.status(200).json({ id });
}
