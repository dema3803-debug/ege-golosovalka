// Сервер приложения для своего (российского) сервера.
// Отдаёт страницы и файлы сайта и запускает обработчики из папки api — те же, что на Vercel.
// Запуск из корня проекта: node deploy/server.js   (порт — переменная PORT, по умолчанию 3000)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // корень проекта
const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};
const PAGES = { "/poll": "index.html", "/app": "app.html", "/plan": "plan.html", "/start": "plan.html", "/privacy": "privacy.html", "/stats": "stats.html", "/consent": "consent.html" };
const PUBLIC = new Set(["index.html", "app.html", "plan.html", "privacy.html", "stats.html", "consent.html", "core.js", "icons.js", "sw.js", "manifest.json"]);
const handlers = new Map();

async function handler(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
  if (handlers.has(name)) return handlers.get(name);
  const file = path.join(ROOT, "api", name + ".js");
  if (!fs.existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  handlers.set(name, mod.default);
  return mod.default;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", e => { console.error(`${req.url.split("?")[0]}: загрузка оборвалась на ${size} байтах (${e.message})`); reject(Object.assign(e, { logged: true })); });
  });
}

// обёртка ответа в стиле Vercel: res.status(...).json(...)
function wrap(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); return res; };
  res.send = body => { res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); return res; };
  return res;
}

function sendFile(res, rel) {
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404; res.setHeader("Content-Type", "text/plain; charset=utf-8"); return res.end("Не найдено");
  }
  res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
  if (rel === "sw.js") { res.setHeader("Cache-Control", "no-cache"); res.setHeader("Service-Worker-Allowed", "/"); }
  else if (rel === "manifest.json") res.setHeader("Content-Type", "application/manifest+json");
  else if (rel.startsWith("icons/")) res.setHeader("Cache-Control", "public, max-age=604800");
  else res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  wrap(res);
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "same-origin");
  try {
    const url = new URL(req.url, "http://localhost");
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith("/api/")) {
      const h = await handler(p.slice(5).replace(/\/$/, ""));
      if (!h) return res.status(404).json({ error: "Не найдено" });
      req.query = Object.fromEntries(url.searchParams);
      if (req.method !== "GET" && req.method !== "HEAD") {
        const raw = await readBody(req, ["import", "files"].includes(p.slice(5).replace(/\/$/, "")) ? 9_000_000 : 1_000_000);
        try { req.body = raw ? JSON.parse(raw) : undefined; } catch { req.body = raw; }
      }
      return await h(req, res);
    }
    if (p === "/" || p === "/index.html") { res.statusCode = 302; res.setHeader("Location", "/app" + url.search); return res.end(); } // главный адрес ведёт в Козю (старый опрос - /poll)
    if (PAGES[p]) return sendFile(res, PAGES[p]);
    if (p.endsWith(".html") && PAGES["/" + p.slice(1, -5)]) { res.statusCode = 301; res.setHeader("Location", "/" + p.slice(1, -5) + url.search); return res.end(); }
    const rel = p.slice(1);
    if (PUBLIC.has(rel) || /^icons\/[a-z0-9-]+\.png$/.test(rel) || /^data\/ege\/[a-z0-9-]+\.json$/.test(rel)) return sendFile(res, rel);
    res.status(404).setHeader("Content-Type", "text/plain; charset=utf-8"); res.end("Не найдено");
  } catch (e) {
    if (!e.logged) console.error(e);
    if (!res.headersSent) res.status(500).json({ error: "Ошибка сервера" }); else res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Козя работает на порту ${PORT}`));
