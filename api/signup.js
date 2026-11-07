import crypto from "node:crypto";
import { redis, hasDb } from "./_redis.js";
import { saveState, readBody } from "./_store.js";
import { formToState, mskToday } from "./_fromForm.js";
import { overLimit, markSeen } from "./_limits.js";

// Регистрация: анкета + почта + пароль → свой план. POST {form, email, password, consent}
export const normEmail = e => String(e || "").trim().toLowerCase();
export const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-zа-я]{2,24}$/i.test(e);
export const CONSENT_VER = "2026-11-07"; // редакция согласия и политики
export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString("hex") };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!hasDb()) return res.status(503).json({ error: "База не подключена" });
  const b = readBody(req) || {};
  const email = normEmail(b.email), password = String(b.password || "");
  if (!validEmail(email)) return res.status(400).json({ error: "Проверь почту - похоже, в ней опечатка." });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: "Пароль - минимум 8 символов." });
  if (b.consent !== true) return res.status(400).json({ error: "Поставь галочку согласия на обработку данных." });
  const age = b.age === "<14" ? "<14" : b.age === "14+" ? "14+" : null;
  if (!age) return res.status(400).json({ error: "Отметь, сколько тебе лет." });
  if (age === "<14" && b.parent !== true) return res.status(400).json({ error: "Если тебе меньше 14, согласие должен дать родитель." });
  if (!b.form || typeof b.form !== "object" || !Array.isArray(b.form.subjects) || !b.form.subjects.length) return res.status(400).json({ error: "Выбери хотя бы один предмет в анкете." });
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (await overLimit(`lim:signup:${ip}`, 10, 3600)) return res.status(429).json({ error: "Слишком много регистраций с этого устройства. Попробуй через час." });
  if (await redis("HEXISTS", "users", email) === 1) return res.status(409).json({ error: "Эта почта уже зарегистрирована - нажми «Войти»." });

  const state = formToState(b.form);
  state.email = email;
  state.tips = { policy: 1 }; // согласие уже дано при регистрации
  if (b.gender === "m" || b.gender === "f") state.gender = b.gender;
  const u = crypto.randomBytes(12).toString("hex");
  const { salt, hash } = hashPassword(password);
  await saveState(u, state);
  // откуда пришёл: метка utm_source из ссылки поста (vk, tg…) и utm_campaign (тема)
  const srcS = /^[a-z0-9_-]{1,30}$/.test(b.src?.s || "") ? b.src.s : null, srcC = /^[a-z0-9_-]{1,40}$/.test(b.src?.c || "") ? b.src.c : null;
  const ok = await redis("HSETNX", "users", email, JSON.stringify({ u, salt, hash, created: mskToday(), consentAt: new Date().toISOString(), consentVer: CONSENT_VER, age, parentConsent: age === "<14", ...(srcS ? { src: srcS, camp: srcC || undefined } : {}) }));
  if (Number(ok) !== 1) return res.status(409).json({ error: "Эта почта уже зарегистрирована - нажми «Войти»." });
  try { await redis("HSET", "plans", "signup-" + u, JSON.stringify({ ...b.form, sentAt: Date.now(), via: "signup" })); } catch {}
  // пришёл по приглашению друга: обоим наряд «Сердечко дружбы»
  try {
    const code = String(b.ref || "").toLowerCase();
    if (/^[a-z0-9]{6}$/.test(code)) {
      const inviter = await redis("GET", "ref:" + code);
      if (inviter && inviter !== u) { await redis("HSET", "invited", u, inviter); await redis("HINCRBY", "refs", inviter, 1); }
    }
  } catch {}
  await markSeen(u);
  res.status(200).json({ ok: true, u });
}
