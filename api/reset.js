import crypto from "node:crypto";
import { redis, hasDb } from "./_redis.js";
import { readBody } from "./_store.js";
import { normEmail, validEmail, hashPassword } from "./signup.js";
import { overLimit } from "./_limits.js";
import { mailReady, sendMail } from "./_mail.js";

// Восстановление пароля по почте.
// POST {action:"request", email}       - прислать письмо со ссылкой (ответ всегда одинаковый, чтобы нельзя было проверить, есть ли почта)
// POST {action:"check", token}         - ссылка ещё действует?
// POST {action:"confirm", token, password} - задать новый пароль → {u}
const TTL = 3600; // ссылка живёт 1 час
const SITE = () => (process.env.SITE_URL || "https://kozya-ege.ru").replace(/\/$/, "");
const okToken = t => typeof t === "string" && /^[a-f0-9]{48}$/.test(t);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const b = readBody(req) || {};
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();

  if (b.action === "request") {
    if (!mailReady()) return res.status(503).json({ error: "Восстановление по почте пока не настроено. Напиши на kozya9828@gmail.com - поможем." });
    const email = normEmail(b.email);
    if (!validEmail(email)) return res.status(400).json({ error: "Проверь почту - похоже, в ней опечатка." });
    if (await overLimit(`lim:reset:${ip}`, 10, 3600) || await overLimit(`lim:reset:${email}`, 3, 3600)) return res.status(429).json({ error: "Слишком много попыток. Проверь «Входящие» и «Спам» - письмо может уже лежать там. Новую ссылку можно запросить через час." });
    const raw = await redis("HGET", "users", email);
    if (raw) {
      const token = crypto.randomBytes(24).toString("hex");
      await redis("SET", `reset:${token}`, email, "EX", String(TTL));
      const link = `${SITE()}/app#reset-${token}`;
      const text = `Привет!\n\nКто-то (надеюсь, ты) попросил сменить пароль в Козе для этой почты.\n\nЧтобы придумать новый пароль, открой ссылку:\n${link}\n\nСсылка работает 1 час. Если это был не ты, просто ничего не делай: пароль останется прежним.\n\nКозя 🐐\nkozya-ege.ru`;
      const html = `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#1B1620;max-width:480px"><p>Привет!</p><p>Кто-то (надеюсь, ты) попросил сменить пароль в Козе для этой почты.</p><p><a href="${link}" style="display:inline-block;background:#1B1620;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:bold">Придумать новый пароль</a></p><p style="color:#6B5A63;font-size:14px">Ссылка работает 1 час. Если это был не ты, просто ничего не делай: пароль останется прежним.</p><p>Козя 🐐<br><a href="${SITE()}" style="color:#B8325E">kozya-ege.ru</a></p></div>`;
      try { await sendMail({ to: email, subject: "Козя: новый пароль", text, html }); }
      catch (e) {
        console.error("reset: письмо не ушло:", e.message);
        // неудачная отправка не должна съедать лимит: вернём попытку
        try { await redis("DECR", `lim:reset:${email}`); await redis("DECR", `lim:reset:${ip}`); await redis("DEL", `reset:${token}`); } catch {}
        return res.status(502).json({ error: "Не получилось отправить письмо. Попробуй через пару минут." });
      }
    }
    return res.status(200).json({ ok: true });
  }

  if (b.action === "check") {
    if (!okToken(b.token)) return res.status(400).json({ error: "Ссылка неполная" });
    const email = await redis("GET", `reset:${b.token}`);
    if (!email) return res.status(410).json({ error: "Ссылка устарела или уже использована." });
    return res.status(200).json({ ok: true, email: email.replace(/^(.{2}).*(@.*)$/, "$1…$2") });
  }

  if (b.action === "confirm") {
    if (!okToken(b.token)) return res.status(400).json({ error: "Ссылка неполная" });
    const password = String(b.password || "");
    if (password.length < 8 || password.length > 100) return res.status(400).json({ error: "Пароль - минимум 8 символов." });
    if (await overLimit(`lim:resetc:${ip}`, 20, 3600)) return res.status(429).json({ error: "Слишком много попыток. Подожди час." });
    const email = await redis("GET", `reset:${b.token}`);
    if (!email) return res.status(410).json({ error: "Ссылка устарела или уже использована. Запроси новую." });
    const raw = await redis("HGET", "users", email);
    let user = null; try { user = JSON.parse(raw); } catch {}
    if (!user) { await redis("DEL", `reset:${b.token}`); return res.status(410).json({ error: "Аккаунт не найден." }); }
    const np = hashPassword(password);
    await redis("HSET", "users", email, JSON.stringify({ ...user, salt: np.salt, hash: np.hash, changedAt: new Date().toISOString(), resetAt: new Date().toISOString() }));
    await redis("DEL", `reset:${b.token}`);
    try { await redis("DEL", `lim:login:${email}`); } catch {}
    return res.status(200).json({ ok: true, u: user.u });
  }
  res.status(400).json({ error: "Неизвестное действие" });
}
