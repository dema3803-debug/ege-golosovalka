import { aiOverLimit } from "./_limits.js";
import { hasDb } from "./_redis.js";
import { validU, loadState, readBody } from "./_store.js";
import { chat } from "./_giga.js";

// POST {u, mode:"check", q, a, answer} — проверить ответ на карточку
// POST {u, mode:"cards", topic, subject, n} — придумать карточки по теме
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const b = readBody(req) || {};
  if (!validU(b.u) || !(await loadState(b.u))) return res.status(400).json({ error: "Неверная ссылка" });
  if (await aiOverLimit(b.u)) return res.status(429).json({ error: "На сегодня я наговорилась 😴 Завтра продолжим. А план можно поправить руками." });
  const clip = (s, n) => String(s ?? "").slice(0, n);
  try {
    if (b.mode === "check") {
      const r = await chat([
        { role: "system", content: 'Ты проверяешь ответ школьницы на карточку для подготовки к ЕГЭ. Сравни её ответ с правильным по смыслу, не придирайся к формулировкам, опечаткам и порядку слов. Ответь строго JSON: {"verdict":"yes|partly|no","comment":"одно короткое тёплое предложение на «ты»: что верно или чего не хватило"}' },
        { role: "user", content: `Вопрос: ${clip(b.q, 300)}\nПравильный ответ: ${clip(b.a, 500)}\nЕё ответ: ${clip(b.answer, 500)}` },
      ], { model: "GigaChat-2", temperature: 0, maxTokens: 150 });
      const j = parse(r.text);
      const verdict = ["yes", "partly", "no"].includes(j?.verdict) ? j.verdict : null;
      if (!verdict) return res.status(200).json({ verdict: null });
      return res.status(200).json({ verdict, comment: clip(j.comment, 200).replace(/"/g, "") });
    }
    if (b.mode === "cards") {
      const n = Math.max(3, Math.min(12, parseInt(b.n) || 6));
      const r = await chat([
        { role: "system", content: `Ты составляешь карточки для подготовки к ЕГЭ. Дай ${n} коротких вопросов с точными ответами по теме — то, что реально спрашивают на ЕГЭ: термины, даты, ключевые факты, определения. Ответы короткие (до 25 слов) и фактически верные; если не уверена в факте — не включай его. Ответ строго JSON: {"cards":[{"q":"...","a":"..."}]}` },
        { role: "user", content: `Предмет: ${clip(b.subject, 40)}. Тема: ${clip(b.topic, 120)}` },
      ], { model: "GigaChat-2-Pro", temperature: 0.3, maxTokens: 1200 });
      const j = parse(r.text);
      const cards = (Array.isArray(j?.cards) ? j.cards : []).filter(c => c && c.q && c.a).slice(0, n).map(c => ({ q: clip(c.q, 300), a: clip(c.a, 500) }));
      return res.status(200).json({ cards });
    }
    res.status(400).json({ error: "Неизвестный режим" });
  } catch {
    res.status(502).json({ error: "Помощник сейчас недоступен" });
  }
}
function parse(text) {
  const t = String(text || "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), z = t.lastIndexOf("}");
  if (a < 0 || z <= a) return null;
  try { return JSON.parse(t.slice(a, z + 1)); } catch { return null; }
}
