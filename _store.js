import { redis } from "./_redis.js";

export const validU = u => typeof u === "string" && /^[a-z0-9]{16,40}$/.test(u);
export async function loadState(u) {
  const raw = await redis("GET", "app:" + u);
  return raw ? JSON.parse(raw) : null;
}
export async function saveState(u, state) {
  const text = JSON.stringify(state);
  if (text.length > 400000) throw new Error("Слишком большой план");
  await redis("SET", "app:" + u, text);
}
export function readBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  return b;
}
