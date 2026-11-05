import { hasDb, redis } from "./_redis.js";
import { validU, loadState, saveState, readBody } from "./_store.js";
import { chat } from "./_giga.js";
import { applyActions, pushChat, DAYS_FULL, weekday, addDays, humanDate } from "../core.js";

// POST {u, message, today, now} — помощник понимает сообщение и правит план.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const b = readBody(req) || {};
  if (!validU(b.u)) return res.status(400).json({ error: "Неверная ссылка" });
  const message = String(b.message || "").trim().slice(0, 600);
  if (!message) return res.status(400).json({ error: "Пустое сообщение" });
  const today = /^\d{4}-\d{2}-\d{2}$/.test(b.today) ? b.today : new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  const now = /^\d{1,2}:\d{2}$/.test(b.now) ? b.now : "";

  const state = await loadState(b.u);
  if (!state) return res.status(404).json({ error: "План не найден" });

  const prompt = buildPrompt(state, today, now);
  const history = (state.chat || []).slice(-6).map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.role === "user" ? m.text : JSON.stringify({ reply: m.text, actions: [] }) }));
  let raw;
  try {
    const r = await chat([{ role: "system", content: prompt }, ...history, { role: "user", content: message }], { model: "GigaChat-2-Pro", temperature: 0.2, maxTokens: 900 });
    raw = r.text;
  } catch (e) {
    try {
      const r = await chat([{ role: "system", content: prompt }, ...history, { role: "user", content: message }], { model: "GigaChat-2", temperature: 0.2, maxTokens: 900 });
      raw = r.text;
    } catch (e2) {
      return res.status(502).json({ error: "Помощник сейчас недоступен. Попробуй через минуту." });
    }
  }
  let parsed = extractJson(raw);
  let repaired = null;
  if (!parsed) {
    // просим модель переписать свой ответ в правильный JSON
    try {
      const r = await chat([
        { role: "system", content: 'Перепиши текст пользователя в один валидный JSON вида {"reply":"...","actions":[...]}. Сохрани смысл и все действия. Только JSON, без пояснений и без markdown.' },
        { role: "user", content: raw.slice(0, 4000) },
      ], { model: "GigaChat-2", temperature: 0, maxTokens: 900 });
      repaired = r.text;
      parsed = extractJson(repaired);
    } catch {}
  }
  try {
    await redis("LPUSH", "giga_log", JSON.stringify({ at: new Date().toISOString(), today, now, message, raw: String(raw).slice(0, 3000), repaired: repaired && repaired.slice(0, 2000), ok: !!parsed }));
    await redis("LTRIM", "giga_log", 0, 29);
  } catch {}
  if (!parsed) {
    const fallback = "Не до конца поняла 🙈 Скажи чуть по-другому: что, к какому дню и по какому предмету?";
    pushChat(state, "user", message); pushChat(state, "assistant", fallback);
    state.rev = (state.rev || 0) + 1; await saveState(b.u, state);
    return res.status(200).json({ reply: fallback, changes: [], state });
  }

  const notes = [];
  const actions = prepareActions(parsed.actions, today, now, notes);
  const changes = applyActions(state, actions, today);
  let reply = String(parsed.reply || "").replace(/\{[\s\\n]*\}/g, " ").replace(/\\n/g, " ").replace(/\s{2,}/g, " ").replace(/["«»]\s*([^\p{L}\p{N}\s]{1,4})\s*["«»]/gu, "$1").replace(/"/g, "").trim().slice(0, 500) || (changes.length ? "Готово!" : "Окей!");
  if (!changes.length && /(вернул|убрал|добавил|постав|перенес|перенёс|отменил|восстанов|удалил|сдвинул|записал|запомнил)/i.test(reply)) {
    reply = "Хм, кажется, я ничего не поменяла 🙈 Скажи чуть по-другому — или поправь сама: нажми на занятие или задачу, либо открой раздел «Расписание».";
  }
  if (notes.length) reply = (reply ? reply + " " : "") + notes.join(" ");
  pushChat(state, "user", message);
  pushChat(state, "assistant", reply, changes.length ? { changes } : {});
  state.rev = (state.rev || 0) + 1;
  await saveState(b.u, state);
  res.status(200).json({ reply, changes, state });
}

const EXAM_RE = /(зач[её]т|контрольн|экзамен|пробник|тест|проверочн|самостоятельн)/i;

// Поправки к действиям модели: зачёты и контрольные считаем по дате самого события.
function prepareActions(actions, today, now, notes) {
  if (!Array.isArray(actions)) return [];
  const nowMin = now ? Number(now.split(":")[0]) * 60 + Number(now.split(":")[1]) : null;
  const night = nowMin != null && nowMin < 5 * 60;
  const out = [];
  for (const a of actions) {
    if (a && a.type === "add_task" && !a.exam_date && EXAM_RE.test(String(a.title || "")) && /подгот|повтор/i.test(String(a.title || "")) && a.due_date) {
      a.exam_date = a.due_date; delete a.due_date; delete a.due_time;
    }
    if (a && a.type === "add_task" && a.exam_date === today) {
      if (/^\d{1,2}:\d{2}$/.test(a.exam_time || "")) { a.due_date = today; a.due_time = a.exam_time; delete a.exam_date; }
      else if (night || nowMin == null || nowMin >= 8 * 60) {
        notes.push(night
          ? "Зачёт уже сегодня, поэтому большую подготовку в план не ставлю: лучше выспаться 😴 Утром перед выходом пробегись по главному минут 15."
          : "Зачёт уже сегодня — если до него есть время, пробегись по главному минут 15. Напиши, во сколько он, и я поставлю повторение прямо перед ним.");
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).replace(/```(?:json|JSON)?/g, "").replace(/[“”„]/g, '"').trim();
  const tries = [t];
  // первый сбалансированный объект {...}
  const a = t.indexOf("{");
  if (a >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let k = a; k < t.length; k++) {
      const ch = t[k];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { tries.push(t.slice(a, k + 1)); break; } }
    }
    const z = t.lastIndexOf("}");
    if (z > a) tries.push(t.slice(a, z + 1));
  }
  for (const c of tries) {
    for (const v of [c, c.replace(/\/\/[^\n"]*$/gm, "").replace(/,\s*([}\]])/g, "$1"), c.replace(/'/g, '"').replace(/,\s*([}\]])/g, "$1")]) {
      try { const o = JSON.parse(v); if (o && typeof o === "object" && !Array.isArray(o)) return { reply: o.reply ?? o.answer ?? "", actions: Array.isArray(o.actions) ? o.actions : [] }; } catch {}
    }
  }
  return null;
}

function buildPrompt(s, today, now) {
  const wd = weekday(today);
  const week = Array.from({ length: 8 }, (_, i) => { const d = addDays(today, i); return `${d} — ${DAYS_FULL[weekday(d)]}${i === 0 ? " (сегодня)" : i === 1 ? " (завтра)" : ""}`; }).join("\n");
  const nowMin = now ? Number(now.split(":")[0]) * 60 + Number(now.split(":")[1]) : 12 * 60;
  const night = nowMin < 5 * 60;
  const occ = [];
  for (let i = 0; i < 8; i++) {
    const d = addDays(today, i);
    for (const l of s.lessons) if (l.days.includes(weekday(d)) && !s.cancelled.some(c => c.lessonId === l.id && c.date === d))
      occ.push(`- ${d} (${DAYS_FULL[weekday(d)]}${i === 0 ? ", сегодня" : ""}): «${l.title}» ${l.from && l.to ? l.from + "–" + l.to : "время не указано"} → lesson_id=${l.id}`);
  }
  const cancelledList = s.cancelled.filter(c => c.date >= today).map(c => { const l = s.lessons.find(x => x.id === c.lessonId); return l ? `- ${c.date} (${DAYS_FULL[weekday(c.date)]}): «${l.title}» ОТМЕНЕНО → lesson_id=${l.id}` : ""; }).filter(Boolean).join("\n");
  const lessons = s.lessons.map(l => `- id=${l.id}: «${l.title}», ${l.days.map(d => DAYS_FULL[d]).join(", ")} ${l.from && l.to ? l.from + "–" + l.to : "(время не указано)"}`).join("\n") || "нет";
  const extra = s.extraLessons.filter(l => l.date >= today).map(l => `- event_id=${l.id}: «${l.title}» ${l.date} ${l.from}–${l.to}`).join("\n");
  const tasks = s.tasks.filter(t => t.done < t.sessions).map(t => `- id=${t.id}: «${t.title}» (${t.subject || "без предмета"}), осталось сессий ${t.sessions - t.done}, срок ${t.due ? t.due + (t.dueTime ? " " + t.dueTime : "") : "нет"}`).join("\n") || "нет";
  const subjects = s.subjects.map(x => `${x.name} (сейчас ${x.current ?? "?"}, цель ${x.target ?? "?"})`).join("; ");
  const free = s.free.map((f, i) => `${DAYS_FULL[i]}: ${f.off ? "выходной" : `${f.from}–${f.to}`}`).join("; ");
  return `Ты — заботливый помощник по подготовке к ЕГЭ для школьницы по имени ${s.name || "ученица"}. Общаешься на «ты», коротко, тепло, по-дружески, можно 1 эмодзи.
Твоя задача — понять сообщение и превратить его в правки плана. Время задач по часам расставляет программа сама, ты его не придумываешь.

Сегодня ${today} (${DAYS_FULL[wd]})${now ? ", сейчас " + now : ""}. Ближайшие дни:
${week}
${night ? `ВАЖНО: сейчас ночь, она ещё не спала. Когда она говорит «завтра», она имеет в виду ${today} (${DAYS_FULL[wd]}) — день, который начнётся после сна. «Послезавтра» = ${addDays(today, 1)}.` : ""}

Предметы: ${subjects}
Свободное время по дням: ${free}
Сессия = ${s.sessionMin} минут.
Регулярные занятия:
${lessons}
Занятия на ближайшие дни (для отмены бери отсюда lesson_id и дату):
${occ.join("\n") || "нет"}
${cancelledList ? "Уже отменённые занятия (вернуть — restore_lesson):\n" + cancelledList : ""}
${extra ? "Разовые занятия:\n" + extra : ""}
Незавершённые задачи:
${tasks}

Доступные действия (поле "type"):
- add_task: {"type":"add_task","title":"...","subject":"...","kind":"ege|school|other","sessions":число 1-20,"due_date":"YYYY-MM-DD или null","due_time":"HH:MM или null"}
  Оцени объём в сессиях по ${s.sessionMin} минут: школьная домашка 1-2, ДЗ курса 2-3, подготовка к зачёту/контрольной 3-4, доклад 3-6, пробник целиком 7-8.
  Если это зачёт/контрольная/экзамен/пробник в какой-то день — добавь поле "exam_date":"YYYY-MM-DD" (дата самого зачёта) и, если она сказала время, "exam_time":"HH:MM". due_date не указывай: программа сама поставит срок накануне.
- complete_task: {"type":"complete_task","task_id":"..."}
- delete_task: {"type":"delete_task","task_id":"..."}
- update_task: {"type":"update_task","task_id":"...","due_date":"...","due_time":"...","sessions":число}
- cancel_lesson: {"type":"cancel_lesson","lesson_id":"...","date":"YYYY-MM-DD"} — занятие в этот день отменили или «не надо». Это ЕДИНСТВЕННЫЙ способ убрать занятие.
- restore_lesson: {"type":"restore_lesson","lesson_id":"...","date":"YYYY-MM-DD"} — вернуть отменённое занятие («верни английский», «англ всё-таки будет»). Бери из списка отменённых.
- delete_event: {"type":"delete_event","event_id":"..."} — убрать разовое занятие/событие.
- add_lesson_once: {"type":"add_lesson_once","title":"...","subject":"...","date":"YYYY-MM-DD","from":"HH:MM","to":"HH:MM"}
- set_availability: {"type":"set_availability","date":"YYYY-MM-DD","from":"HH:MM","to":"HH:MM"} или {"type":"set_availability","date":"...","off":true} — ТОЛЬКО когда она сама говорит, во сколько свободна («сегодня свободна после 19», «в субботу уезжаю»). Не используй для отмены занятий.
- set_lesson_time: {"type":"set_lesson_time","lesson_id":"...","from":"HH:MM","to":"HH:MM"} — указать время регулярного занятия (если конец неизвестен — плюс 1,5 часа)
- learned_topic: {"type":"learned_topic","title":"название темы","subject":"..."} — она изучила тему, нужно поставить интервальные повторения
- tired: {"type":"tired","date":"YYYY-MM-DD"} — она устала и не хочет учиться сегодня
- not_tired: {"type":"not_tired","date":"YYYY-MM-DD"} — силы вернулись

Правила:
- «завтра», «в пятницу» и т.п. переводи в точные даты по списку выше.
- Если она говорит, что занятие (английский, вебинар) не нужно или отменили — cancel_lesson с lesson_id из списка «Занятия на ближайшие дни».
- Если она называет время занятия, у которого «время не указано» — set_lesson_time.
- Если она устала — действие tired, ответ мягкий, без упрёков, предложи совсем маленький шаг на 5 минут.
- Если она просто болтает или спрашивает совет — actions пустой, ответь по делу коротко.
- reply: 1–3 коротких предложения, что ты поменяла и почему. Не перечисляй время блоков. Без переносов строк и фигурных скобок в тексте.
- НИКОГДА не пиши «вернула/убрала/добавила», если в actions нет соответствующего действия. Если не знаешь, каким действием это сделать, — честно скажи, что не смогла, и предложи поправить в разделе «Расписание».
- Не создавай add_lesson_once, чтобы вернуть отменённое регулярное занятие, — для этого restore_lesson.

Отвечай СТРОГО одним JSON без пояснений вокруг:
{"reply":"...","actions":[...]}`;
}
