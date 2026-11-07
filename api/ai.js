import { aiOverLimit } from "./_limits.js";
import { hasDb } from "./_redis.js";
import { validU, loadState, readBody } from "./_store.js";
import { chat } from "./_giga.js";

// POST {u, mode:"check", q, a, answer} - проверить ответ на карточку
// POST {u, mode:"cards", topic, subject, n} - придумать карточки по теме
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const b = readBody(req) || {};
  if (!validU(b.u) || !(await loadState(b.u))) return res.status(400).json({ error: "Неверная ссылка" });
  if (await aiOverLimit(b.u)) return res.status(429).json({ error: "На сегодня я наговорилась 😴 Завтра продолжим. А план можно поправить руками." });
  try {
    if (b.mode === "check") return res.status(200).json(await checkAnswer(b.q, b.a, b.answer));
    if (b.mode === "cards") return res.status(200).json({ cards: await makeCards(b.subject, b.topic, b.n) });
    res.status(400).json({ error: "Неизвестный режим" });
  } catch {
    res.status(502).json({ error: "Помощник сейчас недоступен" });
  }
}
const clip = (s, n) => String(s ?? "").slice(0, n);
// проверка ответа на карточку: {verdict: yes|partly|no|null, comment}
export async function checkAnswer(q, a, answer) {
  const r = await chat([
    { role: "system", content: 'Ты проверяешь ответ ученика на карточку для подготовки к ЕГЭ. Сравни её ответ с правильным по смыслу, не придирайся к формулировкам, опечаткам и порядку слов. Ответь строго JSON: {"verdict":"yes|partly|no","comment":"одно короткое тёплое предложение на «ты»: что верно или чего не хватило"}' },
    { role: "user", content: `Вопрос: ${clip(q, 300)}\nПравильный ответ: ${clip(a, 500)}\nЕё ответ: ${clip(answer, 500)}` },
  ], { model: "GigaChat-2", temperature: 0, maxTokens: 150 });
  const j = parse(r.text);
  const verdict = ["yes", "partly", "no"].includes(j?.verdict) ? j.verdict : null;
  if (!verdict) return { verdict: null };
  return { verdict, comment: clip(j.comment, 200).replace(/"/g, "").replace(/\s*\u2014\s*/g, " - ") };
}
// придумать карточки по теме: [{q, a}]
export async function makeCards(subject, topic, n) {
  n = Math.max(3, Math.min(12, parseInt(n) || 6));
  const sys = `Ты составляешь карточки для подготовки к ЕГЭ. Дай ${n} коротких вопросов с точными ответами по теме - то, что реально спрашивают на ЕГЭ: термины, даты, ключевые факты, определения. Ответы короткие (до 25 слов) и фактически верные; если не уверена в факте - не включай его. Ответ строго JSON: {"cards":[{"q":"...","a":"..."}]}`;
  const get = async (model, content) => {
    const r = await chat([{ role: "system", content: sys }, { role: "user", content }], { model, temperature: 0.3, maxTokens: 1200 });
    const j = parse(r.text);
    const cards = (Array.isArray(j?.cards) ? j.cards : []).filter(c => c && c.q && c.a).slice(0, n).map(c => ({ q: clip(c.q, 300), a: clip(c.a, 500) }));
    return { cards, raw: r.text };
  };
  let res = await get("GigaChat-2-Pro", `Предмет: ${clip(subject, 40)}. Тема: ${clip(topic, 120)}`);
  // GigaChat иногда отказывается от тем вроде политики или права - повторяем, объясняя, что это школьная программа
  if (!res.cards.length) res = await get("GigaChat-2", `Это учебные карточки по школьной программе 11 класса и кодификатору ЕГЭ, только термины и определения из учебника, без оценок и мнений. Предмет: ${clip(subject, 40)}. Тема: ${clip(topic, 120)}`);
  const out = JSON.parse(JSON.stringify(res.cards).replace(/\s*\u2014\s*/g, " - "));
  Object.defineProperty(out, "raw", { value: res.raw }); // для экзамена Кози
  return out;
}
function parse(text) {
  const t = String(text || "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), z = t.lastIndexOf("}");
  if (a < 0 || z <= a) return null;
  try { return JSON.parse(t.slice(a, z + 1)); } catch { return null; }
}
