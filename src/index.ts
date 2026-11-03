import * as bot from "./bot.ts";
import * as db from "./db.ts";
import * as whatsapp from "./whatsapp.ts";
import { applyMetaStatuses, deliverOutboxForWamid, deliverPendingOutbox, drainInbox, processQueueMessage } from "./consumer.ts";
import { hmacHex, safeEqual } from "./auth.ts";
import { loadSettings } from "./config.ts";
import { handlePanel } from "./panels.ts";
import { normalizePhone } from "./phone.ts";
import { runReminders } from "./reminders.ts";
import { nowLocal } from "./time.ts";
import { diag, diagError, setDebugContext } from "./debug.ts";
import { manifestJson, iconResponse, qrRecepcionPage, ICON_192_BASE64, ICON_512_BASE64 } from "./pwa.ts";
import type { Env, InboxJob } from "./types.ts";

// ------------------------------------------------------------------ rutas públicas de la PWA y el QR

/** Sirve el manifiesto PWA generado desde los ajustes del salón, con MIME correcto y caché corta
 *  para que los cambios (nombre, colores, iconos) se noten al actualizar. */
async function manifestResponse(env: Env): Promise<Response> {
  const s = await loadSettings(env);
  return new Response(manifestJson(s), {
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": "public, max-age=600, must-revalidate",
      "content-security-policy": "default-src 'none'",
    },
  });
}

// ------------------------------------------------------------------ webhook de WhatsApp
interface WaMessage {
  id?: string; from?: string; type?: string; timestamp?: number;
  text?: { body: string };
  interactive?: { button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
}

/** Enmascara un número de teléfono para no guardarlo completo en logs. */
function maskPhone(p: string): string {
  if (!p) return "?";
  const d = p.replace(/\D/g, "");
  if (d.length < 4) return "****";
  return `${d.slice(0, 2)}…${d.slice(-2)}`;
}

export function* extractMessages(payload: any): Generator<{ msg: WaMessage; profile: string | null }> {
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c?.wa_id, c?.profile?.name]));
      for (const msg of value.messages ?? []) yield { msg, profile: names.get(msg?.from) ?? null };
    }
  }
}

/** Acuses de entrega/lectura de Meta (no son mensajes del cliente). */
export function* extractStatuses(payload: any): Generator<{ id: string; status: string }> {
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const st of change?.value?.statuses ?? []) {
        if (st?.id && st?.status) yield { id: String(st.id), status: String(st.status) };
      }
    }
  }
}

export interface BotService {
  handleMessage: typeof bot.handleMessage;
}

export interface WhatsAppService {
  send: typeof whatsapp.send;
}

/**
 * Webhook: guarda el mensaje en el Inbox (deduplicado por WAMID), lo publica en la cola
 * local si existe y drena en el acto para que la respuesta no espere al consumidor.
 * La cola y el cron son la red de seguridad: el Inbox es la fuente de verdad.
 */
export async function processMessage(
  env: Env,
  msg: WaMessage,
  profile: string | null,
  services: { bot: BotService, whatsapp: WhatsAppService } = { bot, whatsapp }
): Promise<void> {
  const phone = normalizePhone(msg.from ?? "") ?? msg.from ?? "";
  const mPhone = maskPhone(phone);
  const now = nowLocal(env.SALON_TZ);
  if (!msg.id || !phone) {
    diag(`skip wamid=${msg.id} reason=invalid`);
    return;
  }

  try {
    diag(`incoming wamid=${msg.id} type=${msg.type} phone=${mPhone} profile=${profile ?? "none"}`);
    const saved = await db.saveInboxMessage(env.DB, msg, profile, phone, now);
    if (!saved) {
      diag(`duplicate wamid=${msg.id} phone=${mPhone} (ignorado)`);
      return;
    }
    diag(`inbox saved wamid=${msg.id} phone=${mPhone} seq=${saved.sequence}`);

    if (env.WHATSAPP_QUEUE) {
      try {
        await env.WHATSAPP_QUEUE.send({ id: msg.id });
        diag(`queued wamid=${msg.id}`);
      } catch (e) {
        // Sin cola el mensaje sigue en el Inbox: el cron lo recuperará.
        diagError(`queue send failed wamid=${msg.id}:`, e);
      }
    }

    if (env.INLINE_DRAIN === "0") {
      diag(`inline drain disabled wamid=${msg.id} (modo cola)`);
    } else {
      const processed = await drainInbox(env, services);
      diag(`drain wamid=${msg.id} processed=${processed}`);
    }
  } catch (e) {
    diagError(`error processing message from ${mPhone} wamid=${msg.id}:`, e);
    try { await db.markInboxFailed(env.DB, msg.id, now, String(e)); } catch { /* la fila puede no existir */ }
    const s = await loadSettings(env).catch(() => null);
    const text = `Ha habido un problema técnico. Inténtalo de nuevo en un momento${s ? ` o llámanos al ${s.phone}` : ""}.`;
    try {
      await db.createOutboxMessage(env.DB, `error:${msg.id}`, 0, phone, text, now);
      await deliverOutboxForWamid(env, `error:${msg.id}`, services.whatsapp, now);
    } catch (sendError) {
      diagError(`no se pudo avisar del error wamid=${msg.id}:`, sendError);
    }
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
  const msgs = Array.from(extractMessages(payload));
  const statuses = Array.from(extractStatuses(payload));
  diag(`webhook POST received ${msgs.length} message(s), ${statuses.length} status(es)`);
  if (statuses.length) {
    ctx.waitUntil(applyMetaStatuses(env, statuses).catch((e) => diagError("status update failed:", e)));
  }
  for (const { msg, profile } of msgs) ctx.waitUntil(processMessage(env, msg, profile));
  return Response.json({ status: "ok" });
}

// ------------------------------------------------------------------ entrada del Worker
export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    setDebugContext(env);
    const url = new URL(req.url);
    try {
      // --- Rutas públicas de la PWA y el QR (sin autenticación) ---
      if (url.pathname === "/manifest.json" && req.method === "GET") return await manifestResponse(env);
      if (url.pathname === "/icon-192.png" && req.method === "GET") return iconResponse(ICON_192_BASE64);
      if (url.pathname === "/icon-512.png" && req.method === "GET") return iconResponse(ICON_512_BASE64);
      if (url.pathname === "/qr-recepcion" && req.method === "GET") {
        const s = await loadSettings(env);
        const baseUrl = new URL(req.url).origin;
        return qrRecepcionPage(env, s, baseUrl);
      }

      if (url.pathname === "/health") {
        try {
          await env.DB.prepare("SELECT 1").first();
          return Response.json({ ok: true });
        } catch (e) {
          return Response.json({ ok: false, error: "database unreachable" }, { status: 503 });
        }
      }
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
    setDebugContext(env);
    ctx.waitUntil((async () => {
      try {
        const now = nowLocal(env.SALON_TZ);
        await runReminders(env, now);
        // Recuperación de Fase 2: mensajes atascados y entregas pendientes/inciertas.
        await drainInbox(env, { bot, whatsapp });
        await deliverPendingOutbox(env, whatsapp);
        await db.cleanup(env.DB, now);
      } catch (e) { console.error("Fallo en la tarea programada:", e); }
    })());
  },

  // Consumidor de la cola local de WhatsApp
  async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext): Promise<void> {
    setDebugContext(env);
    for (const message of batch.messages) {
      const job = message.body as InboxJob;
      try {
        const result = await processQueueMessage(env, job, { bot, whatsapp });
        if (result.processed) message.ack();
        else if (result.deferred) message.retry({ delaySeconds: 2 });
        else message.retry({ delaySeconds: 30 });
      } catch (e) {
        diagError(`queue message failed wamid=${job?.id}:`, e);
        message.retry({ delaySeconds: 30 });
      }
    }
  },
} satisfies ExportedHandler<Env>;
