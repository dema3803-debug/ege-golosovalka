import crypto from "node:crypto";
import { redis, hasDb } from "./_redis.js";
import { saveState } from "./_store.js";
import { emptyState, DAYS, uid } from "../core.js";

// Создаёт личный план из последней анкеты (или анкеты с нужным именем) и выдаёт ссылку.
// Открывать: /api/app-init?key=ADMIN_KEY            — по последней анкете
//            /api/app-init?key=ADMIN_KEY&name=Вера  — по анкете с этим именем
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

  const s = emptyState();
  s.name = f.name || "";
  s.subjects = (f.subjects || []).map(x => ({ name: x.name, target: Number(x.target) || null, current: Number(x.current) || null }));
  const dayIdx = d => DAYS.indexOf(d);
  s.free = DAYS.map((d, i) => {
    const x = (f.free || []).find(y => y.day === d) || {};
    return { off: !!x.off, from: x.from || "", to: x.to || "" };
  });
  const capMap = { "Меньше часа": 60, "1–2 часа": 120, "2–3 часа": 180, "3–4 часа": 240, "Больше 4 часов": 270 };
  s.dailyCapMin = capMap[f.choices?.selfHours?.[0]] || 180;
  const sess = f.choices?.session?.[0] || "";
  s.sessionMin = sess.startsWith("25") ? 25 : sess.startsWith("45") ? 45 : sess.startsWith("1 час") ? 50 : sess.startsWith("1,5") ? 50 : 25;
  s.lessons = (f.lessons || []).filter(l => l.subject || l.kind).map(l => ({
    id: uid("l"), subject: l.subject || "", title: (l.kind && l.kind !== "Другое" ? l.kind.replace("Вебинар онлайн-курса", "Вебинар") + ": " : "") + (l.subject || "Занятие"),
    days: (l.days || []).map(dayIdx).filter(i => i >= 0), from: l.from || "", to: l.to || "", where: l.where || "",
  }));
  const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  s.tasks = (f.deadlines || []).filter(d => d.date && d.date >= today).map(d => ({
    id: uid("t"), title: `${(d.what || "Задание").trim() || "Задание"}${d.subject ? " — " + d.subject : ""}`.replace(/^дз/i, "ДЗ"), subject: d.subject || "",
    kind: "ege", sessions: 2, done: 0, due: d.date, dueTime: d.time || null, created: today,
  }));
  s.habits = [{ id: uid("h"), title: "Школьные задания", subject: "Школа", days: [0, 1, 2, 3, 4], sessions: 1 }];
  s.prefs = { bestTime: f.choices?.bestTime || [], remind: f.choices?.remindWhen || [] };

  // ?u=... — пересоздать план по той же ссылке (сбросить к данным анкеты)
  const u = /^[a-z0-9]{16,40}$/.test(req.query.u || "") ? req.query.u : crypto.randomBytes(12).toString("hex");
  await saveState(u, s);
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  res.status(200).json({ ok: true, name: s.name, link: `https://${host}/app?u=${u}` });
}
