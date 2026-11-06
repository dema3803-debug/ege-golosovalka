// Превращает анкету (plan.html) в стартовый план приложения.
import { emptyState, DAYS, uid } from "../core.js";

export const mskToday = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);

export function formToState(f) {
  const s = emptyState();
  const clip = (x, n) => String(x ?? "").slice(0, n);
  s.name = clip(f.name, 40).trim();
  s.subjects = (f.subjects || []).slice(0, 8).map(x => ({ name: clip(x.name, 40), target: Number(x.target) || null, current: Number(x.current) || null }));
  const dayIdx = d => DAYS.indexOf(d);
  s.free = DAYS.map(d => {
    const x = (f.free || []).find(y => y.day === d) || {};
    return { off: !!x.off, from: clip(x.from, 5), to: clip(x.to, 5) };
  });
  const capMap = { "Меньше часа": 60, "1–2 часа": 120, "2–3 часа": 180, "3–4 часа": 240, "Больше 4 часов": 270 };
  s.dailyCapMin = capMap[f.choices?.selfHours?.[0]] || 180;
  const sess = f.choices?.session?.[0] || "";
  s.sessionMin = sess.startsWith("25") ? 25 : sess.startsWith("45") ? 45 : sess.startsWith("1 час") ? 50 : sess.startsWith("1,5") ? 50 : 25;
  s.lessons = (f.lessons || []).slice(0, 30).filter(l => l.subject || l.kind).map(l => ({
    id: uid("l"), subject: clip(l.subject, 40), title: clip((l.kind && l.kind !== "Другое" ? l.kind.replace("Вебинар онлайн-курса", "Вебинар") + ": " : "") + (l.subject || "Занятие"), 80),
    days: (l.days || []).map(dayIdx).filter(i => i >= 0), from: clip(l.from, 5), to: clip(l.to, 5), where: clip(l.where, 200),
  }));
  const today = mskToday();
  s.tasks = (f.deadlines || []).slice(0, 30).filter(d => d.date && d.date >= today).map(d => ({
    id: uid("t"), title: clip(`${(d.what || "Задание").trim() || "Задание"}${d.subject ? " — " + d.subject : ""}`.replace(/^дз/i, "ДЗ"), 100), subject: clip(d.subject, 40),
    kind: "ege", sessions: 2, done: 0, due: clip(d.date, 10), dueTime: clip(d.time, 5) || null, created: today,
  }));
  s.habits = [{ id: uid("h"), title: "Школьные задания", subject: "Школа", days: [0, 1, 2, 3, 4], sessions: 1 }];
  s.prefs = { bestTime: f.choices?.bestTime || [], remind: f.choices?.remindWhen || [] };
  s.created = today;
  return s;
}
