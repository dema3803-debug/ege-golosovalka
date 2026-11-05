// Подключение к GigaChat: получение токена и запрос к модели.
// Сертификат Минцифры берётся из папки certs (если он там есть).
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CERT_FILES = ["russian_trusted_root_ca_pem.crt", "russian_trusted_sub_ca_pem.crt", "russian_trusted_root_ca.cer", "russian_trusted_sub_ca.cer"];

export function russianCerts() {
  const out = [];
  for (const f of CERT_FILES) {
    try {
      let txt = fs.readFileSync(path.join(process.cwd(), "certs", f));
      if (!txt.toString("latin1").includes("BEGIN CERTIFICATE")) {
        // двоичный формат (DER) — переводим в PEM
        txt = "-----BEGIN CERTIFICATE-----\n" + txt.toString("base64").match(/.{1,64}/g).join("\n") + "\n-----END CERTIFICATE-----\n";
      }
      out.push(txt.toString());
    } catch {}
  }
  return out;
}

export function request(url, { method = "GET", headers = {}, body = null, extraCa = [] } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers, timeout: 20000 };
    if (extraCa.length) opts.ca = [...tls.rootCertificates, ...extraCa];
    const r = https.request(opts, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    r.on("timeout", () => r.destroy(new Error("Таймаут: сервер не ответил за 20 секунд")));
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

let cached = null; // { token, until }

export async function getToken() {
  if (cached && cached.until > Date.now() + 60000) return cached.token;
  const key = process.env.GIGACHAT_KEY;
  if (!key) throw new Error("Нет GIGACHAT_KEY в настройках Vercel");
  const r = await request("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", RqUID: crypto.randomUUID(), Authorization: `Basic ${key.trim()}` },
    body: "scope=GIGACHAT_API_PERS",
    extraCa: russianCerts(),
  });
  if (r.status !== 200) throw new Error(`Токен не выдан: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  const j = JSON.parse(r.text);
  cached = { token: j.access_token, until: j.expires_at || Date.now() + 25 * 60000 };
  return cached.token;
}

const BASES = ["https://api.giga.chat", "https://gigachat.devices.sberbank.ru"];

export async function chat(messages, { model = "GigaChat-2", temperature = 0.3, maxTokens = 1500 } = {}) {
  const token = await getToken();
  let lastErr = null;
  for (const base of BASES) {
    try {
      const r = await request(`${base}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        extraCa: russianCerts(),
      });
      if (r.status === 200) return { base, text: JSON.parse(r.text).choices[0].message.content };
      lastErr = new Error(`${base}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    } catch (e) { lastErr = new Error(`${base}: ${e.message}`); }
  }
  throw lastErr;
}
