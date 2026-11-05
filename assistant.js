import { hasDb } from "./_redis.js";
import { validU, loadState, saveState, readBody } from "./_store.js";
import { chat } from "./_giga.js";
import { applyActions, DAYS_FULL, weekday, addDays, humanDate } from "../core.js";

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
  let raw;
  try {
    const r = await chat([{ role: "system", content: prompt }, { role: "user", content: message }], { model: "GigaChat-2-Pro", temperature: 0.2, maxTokens: 900 });
    raw = r.text;
  } catch (e) {
    try {
      const r = await chat([{ role: "system", content: prompt }, { role: "user", content: message }], { model: "GigaChat-2", temperature: 0.2, maxTokens: 900 });
      raw = r.text;
    } catch (e2) {
      return res.status(502).json({ error: "Помощник сейчас недоступен. Попробуй через минуту." });
    }
  }
  const parsed = extractJson(raw);
  if (!parsed) return res.status(200).json({ reply: "Не до конца поняла 🙈 Скажи чуть по-другому: что, к какому дню и по какому предмету?", changes: [], state });

  const changes = applyActions(state, parsed.actions, today);
  if (changes.length) {
    state.rev = (state.rev || 0) + 1;
    await saveState(b.u, state);
  }
  const reply = String(parsed.reply || "").replace(/["«»]\s*([^\p{L}\p{N}\s]{1,4})\s*["«»]/gu, "$1").replace(/"/g, "").trim().slice(0, 500) || (changes.length ? "Готово!" : "Окей!");
  res.status(200).json({ reply, changes, state });
}

function extractJson(text) {
  if (!text) return null;
  const t = text.replace(/```json|```/g, "");
  const a = t.indexOf("{"), z = t.lastIndexOf("}");
  if (a < 0 || z <= a) return null;
  try { return JSON.parse(t.slice(a, z + 1)); } catch { return null; }
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
  const lessons = s.lessons.map(l => `- id=${l.id}: «${l.title}», ${l.days.map(d => DAYS_FULL[d]).join(", ")} ${l.from && l.to ? l.from + "–" + l.to : "(время не указано)"}`).join("\n") || "нет";
  const extra = s.extraLessons.filter(l => l.date >= today).map(l => `- «${l.title}» ${l.date} ${l.from}–${l.to}`).join("\n");
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
${extra ? "Разовые занятия:\n" + extra : ""}
Незавершённые задачи:
${tasks}

Доступные действия (поле "type"):
- add_task: {"type":"add_task","title":"...","subject":"...","kind":"ege|school|other","sessions":число 1-20,"due_date":"YYYY-MM-DD или null","due_time":"HH:MM или null"}
  Оцени объём в сессиях по ${s.sessionMin} минут: школьная домашка 1-2, ДЗ курса 2-3, подготовка к зачёту/контрольной 3-4, доклад 3-6, пробник целиком 7-8.
  Если это зачёт/контрольная/экзамен/пробник в какой-то день — добавь поле "exam_date":"YYYY-MM-DD" (дата самого зачёта), а due_date не указывай: программа сама поставит срок накануне.
- complete_task: {"type":"complete_task","task_id":"..."}
- delete_task: {"type":"delete_task","task_id":"..."}
- update_task: {"type":"update_task","task_id":"...","due_date":"...","due_time":"...","sessions":число}
- cancel_lesson: {"type":"cancel_lesson","lesson_id":"...","date":"YYYY-MM-DD"} — занятие в этот день отменили или «не надо». Это ЕДИНСТВЕННЫЙ способ убрать занятие.
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
- reply: 1–3 коротких предложения, что ты поменяла и почему. Не перечисляй время блоков.

Отвечай СТРОГО одним JSON без пояснений вокруг:
{"reply":"...","actions":[...]}`;
}
