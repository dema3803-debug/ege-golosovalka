// Общая логика приложения: даты, раскладка задач по окнам, повторения, применение правок.
// Используется и на сайте (в браузере), и на сервере (помощник).

export const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
export const DAYS_FULL = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
export const INTERVALS = [1, 3, 7, 14, 30, 60]; // дни между повторениями темы
export const REVIEW_MIN = 10;
export const MAX_REVIEWS_PER_DAY = 4;
export const BREAK_MIN = 5;

// ---------- даты и время ----------
export const toMin = t => { if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null; const [h, m] = t.split(":").map(Number); return h * 60 + m; };
export const toHHMM = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const parseDate = s => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const fmtDate = d => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = parseDate(s); d.setUTCDate(d.getUTCDate() + n); return fmtDate(d); };
export const weekday = s => (parseDate(s).getUTCDay() + 6) % 7; // 0 = понедельник
export const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export const humanDate = s => { const d = parseDate(s); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
export const uid = (p = "") => p + Math.random().toString(36).slice(2, 9);

// ---------- состояние ----------
export function emptyState() {
  return {
    v: 1, rev: 0, name: "", subjects: [],
    free: DAYS.map(() => ({ off: false, from: "15:00", to: "21:00" })),
    sessionMin: 25, dailyCapMin: 240, capFactor: 1,
    lessons: [], extraLessons: [], cancelled: [], avail: {},
    tasks: [], habits: [], topics: [], tired: {}, log: {}, chat: [],
  };
}

function dayIsOff(state, date) {
  const a = state.avail[date];
  if (a && a.off) return true;
  if (a && a.from) return false;
  return !!state.free[weekday(date)]?.off;
}
function dayWindow(state, date) {
  const a = state.avail[date];
  const f = state.free[weekday(date)] || {};
  return { from: toMin(a?.from) ?? toMin(f.from), to: toMin(a?.to) ?? toMin(f.to) };
}

export function lessonsOn(state, date) {
  const wd = weekday(date);
  const out = [];
  for (const l of state.lessons) {
    if (!l.days.includes(wd)) continue;
    if (state.cancelled.some(c => c.lessonId === l.id && c.date === date)) continue;
    out.push({ ...l, from: toMin(l.from), to: toMin(l.to) });
  }
  for (const l of state.extraLessons) if (l.date === date) out.push({ ...l, from: toMin(l.from), to: toMin(l.to) });
  return out;
}

// вычесть занятые интервалы из окна
function subtract(win, busy) {
  let free = [win];
  for (const b of busy) {
    const next = [];
    for (const f of free) {
      if (b.to <= f.from || b.from >= f.to) { next.push(f); continue; }
      if (b.from > f.from) next.push({ from: f.from, to: b.from });
      if (b.to < f.to) next.push({ from: b.to, to: f.to });
    }
    free = next;
  }
  return free.filter(f => f.to - f.from >= 10).sort((a, b) => a.from - b.from);
}

// Сколько дней с самостоятельной работой есть с date до due включительно
function workDaysLeft(state, date, due) {
  let n = 0;
  for (let d = date; d <= due && n < 60; d = addDays(d, 1)) if (!dayIsOff(state, d)) n++;
  return Math.max(1, n);
}

/**
 * Раскладывает задачи и повторения на nDays дней начиная с today.
 * nowMin — текущее время в минутах (для сегодняшнего дня план строится от «сейчас»).
 */
export function buildPlan(state, today, nDays = 7, nowMin = null) {
  const remaining = {};
  for (const t of state.tasks) remaining[t.id] = Math.max(0, t.sessions - t.done);
  const reviewPlaced = new Set();
  const days = [];
  const S = state.sessionMin || 25;

  for (let i = 0; i < nDays; i++) {
    const date = addDays(today, i);
    const wd = weekday(date);
    const isToday = i === 0;
    const lessons = lessonsOn(state, date);
    const timed = lessons.filter(l => l.from != null && l.to != null);
    const notes = lessons.filter(l => l.from == null || l.to == null);
    const done = (state.log[date] || []).map(x => ({ ...x, type: "done", start: toMin(x.start), end: toMin(x.end) }));
    const tired = !!state.tired[date];
    const off = dayIsOff(state, date);
    const blocks = timed.map(l => ({ type: "lesson", start: l.from, end: l.to, title: l.title, subject: l.subject, ref: l.id }));
    blocks.push(...done.filter(d => d.start != null));
    const unplaced = [];
    let freeLeft = [];

    // задачи, которые она сама поставила на конкретное время
    const pinned = [];
    for (const t of state.tasks) {
      if (!t.pin || t.pin.date !== date || remaining[t.id] <= 0) continue;
      let at = toMin(t.pin.from); if (at == null) continue;
      while (remaining[t.id] > 0 && at + S <= 24 * 60) {
        pinned.push({ type: "task", len: S, title: t.title, subject: t.subject, ref: t.id, due: t.due, dueTime: t.dueTime, pinned: true, start: at, end: at + S });
        remaining[t.id]--; at += S + BREAK_MIN;
      }
    }
    blocks.push(...pinned);

    if (!off && !tired) {
      const win = dayWindow(state, date);
      if (win.from != null && win.to != null) {
        // отменённое занятие освобождает своё время, если оно рядом со свободным окном
        for (const c of state.cancelled.filter(c => c.date === date)) {
          const l = state.lessons.find(x => x.id === c.lessonId);
          const f = toMin(l?.from), t = toMin(l?.to);
          if (f == null || t == null) continue;
          if (f <= win.to + 30 && t >= win.from - 30) { win.from = Math.min(win.from, f); win.to = Math.max(win.to, t); }
        }
        if (isToday && nowMin != null) win.from = Math.max(win.from, Math.ceil(nowMin / 5) * 5);
        const busy = [...timed.map(l => ({ from: l.from - 0, to: l.to + 15 })), ...done.filter(d => d.start != null).map(d => ({ from: d.start, to: d.end })), ...pinned.map(p => ({ from: p.start, to: p.end + BREAK_MIN }))];
        const slots = win.to > win.from ? subtract(win, busy) : [];
        const doneMin = done.reduce((s, d) => s + Math.max(0, (d.end ?? 0) - (d.start ?? 0)), 0);
        let cap = Math.round((state.dailyCapMin || 240) * (state.capFactor || 1)) - doneMin - pinned.reduce((a, p) => a + p.len, 0);

        const queue = [];
        // 1) повторения тем
        const doneRefs = new Set((state.log[date] || []).map(x => x.ref));
        const dueTopics = state.topics.filter(t => t.next && t.next <= date && !reviewPlaced.has(t.id) && !doneRefs.has(t.id))
          .sort((a, b) => a.next.localeCompare(b.next)).slice(0, MAX_REVIEWS_PER_DAY);
        for (const t of dueTopics) queue.push({ type: "review", len: REVIEW_MIN, title: t.title, subject: t.subject, ref: t.id, step: t.step, overdue: t.next < date });
        // 2) ежедневные школьные задания
        for (const h of state.habits) {
          if (!h.days.includes(wd) || doneRefs.has(h.id)) continue;
          for (let k = 0; k < (h.sessions || 1); k++) queue.push({ type: "habit", len: S, title: h.title, subject: h.subject, ref: h.id });
        }
        // 3) задачи по срочности
        const active = state.tasks.filter(t => remaining[t.id] > 0 && !(t.skip || []).includes(date) && !(t.pin && t.pin.date > date))
          .map(t => ({ t, due: t.due || addDays(date, 14) }))
          .sort((a, b) => a.due.localeCompare(b.due) || (a.t.created || "").localeCompare(b.t.created || ""));
        for (const { t, due } of active) {
          const overdue = due < date;
          const must = due <= date;
          const quota = must ? remaining[t.id] : Math.ceil(remaining[t.id] / workDaysLeft(state, date, due));
          for (let k = 0; k < quota; k++) queue.push({ type: "task", len: S, title: t.title, subject: t.subject, ref: t.id, due: t.due, dueTime: t.dueTime, overdue, must });
        }

        // раскладка по свободным окнам
        let si = 0, cursor = slots[0]?.from;
        for (const q of queue) {
          if (cap < q.len && !q.must) { if (q.type === "task") unplaced.push(q); continue; }
          let placed = false;
          while (si < slots.length) {
            const s = slots[si];
            if (cursor < s.from) cursor = s.from;
            const limit = q.type === "task" && q.due === date && q.dueTime ? Math.min(s.to, toMin(q.dueTime)) : s.to;
            if (cursor + q.len <= limit) {
              blocks.push({ ...q, start: cursor, end: cursor + q.len });
              cursor += q.len + BREAK_MIN; cap -= q.len; placed = true;
              if (q.type === "task") remaining[q.ref]--;
              if (q.type === "review") reviewPlaced.add(q.ref);
              break;
            }
            if (limit < s.to) break; // дедлайн раньше конца окна — дальше не влезет
            si++; cursor = slots[si]?.from;
          }
          if (!placed && q.type === "task") unplaced.push(q);
        }
        freeLeft = win.to > win.from ? subtract(win, blocks.map(x => ({ from: x.start, to: x.end + (x.type === "lesson" ? 15 : BREAK_MIN) }))).filter(f => f.to - f.from >= 30) : [];
      }
    }
    blocks.sort((a, b) => a.start - b.start);
    days.push({ date, wd, isToday, off, tired, blocks, notes, freeLeft, unplaced: dedupe(unplaced.filter(q => q.must)) });
  }
  return days;
}
function dedupe(list) {
  const m = new Map();
  for (const q of list) m.set(q.ref, { ...q, count: (m.get(q.ref)?.count || 0) + 1 });
  return [...m.values()];
}

// склеить подряд идущие сессии одной задачи в один блок
export function mergeBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    const p = out[out.length - 1];
    if (p && p.type === b.type && (b.type === "task" || b.type === "habit") && p.ref === b.ref && b.start - p.end <= BREAK_MIN) {
      p.end = b.end; p.count = (p.count || 1) + 1;
    } else out.push({ ...b, count: 1 });
  }
  return out;
}

// ---------- отметки ----------
export function markDone(state, date, block) {
  const s = state.sessionMin || 25;
  const entry = { kind: block.type, ref: block.ref, title: block.title, subject: block.subject, start: toHHMM(block.start), end: toHHMM(block.start + (block.type === "review" ? REVIEW_MIN : s)) };
  (state.log[date] ||= []).push(entry);
  if (block.type === "task") {
    const t = state.tasks.find(x => x.id === block.ref);
    if (t) { t.done = Math.min(t.sessions, t.done + 1); if (t.done >= t.sessions) t.doneAt = date; }
  }
}
export function undoDone(state, date, idx) {
  const list = state.log[date] || [];
  const e = list[idx]; if (!e) return;
  list.splice(idx, 1);
  if (e.kind === "task") { const t = state.tasks.find(x => x.id === e.ref); if (t) { t.done = Math.max(0, t.done - 1); delete t.doneAt; } }
  if (e.kind === "review" && e.prev) { const t = state.topics.find(x => x.id === e.ref); if (t) { t.step = e.prev.step; t.next = e.prev.next; } }
}
// оценка повторения: easy | hard | forgot
export function gradeReview(state, date, topicId, grade, start) {
  const t = state.topics.find(x => x.id === topicId); if (!t) return;
  const prev = { step: t.step, next: t.next };
  if (grade === "easy") t.step = Math.min(INTERVALS.length - 1, t.step + 1);
  if (grade === "forgot") t.step = 0;
  t.next = addDays(date, INTERVALS[t.step]);
  (t.history ||= []).push({ date, grade });
  const st = start ?? 0;
  (state.log[date] ||= []).push({ kind: "review", ref: t.id, title: t.title, subject: t.subject, start: toHHMM(st), end: toHHMM(st + REVIEW_MIN), grade, prev });
}
export function addTopic(state, title, subject, date) {
  state.topics.push({ id: uid("p"), title: clip(title, 80), subject: clip(subject, 40), step: 0, next: addDays(date, INTERVALS[0]), learned: date, history: [] });
}

// ---------- режим «сил нет» ----------
export function tiredStreak(state, today) {
  let n = 0;
  for (let i = 0; i < 4; i++) if (state.tired[addDays(today, -i)]) n++;
  return n;
}
export function microOptions(state, today) {
  const out = [];
  const used = new Set((state.log[today] || []).map(x => x.ref + "|" + x.kind));
  for (const t of state.topics.filter(t => t.next && t.next <= today).sort((a, b) => a.next.localeCompare(b.next)))
    if (!used.has(t.id + "|review")) out.push({ kind: "review", ref: t.id, title: `Повторить: ${t.title}`, subject: t.subject, min: 5 });
  const tasks = state.tasks.filter(t => t.done < t.sessions).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  for (const t of tasks) if (!used.has(t.id + "|micro")) out.push({ kind: "micro", ref: t.id, title: `Начать «${t.title}» — просто 5 минут`, subject: t.subject, min: 5 });
  for (const s of state.subjects) if (!used.has(s.name + "|micro")) out.push({ kind: "micro", ref: s.name, title: `${s.name}: 5 терминов или дат на карточках`, subject: s.name, min: 5 });
  return out;
}

// ---------- правки от помощника ----------
const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = s => typeof s === "string" && /^\d{1,2}:\d{2}$/.test(s) && toMin(s) < 24 * 60;

/** Применяет список действий. Возвращает описания того, что поменялось. */
export function applyActions(state, actions, today) {
  const changes = [];
  if (!Array.isArray(actions)) return changes;
  for (const a of actions.slice(0, 12)) {
    if (!a || typeof a !== "object") continue;
    switch (a.type) {
      case "add_task": {
        const title = clip(a.title, 100); if (!title) break;
        const sessions = Math.max(1, Math.min(20, parseInt(a.sessions) || 2));
        const due = isDate(a.exam_date) ? (addDays(a.exam_date, -1) < today ? today : addDays(a.exam_date, -1)) : isDate(a.due_date) ? a.due_date : null;
        const kind = ["ege", "school", "other"].includes(a.kind) ? a.kind : "other";
        state.tasks.push({ id: uid("t"), title, subject: clip(a.subject, 40), kind, sessions, done: 0, due, dueTime: isTime(a.due_time) ? a.due_time : null, created: today });
        changes.push(`добавила «${title}»${due ? ` к ${humanDate(due)}` : ""}`);
        break;
      }
      case "complete_task": {
        const t = state.tasks.find(x => x.id === a.task_id); if (!t) break;
        t.done = t.sessions; t.doneAt = today; changes.push(`отметила «${t.title}» сделанной`);
        break;
      }
      case "delete_task": {
        const i = state.tasks.findIndex(x => x.id === a.task_id); if (i < 0) break;
        changes.push(`убрала «${state.tasks[i].title}»`); state.tasks.splice(i, 1);
        break;
      }
      case "update_task": {
        const t = state.tasks.find(x => x.id === a.task_id); if (!t) break;
        if (isDate(a.due_date)) t.due = a.due_date;
        if (a.due_date === null) t.due = null;
        if (isTime(a.due_time)) t.dueTime = a.due_time;
        if (a.sessions) t.sessions = Math.max(t.done + 1, Math.min(20, parseInt(a.sessions) || t.sessions));
        if (a.title) t.title = clip(a.title, 100);
        changes.push(`поправила «${t.title}»`);
        break;
      }
      case "cancel_lesson": {
        const l = state.lessons.find(x => x.id === a.lesson_id); if (!l || !isDate(a.date)) break;
        if (!state.cancelled.some(c => c.lessonId === l.id && c.date === a.date)) state.cancelled.push({ lessonId: l.id, date: a.date });
        changes.push(`убрала «${l.title}» ${humanDate(a.date)}`);
        break;
      }
      case "set_lesson_time": {
        const l = state.lessons.find(x => x.id === a.lesson_id); if (!l || !isTime(a.from)) break;
        l.from = a.from; l.to = isTime(a.to) ? a.to : toHHMM(Math.min(toMin(a.from) + 90, 1439));
        changes.push(`«${l.title}» теперь ${l.from}–${l.to}`);
        break;
      }
      case "add_lesson_once": {
        if (!isDate(a.date) || !isTime(a.from) || !isTime(a.to)) break;
        const title = clip(a.title, 80) || "Занятие";
        state.extraLessons.push({ id: uid("x"), title, subject: clip(a.subject, 40), date: a.date, from: a.from, to: a.to });
        changes.push(`поставила «${title}» ${humanDate(a.date)} в ${a.from}`);
        break;
      }
      case "set_availability": {
        if (!isDate(a.date)) break;
        if (a.off) { state.avail[a.date] = { off: true }; changes.push(`${humanDate(a.date)} — без подготовки`); }
        else if (isTime(a.from) || isTime(a.to)) {
          const f = state.free[weekday(a.date)];
          state.avail[a.date] = { from: isTime(a.from) ? a.from : f.from, to: isTime(a.to) ? a.to : f.to };
          changes.push(`${humanDate(a.date)} свободна ${state.avail[a.date].from}–${state.avail[a.date].to}`);
        }
        break;
      }
      case "learned_topic": {
        const title = clip(a.title, 80); if (!title) break;
        addTopic(state, title, a.subject, isDate(a.date) ? a.date : today);
        changes.push(`запомнила тему «${title}», первое повторение завтра`);
        break;
      }
      case "tired": {
        const d = isDate(a.date) ? a.date : today;
        state.tired[d] = state.tired[d] || { micro: 0 };
        changes.push("включила режим «сил нет»");
        break;
      }
      case "not_tired": {
        const d = isDate(a.date) ? a.date : today;
        delete state.tired[d]; changes.push("вернула обычный план");
        break;
      }
    }
  }
  return changes;
}

// ---------- переписка ----------
export function pushChat(state, role, text, extra = {}) {
  (state.chat ||= []).push({ role, text: String(text).slice(0, 800), at: Date.now(), ...extra });
  if (state.chat.length > 60) state.chat.splice(0, state.chat.length - 60);
}
