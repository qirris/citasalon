import type { Appt, BotMessage, Role, Service } from "./types.ts";
import { addMin, iso, parseDT } from "./time.ts";

// ------------------------------------------------------------------ conversación de WhatsApp
export async function getSession(db: D1Database, phone: string, now: Date, ttlMin: number): Promise<{ state: string; data: Record<string, any>; expired: boolean } | null> {
  const row = await db.prepare("SELECT state, data, updated_at FROM sessions WHERE phone = ?")
    .bind(phone).first<{ state: string; data: string; updated_at: string }>();
  if (!row) return null;
  const expired = now.getTime() - parseDT(row.updated_at).getTime() > ttlMin * 60000;
  if (expired) {
    // No borramos aquí para poder mostrar aviso; el caller decide qué hacer
    return { state: row.state, data: JSON.parse(row.data) as Record<string, any>, expired: true };
  }
  return { state: row.state, data: JSON.parse(row.data) as Record<string, any>, expired: false };
}

export async function saveSession(db: D1Database, phone: string, state: string, data: object, now: Date) {
  await db.prepare(
    "INSERT INTO sessions(phone, state, data, updated_at) VALUES (?,?,?,?) " +
    "ON CONFLICT(phone) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=excluded.updated_at",
  ).bind(phone, state, JSON.stringify(data), iso(now)).run();
}

export async function clearSession(db: D1Database, phone: string) {
  await db.prepare("DELETE FROM sessions WHERE phone = ?").bind(phone).run();
}

/** true la primera vez que vemos este mensaje; false si es un reintento de Meta */
export async function markMessageSeen(db: D1Database, id: string, now: Date): Promise<boolean> {
  const r = await db.prepare("INSERT OR IGNORE INTO processed_messages(id, created_at) VALUES (?, ?)")
    .bind(id, iso(now)).run();
  return r.meta.changes === 1;
}

/** Libera un mensaje reclamado si su procesamiento falló, para que el reintento de Meta no se pierda. */
export async function forgetMessage(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM processed_messages WHERE id = ?").bind(id).run();
}

// ------------------------------------------------------------------ citas
export async function getAppt(db: D1Database, id: number): Promise<Appt | null> {
  return db.prepare("SELECT * FROM appointments WHERE id = ?").bind(id).first<Appt>();
}

export interface NewAppt {
  phone: string;
  name: string;
  service: Service;
  start: Date;
  stylists: string[];       // peluqueros entre los que elegir
  stylist?: string;         // si se pide uno concreto
  source: Appt["source"];
  notes?: string;
  now: Date;
  /** WAMID del mensaje de WhatsApp que originó la cita (idempotencia en reintentos). */
  sourceWamid?: string;
}

export async function getApptByWamid(db: D1Database, wamid: string): Promise<Appt | null> {
  return db.prepare("SELECT * FROM appointments WHERE source_wamid = ?").bind(wamid).first<Appt>();
}

/**
 * Crea la cita de forma idempotente: cada INSERT comprueba solape y WAMID dentro de la misma
 * sentencia. Si el mismo mensaje se reintenta, devuelve la cita ya creada en vez de duplicarla.
 */
export async function createAppointment(db: D1Database, a: NewAppt): Promise<Appt | null> {
  const start = iso(a.start);
  const end = iso(addMin(a.start, a.service.minutes));
  const now = iso(a.now);

  if (a.sourceWamid) {
    const existing = await getApptByWamid(db, a.sourceWamid);
    if (existing) return existing;
  }

  for (const stylist of a.stylist ? [a.stylist] : a.stylists) {
    const r = await db.prepare(
      `INSERT INTO appointments (phone,name,service_id,service_name,stylist,starts_at,ends_at,source,notes,created_at,updated_at,source_wamid)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?
       WHERE NOT EXISTS (SELECT 1 FROM appointments
                         WHERE status IN ('confirmed', 'done') AND stylist=? AND starts_at < ? AND ends_at > ?)
         AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM appointments WHERE source_wamid = ?))`,
    ).bind(a.phone, a.name, a.service.id, a.service.name, stylist, start, end, a.source, a.notes ?? "",
      now, now, a.sourceWamid ?? null, stylist, end, start, a.sourceWamid ?? null, a.sourceWamid ?? null).run();
    if (r.meta.changes === 1) return getAppt(db, r.meta.last_row_id as number);
    if (a.sourceWamid) {
      const existing = await getApptByWamid(db, a.sourceWamid);
      if (existing) return existing;
    }
  }
  return null;
}

export interface EditAppt {
  name: string;
  phone: string;
  service: Service;
  stylist: string;
  start: Date;
  notes: string;
}

export async function updateAppointment(
  db: D1Database, id: number, e: EditAppt, now: Date,
): Promise<"ok" | "clash" | "missing" | "cancelled"> {
  const start = iso(e.start);
  const end = iso(addMin(e.start, e.service.minutes));
  const r = await db.prepare(
    `UPDATE appointments
        SET name=?, phone=?, service_id=?, service_name=?, stylist=?, starts_at=?, ends_at=?, notes=?, updated_at=?,
            reminder_sent = CASE WHEN starts_at != ? THEN 0 ELSE reminder_sent END
      WHERE id=? AND status='confirmed'
        AND NOT EXISTS (SELECT 1 FROM appointments
                        WHERE id != ? AND status IN ('confirmed', 'done') AND stylist=? AND starts_at < ? AND ends_at > ?)`,
  ).bind(e.name, e.phone, e.service.id, e.service.name, e.stylist, start, end, e.notes, iso(now),
    start, id, id, e.stylist, end, start).run();
  if (r.meta.changes === 1) return "ok";
  const row = await getAppt(db, id);
  if (!row) return "missing";
  return row.status !== "confirmed" ? "cancelled" : "clash";
}

export async function setStatus(db: D1Database, id: number, status: "confirmed" | "cancelled" | "done", now: Date) {
  // al restaurar, se comprueba que el hueco siga libre
  const r = await db.prepare(
    `UPDATE appointments SET status=?, updated_at=?
      WHERE id=? AND status != ?
        AND (? = 'cancelled' OR NOT EXISTS (
              SELECT 1 FROM appointments o, appointments me
               WHERE me.id = ? AND o.id != me.id AND o.status IN ('confirmed', 'done') AND o.stylist=me.stylist
                 AND o.starts_at < me.ends_at AND o.ends_at > me.starts_at))`,
  ).bind(status, iso(now), id, status, status, id).run();
  return r.meta.changes === 1;
}

export async function deleteAppointment(db: D1Database, id: number) {
  await db.prepare("DELETE FROM appointments WHERE id = ?").bind(id).run();
}

export async function futureAppointments(db: D1Database, phone: string, now: Date): Promise<Appt[]> {
  const r = await db.prepare(
    "SELECT * FROM appointments WHERE phone=? AND status='confirmed' AND starts_at > ? ORDER BY starts_at",
  ).bind(phone, iso(now)).all<Appt>();
  return r.results;
}

export async function allFutureAppointments(db: D1Database, phone: string, now: Date): Promise<Appt[]> {
  const r = await db.prepare(
    "SELECT * FROM appointments WHERE phone=? AND status='confirmed' AND starts_at > ? ORDER BY starts_at",
  ).bind(phone, iso(now)).all<Appt>();
  return r.results;
}

/** El cliente solo puede cancelar sus propias citas (el teléfono tiene que coincidir) */
export async function cancelOwn(db: D1Database, id: number, phone: string, now: Date): Promise<boolean> {
  const r = await db.prepare(
    "UPDATE appointments SET status='cancelled', updated_at=? WHERE id=? AND phone=? AND status='confirmed'",
  ).bind(iso(now), id, phone).run();
  return r.meta.changes === 1;
}

export async function getOwn(db: D1Database, id: number, phone: string): Promise<Appt | null> {
  return db.prepare("SELECT * FROM appointments WHERE id=? AND phone=? AND status='confirmed'")
    .bind(id, phone).first<Appt>();
}

// ------------------------------------------------------------------ escrituras planificadas (Fase 2)
// El Consumer NO ejecuta escrituras de negocio por su cuenta: las planifica (leyendo el
// estado actual) y las entrega al `batch` atómico de `commitInboxProcessing`, donde van
// precedidas por la guarda del fencing token. Si una guarda falla, D1 revierte todo.

/** ¿Está libre el hueco de ese peluquero? `ignoreId` excluye la propia cita al reprogramar. */
export async function slotIsFree(
  db: D1Database, stylist: string, start: Date, end: Date, ignoreId?: number,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS ok FROM appointments
      WHERE status IN ('confirmed','done') AND stylist=? AND starts_at < ? AND ends_at > ?
        AND (? IS NULL OR id != ?)
      LIMIT 1`,
  ).bind(stylist, iso(start), iso(end), ignoreId ?? null, ignoreId ?? null).first<{ ok: number }>();
  return !row;
}

/** Sentencia INSERT de una cita para un peluquero ya elegido (se ejecuta dentro del batch). */
export function insertAppointmentStatement(
  db: D1Database, a: NewAppt & { stylist: string },
): D1PreparedStatement {
  const start = iso(a.start);
  const end = iso(addMin(a.start, a.service.minutes));
  const now = iso(a.now);
  return db.prepare(
    `INSERT INTO appointments (phone,name,service_id,service_name,stylist,starts_at,ends_at,source,notes,created_at,updated_at,source_wamid)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?
     WHERE NOT EXISTS (SELECT 1 FROM appointments
                       WHERE status IN ('confirmed', 'done') AND stylist=? AND starts_at < ? AND ends_at > ?)
       AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM appointments WHERE source_wamid = ?))`,
  ).bind(a.phone, a.name, a.service.id, a.service.name, a.stylist, start, end, a.source, a.notes ?? "",
    now, now, a.sourceWamid ?? null, a.stylist, end, start, a.sourceWamid ?? null, a.sourceWamid ?? null);
}

/** Sentencia UPDATE de reprogramación (idempotente: repetirla no cambia nada). */
export function updateAppointmentStatement(
  db: D1Database, id: number, e: EditAppt, now: Date,
): D1PreparedStatement {
  const start = iso(e.start);
  const end = iso(addMin(e.start, e.service.minutes));
  return db.prepare(
    `UPDATE appointments
        SET name=?, phone=?, service_id=?, service_name=?, stylist=?, starts_at=?, ends_at=?, notes=?, updated_at=?,
            reminder_sent = CASE WHEN starts_at != ? THEN 0 ELSE reminder_sent END
      WHERE id=? AND status='confirmed'
        AND NOT EXISTS (SELECT 1 FROM appointments
                        WHERE id != ? AND status IN ('confirmed', 'done') AND stylist=? AND starts_at < ? AND ends_at > ?)`,
  ).bind(e.name, e.phone, e.service.id, e.service.name, e.stylist, start, end, e.notes, iso(now),
    start, id, id, e.stylist, end, start);
}

/** Sentencia UPDATE de cancelación del cliente (solo su propia cita y si sigue confirmada). */
export function cancelOwnStatement(db: D1Database, id: number, phone: string, now: Date): D1PreparedStatement {
  return db.prepare(
    "UPDATE appointments SET status='cancelled', updated_at=? WHERE id=? AND phone=? AND status='confirmed'",
  ).bind(iso(now), id, phone);
}

export function auditStatement(
  db: D1Database, now: Date, role: Role | "whatsapp", action: string, apptId: number | null, detail = "",
): D1PreparedStatement {
  return db.prepare("INSERT INTO audit_log(at, role, action, appt_id, detail) VALUES (?,?,?,?,?)")
    .bind(iso(now), role, action, apptId, detail.slice(0, 300));
}

/**
 * Auditoría de una cita recién creada. El `id` se resuelve por `source_wamid` dentro de la
 * misma transacción: si la cita no se insertó, tampoco se escribe la auditoría.
 */
export function auditCreatedAppointmentStatement(
  db: D1Database, now: Date, sourceWamid: string, detail: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_log(at, role, action, appt_id, detail)
     SELECT ?, 'whatsapp', 'crear', id, ? FROM appointments WHERE source_wamid = ?`,
  ).bind(iso(now), detail.slice(0, 300), sourceWamid);
}

/**
 * Guarda de fencing: se coloca como PRIMERA sentencia del batch. Si el token ya no es
 * válido inserta una fila en `tx_fencing_guard`, cuyo CHECK falla y revierte toda la
 * transacción. Así no existe la ventana "comprobar después de escribir".
 */
export function lockGuardStatement(
  db: D1Database, phone: string, workerId: string, token: number, now: Date,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO tx_fencing_guard(violation)
     SELECT 1 WHERE NOT EXISTS (
       SELECT 1 FROM phone_locks
        WHERE phone=? AND worker_id=? AND fencing_token=? AND expires_at > ?)`,
  ).bind(phone, workerId, token, now.toISOString());
}

/**
 * Guarda de negocio: si `condition` (expresión SQL booleana) no se cumple, aborta el batch.
 * Se usa para que el estado leído al planificar siga siendo cierto al commitear.
 */
export function businessGuardStatement(
  db: D1Database, condition: string, ...params: (string | number | null)[]
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO tx_business_guard(violation) SELECT 1 WHERE NOT (${condition})`,
  ).bind(...params);
}

export async function getOwnAny(db: D1Database, id: number, phone: string): Promise<Appt | null> {
  return db.prepare("SELECT * FROM appointments WHERE id=? AND phone=? AND status='confirmed'")
    .bind(id, phone).first<Appt>();
}

export async function lastNameFor(db: D1Database, phone: string): Promise<string | null> {
  const row = await db.prepare("SELECT name FROM appointments WHERE phone=? ORDER BY id DESC LIMIT 1")
    .bind(phone).first<{ name: string }>();
  return row?.name ?? null;
}

export async function appointmentsForDay(db: D1Database, day: string, includeCancelled = false): Promise<Appt[]> {
  const r = await db.prepare(
    `SELECT * FROM appointments WHERE starts_at >= ? AND starts_at <= ? ${includeCancelled ? "" : "AND status != 'cancelled'"}
     ORDER BY starts_at, stylist`,
  ).bind(`${day}T00:00`, `${day}T23:59`).all<Appt>();
  return r.results;
}

export async function searchAppointments(
  db: D1Database, o: { from?: string; to?: string; q?: string; status?: string; limit?: number },
): Promise<Appt[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (o.from) { where.push("starts_at >= ?"); args.push(`${o.from}T00:00`); }
  if (o.to) { where.push("starts_at <= ?"); args.push(`${o.to}T23:59`); }
  if (o.status === "confirmed" || o.status === "cancelled") { where.push("status = ?"); args.push(o.status); }
  if (o.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')");
    const like = `%${o.q.replace(/[\\%_]/g, "\\$&")}%`;
    args.push(like, like);
  }
  const sql = `SELECT * FROM appointments ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY starts_at DESC LIMIT ?`;
  args.push(o.limit ?? 200);
  return (await db.prepare(sql).bind(...args).all<Appt>()).results;
}

/** Número de citas (confirmadas o canceladas) que usan un servicio. */
export async function countAppointmentsForService(db: D1Database, serviceId: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE service_id = ?")
    .bind(serviceId).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Próximas citas confirmadas desde `from` (inclusive), para que una reserva hecha por WhatsApp
 * para otro día no quede invisible al abrir la agenda en el día de hoy.
 */
export async function upcomingConfirmed(db: D1Database, from: string, limit = 5): Promise<Appt[]> {
  const r = await db.prepare(
    "SELECT * FROM appointments WHERE status='confirmed' AND starts_at >= ? ORDER BY starts_at, stylist, id LIMIT ?",
  ).bind(`${from}T00:00`, limit).all<Appt>();
  return r.results;
}

/** Citas (confirmadas y canceladas) cuyo inicio cae entre dos días inclusive */
export async function appointmentsInRange(db: D1Database, from: string, to: string): Promise<Appt[]> {
  const r = await db.prepare(
    "SELECT * FROM appointments WHERE starts_at >= ? AND starts_at <= ? ORDER BY starts_at, stylist, id",
  ).bind(`${from}T00:00`, `${to}T23:59`).all<Appt>();
  return r.results;
}

export async function dueReminders(db: D1Database, now: Date): Promise<Appt[]> {
  // citas de las próximas 24 h, sin recordatorio, y reservadas con más de 24 h de antelación
  const r = await db.prepare(
    "SELECT * FROM appointments WHERE status='confirmed' AND reminder_sent=0 AND phone != '' AND starts_at > ? AND starts_at <= ?",
  ).bind(iso(now), iso(addMin(now, 24 * 60))).all<Appt>();
  return r.results.filter((a) => parseDT(a.created_at).getTime() < parseDT(a.starts_at).getTime() - 24 * 3600000);
}

export async function markReminderSent(db: D1Database, id: number) {
  await db.prepare("UPDATE appointments SET reminder_sent=1 WHERE id=?").bind(id).run();
}

// ------------------------------------------------------------------ historial y seguridad
export async function audit(
  db: D1Database, now: Date, role: Role | "whatsapp", action: string, apptId: number | null, detail = "",
) {
  await db.prepare("INSERT INTO audit_log(at, role, action, appt_id, detail) VALUES (?,?,?,?,?)")
    .bind(iso(now), role, action, apptId, detail.slice(0, 300)).run();
}

export async function listAudit(db: D1Database, limit = 200) {
  return (await db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").bind(limit).all<{
    id: number; at: string; role: string; action: string; appt_id: number | null; detail: string;
  }>()).results;
}

// ------------------------------------------------------------------ WhatsApp Inbox
export interface InboxRow {
  id: string;
  phone: string;
  payload: string;
  sequence: number;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface OutboxRow {
  wamid_origin: string;
  message_index: number;
  dest_phone: string;
  payload: string;
  status: string;
  meta_status: string | null;
  wamid_sent: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Guarda el mensaje en el Inbox y le asigna la siguiente secuencia **del teléfono**.
 * El WAMID es la clave primaria: un reintento de Meta no crea una segunda fila ni
 * consume una secuencia. La secuencia se calcula dentro del mismo INSERT para no
 * dejar huecos por duplicados concurrentes.
 */
export async function saveInboxMessage(
  db: D1Database, msg: any, profile: string | null, phone: string, now: Date,
): Promise<InboxRow | null> {
  const at = iso(now);
  const insert = () => db.prepare(
    `INSERT INTO inbox_messages (id, phone, payload, sequence, status, attempts, created_at, updated_at)
     SELECT ?,?,?,COALESCE((SELECT MAX(sequence) FROM inbox_messages WHERE phone=?),0)+1,'PENDING',0,?,?
     WHERE NOT EXISTS (SELECT 1 FROM inbox_messages WHERE id=?)`,
  ).bind(msg.id, phone, JSON.stringify({ msg, profile }), phone, at, at, msg.id).run();

  for (let intento = 0; intento < 2; intento++) {
    try {
      const r = await insert();
      if (r.meta.changes !== 1) return null;
      return getInboxMessage(db, msg.id);
    } catch (e) {
      if (!String(e).toUpperCase().includes("UNIQUE")) throw e;
      // Si la fila ya existe, era una entrega duplicada del mismo WAMID.
      if (await getInboxMessage(db, msg.id)) return null;
      // Si no existe, chocó la secuencia de otro insert simultáneo: se recalcula una vez.
    }
  }
  throw new Error(`no se pudo guardar en el Inbox el mensaje ${msg.id}`);
}

export async function getInboxMessage(db: D1Database, id: string): Promise<InboxRow | null> {
  return db.prepare("SELECT * FROM inbox_messages WHERE id = ?").bind(id).first<InboxRow>();
}

export async function getLastProcessedSequence(db: D1Database, phone: string): Promise<number> {
  const row = await db.prepare("SELECT last_processed_seq FROM phone_sequences WHERE phone = ?")
    .bind(phone).first<{ last_processed_seq: number }>();
  return row?.last_processed_seq ?? 0;
}

export async function setLastProcessedSequence(db: D1Database, phone: string, seq: number) {
  await db.prepare(
    "INSERT INTO phone_sequences (phone, last_processed_seq) VALUES (?, ?) " +
    "ON CONFLICT(phone) DO UPDATE SET last_processed_seq = MAX(phone_sequences.last_processed_seq, excluded.last_processed_seq)",
  ).bind(phone, seq).run();
}

export async function updateInboxStatus(db: D1Database, id: string, status: string, now?: Date) {
  if (now) {
    await db.prepare("UPDATE inbox_messages SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, iso(now), id).run();
  } else {
    await db.prepare("UPDATE inbox_messages SET status = ? WHERE id = ?").bind(status, id).run();
  }
}

/** Intentos máximos del Inbox antes de darlo por perdido (DEAD) y avisar al cliente. */
export const MAX_INBOX_ATTEMPTS = 5;

/**
 * Marca el mensaje como fallido y calcula el siguiente intento con backoff exponencial
 * (1, 2, 4, 8… minutos, tope 30). Al llegar al 5º fallo (attempts=5) pasa a DEAD: 
 * sale del orden del teléfono, se avisa al cliente y no se reintenta más.
 * 
 * Flujo: fallo 1 (espera 1min) → fallo 2 (espera 2min) → fallo 3 (espera 4min) 
 *        → fallo 4 (espera 8min) → fallo 5 (DEAD, sin reintento).
 */
export async function markInboxFailed(
  db: D1Database, id: string, now: Date, error: string,
): Promise<{ attempts: number; dead: boolean }> {
  const at = iso(now);
  await db.prepare(
    `UPDATE inbox_messages
        SET status='FAILED', attempts=COALESCE(attempts,0)+1, last_error=?, updated_at=?
      WHERE id=?`,
  ).bind(error.slice(0, 300), at, id).run();
  const row = await db.prepare("SELECT attempts FROM inbox_messages WHERE id=?")
    .bind(id).first<{ attempts: number }>();
  const attempts = row?.attempts ?? 1;
  if (attempts >= MAX_INBOX_ATTEMPTS) {
    await db.prepare("UPDATE inbox_messages SET status='DEAD', next_attempt_at=NULL WHERE id=?")
      .bind(id).run();
    return { attempts, dead: true };
  }
  const retryAt = iso(addMin(now, Math.min(30, 2 ** (attempts - 1))));
  await db.prepare("UPDATE inbox_messages SET next_attempt_at=? WHERE id=?")
    .bind(retryAt, id).run();
  return { attempts, dead: false };
}

export async function pendingInbox(
  db: D1Database, now: Date, limit = 20, phone?: string,
): Promise<InboxRow[]> {
  const at = iso(now);
  const sql = `SELECT * FROM inbox_messages
                WHERE status IN ('PENDING','QUEUED','FAILED')
                  AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                  ${phone ? "AND phone = ?" : ""}
                ORDER BY sequence LIMIT ?`;
  const stmt = db.prepare(sql).bind(...(phone ? [at, phone, limit] : [at, limit]));
  return (await stmt.all<InboxRow>()).results;
}

/**
 * Primer mensaje sin terminar de un teléfono, aunque todavía no toque reintentarlo.
 * Es la base del procesamiento ordenado: nunca se adelanta el mensaje 2 si el 1 sigue vivo.
 */
export async function firstUnfinishedInbox(db: D1Database, phone: string): Promise<InboxRow | null> {
  return db.prepare(
    `SELECT * FROM inbox_messages
      WHERE phone = ? AND status IN ('PENDING','QUEUED','FAILED')
      ORDER BY sequence LIMIT 1`,
  ).bind(phone).first<InboxRow>();
}

/** Teléfonos con algún mensaje sin terminar (para drenar la cola desde el cron o el webhook). */
export async function phonesWithUnfinished(db: D1Database, limit = 50): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT DISTINCT phone FROM inbox_messages
      WHERE status IN ('PENDING','QUEUED','FAILED')
      ORDER BY phone LIMIT ?`,
  ).bind(limit).all<{ phone: string }>();
  return rows.results.map((r) => r.phone);
}

/**
 * Cierre atómico del procesamiento. En un único `batch` (transacción de D1) van, en este orden:
 *
 *   1. la guarda del fencing token (primera sentencia, antes de cualquier escritura);
 *   2. las escrituras de negocio planificadas (cita, cancelación, reprogramación y auditoría);
 *   3. la sesión;
 *   4. las respuestas en el Outbox;
 *   5. el avance de secuencia del teléfono;
 *   6. el cierre del Inbox (`COMPLETED`).
 *
 * Si la guarda de fencing o una de negocio falla, D1 revierte **todo**: no queda cita sin
 * respuesta, ni sesión sin secuencia, ni mensaje cerrado sin haberse aplicado.
 */
export async function commitInboxProcessing(
  db: D1Database,
  o: {
    phone: string; inboxId: string; sequence: number;
    state: string; data: Record<string, any>; replies: BotMessage[]; now: Date;
    lock: { workerId: string; token: number };
    /** Escrituras de la intención, ya planificadas y con sus propias guardas. */
    business?: D1PreparedStatement[];
  },
): Promise<void> {
  const at = iso(o.now);
  const stmts: D1PreparedStatement[] = [
    lockGuardStatement(db, o.phone, o.lock.workerId, o.lock.token, o.now),
    ...(o.business ?? []),
    db.prepare(
      "INSERT INTO sessions(phone, state, data, updated_at) VALUES (?,?,?,?) " +
      "ON CONFLICT(phone) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=excluded.updated_at",
    ).bind(o.phone, o.state, JSON.stringify(o.data), at),
  ];
  o.replies.forEach((reply, i) => {
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO sent_messages
         (wamid_origin, message_index, dest_phone, payload, status, attempts, created_at, updated_at)
       VALUES (?,?,?,?, 'PENDING', 0, ?, ?)`,
    ).bind(o.inboxId, i, o.phone, JSON.stringify(reply), at, at));
  });
  stmts.push(db.prepare(
    "INSERT INTO phone_sequences (phone, last_processed_seq) VALUES (?, ?) " +
    "ON CONFLICT(phone) DO UPDATE SET last_processed_seq = MAX(phone_sequences.last_processed_seq, excluded.last_processed_seq)",
  ).bind(o.phone, o.sequence));
  stmts.push(db.prepare(
    "UPDATE inbox_messages SET status='COMPLETED', next_attempt_at=NULL, last_error=NULL, updated_at=? WHERE id=?",
  ).bind(at, o.inboxId));
  await db.batch(stmts);
}

/**
 * Cierra una entrega duplicada de la cola (secuencia ya procesada) sin tocar sesión ni
 * Outbox. La guarda del fencing también protege esta escritura.
 */
export async function completeDuplicateInbox(
  db: D1Database,
  o: { phone: string; inboxId: string; now: Date; lock: { workerId: string; token: number } },
): Promise<void> {
  await db.batch([
    lockGuardStatement(db, o.phone, o.lock.workerId, o.lock.token, o.now),
    db.prepare(
      "UPDATE inbox_messages SET status='COMPLETED', next_attempt_at=NULL, last_error=NULL, updated_at=? WHERE id=?",
    ).bind(iso(o.now), o.inboxId),
  ]);
}

// ------------------------------------------------------------------ WhatsApp Outbox
export async function createOutboxMessage(
  db: D1Database, wamidOrigin: string, index: number, phone: string, payload: any, now: Date,
): Promise<boolean> {
  const at = iso(now);
  const r = await db.prepare(
    `INSERT OR IGNORE INTO sent_messages
       (wamid_origin, message_index, dest_phone, payload, status, attempts, created_at, updated_at)
     VALUES (?,?,?,?, 'PENDING', 0, ?, ?)`,
  ).bind(wamidOrigin, index, phone, JSON.stringify(payload), at, at).run();
  return r.meta.changes === 1;
}

export async function outboxForWamid(db: D1Database, wamidOrigin: string): Promise<OutboxRow[]> {
  return (await db.prepare(
    "SELECT * FROM sent_messages WHERE wamid_origin = ? ORDER BY message_index",
  ).bind(wamidOrigin).all<OutboxRow>()).results;
}

export async function claimOutboxDelivery(
  db: D1Database, wamidOrigin: string, index: number, now: Date,
): Promise<OutboxRow | null> {
  const at = iso(now);
  const r = await db.prepare(
    `UPDATE sent_messages
        SET status='SENDING', attempts=COALESCE(attempts,0)+1, updated_at=?
      WHERE wamid_origin=? AND message_index=?
        AND ((status='PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status='FAILED' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?))`,
  ).bind(at, wamidOrigin, index, at, at).run();
  if (r.meta.changes !== 1) return null;
  return db.prepare("SELECT * FROM sent_messages WHERE wamid_origin=? AND message_index=?")
    .bind(wamidOrigin, index).first<OutboxRow>();
}

export async function markOutboxSent(
  db: D1Database, wamidOrigin: string, index: number, wamidSent: string | null, metaStatus: string, now: Date,
) {
  await db.prepare(
    `UPDATE sent_messages
        SET status='SENT', wamid_sent=?, meta_status=?, next_attempt_at=NULL, last_error=NULL, updated_at=?
      WHERE wamid_origin=? AND message_index=?`,
  ).bind(wamidSent, metaStatus, iso(now), wamidOrigin, index).run();
}

/** Actualiza el estado que reporta Meta (sent/delivered/read/failed) buscando por WAMID enviado. */
export async function updateOutboxMetaStatus(db: D1Database, wamidSent: string, metaStatus: string, now: Date) {
  await db.prepare(
    "UPDATE sent_messages SET meta_status=?, updated_at=? WHERE wamid_sent=?",
  ).bind(metaStatus, iso(now), wamidSent).run();
}

export async function markOutboxFailed(
  db: D1Database, wamidOrigin: string, index: number, status: "FAILED" | "UNKNOWN",
  error: string, retryAt: Date | null, now: Date,
) {
  await db.prepare(
    `UPDATE sent_messages
        SET status=?, last_error=?, next_attempt_at=?, updated_at=?
      WHERE wamid_origin=? AND message_index=?`,
  ).bind(status, error.slice(0, 300), retryAt ? iso(retryAt) : null, iso(now), wamidOrigin, index).run();
}

/**
 * Filas que el cron debe reintentar.
 *
 * Solo `PENDING` (entrega inmediata o vencida) y `FAILED` **con reintento programado**.
 * `UNKNOWN` es terminal por diseño: el resultado de la entrega es incierto y reenviar
 * podría duplicar el mensaje en el móvil del cliente. Se conserva para reconciliación
 * manual, pero ninguna tarea automática lo vuelve a enviar.
 */
export async function pendingOutbox(db: D1Database, now: Date, limit = 20): Promise<OutboxRow[]> {
  const at = iso(now);
  return (await db.prepare(
    `SELECT * FROM sent_messages
      WHERE (status='PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (status='FAILED' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
      ORDER BY created_at, wamid_origin, message_index LIMIT ?`,
  ).bind(at, at, limit).all<OutboxRow>()).results;
}

/**
 * Un `SENDING` caducado significa que el worker murió después de reclamar la entrega: no se
 * sabe si Meta la recibió. Pasa a `UNKNOWN` **sin programar reintento** y se conserva la fila
 * para reconciliación. Reenviar a ciegas podría duplicar el mensaje.
 */
export async function reclaimStaleSending(db: D1Database, now: Date): Promise<number> {
  const r = await db.prepare(
    `UPDATE sent_messages
        SET status='UNKNOWN', last_error='SENDING caducado: resultado desconocido',
            next_attempt_at=NULL, updated_at=?
      WHERE status='SENDING' AND updated_at <= ?`,
  ).bind(iso(now), iso(addMin(now, -2))).run();
  return r.meta.changes;
}

// ------------------------------------------------------------------ Bloqueos con fencing token
/**
 * Bloqueo por teléfono con fencing token **monotónico**. El token se incrementa en la
 * propia sentencia UPSERT, nunca se reinicia al liberar, y solo se puede tomar el bloqueo
 * si el anterior ha caducado. Así dos workers nunca obtienen el mismo token.
 */
export async function acquireLock(
  db: D1Database, phone: string, workerId: string, now: Date, ttlMs = 30000,
): Promise<number | null> {
  const expires = new Date(now.getTime() + ttlMs).toISOString();
  const row = await db.prepare(
    `INSERT INTO phone_locks (phone, worker_id, fencing_token, expires_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(phone) DO UPDATE SET
       worker_id=excluded.worker_id,
       fencing_token=phone_locks.fencing_token+1,
       expires_at=excluded.expires_at
     WHERE phone_locks.expires_at <= ? OR phone_locks.worker_id = ''
     RETURNING fencing_token`,
  ).bind(phone, workerId, expires, now.toISOString()).first<{ fencing_token: number }>();
  return row?.fencing_token ?? null;
}

export async function assertLock(
  db: D1Database, phone: string, workerId: string, token: number, now: Date,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT 1 AS ok FROM phone_locks WHERE phone=? AND worker_id=? AND fencing_token=? AND expires_at > ?",
  ).bind(phone, workerId, token, now.toISOString()).first<{ ok: number }>();
  return !!row;
}

/** Libera el bloqueo sin borrar la fila: el fencing token debe seguir siendo monotónico. */
export async function releaseLock(db: D1Database, phone: string, workerId: string, token: number) {
  const r = await db.prepare(
    `UPDATE phone_locks SET worker_id='', expires_at=?
      WHERE phone=? AND worker_id=? AND fencing_token=?`,
  ).bind(new Date(0).toISOString(), phone, workerId, token).run();
  return r.meta.changes === 1;
}

export async function tooManyAttempts(db: D1Database, ip: string, now: Date): Promise<boolean> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip=? AND at > ?")
    .bind(ip, iso(addMin(now, -15))).first<{ n: number }>();
  return (row?.n ?? 0) >= 5;
}

export async function recordFailure(db: D1Database, ip: string, now: Date) {
  await db.prepare("INSERT INTO login_attempts(ip, at) VALUES (?, ?)").bind(ip, iso(now)).run();
}

export async function clearAttempts(db: D1Database, ip: string) {
  await db.prepare("DELETE FROM login_attempts WHERE ip=?").bind(ip).run();
}

export async function rateLimited(
  db: D1Database, key: string, now: Date, limit: number, windowMs: number,
): Promise<boolean> {
  const ts = (d: Date): string => d.toISOString().slice(0, 19);
  const row = await db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key = ? AND at > ?")
    .bind(key, ts(new Date(now.getTime() - windowMs))).first<{ n: number }>();
  if ((row?.n ?? 0) >= limit) return true;
  await db.prepare("INSERT INTO rate_limits(key, at) VALUES (?, ?)").bind(key, ts(now)).run();
  return false;
}

export async function cleanup(db: D1Database, now: Date) {
  await db.batch([
    db.prepare("DELETE FROM processed_messages WHERE created_at < ?").bind(iso(addMin(now, -3 * 1440))),
    db.prepare("DELETE FROM sessions WHERE updated_at < ?").bind(iso(addMin(now, -1440))),
    db.prepare("DELETE FROM login_attempts WHERE at < ?").bind(iso(addMin(now, -1440))),
    db.prepare("DELETE FROM rate_limits WHERE at < ?").bind(iso(addMin(now, -10))),
    db.prepare("DELETE FROM audit_log WHERE at < ?").bind(iso(addMin(now, -365 * 1440))),
    // Inbox: los mensajes cerrados se conservan una semana para diagnosticar; los enviados, 30 días.
    db.prepare("DELETE FROM inbox_messages WHERE status='COMPLETED' AND updated_at < ?").bind(iso(addMin(now, -7 * 1440))),
    db.prepare("DELETE FROM inbox_messages WHERE status='DEAD' AND updated_at < ?").bind(iso(addMin(now, -30 * 1440))),
    db.prepare("DELETE FROM sent_messages WHERE status='SENT' AND updated_at < ?").bind(iso(addMin(now, -30 * 1440))),
    // `phone_locks` NO se limpia: es el contador monotónico del fencing token. Se conserva
    // una fila por teléfono de forma permanente para que el token nunca se reinicie.
  ]);
}
