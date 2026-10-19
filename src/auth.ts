const enc = new TextEncoder();

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function safeEqual(secret: string, a: string, b: string): Promise<boolean> {
  const [ha, hb] = [await hmacHex(secret, a), await hmacHex(secret, b)];
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

export type PanelRole = "admin" | "staff";

const SESSION_MS = 12 * 60 * 60 * 1000;
const secret = (env: { SESSION_SECRET?: string }) => env.SESSION_SECRET || "sin-secreto";

export async function createSession(env: { SESSION_SECRET?: string }, role: PanelRole): Promise<string> {
  const exp = Date.now() + SESSION_MS;
  const sig = await hmacHex(secret(env), `${role}.${exp}`);
  return `${role}.${exp}.${sig}`;
}

export async function readSession(env: { SESSION_SECRET?: string }, req: Request): Promise<PanelRole | null> {
  const m = (req.headers.get("Cookie") ?? "").match(/(?:^|;\s*)sid=([^;]+)/);
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 3) return null;
  const [role, expStr, sig] = parts;
  if (role !== "admin" && role !== "staff") return null;
  if (!/^\d+$/.test(expStr) || Date.now() > Number(expStr)) return null;
  const expected = await hmacHex(secret(env), `${role}.${expStr}`);
  return (await safeEqual(secret(env), sig, expected)) ? role : null;
}

export async function sessionCookie(env: { SESSION_SECRET?: string }, role: PanelRole, req: Request): Promise<string> {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `sid=${await createSession(env, role)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure}`;
}

export const clearCookie = "sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";

export function badOrigin(req: Request): boolean {
  const o = req.headers.get("Origin");
  if (!o) return false;
  try { return new URL(o).host !== new URL(req.url).host; } catch { return true; }
}
