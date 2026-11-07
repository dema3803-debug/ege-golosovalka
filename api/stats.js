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
  for (let i = 0; i + 1 < flat.length; i += 2) { try { const x = JSON.parse(flat[i + 1]); emails[x.u] = { email: flat[i], created: x.created, src: x.src || null, camp: x.camp || null }; } catch {} }
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
      const games = Object.values(s.played || {}).reduce((a, n) => a + (Number(n) || 0), 0);
      const friends = Number(await redis("HGET", "refs", u)) || 0;
      const invitedBy = await redis("HGET", "invited", u);
      people.push({ name: s.name || "", откуда: emails[u]?.src || (invitedBy ? "friend" : emails[u] ? "none" : null), тема_поста: emails[u]?.camp || null, игр: games, привёл_друзей: friends, задач: (s.tasks || []).length, повторяющихся: (s.habits || []).length, email: emails[u]?.email || "", created, lastSeen: seen.at(-1) || null, daysActive: seen.length, doneBlocks: done, messages: (s.chat || []).filter(m => m.role === "user").length, topics: (s.topics || []).length, cards: (s.cards || []).length,
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
  let reports = [];
  try { reports = ((await redis("LRANGE", "reports", 0, 49)) || []).map(x => { try { const r = JSON.parse(x); return { когда: new Date(Date.parse(r.at) + 3 * 3600000).toISOString().slice(0, 16).replace("T", " "), кто: r.name, предмет: r.subject, карточка: r.card, вопрос: r.q, ответ_ученика: r.given, что_не_так: r.text }; } catch { return null; } }).filter(Boolean); } catch {}
  people.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  const days = [];
  for (let i = 29; i >= 0; i--) { const d = addDays(today, -i); days.push({ день: d, заходили: people.filter(p => p.seen.includes(d)).length, новых: signedUp.filter(p => p.created === d).length }); }
  const sumH = async key => { try { return ((await redis("HVALS", key)) || []).reduce((a, x) => a + (Number(x) || 0), 0); } catch { return 0; } };
  let pioneers = 0; try { pioneers = Number(await redis("HLEN", "pioneers")) || 0; } catch {}
  // как справляется Козя в чате (счётчики из api/assistant.js)
  const AI_F = ["changed", "quiz", "talk", "claimed", "notjson", "down", "limit", "safety"];
  const aiDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i), row = { день: d };
    let flat = []; try { flat = (await redis("HGETALL", `ai:day:${d}`)) || []; } catch {}
    for (const f of AI_F) row[f] = 0;
    for (let k = 0; k + 1 < flat.length; k += 2) row[flat[k]] = Number(flat[k + 1]) || 0;
    aiDays.push(row);
  }
  const aiSum = Object.fromEntries(AI_F.map(f => [f, aiDays.reduce((a, r) => a + r[f], 0)]));
  let aiFails = [];
  try { aiFails = ((await redis("LRANGE", "ai:fails", 0, 14)) || []).map(x => { try { const r = JSON.parse(x); return { когда: new Date(Date.parse(r.at) + 3 * 3600000).toISOString().slice(0, 16).replace("T", " "), что: r.kind, сообщение: r.message }; } catch { return null; } }).filter(Boolean); } catch {}
  // откуда пришли зарегистрировавшиеся: по меткам из ссылок постов
  const srcMap = {};
  for (const p of signedUp) {
    const k = p.откуда || "none", r = (srcMap[k] ||= { источник: k, всего: 0, за_7_дней: 0, темы: {} });
    r.всего++; if (p.created && p.created >= addDays(today, -6)) r.за_7_дней++;
    if (p.тема_поста) r.темы[p.тема_поста] = (r.темы[p.тема_поста] || 0) + 1;
  }
  const откуда = Object.values(srcMap).sort((a, b) => b.всего - a.всего);
  res.status(200).json({
    сегодня: today,
    откуда_пришли: откуда,
    козя_за_7_дней: { итог: aiSum, по_дням: aiDays, неудачи: aiFails },
    всего_планов: people.length,
    зарегистрировались_сами: signedUp.length,
    заходили_сегодня: people.filter(p => p.lastSeen === today).length,
    заходили_за_7_дней: people.filter(p => p.lastSeen && p.lastSeen >= addDays(today, -6)).length,
    вернулись_на_следующий_день: ret(signedUp, 1),
    вернулись_через_неделю: ret(signedUp, 7),
    тренажёр_пользовались: people.filter(p => p.тренажёр.ответов > 0).length,
    жалобы_на_карточки: reports,
    тренажёр_всего_ответов: people.reduce((a, p) => a + p.тренажёр.ответов, 0),
    по_дням: days,
    первопроходцев: pioneers,
    пришли_по_приглашению: await sumH("refs"),
    ссылок_на_карточки: await sumH("share:made"),
    открыли_ссылки_на_карточки: await sumH("share:opens"),
    игр_всего: people.reduce((a, p) => a + p.игр, 0),
    люди: people.map(({ seen, ...p }) => p),
  });
}
