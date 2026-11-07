import { aiOverLimit } from "./_limits.js";
import { hasDb, redis } from "./_redis.js";
import { validU, loadState, saveState, readBody } from "./_store.js";
import { chat } from "./_giga.js";
import { applyActions, pushChat, DAYS_FULL, weekday, addDays, humanDate, parseDay } from "../core.js";

// POST {u, message, today, now} - помощник понимает сообщение и правит план.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (process.env.MOVED_TO) return res.status(410).json({ error: "Козя переехала на новый адрес - обнови приложение", movedTo: process.env.MOVED_TO.replace(/\/$/, "") });
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const b = readBody(req) || {};
  if (!validU(b.u)) return res.status(400).json({ error: "Неверная ссылка" });
  const message = String(b.message || "").trim().slice(0, 600);
  if (!message) return res.status(400).json({ error: "Пустое сообщение" });
  const today = /^\d{4}-\d{2}-\d{2}$/.test(b.today) ? b.today : new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  const now = /^\d{1,2}:\d{2}$/.test(b.now) ? b.now : "";

  let state = await loadState(b.u);
  if (!state) return res.status(404).json({ error: "План не найден" });
  // тревожное сообщение: отвечаем сами, бережно, без нейросети и без лимита
  const safe = safetyReply(message, state);
  if (safe) {
    pushChat(state, "user", message); pushChat(state, "assistant", safe);
    state.rev = (state.rev || 0) + 1; await saveState(b.u, state);
    await aiStat(today, "safety");
    return res.status(200).json({ reply: safe, changes: [], state });
  }
  if (await aiOverLimit(b.u)) { await aiStat(today, "limit"); return res.status(429).json({ error: "На сегодня я наговорилась 😴 Завтра продолжим. А план можно поправить руками." }); }

  const prompt = buildPrompt(state, today, now);
  const history = (state.chat || []).slice(-6).map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.role === "user" ? m.text : JSON.stringify({ reply: m.text, actions: [] }) }));
  const ask = await askModel(prompt, history, message);
  if (ask.down) { await aiStat(today, "down"); return res.status(502).json({ error: "Помощник сейчас недоступен. Попробуй через минуту." }); }
  const { raw, repaired } = ask;
  let parsed = ask.parsed;
  try {
    await redis("LPUSH", "giga_log", JSON.stringify({ at: new Date().toISOString(), today, now, message, raw: String(raw).slice(0, 3000), repaired: repaired && repaired.slice(0, 2000), ok: !!parsed }));
    await redis("LTRIM", "giga_log", 0, 29);
  } catch {}
  if (!parsed) {
    { const fresh = await loadState(b.u); if (fresh) state = fresh; }
    const fallback = "Не до конца поняла 🙈 Скажи чуть по-другому: что, к какому дню и по какому предмету?";
    await aiStat(today, "notjson", message);
    pushChat(state, "user", message); pushChat(state, "assistant", fallback);
    state.rev = (state.rev || 0) + 1; await saveState(b.u, state);
    return res.status(200).json({ reply: fallback, changes: [], state });
  }

  // пока помощник думал, план могли поменять (отметить сделанное) - применяем действия к свежей версии
  { const fresh = await loadState(b.u); if (fresh && fresh.rev !== state.rev) state = fresh; }
  const notes = [];
  const quizAct = Array.isArray(parsed.actions) ? parsed.actions.find(a => a && a.type === "start_quiz") : null;
  const quiz = quizAct ? { subject: quizAct.subject || null, topic: quizAct.topic || null, n: Math.max(3, Math.min(10, parseInt(quizAct.n) || 5)) } : null;
  const actions = prepareActions(parsed.actions, today, now, notes, message);
  const changes = applyActions(state, actions, today);
  let reply = cleanReply(parsed.reply) || (changes.length ? "Готово!" : "Окей!");
  let claimed = false;
  if (!changes.length && !quiz && /(вернул|верну|возвращ|убрал|убер|убира|добавл|добавил|постав|ставлю|перенес|перенёс|перенош|отмен|восстанов|удал|сдвин|запис|запомн)/i.test(reply)) {
    claimed = true;
    reply = `Хм, кажется, я ничего не поменяла 🙈 Скажи чуть по-другому - или поправь ${state.gender === "m" ? "сам" : "сама"}: нажми на занятие или задачу, либо открой раздел «Расписание».`;
  }
  if (notes.length) reply = (reply ? reply + " " : "") + notes.join(" ");
  await aiStat(today, changes.length ? "changed" : quiz ? "quiz" : claimed ? "claimed" : "talk", claimed ? message : null);
  pushChat(state, "user", message);
  pushChat(state, "assistant", reply, changes.length ? { changes } : {});
  state.rev = (state.rev || 0) + 1;
  await saveState(b.u, state);
  res.status(200).json({ reply, changes, state, quiz });
}

const EXAM_RE = /(зач[её]т|контрольн|экзамен|пробник|тест|проверочн|самостоятельн)/i;

// Поправки к действиям модели: зачёты и контрольные считаем по дате самого события.
// дни недели, названные в сообщении («сб пн и вт», «по вторникам»), по порядку от сегодня
function mentionedDays(message, today) {
  const words = String(message || "").toLowerCase().match(/[а-яё]+/g) || [];
  const DAY_RE = /^(пн|вт|ср|чт|пт|сб|вс|понедельник[а-я]*|вторник[а-я]*|сред(а|у|ы|е|ой|ам|ами|ах)|четверг[а-я]*|пятниц[а-я]*|суббот[а-я]*|воскресень[а-я]*)$/;
  const set = new Set(words.filter(w => DAY_RE.test(w)).map(parseDay).filter(x => x != null));
  return [...set].sort((a, b) => ((a - weekday(today) + 7) % 7) - ((b - weekday(today) + 7) % 7));
}
function prepareActions(actions, today, now, notes, message = "") {
  if (!Array.isArray(actions)) return [];
  // нейросеть путает числа и дни недели: если она прислала даты не на те дни, что назвала ученица, ставим по названным дням
  const days = mentionedDays(message, today);
  const once = actions.filter(a => a && a.type === "add_lesson_once" && !a.day && /^\d{4}-\d{2}-\d{2}$/.test(a.date || ""));
  if (days.length && once.length === days.length && once.some(a => !days.includes(weekday(a.date)))) {
    once.sort((x, y) => x.date.localeCompare(y.date)).forEach((a, i) => { a.day = days[i]; delete a.date; });
  }
  // назван ровно один день недели («к пятнице», «в понедельник зачёт»), а дата в действии на другой день - ставим ближайший такой день
  if (days.length === 1 && !/(завтра|сегодня|послезавтра|\d{1,2}[.\/]\d{1,2}|\d{1,2}\s+(январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр))/i.test(message)) {
    let d = today; for (let k = 0; k < 7 && weekday(d) !== days[0]; k++) d = addDays(d, 1);
    for (const a of actions) for (const f of ["date", "due_date", "exam_date"])
      if (a && a.type !== "tired" && a.type !== "not_tired" && a.type !== "learned_topic" && /^\d{4}-\d{2}-\d{2}$/.test(a[f] || "") && weekday(a[f]) !== days[0]) a[f] = d;
  }
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
          : "Зачёт уже сегодня - если до него есть время, пробегись по главному минут 15. Напиши, во сколько он, и я поставлю повторение прямо перед ним.");
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

// чистим ответ модели: без длинного тире, служебных слов и мусора
function cleanReply(text) {
  return String(text || "").replace(/\s*\u2014\s*/g, " - ").replace(/\s*\(?\b(?:lesson_id|task_id|topic_id|event_id|exam_id|id)\s*[=:]\s*[\w-]+\)?/gi, "").replace(/[^.!?\n]*\b(?:actions?|json)\b[^.!?\n]*[.!?]?/gi, "").replace(/\{[\s\\n]*\}/g, " ").replace(/\\n/g, " ").replace(/\s{2,}/g, " ").replace(/["«»]\s*([^\p{L}\p{N}\s]{1,4})\s*["«»]/gu, "$1").replace(/"/g, "").trim().slice(0, 500);
}

// мысли о смерти и самоповреждении - не отдаём нейросети, отвечаем бережно и даём телефон доверия
const RISK_RE = /(не\s+хочу\s+(больше\s+)?жить|не\s+хочется\s+жить|жить\s+не\s+хочется|хочу\s+умереть|хочется\s+умереть|лучше\s+(бы\s+)?(мне\s+)?умереть|покончить\s+с\s+собой|покончу\s+с\s+собой|убить\s+себя|убью\s+себя|суицид|самоубий|выпилиться|выпилюсь|роскомнадзорнуться|лучше\s+бы\s+меня\s+не\s+было|меня\s+не\s+должно\s+быть|(порезать|порезала|порезал|порежу|режу|резать)\s+(себя|себе|руки|вены)|(наношу|нанести|наносить|причиняю|причинить|причиню)\s+себе\s+(вред|боль|порез))/i;
function safetyReply(message, s) {
  const m = String(message || "").toLowerCase().replace(/ё/g, "е");
  if (!RISK_RE.test(m)) return null;
  const f = s.gender !== "m";
  return `Мне очень жаль, что тебе сейчас так тяжело 💛 Ты не ${f ? "одна" : "один"} с этим. Пожалуйста, расскажи кому-то из близких взрослых или позвони на Детский телефон доверия: 8-800-2000-122, бесплатно и круглосуточно, можно анонимно. Если прямо сейчас ты в опасности, звони 112. Учёба подождёт, сейчас важнее ты.`;
}

// счётчики для /stats: как справляется Козя (по дням) и последние неудачные сообщения
async function aiStat(day, field, message = null) {
  try {
    await redis("HINCRBY", `ai:day:${day}`, field, 1);
    await redis("EXPIRE", `ai:day:${day}`, 60 * 86400);
    if (message) { await redis("LPUSH", "ai:fails", JSON.stringify({ at: new Date().toISOString(), kind: field, message: String(message).slice(0, 200) })); await redis("LTRIM", "ai:fails", 0, 29); }
  } catch {}
}

// запрос к нейросети: Pro, при сбое обычная модель; если ответ не JSON - просим переписать
async function askModel(prompt, history, message) {
  const msgs = [{ role: "system", content: prompt }, ...history, { role: "user", content: message }];
  let raw;
  try { raw = (await chat(msgs, { model: "GigaChat-2-Pro", temperature: 0.2, maxTokens: 900 })).text; }
  catch { try { raw = (await chat(msgs, { model: "GigaChat-2", temperature: 0.2, maxTokens: 900 })).text; } catch { return { down: true }; } }
  let parsed = extractJson(raw), repaired = null;
  if (!parsed) {
    try {
      repaired = (await chat([
        { role: "system", content: 'Перепиши текст пользователя в один валидный JSON вида {"reply":"...","actions":[...]}. Сохрани смысл и все действия. Только JSON, без пояснений и без markdown.' },
        { role: "user", content: raw.slice(0, 4000) },
      ], { model: "GigaChat-2", temperature: 0, maxTokens: 900 })).text;
      parsed = extractJson(repaired);
    } catch {}
  }
  return { raw, repaired, parsed };
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
  const week = Array.from({ length: 8 }, (_, i) => { const d = addDays(today, i); return `${d} - ${DAYS_FULL[weekday(d)]}${i === 0 ? " (сегодня)" : i === 1 ? " (завтра)" : ""}`; }).join("\n");
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
  return `Ты - ${String(s.look?.name || "").trim().slice(0, 20) || (s.look?.char === "choco" ? "Шоколадка" : "Козя")}, заботливая помощница-козочка по подготовке к ЕГЭ для ${s.gender === "m" ? "школьника" : "школьницы"} по имени ${s.name || (s.gender === "m" ? "ученик" : "ученица")}. Никогда не используй длинное тире: вместо него запятая, двоеточие или обычный дефис «-». В reply никогда не пиши служебные слова и коды: id, lesson_id, task_id, actions, JSON - только обычный текст для ученика. Говоришь о себе в женском роде, ${s.gender === "m" ? "а к ученику обращаешься в МУЖСКОМ роде (сделал, устал, молодец) - даже там, где ниже в инструкции про пользователя написано «она»," : "к ученице обращаешься в женском роде,"} общаешься на «ты», коротко, тепло, по-дружески, можно 1 эмодзи.
Твоя задача - понять сообщение и превратить его в правки плана. Время задач по часам расставляет программа сама, ты его не придумываешь.

Сегодня ${today} (${DAYS_FULL[wd]})${now ? ", сейчас " + now : ""}. Ближайшие дни:
${week}
${night ? `ВАЖНО: сейчас ночь, она ещё не спала. Когда она говорит «завтра», она имеет в виду ${today} (${DAYS_FULL[wd]}) - день, который начнётся после сна. «Послезавтра» = ${addDays(today, 1)}.` : ""}

Предметы: ${subjects}
Свободное время по дням: ${free}
Сессия = ${s.sessionMin} минут.
Регулярные занятия:
${lessons}
Занятия на ближайшие дни (для отмены бери отсюда lesson_id и дату):
${occ.join("\n") || "нет"}
${cancelledList ? "Уже отменённые занятия (вернуть - restore_lesson):\n" + cancelledList : ""}
${extra ? "Разовые занятия:\n" + extra : ""}
Незавершённые задачи:
${tasks}
Темы на повторении: ${s.topics.map(t => `«${t.title}» (${t.subject})`).join(", ") || "нет"}
В базе знаний карточек: ${(s.cards || []).length}

Доступные действия (поле "type"):
- add_task: {"type":"add_task","title":"...","subject":"...","kind":"ege|school|other","sessions":число 1-20,"due_date":"YYYY-MM-DD или null","due_time":"HH:MM или null"}
  Оцени объём в сессиях по ${s.sessionMin} минут: школьная домашка 1-2, ДЗ курса 2-3, подготовка к зачёту/контрольной 3-4, доклад 3-6, пробник целиком 7-8.
  Если это зачёт/контрольная/экзамен/пробник в какой-то день - добавь поле "exam_date":"YYYY-MM-DD" (дата самого зачёта) и, если она сказала время, "exam_time":"HH:MM". due_date не указывай: программа сама поставит срок накануне.
- complete_task: {"type":"complete_task","task_id":"..."}
- delete_task: {"type":"delete_task","task_id":"..."}
- update_task: {"type":"update_task","task_id":"...","due_date":"...","due_time":"...","sessions":число}
- cancel_lesson: {"type":"cancel_lesson","lesson_id":"...","date":"YYYY-MM-DD"} - занятие в этот день отменили или «не надо». Это ЕДИНСТВЕННЫЙ способ убрать занятие.
- restore_lesson: {"type":"restore_lesson","lesson_id":"...","date":"YYYY-MM-DD"} - вернуть отменённое занятие («верни английский», «англ всё-таки будет»). Бери из списка отменённых.
- delete_event: {"type":"delete_event","event_id":"..."} - убрать разовое занятие/событие.
- add_cards: {"type":"add_cards","subject":"...","topic":"название темы или null","cards":[{"q":"вопрос","a":"ответ"}]} - когда она просит запомнить факт/термин/дату («запомни: ...», «добавь в карточки ...»). Сформулируй вопрос сама.
- start_quiz: {"type":"start_quiz","subject":"предмет или null","topic":"тема или null","n":число 3-10} - когда она просит её поспрашивать/проверить («спроси меня по истории», «погоняй по терминам»).
- add_lesson: {"type":"add_lesson","title":"...","subject":"...","days":["пн","вт"],"from":"HH:MM","to":"HH:MM"} - РЕГУЛЯРНОЕ занятие каждую неделю (репетитор, курс, вебинары, «занятия по понедельникам и вторникам», «в расписание»). days - коды дней: пн, вт, ср, чт, пт, сб, вс. Если конец не назван, "to" не пиши.
- add_lesson_once: {"type":"add_lesson_once","title":"...","subject":"...","day":"вт","from":"HH:MM","to":"HH:MM"} - РАЗОВОЕ занятие. Если она назвала день недели («во вторник»), пиши "day" кодом дня, а не дату: программа сама найдёт ближайший такой день. Если назвала число или «завтра» - пиши "date":"YYYY-MM-DD". Для нескольких дней - несколько действий. Если конец не назван, "to" не пиши.
- set_availability: {"type":"set_availability","date":"YYYY-MM-DD","from":"HH:MM","to":"HH:MM"} или {"type":"set_availability","date":"...","off":true} - ТОЛЬКО когда она сама говорит, во сколько свободна («сегодня свободна после 19», «в субботу уезжаю»). Не используй для отмены занятий.
- set_lesson_time: {"type":"set_lesson_time","lesson_id":"...","from":"HH:MM","to":"HH:MM"} - указать время регулярного занятия (если конец неизвестен - плюс 1,5 часа)
- learned_topic: {"type":"learned_topic","title":"название темы","subject":"..."} - она изучила тему, нужно поставить интервальные повторения
- tired: {"type":"tired","date":"YYYY-MM-DD"} - она устала и не хочет учиться сегодня
- not_tired: {"type":"not_tired","date":"YYYY-MM-DD"} - силы вернулись

Правила:
- «завтра», «послезавтра», числа переводи в точные даты по списку выше. Дни недели для занятий передавай кодом (пн, вт…) в "day" или "days".
- «на 19», «с 19», «в 7 вечера» - это время 19:00, а не число месяца.
- Если не сказано «только на этой неделе» или «один раз», занятия по дням недели (вебинары, репетитор, курсы) считай регулярными: add_lesson.
- Если она говорит, что занятие (английский, вебинар) не нужно или отменили - cancel_lesson с lesson_id из списка «Занятия на ближайшие дни».
- Если она называет время занятия, у которого «время не указано» - set_lesson_time.
- Если она устала - действие tired, ответ мягкий, без упрёков, предложи совсем маленький шаг на 5 минут.
- Если она просто болтает или спрашивает совет - actions пустой, ответь по делу коротко.
- Если она пишет, что ей очень плохо, что не хочет жить, думает о смерти или хочет причинить себе вред (даже намёком) - actions пустой, план не трогай, ответь очень бережно и обязательно дай Детский телефон доверия 8-800-2000-122 (бесплатно, круглосуточно) и 112, если опасно прямо сейчас. Шутки вроде «ЕГЭ меня убьёт» - это не про это, отвечай как обычно.
- Не переспрашивай про число сессий, длительность или конец занятия: оцени сама и сразу добавь. Переспрашивай, только если непонятно, ЧТО добавить.
- reply: 1–3 коротких предложения, что ты поменяла и почему. Не перечисляй время блоков. Без переносов строк и фигурных скобок в тексте.
- НИКОГДА не пиши «вернула/убрала/добавила», если в actions нет соответствующего действия. Если не знаешь, каким действием это сделать, - честно скажи, что не смогла, и предложи поправить в разделе «Расписание».
- Не создавай add_lesson_once, чтобы вернуть отменённое регулярное занятие, - для этого restore_lesson.

Отвечай СТРОГО одним JSON без пояснений вокруг:
{"reply":"...","actions":[...]}`;
}

// для проверки Кози на наборе фраз (deploy/giga-eval.js)
export { buildPrompt, prepareActions, extractJson, askModel, cleanReply, safetyReply };
