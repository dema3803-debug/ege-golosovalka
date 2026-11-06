import crypto from "node:crypto";
import { redis, hasDb } from "./_redis.js";
import { validU, loadState, readBody } from "./_store.js";

// Файлы-материалы (фото конспектов, PDF). Храним в Redis.
// POST {u, name, mime, data(base64)} → {id}; GET ?u=&id= → файл; DELETE ?u=&id=
const MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_BYTES = 4_500_000, MAX_FILES = 80;
const validId = id => /^[a-f0-9]{16}$/.test(String(id || ""));

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  if (req.method === "GET" || req.method === "DELETE") {
    const { u, id } = req.query;
    if (!validU(u) || !validId(id)) return res.status(400).json({ error: "Неверная ссылка" });
    if (req.method === "DELETE") { await redis("DEL", `file:${u}:${id}`); await redis("SREM", `files:${u}`, id); return res.status(200).json({ ok: true }); }
    const raw = await redis("GET", `file:${u}:${id}`);
    if (!raw) return res.status(404).json({ error: "Файл не найден" });
    const f = JSON.parse(raw), buf = Buffer.from(f.data, "base64");
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.name || "file")}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.end(buf);
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Только GET, POST и DELETE" });
  const b = readBody(req) || {};
  if (!validU(b.u) || !(await loadState(b.u))) return res.status(400).json({ error: "Неверная ссылка" });
  if (!MIMES.includes(b.mime)) return res.status(400).json({ error: "Можно прикрепить фото или PDF." });
  const data = String(b.data || "").replace(/^data:[^;]+;base64,/, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({ error: "Файл повреждён" });
  const size = Math.floor(data.length * 3 / 4);
  if (size > MAX_BYTES) return res.status(413).json({ error: "Файл больше 4 МБ. Сожми его или прикрепи ссылкой." });
  if (Number(await redis("SCARD", `files:${b.u}`)) >= MAX_FILES) return res.status(400).json({ error: `Уже ${MAX_FILES} файлов — удали ненужные или прикрепляй ссылками.` });
  const id = crypto.randomBytes(8).toString("hex");
  await redis("SET", `file:${b.u}:${id}`, JSON.stringify({ mime: b.mime, name: String(b.name || "").slice(0, 120), data, at: Date.now() }));
  await redis("SADD", `files:${b.u}`, id);
  res.status(200).json({ ok: true, id, size });
}
