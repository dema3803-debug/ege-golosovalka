import { redis, hasDb } from "./_redis.js";

// Отдаёт сводку: сколько человек ответило и сколько раз выбран каждый вариант.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  try {
    const flat = (await redis("HGETALL", "answers")) || [];
    const counts = {}, answered = {};
    let voters = 0;
    for (let i = 1; i < flat.length; i += 2) {
      let a; try { a = JSON.parse(flat[i]); } catch { continue; }
      let any = false;
      for (const [q, arr] of Object.entries(a)) {
        if (!Array.isArray(arr) || !arr.length) continue;
        any = true;
        answered[q] = (answered[q] || 0) + 1;
        counts[q] = counts[q] || [];
        for (const idx of arr) counts[q][idx] = (counts[q][idx] || 0) + 1;
      }
      if (any) voters++;
    }
    res.status(200).json({ voters, answered, counts });
  } catch (e) {
    res.status(500).json({ error: "Не удалось загрузить результаты" });
  }
}
