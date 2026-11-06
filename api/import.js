import { aiOverLimit } from "./_limits.js";
import crypto from "node:crypto";
import { hasDb, redis } from "./_redis.js";
import { validU, loadState, readBody } from "./_store.js";
import { chat, uploadImage } from "./_giga.js";
import { DAYS_FULL, weekday, addDays } from "../core.js";
import { mskToday } from "./_fromForm.js";

// Импорт расписания онлайн-школы: POST {u, text?, images?: ["data:image/jpeg;base64,..."]}
// Разбор идёт в фоне: POST сразу отвечает {job}, телефон спрашивает GET ?u=&job= пока не будет готово.
// Ничего не сохраняет в план — возвращает найденное, человек сам отмечает, что добавить.
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const hhmm = t => { const m = String(t || "").match(/^(\d{1,2})[:.](\d{2})$/); if (!m) return ""; const v = `${m[1].padStart(2, "0")}:${m[2]}`; return TIME.test(v) ? v : ""; };
const plus = (t, min) => { const [h, m] = t.split(":").map(Number); const x = Math.min(h * 60 + m + min, 1439); return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; };

export function matchSubject(name, subjects) {
  const n = clip(name, 40).toLowerCase();
  if (!n) return "";
  const list = subjects.map(s => s.name);
  const hit = list.find(s => s.toLowerCase() === n)
    || list.find(s => s.toLowerCase().startsWith(n.slice(0, 5)) || n.startsWith(s.toLowerCase().slice(0, 5)))
    || (/общ/.test(n) && list.find(s => /общ/i.test(s))) || (/англ/.test(n) && list.find(s => /англ/i.test(s)))
    || (/мат/.test(n) && list.find(s => /мат/i.test(s))) || (/рус/.test(n) && list.find(s => /рус/i.test(s)));
  return hit || clip(name, 40);
}

export function normalize(j, subjects, today) {
  const max = addDays(today, 200);
  const out = { lessons: [], events: [], deadlines: [] };
  for (const l of (Array.isArray(j?.lessons) ? j.lessons : []).slice(0, 30)) {
    const days = [...new Set((Array.isArray(l.days) ? l.days : []).map(Number).filter(d => d >= 0 && d <= 6))].sort();
    const from = hhmm(l.from); if (!days.length || !from) continue;
    out.lessons.push({ title: clip(l.title, 80) || "Вебинар", subject: matchSubject(l.subject, subjects), days, from, to: hhmm(l.to) || plus(from, 90), where: clip(l.where, 200) });
  }
  for (const e of (Array.isArray(j?.events) ? j.events : []).slice(0, 60)) {
    const from = hhmm(e.from); if (!DATE.test(e.date || "") || e.date < today || e.date > max || !from) continue;
    out.events.push({ title: clip(e.title, 80) || "Вебинар", subject: matchSubject(e.subject, subjects), date: e.date, from, to: hhmm(e.to) || plus(from, 90), where: clip(e.where, 200) });
  }
  for (const d of (Array.isArray(j?.deadlines) ? j.deadlines : []).slice(0, 60)) {
    if (!DATE.test(d.date || "") || d.date < today || d.date > max) continue;
    out.deadlines.push({ title: clip(d.title, 100) || "Домашнее задание", subject: matchSubject(d.subject, subjects), date: d.date, time: hhmm(d.time) || null });
  }
  out.events.sort((a, b) => (a.date + a.from).localeCompare(b.date + b.from));
  out.deadlines.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function parse(text) {
  const t = String(text || "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), z = t.lastIndexOf("}");
  if (a < 0 || z <= a) return null;
  try { return JSON.parse(t.slice(a, z + 1)); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  if (req.method === "GET") {
    const { u, job } = req.query;
    if (!validU(u) || !/^[a-f0-9]{16}$/.test(String(job || ""))) return res.status(400).json({ error: "Неверная ссылка" });
    const raw = await redis("GET", `job:${u}:${job}`);
    if (!raw) return res.status(404).json({ status: "error", error: "Разбор потерялся. Попробуй ещё раз." });
    return res.status(200).json(JSON.parse(raw));
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Только GET и POST" });
  const b = readBody(req) || {};
  if (!validU(b.u)) return res.status(400).json({ error: "Неверная ссылка" });
  const state = await loadState(b.u);
  if (!state) return res.status(404).json({ error: "План не найден" });
  const text = String(b.text || "").slice(0, 12000).trim();
  const images = (Array.isArray(b.images) ? b.images : []).slice(0, 4).map(x => String(x).match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/)).filter(Boolean);
  if (!text && !images.length) return res.status(400).json({ error: "Вставь текст расписания или прикрепи скриншот." });
  if (await aiOverLimit(b.u)) return res.status(429).json({ error: "На сегодня я наговорилась 😴 Завтра продолжим." });

  const job = crypto.randomBytes(8).toString("hex"), key = `job:${b.u}:${job}`;
  await redis("SET", key, JSON.stringify({ status: "work" }), "EX", 900);
  runImport(state, text, images).then(
    found => redis("SET", key, JSON.stringify({ status: "done", ...found }), "EX", 900),
    e => redis("SET", key, JSON.stringify({ status: "error", error: e.message }), "EX", 900),
  ).catch(() => {});
  res.status(200).json({ job });
}

async function runImport(state, text, images) {
  const t0 = Date.now();
  const today = mskToday();
  const subjects = state.subjects || [];
  const sys = `Ты разбираешь расписание онлайн-школы подготовки к ЕГЭ (Умскул, Вебиум, 100балльный, Lomonosov School, Фоксфорд, репетитор и т.п.) и переводишь его в план школьницы.
Сегодня ${today}, ${DAYS_FULL[weekday(today)]}. Её предметы: ${subjects.map(s => s.name).join(", ") || "не указаны"}.
Разложи всё, что найдёшь, на три списка:
• lessons — то, что повторяется каждую неделю в один и тот же день и время (например «вебинары по истории по вторникам в 18:00»). days — номера дней недели: 0 = понедельник … 6 = воскресенье.
• events — разовые вебинары, занятия, пробники с конкретной датой.
• deadlines — сроки сдачи: домашки, рабочие тетради, пробники, «дедлайн до …».
Обязательно учти КАЖДЫЙ день расписания, ничего не пропускай. Если у видеоурока, разбора (например «разборы: тесты блока…»), лекции или практики нет времени — это не вебинар, а дело на этот день: положи в deadlines с этой датой и title «Посмотреть: …» или «Разбор: …» (time пустое). Домашнее задание со сроком «дедлайн д/з … в 23:55» — в deadlines именно на дату дедлайна. Объявления вроде «выход тестов», «выход нового д/з», «начало/завершение недели» пропускай. Практики, вебинары и созвоны со временем («в 17:00 по мск») — в events.
Правила: даты пиши как ГГГГ-ММ-ДД; если год не указан — бери ближайшую будущую дату. Время по Москве в формате ЧЧ:ММ; если указан другой часовой пояс — переведи в московский. Если конец занятия не указан — оставь to пустым. Прошедшие даты пропускай. subject — предмет из её списка, если подходит. title — коротко, как в расписании («Вебинар: Право», «ДЗ №5»). where — ссылка или платформа, если есть. Не выдумывай ничего, чего нет в расписании.
Ответь строго JSON без пояснений: {"lessons":[{"title":"","subject":"","days":[1],"from":"18:00","to":"","where":""}],"events":[{"title":"","subject":"","date":"2026-11-12","from":"18:00","to":"","where":""}],"deadlines":[{"title":"","subject":"","date":"2026-11-15","time":"23:59"}]}`;
  try {
    // Шаг 1: каждую картинку — в текст (модель с картинкой и без системной инструкции читает надёжнее)
    let all = text ? `Расписание:\n${text}` : "";
    for (const [k, m] of images.entries()) {
      const up = await uploadImage(Buffer.from(m[2], "base64"), m[1]);
      const ask = [{ role: "user", attachments: [up.id], content: `Это расписание занятий школьника. Перепиши его в текст очень аккуратно.
Если это календарь-таблица с клетками по датам — иди по клеткам по порядку и для КАЖДОЙ клетки пиши отдельную строку:
ДД.ММ (день недели): пункт 1; пункт 2; пункт 3
Время пиши как на картинке, например 17:00 или 23:55 (не путай двоеточие с цифрами). Пустые клетки пропускай.
Если это список или таблица — переписывай построчно, сохраняя даты, дни недели, время и предметы.
В начале одной строкой укажи заголовок/предмет, если он есть. Ничего не выдумывай и не объясняй.` }];
      let tr;
      try { tr = await chat(ask, { model: "GigaChat-2-Max", temperature: 0, maxTokens: 3000, timeout: 90000, base: up.base }); }
      catch (e) { console.log("import: Max недоступна, беру Pro:", e.message.slice(0, 120)); tr = await chat(ask, { model: "GigaChat-2-Pro", temperature: 0, maxTokens: 3000, timeout: 90000, base: up.base }); }
      const t = String(tr.text || "").trim();
      console.log(`import: скриншот ${k + 1} → текст (${t.length} симв., ${tr.model || ""}): ${t.replace(/\s+/g, " ").slice(0, 600)}`);
      if (t.length > 15) all += `\n\nСкриншот ${k + 1}:\n${t.slice(0, 6000)}`;
    }
    if (!all.trim()) throw new Error("пустая расшифровка");
    // Шаг 2: текст — в занятия, вебинары и дедлайны
    const user = { role: "user", content: all };
    let r;
    try { r = await chat([{ role: "system", content: sys }, user], { model: "GigaChat-2-Pro", temperature: 0, maxTokens: 3000, timeout: 60000 }); }
    catch { r = await chat([{ role: "system", content: sys }, user], { model: "GigaChat-2", temperature: 0, maxTokens: 3000, timeout: 60000 }); }
    const found = normalize(parse(r.text), subjects, today);
    console.log(`import: ${Date.now() - t0} мс, скриншотов ${images.length}, найдено ${found.lessons.length}/${found.events.length}/${found.deadlines.length}`);
    if (!found.lessons.length && !found.events.length && !found.deadlines.length) console.log(`import: ответ модели (${r.base}): ${String(r.text).replace(/\s+/g, " ").slice(0, 400)}`);
    return found;
  } catch (e) {
    console.error(`import: ошибка через ${Date.now() - t0} мс:`, e.message);
    throw new Error(images.length ? "Козя пока не умеет читать скриншоты. Скопируй текст с картинки: открой скриншот в «Фото», нажми на текст и держи → «Выбрать все» → «Скопировать», потом вставь сюда в поле для текста." : "Козя сейчас не может разобрать расписание. Попробуй через пару минут.");
  }
}
