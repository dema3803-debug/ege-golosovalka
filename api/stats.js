import { redis, hasDb } from "./_redis.js";
import { addDays } from "../core.js";
import { mskToday } from "./_fromForm.js";

// Статистика пилота для Демы: /api/stats?key=ADMIN_KEY
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Неверный ключ" });
  const today = mskToday();
  const emails = {};
  const flat = (await redis("HGETALL", "users")) || [];
  for (let i = 0; i + 1 < flat.length; i += 2) { try { const x = JSON.parse(flat[i + 1]); emails[x.u] = { email: flat[i], created: x.created }; } catch {} }
  const people = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis("SCAN", cursor, "MATCH", "app:*", "COUNT", "500");
    for (const k of keys || []) {
      const u = k.slice(4);
      let s = {}; try { s = JSON.parse(await redis("GET", k)) || {}; } catch {}
      const seen = ((await redis("SMEMBERS", `seen:${u}`)) || []).sort();
      const done = Object.values(s.log || {}).reduce((a, l) => a + (l?.length || 0), 0);
      const created = emails[u]?.created || s.created || seen[0] || null;
      const eg = Object.values(s.ege || {}), egR = eg.reduce((a, x) => a + (x.r || 0), 0), egW = eg.reduce((a, x) => a + (x.w || 0), 0);
      const egeDays = new Set(eg.map(x => x.last).filter(Boolean)).size;
      people.push({ name: s.name || "", email: emails[u]?.email || "", created, lastSeen: seen.at(-1) || null, daysActive: seen.length, doneBlocks: done, messages: (s.chat || []).filter(m => m.role === "user").length, topics: (s.topics || []).length, cards: (s.cards || []).length,
        тренажёр: { карточек_изучено: eg.length, ответов: egR + egW, верно: egR, процент: egR + egW ? Math.round(egR / (egR + egW) * 100) : null, дней_с_тренажёром: egeDays }, seen });
    }
    cursor = String(next);
  } while (cursor !== "0");
  const signedUp = people.filter(p => p.email);
  const ret = (list, n) => {
    const base = list.filter(p => p.created && p.created <= addDays(today, -n));
    const back = base.filter(p => p.seen.some(d => d >= addDays(p.created, n)));
    return { из: base.length, вернулись: back.length, процент: base.length ? Math.round(back.length / base.length * 100) : null };
  };
  people.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  res.status(200).json({
    сегодня: today,
    всего_планов: people.length,
    зарегистрировались_сами: signedUp.length,
    заходили_сегодня: people.filter(p => p.lastSeen === today).length,
    заходили_за_7_дней: people.filter(p => p.lastSeen && p.lastSeen >= addDays(today, -6)).length,
    вернулись_на_следующий_день: ret(signedUp, 1),
    вернулись_через_неделю: ret(signedUp, 7),
    тренажёр_пользовались: people.filter(p => p.тренажёр.ответов > 0).length,
    тренажёр_всего_ответов: people.reduce((a, p) => a + p.тренажёр.ответов, 0),
    люди: people.map(({ seen, ...p }) => p),
  });
}
