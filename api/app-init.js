import crypto from "node:crypto";
import { redis, hasDb } from "./_redis.js";
import { saveState } from "./_store.js";
import { formToState } from "./_fromForm.js";

// Создаёт личный план из последней анкеты (или анкеты с нужным именем) и выдаёт ссылку.
// Открывать: /api/app-init?key=ADMIN_KEY            - по последней анкете
//            /api/app-init?key=ADMIN_KEY&name=Вера  - по анкете с этим именем
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Неверный ключ" });
  const flat = (await redis("HGETALL", "plans")) || [];
  let forms = [];
  for (let i = 1; i < flat.length; i += 2) { try { forms.push(JSON.parse(flat[i])); } catch {} }
  if (req.query.name) forms = forms.filter(f => (f.name || "").toLowerCase().includes(String(req.query.name).toLowerCase()));
  forms.sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
  const f = forms[0];
  if (!f) return res.status(404).json({ error: "Анкета не найдена" });

  const s = formToState(f);

  // ?u=... - пересоздать план по той же ссылке (сбросить к данным анкеты)
  const u = /^[a-z0-9]{16,40}$/.test(req.query.u || "") ? req.query.u : crypto.randomBytes(12).toString("hex");
  await saveState(u, s);
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  res.status(200).json({ ok: true, name: s.name, link: `https://${host}/app?u=${u}` });
}
