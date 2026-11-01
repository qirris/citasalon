/**
 * Consumer de WhatsApp.
 *
 * Flujo de un mensaje:
 *   1. Se toma el bloqueo del teléfono (fencing token monotónico).
 *   2. Se comprueba que sea el primer mensaje sin terminar de ese teléfono (orden estricto).
 *   3. El bot calcula respuesta + intención SIN escribir en D1.
 *   4. El Consumer ejecuta la intención (con idempotencia por WAMID / estado).
 *   5. Sesión, respuestas en el Outbox, secuencia y cierre del Inbox se guardan en un único
 *      `batch` atómico de D1.
 *   6. Se entrega el Outbox; si Meta falla, queda PENDING/FAILED/UNKNOWN para el cron.
 */
import * as bot from "./bot.ts";
import * as whatsapp from "./whatsapp.ts";
import * as db from "./db.ts";
import { loadSettings } from "./config.ts";
import { addMin, iso, nowLocal, parseDT } from "./time.ts";
import { diag, diagWarn, diagError } from "./debug.ts";
import type { BotService, WhatsAppService } from "./index.ts";
import type { BotMessage, Env, InboxJob, Intent } from "./types.ts";

export interface ProcessResult {
  processed: boolean;
  deferred?: boolean;
  error?: string;
}

const DEFAULT_SERVICES = { bot, whatsapp };
const MAX_ATTEMPTS = 5;

/** Entre 1 y 60 minutos de espera según el número de intentos. */
const retryMinutes = (attempts: number) => Math.min(60, 2 ** Math.max(0, attempts - 1));

const errorText = (e: unknown) => {
  const err = e as { message?: unknown } | null;
  const msg = String(err?.message ?? e ?? "");
  return msg;
};

/** La guarda de fencing abortó la transacción: otro worker tomó el teléfono. */
export const isFencingViolation = (e: unknown) => {
  const msg = errorText(e).toLowerCase();
  return msg.includes("tx_fencing_guard");
};
/** La guarda de negocio abortó la transacción: el estado cambió entre planificar y commitear. */
export const isBusinessViolation = (e: unknown) => {
  const msg = errorText(e).toLowerCase();
  return msg.includes("tx_business_guard") || msg.includes("check constraint failed");
};

interface Incoming {
  text: string;
  payload: string | null;
  unsupported?: boolean;
}

/** Normaliza texto/botones/listas de Meta a lo que espera el bot. */
export function extractIncoming(msg: any): Incoming {
  if (msg?.type === "text" && msg.text?.body) return { text: String(msg.text.body), payload: null };
  if (msg?.type === "interactive") {
    const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
    if (reply?.id) return { text: String(reply.title ?? reply.id), payload: String(reply.id) };
  }
  if (msg?.type === "button" && msg.button?.payload) {
    return { text: String(msg.button.text ?? msg.button.payload), payload: String(msg.button.payload) };
  }
  return { text: "", payload: null, unsupported: true };
}

export interface IntentPlan {
  /** Resultado previsto según el estado leído. Las guardas del batch lo confirman al commitear. */
  ok: boolean;
  /** Escrituras de negocio + guardas, listas para el `batch` atómico. */
  statements: D1PreparedStatement[];
}

/**
 * Planifica la intención devuelta por el bot **sin escribir**. Lee el estado actual y
 * construye las sentencias que irán dentro del mismo `batch` que la sesión, el Outbox, la
 * secuencia y el cierre del Inbox. Cada escritura lleva su propia guarda:
 *
 * - crear: `source_wamid` único + hueco libre del peluquero elegido;
 * - cancelar: la cita sigue confirmada y es del mismo teléfono (repetir = éxito sin escritura);
 * - reprogramar: la cita sigue confirmada y el nuevo hueco está libre (repetir = sin cambios).
 *
 * Si entre esta lectura y el commit alguien ocupa el hueco, la guarda de negocio revierte la
 * transacción entera; el Consumer vuelve a planificar y responde con `onFailure`.
 */
export async function planIntent(env: Env, intent: Intent, now: Date): Promise<IntentPlan> {
  const none: IntentPlan = { ok: false, statements: [] };
  const applied: IntentPlan = { ok: true, statements: [] };

  if (intent.type === "CREATE_APPOINTMENT") {
    const p = intent.payload;
    if (p.sourceWamid) {
      const already = await db.getApptByWamid(env.DB, p.sourceWamid);
      if (already) return applied; // reintento del mismo WAMID: no se duplica ni se audita
    }

    const start = parseDT(p.start);
    const end = addMin(start, p.service.minutes);
    for (const stylist of p.stylist ? [p.stylist] : p.stylists) {
      if (!(await db.slotIsFree(env.DB, stylist, start, end))) continue;
      return {
        ok: true,
        statements: [
          db.businessGuardStatement(
            env.DB,
            `NOT EXISTS (SELECT 1 FROM appointments
                          WHERE status IN ('confirmed','done') AND stylist=? AND starts_at < ? AND ends_at > ?)
              AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM appointments WHERE source_wamid = ?))`,
            stylist, iso(end), iso(start), p.sourceWamid || null, p.sourceWamid || null,
          ),
          db.insertAppointmentStatement(env.DB, {
            phone: p.phone, name: p.name, service: p.service, start,
            stylists: p.stylists, stylist, source: p.source,
            sourceWamid: p.sourceWamid || undefined, now: parseDT(p.now),
          }),
          db.auditCreatedAppointmentStatement(env.DB, now, p.sourceWamid,
            `${p.name} · ${p.service.name} · ${p.start} · ${stylist}`),
        ],
      };
    }
    return none; // todos los peluqueros posibles están ocupados
  }

  if (intent.type === "CANCEL_APPOINTMENT") {
    const p = intent.payload;
    const current = await db.getAppt(env.DB, p.id);
    if (!current || current.phone !== p.phone) return none;
    if (current.status === "cancelled") return applied; // reintento: ya estaba cancelada
    if (current.status !== "confirmed") return none;
    return {
      ok: true,
      statements: [
        db.businessGuardStatement(env.DB,
          "EXISTS (SELECT 1 FROM appointments WHERE id=? AND phone=? AND status='confirmed')",
          p.id, p.phone),
        db.cancelOwnStatement(env.DB, p.id, p.phone, parseDT(p.now)),
        db.auditStatement(env.DB, now, "whatsapp", "cancelar", p.id, `${current.name} · ${current.starts_at}`),
      ],
    };
  }

  const p = intent.payload;
  const current = await db.getAppt(env.DB, p.id);
  if (!current || current.phone !== p.phone || current.status !== "confirmed") return none;

  const start = parseDT(p.start);
  const end = addMin(start, p.service.minutes);
  if (!(await db.slotIsFree(env.DB, p.stylist, start, end, p.id))) return none;

  const changed = current.starts_at !== p.start || current.stylist !== p.stylist || current.service_id !== p.service.id;
  const statements = [
    db.businessGuardStatement(
      env.DB,
      `EXISTS (SELECT 1 FROM appointments WHERE id=? AND phone=? AND status='confirmed')
       AND NOT EXISTS (SELECT 1 FROM appointments
                        WHERE id != ? AND status IN ('confirmed','done') AND stylist=? AND starts_at < ? AND ends_at > ?)`,
      p.id, p.phone, p.id, p.stylist, iso(end), iso(start),
    ),
    db.updateAppointmentStatement(env.DB, p.id, {
      name: p.name, phone: p.phone, service: p.service, stylist: p.stylist,
      start, notes: p.notes,
    }, parseDT(p.now)),
  ];
  if (changed) {
    statements.push(db.auditStatement(env.DB, now, "whatsapp", "editar", p.id,
      `${p.name} · ${p.service.name} · ${p.start}`));
  }
  return { ok: true, statements };
}

/**
 * Procesa una fila concreta del Inbox. Devuelve `deferred` cuando todavía no toca:
 * otro worker tiene el teléfono, falta un mensaje anterior o el reintento está en espera.
 */
export async function processInboxRow(
  env: Env, row: db.InboxRow, services: { bot: BotService; whatsapp: WhatsAppService } = DEFAULT_SERVICES,
): Promise<ProcessResult> {
  const now = nowLocal(env.SALON_TZ);
  const workerId = crypto.randomUUID();
  const token = await db.acquireLock(env.DB, row.phone, workerId, now);
  if (token === null) return { processed: false, deferred: true };

  try {
    const last = await db.getLastProcessedSequence(env.DB, row.phone);
    if (row.sequence <= last) {
      // Entrega duplicada de la cola: el trabajo ya está hecho. La guarda impide que un
      // worker con el token caducado cierre una fila ajena.
      await db.completeDuplicateInbox(env.DB, {
        phone: row.phone, inboxId: row.id, now,
        lock: { workerId, token },
      });
      return { processed: true };
    }

    const first = await db.firstUnfinishedInbox(env.DB, row.phone);
    if (!first) return { processed: true };
    if (first.id !== row.id) {
      diag(`defer wamid=${row.id} reason=older-pending first=${first.id}`);
      return { processed: false, deferred: true };
    }
    if (first.next_attempt_at && first.next_attempt_at > iso(now)) {
      diag(`defer wamid=${row.id} reason=retry-at ${first.next_attempt_at}`);
      return { processed: false, deferred: true };
    }

    const s = await loadSettings(env);
    const session = (await db.getSession(env.DB, row.phone, now, s.sessionTtlMinutes))
      ?? { state: "MENU", data: {}, expired: false };
    const stored = JSON.parse(row.payload) as { msg: any; profile: string | null };
    const incoming = extractIncoming(stored.msg);

    let result: bot.BotResult;
    if (incoming.unsupported) {
      result = {
        replies: ["Solo entiendo texto y botones 🙂 Escribe *hola* para ver el menú."],
        state: session.state, data: session.data, intent: null,
      };
    } else {
      result = await services.bot.handleMessage(
        env, row.phone, incoming.text, stored.profile, now, incoming.payload,
        { ...session, wamid: row.id },
      );
    }

    const intent = result.intent;
    let plan: IntentPlan = { ok: true, statements: [] };
    if (intent) plan = await planIntent(env, intent, now);

    // El commit es UN batch: guarda de fencing + escrituras de negocio + sesión + Outbox +
    // secuencia + cierre del Inbox. No hay ninguna escritura suelta antes de la guarda.
    // Si la guarda de negocio falla, se vuelve a planificar y se reintentar con onFailure.
    // Si el plan no es ok (ej. hueco ocupado), aún commiteamos con business: [] para
    // guardar la sesión, el Outbox de fallo y cerrar el Inbox.
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = intent
        ? (plan.ok ? intent.onSuccess : intent.onFailure)
        : { state: result.state, data: result.data, replies: result.replies };
      try {
        await db.commitInboxProcessing(env.DB, {
          phone: row.phone, inboxId: row.id, sequence: row.sequence,
          state: outcome.state, data: outcome.data, replies: outcome.replies, now,
          lock: { workerId, token },
          business: plan.ok ? plan.statements : [],
        });
        if (intent) diag(`intent=${intent.type} wamid=${row.id} applied=${plan.ok}`);
        break;
      } catch (e) {
        if (isFencingViolation(e)) {
          diag(`lost lock wamid=${row.id} phone=${row.phone.slice(0, 2)}…`);
          return { processed: false, deferred: true };
        }
        if (intent && isBusinessViolation(e) && attempt === 0 && plan.ok) {
          // El hueco/estado cambió entre la lectura y el commit. La transacción ya se revirtió:
          // se vuelve a leer y se responde con el resultado real (normalmente onFailure).
          diag(`business guard retry wamid=${row.id} intent=${intent.type}`);
          plan = await planIntent(env, intent, now);
          continue;
        }
        // Si el business guard falló aunque el plan decía ok (slotIsFree no detectó el
        // conflicto), respondemos con onFailure sin guardas de negocio. El batch ya se
        // revirtió; commiteamos sesión + Outbox + cierre de Inbox sin escribir citas.
        if (intent && isBusinessViolation(e)) {
          diag(`business violation fallback wamid=${row.id} intent=${intent.type}`);
          await db.commitInboxProcessing(env.DB, {
            phone: row.phone, inboxId: row.id, sequence: row.sequence,
            state: intent.onFailure.state, data: intent.onFailure.data, replies: intent.onFailure.replies, now,
            lock: { workerId, token },
            business: [],
          });
          break;
        }
        throw e;
      }
    }

    try {
      await deliverOutboxForWamid(env, row.id, services.whatsapp, now);
    } catch (deliveryError) {
      // El commit ya está hecho: el Outbox queda PENDING y lo reintenta el cron. No se debe
      // marcar el Inbox como fallido ni volver a aplicar la intención.
      diagError(`outbox delivery failed wamid=${row.id}:`, deliveryError);
    }
    return { processed: true };
  } catch (e) {
    diagError(`processing failed wamid=${row.id}:`, e);
    const failure = await db.markInboxFailed(env.DB, row.id, now, String(e));
    diag(`inbox failed wamid=${row.id} attempts=${failure.attempts} dead=${failure.dead}`);
    if (failure.dead) {
      // Se agotaron los reintentos: el cliente recibe un aviso en vez de silencio.
      try {
        const text = "Lo siento, no he podido completar tu solicitud. Inténtalo de nuevo en un momento.";
        await db.createOutboxMessage(env.DB, `error:${row.id}`, 0, row.phone, text, now);
        await deliverOutboxForWamid(env, `error:${row.id}`, services.whatsapp, now);
      } catch (notifyError) {
        diagError(`no se pudo avisar del fallo wamid=${row.id}:`, notifyError);
      }
    }
    return { processed: false, error: String(e) };
  } finally {
    await db.releaseLock(env.DB, row.phone, workerId, token);
  }
}

/** Entrada de la cola: procesa el WAMID indicado respetando el orden del teléfono. */
export async function processQueueMessage(
  env: Env, job: InboxJob, services: { bot: BotService; whatsapp: WhatsAppService } = DEFAULT_SERVICES,
): Promise<ProcessResult> {
  const row = await db.getInboxMessage(env.DB, job.id);
  if (!row) {
    diag(`message not found in inbox wamid=${job.id}`);
    return { processed: false, error: "not-found" };
  }
  if (row.status === "COMPLETED" || row.status === "DEAD") return { processed: true };
  return processInboxRow(env, row, services);
}

/**
 * Procesa en orden todo lo pendiente (rápido para el webhook local y recuperación del cron).
 * Cada teléfono avanza como máximo un mensaje por ronda para no romper el orden.
 */
export async function drainInbox(
  env: Env, services: { bot: BotService; whatsapp: WhatsAppService } = DEFAULT_SERVICES, limit = 50,
): Promise<number> {
  let processed = 0;
  for (let round = 0; round < limit; round++) {
    const phones = await db.phonesWithUnfinished(env.DB, 50);
    if (!phones.length) break;
    let progressed = false;
    for (const phone of phones) {
      const first = await db.firstUnfinishedInbox(env.DB, phone);
      if (!first) continue;
      const now = nowLocal(env.SALON_TZ);
      if (first.next_attempt_at && first.next_attempt_at > iso(now)) continue;
      const r = await processInboxRow(env, first, services);
      if (r.processed) { processed++; progressed = true; }
      if (processed >= limit) break;
    }
    if (!progressed) break;
  }
  return processed;
}

/** Entrega una fila del Outbox. `claimOutboxDelivery` garantiza un solo intento a la vez. */
async function deliverRow(
  env: Env, row: db.OutboxRow, whatsappService: WhatsAppService, now: Date,
): Promise<boolean> {
  const claimed = await db.claimOutboxDelivery(env.DB, row.wamid_origin, row.message_index, now);
  if (!claimed) return false;
  let payload: BotMessage;
  try {
    payload = JSON.parse(claimed.payload) as BotMessage;
  } catch {
    await db.markOutboxFailed(env.DB, row.wamid_origin, row.message_index, "FAILED", "payload inválido", null, now);
    return false;
  }

  const result = await whatsappService.send(env, claimed.dest_phone, payload);
  if (result.ok) {
    await db.markOutboxSent(env.DB, row.wamid_origin, row.message_index,
      result.wamid ?? null, result.simulated ? "simulated" : "accepted", now);
    diag(`outbox SENT origin=${row.wamid_origin} idx=${row.message_index} simulated=${result.simulated}`);
    return true;
  }

  // Sin código HTTP el resultado es incierto (timeout/red): UNKNOWN, se conserva para
  // reconciliación y NUNCA se reenvía automáticamente (podría duplicar el mensaje).
  if (result.status === undefined) {
    await db.markOutboxFailed(env.DB, row.wamid_origin, row.message_index,
      "UNKNOWN", result.error ?? "sin respuesta HTTP", null, now);
    diagWarn(`outbox UNKNOWN origin=${row.wamid_origin} idx=${row.message_index} attempts=${claimed.attempts ?? 1} (sin reintento automático)`);
    return false;
  }

  // Error HTTP: 4xx definitivo (salvo 408/429) no se reintenta; 5xx, 408 y 429 son temporales.
  const attempts = claimed.attempts ?? 1;
  const retryable = result.status === 408 || result.status === 429 || result.status >= 500;
  const retryAt = retryable && attempts < MAX_ATTEMPTS ? addMin(now, retryMinutes(attempts)) : null;
  await db.markOutboxFailed(env.DB, row.wamid_origin, row.message_index,
    "FAILED", result.error ?? `HTTP ${result.status}`, retryAt, now);
  diagWarn(`outbox FAILED origin=${row.wamid_origin} idx=${row.message_index} status=${result.status} attempts=${attempts} retryable=${retryable} retryAt=${retryAt ? iso(retryAt) : "no"}`);
  return false;
}

/** Entrega las respuestas generadas por un mensaje concreto. */
export async function deliverOutboxForWamid(
  env: Env, wamidOrigin: string, whatsappService: WhatsAppService = whatsapp,
  now: Date = nowLocal(env.SALON_TZ),
): Promise<number> {
  let sent = 0;
  for (const row of await db.outboxForWamid(env.DB, wamidOrigin)) {
    // SENT/SENDING se están entregando ya; UNKNOWN es terminal y no se reenvía.
    if (row.status !== "PENDING" && row.status !== "FAILED") continue;
    if (await deliverRow(env, row, whatsappService, now)) sent++;
  }
  return sent;
}

/** Reintenta todo lo que el Outbox dejó pendiente o incierto. */
export async function deliverPendingOutbox(
  env: Env, whatsappService: WhatsAppService = whatsapp, limit = 20,
): Promise<number> {
  const now = nowLocal(env.SALON_TZ);
  await db.reclaimStaleSending(env.DB, now);
  let sent = 0;
  for (const row of await db.pendingOutbox(env.DB, now, limit)) {
    if (await deliverRow(env, row, whatsappService, now)) sent++;
  }
  return sent;
}

/** Aplica los acuses de Meta (sent/delivered/read/failed) al Outbox por WAMID. */
export async function applyMetaStatuses(env: Env, statuses: any[], now = nowLocal(env.SALON_TZ)): Promise<number> {
  let updated = 0;
  for (const st of statuses) {
    if (!st?.id || !st?.status) continue;
    await db.updateOutboxMetaStatus(env.DB, String(st.id), String(st.status), now);
    updated++;
  }
  return updated;
}
