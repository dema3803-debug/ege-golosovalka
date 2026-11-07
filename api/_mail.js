// Отправка писем через SMTP (Яндекс Почта: smtp.yandex.ru, порт 465, пароль приложения).
// Настройки в /etc/kozya.env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM (по умолчанию = SMTP_USER).
// Для проверки у себя: MAIL_FAKE_FILE=путь - письма пишутся в файл, а не отправляются.
import tls from "node:tls";
import fs from "node:fs";
import crypto from "node:crypto";

export const mailReady = () => !!(process.env.MAIL_FAKE_FILE || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS));
const b64 = s => Buffer.from(String(s), "utf8").toString("base64");
const head = s => `=?UTF-8?B?${b64(s)}?=`;

export async function sendMail({ to, subject, text, html }) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || "kozya@localhost";
  const bnd = "kz" + crypto.randomBytes(8).toString("hex");
  const msg = [
    `From: ${head("Козя")} <${from}>`, `To: <${to}>`, `Subject: ${head(subject)}`, `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomBytes(12).toString("hex")}@${from.split("@")[1] || "kozya-ege.ru"}>`, "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${bnd}"`, "",
    `--${bnd}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(text).match(/.{1,76}/g).join("\r\n"),
    `--${bnd}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(html || text).match(/.{1,76}/g).join("\r\n"),
    `--${bnd}--`, "",
  ].join("\r\n");
  if (process.env.MAIL_FAKE_FILE) { fs.appendFileSync(process.env.MAIL_FAKE_FILE, JSON.stringify({ to, subject, text }) + "\n"); return; }
  const host = process.env.SMTP_HOST, port = Number(process.env.SMTP_PORT) || 465;
  await new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host, timeout: 20000 });
    let buf = "", step = 0;
    const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
    // шаги диалога: [ожидаемый код ответа, что отправить дальше]
    const steps = [
      [220, `EHLO kozya-ege.ru`], [250, `AUTH LOGIN`], [334, b64(user)], [334, b64(pass)], [235, `MAIL FROM:<${from}>`],
      [250, `RCPT TO:<${to}>`], [250, `DATA`], [354, msg.replace(/\r\n\./g, "\r\n..") + "\r\n."], [250, `QUIT`],
    ];
    const fail = e => { sock.destroy(); reject(e instanceof Error ? e : new Error(e)); };
    sock.on("timeout", () => fail("SMTP: нет ответа"));
    sock.on("error", fail);
    sock.on("data", d => {
      buf += d.toString("utf8");
      const lines = buf.split("\r\n"); if (lines.at(-1) !== "") return;
      const last = lines.filter(Boolean).at(-1) || "";
      if (!/^\d{3} /.test(last)) return; // ответ ещё не весь (многострочный 250-…)
      buf = "";
      const code = Number(last.slice(0, 3));
      if (step >= steps.length) { sock.end(); return resolve(); }
      const [want, send] = steps[step];
      if (code !== want) return fail(`SMTP: ждали ${want}, сервер ответил «${last.slice(0, 120)}»`);
      step++; sock.write(send + "\r\n");
      if (step === steps.length) setTimeout(() => { sock.end(); resolve(); }, 500);
    });
  });
}
