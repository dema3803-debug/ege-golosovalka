import { request, russianCerts, getToken, chat } from "./_giga.js";

// Проверка связи с GigaChat. Открывать: /api/giga-test?key=ВАШ_ADMIN_KEY
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Неверный ключ" });
  const report = {
    "1_ключ_GIGACHAT_KEY": process.env.GIGACHAT_KEY ? "есть" : "НЕТ — добавь в Environment Variables",
    "2_сертификатов_Минцифры_в_папке_certs": russianCerts().length,
    "регион_сервера": process.env.VERCEL_REGION || "неизвестно",
  };
  try {
    await request("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", { method: "POST", body: "", extraCa: russianCerts() });
    report["3_сервер_Сбера_доступен"] = "да";
  } catch (e) { report["3_сервер_Сбера_доступен"] = "НЕТ: " + e.message; }
  try {
    await getToken();
    report["4_токен_получен"] = "да";
    const r = await chat([{ role: "user", content: "Ответь одним словом: привет" }], { maxTokens: 20 });
    report["5_ответ_модели"] = r.text;
    report["адрес_API"] = r.base;
    report["ИТОГ"] = "ВСЁ РАБОТАЕТ ✅";
  } catch (e) {
    report["ошибка"] = e.message;
    report["ИТОГ"] = "НЕ РАБОТАЕТ ❌";
  }
  res.status(200).json(report);
}
