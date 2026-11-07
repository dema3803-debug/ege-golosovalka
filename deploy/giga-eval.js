// Экзамен для Кози: прогоняет типичные просьбы через GigaChat и проверяет, что план поменялся правильно.
// Запуск на сервере (ключ GigaChat берётся из /etc/kozya.env, в вывод не попадает):
//   cd /opt/kozya && set -a && . /etc/kozya.env && set +a && node deploy/giga-eval.js
// Только часть проверок: node deploy/giga-eval.js 1,2,5
// Настоящие планы пользователей не трогаются: всё происходит на тестовом плане в памяти.
import { chat } from "../api/_giga.js";
import { buildPrompt, prepareActions, extractJson } from "../api/assistant.js";
import { emptyState, applyActions, lessonsOn, toMin } from "../core.js";

function base() {
  const s = emptyState();
  Object.assign(s, { name: "Вера", gender: "f", sessionMin: 25 });
  s.subjects = ["Обществознание", "История", "Английский", "Русский язык"].map(name => ({ name, current: 60, target: 85 }));
  s.lessons = [{ id: "l1", title: "Репетитор по обществу", subject: "Обществознание", days: [1, 3], from: "17:00", to: "18:30", where: "" }];
  s.tasks = [{ id: "t1", title: "ДЗ по истории", subject: "История", kind: "school", sessions: 2, done: 0, due: null, dueTime: null, created: "2026-11-01" }];
  return s;
}
const at = (s, date, re, from) => lessonsOn(s, date).some(l => re.test(l.title + " " + (l.subject || "")) && (from == null || l.from === toMin(from)));
const fail = m => m;

const SAT = "2026-11-07", WED = "2026-11-11";
const CASES = [
  { msg: "Добавь в план вебинар по Английскому на 19 сб пн и вт", today: SAT,
    check: s => [["2026-11-07", 1], ["2026-11-08", 0], ["2026-11-09", 1], ["2026-11-10", 1], ["2026-11-11", 0]].every(([d, y]) => at(s, d, /англ/i, "19:00") === !!y) || fail("ожидала английский в 19:00 в сб 7, пн 9, вт 10 и не в вс 8, ср 11") },
  { msg: "Добавь в расписание занятия по Английскому вторник понедельник с 19-20", today: SAT,
    check: s => { const l = s.lessons.find(x => /англ/i.test(x.title + x.subject)); return (l && l.days.join() === "0,1" && l.from === "19:00" && l.to === "20:00") || fail("ожидала регулярное занятие пн, вт 19:00-20:00"); } },
  { msg: "репетитора по обществу в этот вторник не будет", today: SAT,
    check: s => (s.cancelled.some(c => c.lessonId === "l1" && c.date === "2026-11-10") && s.cancelled.length === 1) || fail("ожидала отмену репетитора 10 ноября (вт)") },
  { msg: "верни репетитора во вторник, всё-таки будет", today: SAT, setup: s => s.cancelled.push({ lessonId: "l1", date: "2026-11-10" }),
    check: s => !s.cancelled.length || fail("ожидала, что отмена 10 ноября снята") },
  { msg: "нужно написать эссе по обществу к пятнице", today: SAT,
    check: s => { const t = s.tasks.find(x => x.id !== "t1"); return (t && /общ/i.test(t.subject + t.title) && t.due === "2026-11-13") || fail("ожидала задачу по обществу со сроком 13 ноября (пт)" + (t ? `, а срок ${t.due}` : "")); } },
  { msg: "в понедельник у меня зачёт по истории в 10 утра", today: SAT,
    check: s => { const t = s.tasks.find(x => x.id !== "t1"); return (t && /истор/i.test(t.subject + t.title) && t.due === "2026-11-08") || fail("ожидала подготовку к зачёту по истории со сроком 8 ноября (накануне)" + (t ? `, а срок ${t.due}` : "")); } },
  { msg: "сил вообще нет сегодня", today: SAT, check: s => !!s.tired[SAT] || fail("ожидала режим «сил нет» на сегодня") },
  { msg: "привет! как дела?", today: SAT, check: (s, ch) => !ch.length || fail("ожидала, что ничего не поменяется") },
  { msg: "запомни: Конституция РФ принята 12 декабря 1993 года", today: SAT, check: s => s.cards.length >= 1 || fail("ожидала новую карточку") },
  { msg: "в понедельник свободна только после 18", today: SAT, check: s => s.avail["2026-11-09"]?.from === "18:00" || fail("ожидала свободное время 9 ноября с 18:00") },
  { msg: "в пятницу вебинар по русскому с 18 до 19:30, только один раз", today: WED,
    check: s => (at(s, "2026-11-13", /рус/i, "18:00") && !s.lessons.some(l => /рус/i.test(l.title + l.subject))) || fail("ожидала разовый вебинар 13 ноября (пт) 18:00, не регулярный") },
  { msg: "по средам и пятницам у меня теперь курс по истории в 16:00", today: WED,
    check: s => { const l = s.lessons.find(x => /истор/i.test(x.title + x.subject)); return (l && l.days.join() === "2,4" && l.from === "16:00") || fail("ожидала регулярный курс ср, пт с 16:00"); } },
];

const only = (process.argv[2] || "").split(",").map(Number).filter(Boolean);
let ok = 0, n = 0;
for (const [i, c] of CASES.entries()) {
  if (only.length && !only.includes(i + 1)) continue;
  n++;
  const s = base(); c.setup?.(s);
  const msgs = [{ role: "system", content: buildPrompt(s, c.today, c.now || "15:40") }, { role: "user", content: c.msg }];
  let raw = "", parsed = null, err = "";
  try { raw = (await chat(msgs, { model: "GigaChat-2-Pro", temperature: 0.2, maxTokens: 900 })).text; parsed = extractJson(raw); }
  catch (e) { err = e.message; }
  const notes = [];
  const acts = parsed ? prepareActions(parsed.actions, c.today, c.now || "15:40", notes, c.msg) : [];
  const changes = parsed ? applyActions(s, acts, c.today) : [];
  const res = err ? "ошибка связи: " + err : !parsed ? "ответ не JSON" : c.check(s, changes);
  if (res === true) ok++;
  console.log(`${res === true ? "✅" : "❌"} ${i + 1}. «${c.msg}» (сегодня ${c.today})`);
  if (res !== true) {
    console.log(`   что не так: ${res}`);
    console.log(`   ответ Кози: ${parsed?.reply || "-"}`);
    console.log(`   действия нейросети: ${JSON.stringify(parsed?.actions || []).slice(0, 500)}`);
    console.log(`   что изменилось: ${changes.join("; ") || "ничего"}`);
  }
}
console.log(`\nИтог: ${ok} из ${n}`);
