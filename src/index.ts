import * as bot from "./bot.ts";
import * as db from "./db.ts";
import { hmacHex, safeEqual } from "./auth.ts";
import { loadSettings } from "./config.ts";
import { handlePanel } from "./panels.ts";
import { normalizePhone } from "./phone.ts";
import { runReminders } from "./reminders.ts";
import { nowLocal } from "./time.ts";
import type { Env } from "./types.ts";
import { send, sendText } from "./whatsapp.ts";

// ------------------------------------------------------------------ webhook de WhatsApp
interface WaMessage {
  id?: string; from?: string; type?: string;
  text?: { body: string };
  interactive?: { button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
}

function* extractMessages(payload: any): Generator<{ msg: WaMessage; profile: string | null }> {
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c?.wa_id, c?.profile?.name]));
      for (const msg of value.messages ?? []) yield { msg, profile: names.get(msg?.from) ?? null };
    }
  }
}

async function processMessage(env: Env, msg: WaMessage, profile: string | null): Promise<void> {
  const phone = normalizePhone(msg.from ?? "") ?? msg.from ?? "";
  try {
    const now = nowLocal(env.SALON_TZ);
    if (!msg.id || !phone || !(await db.markMessageSeen(env.DB, msg.id, now))) return;
    let replies;
    if (msg.type === "text" && msg.text) {
      replies = await bot.handleMessage(env, phone, msg.text.body, profile, now);
    } else if (msg.type === "interactive") {
      const r = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      replies = r ? await bot.handleMessage(env, phone, r.title, profile, now, r.id)
                  : ["Solo entiendo texto y botones 🙂 Escribe *hola* para ver el menú."];
    } else {
      replies = ["Solo entiendo texto y botones 🙂 Escribe *hola* para ver el menú."];
    }
    for (const reply of replies) await send(env, phone, reply);
  } catch (e) {
    console.error(`Error procesando mensaje de ${phone}:`, e);
    const s = await loadSettings(env).catch(() => null);
    await sendText(env, phone, `Ha habido un problema técnico. Inténtalo de nuevo en un momento${s ? ` o llámanos al ${s.phone}` : ""}.`);
  }
}

async function webhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method === "GET") {
    const u = new URL(req.url);
    const ok = u.searchParams.get("hub.mode") === "subscribe" && env.VERIFY_TOKEN &&
      (await safeEqual(env.VERIFY_TOKEN, u.searchParams.get("hub.verify_token") ?? "", env.VERIFY_TOKEN));
    return ok ? new Response(u.searchParams.get("hub.challenge") ?? "") : new Response("Token de verificación incorrecto", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Método no permitido", { status: 405 });

  const raw = await req.text();
  if (env.APP_SECRET) {
    const expected = `sha256=${await hmacHex(env.APP_SECRET, raw)}`;
    if (!(await safeEqual(env.APP_SECRET, req.headers.get("X-Hub-Signature-256") ?? "", expected))) {
      return new Response("Firma inválida", { status: 403 });
    }
  } else {
    console.warn("APP_SECRET no configurado: no se valida la firma de los webhooks.");
  }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return Response.json({ status: "ignored" }); }
  for (const { msg, profile } of extractMessages(payload)) ctx.waitUntil(processMessage(env, msg, profile));
  return Response.json({ status: "ok" });
}

// ------------------------------------------------------------------ entrada del Worker
export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") return Response.json({ ok: true });
      if (url.pathname === "/webhook") return await webhook(req, env, _ctx);
      const panel = await handlePanel(req, env);
      if (panel) return panel;
      return new Response("No encontrado", { status: 404 });
    } catch (e) {
      console.error("Error no controlado:", e);
      return new Response("Error interno", { status: 500 });
    }
  },

  // Cada 10 minutos (ver "triggers" en wrangler.jsonc)
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        await runReminders(env);
        await db.cleanup(env.DB, nowLocal(env.SALON_TZ));
      } catch (e) { console.error("Fallo en la tarea programada:", e); }
    })());
  },
} satisfies ExportedHandler<Env>;
