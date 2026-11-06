// База данных. Два режима:
// • на своём сервере - локальный Redis (переменная LOCAL_REDIS_URL, например redis://127.0.0.1:6379);
// • на Vercel - Upstash Redis по REST (переменные KV_REST_API_URL / KV_REST_API_TOKEN).
import net from "node:net";

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const LOCAL = process.env.LOCAL_REDIS_URL || ""; // только на своём сервере (Vercel сам заводит REDIS_URL - его не трогаем)

export function hasDb() { return Boolean(LOCAL || (URL_ && TOKEN)); }

export async function redis(...cmd) {
  if (LOCAL) return local(cmd.map(String));
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `Redis HTTP ${r.status}`);
  return j.result;
}

// ---------- простой клиент локального Redis (протокол RESP) ----------
let sock = null, buf = Buffer.alloc(0), queue = [], connecting = null;

function connect() {
  if (sock && !sock.destroyed) return Promise.resolve();
  if (connecting) return connecting;
  const u = new URL(LOCAL);
  connecting = new Promise((resolve, reject) => {
    const s = net.createConnection({ host: u.hostname || "127.0.0.1", port: Number(u.port) || 6379 });
    s.once("connect", async () => {
      sock = s; connecting = null; buf = Buffer.alloc(0);
      resolve();
    });
    s.once("error", e => { connecting = null; reject(e); });
    s.on("data", d => { buf = Buffer.concat([buf, d]); drain(); });
    s.on("close", () => { sock = null; const q = queue; queue = []; q.forEach(p => p.reject(new Error("Redis: соединение закрыто"))); });
  });
  return connecting.then(async () => { if (u.password) await local(["AUTH", decodeURIComponent(u.password)]); });
}

function encode(args) {
  let out = `*${args.length}\r\n`;
  for (const a of args) out += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
  return out;
}

// разбор одного ответа из буфера; возвращает [значение, длина] или null, если данных пока мало
function parse(b, i = 0) {
  const nl = b.indexOf("\r\n", i);
  if (nl < 0) return null;
  const type = String.fromCharCode(b[i]), line = b.toString("utf8", i + 1, nl), next = nl + 2;
  if (type === "+") return [line, next];
  if (type === "-") return [new Error(line), next];
  if (type === ":") return [Number(line), next];
  if (type === "$") {
    const len = Number(line);
    if (len < 0) return [null, next];
    if (b.length < next + len + 2) return null;
    return [b.toString("utf8", next, next + len), next + len + 2];
  }
  if (type === "*") {
    const n = Number(line);
    if (n < 0) return [null, next];
    const arr = []; let p = next;
    for (let k = 0; k < n; k++) { const r = parse(b, p); if (!r) return null; arr.push(r[0]); p = r[1]; }
    return [arr, p];
  }
  throw new Error("Redis: непонятный ответ");
}

function drain() {
  while (queue.length) {
    const r = parse(buf);
    if (!r) return;
    buf = buf.subarray(r[1]);
    const p = queue.shift();
    r[0] instanceof Error ? p.reject(r[0]) : p.resolve(r[0]);
  }
}

async function local(args) {
  await connect();
  return new Promise((resolve, reject) => { queue.push({ resolve, reject }); sock.write(encode(args)); });
}
