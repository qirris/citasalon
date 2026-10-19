import type { Appt, Role, Service } from "./types.ts";
import { addMin, iso, parseDT } from "./time.ts";

// ------------------------------------------------------------------ conversación de WhatsApp
export async function getSession(db: D1Database, phone: string, now: Date, ttlMin: number) {
  const row = await db.prepare("SELECT state, data, updated_at FROM sessions WHERE phone = ?")
    .bind(phone).first<{ state: string; data: string; updated_at: string }>();
  if (!row) return null;
  if (now.getTime() - parseDT(row.updated_at).getTime() > ttlMin * 60000) return null;
  return { state: row.state, data: JSON.parse(row.data) as Record<string, any> };
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
}

/**
 * Crea la cita si algún peluquero está libre. Cada INSERT comprueba el choque dentro de la
 * misma sentencia, y D1 escribe de una en una: dos personas no pueden coger el mismo hueco.
 */
export async function createAppointment(db: D1Database, a: NewAppt): Promise<Appt | null> {
  const start = iso(a.start);
  const end = iso(addMin(a.start, a.service.minutes));
  const now = iso(a.now);
  for (const stylist of a.stylist ? [a.stylist] : a.stylists) {
    const r = await db.prepare(
      `INSERT INTO appointments (phone,name,service_id,service_name,stylist,starts_at,ends_at,source,notes,created_at,updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?
       WHERE NOT EXISTS (SELECT 1 FROM appointments
                         WHERE status='confirmed' AND stylist=? AND starts_at < ? AND ends_at > ?)`,
    ).bind(a.phone, a.name, a.service.id, a.service.name, stylist, start, end, a.source, a.notes ?? "",
      now, now, stylist, end, start).run();
    if (r.meta.changes === 1) return getAppt(db, r.meta.last_row_id as number);
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
                        WHERE id != ? AND status='confirmed' AND stylist=? AND starts_at < ? AND ends_at > ?)`,
  ).bind(e.name, e.phone, e.service.id, e.service.name, e.stylist, start, end, e.notes, iso(now),
    start, id, id, e.stylist, end, start).run();
  if (r.meta.changes === 1) return "ok";
  const row = await getAppt(db, id);
  if (!row) return "missing";
  return row.status !== "confirmed" ? "cancelled" : "clash";
}

export async function setStatus(db: D1Database, id: number, status: "confirmed" | "cancelled", now: Date) {
  // al restaurar, se comprueba que el hueco siga libre
  const r = await db.prepare(
    `UPDATE appointments SET status=?, updated_at=?
      WHERE id=? AND status != ?
        AND (? = 'cancelled' OR NOT EXISTS (
              SELECT 1 FROM appointments o, appointments me
               WHERE me.id = ? AND o.id != me.id AND o.status='confirmed' AND o.stylist=me.stylist
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

export async function lastNameFor(db: D1Database, phone: string): Promise<string | null> {
  const row = await db.prepare("SELECT name FROM appointments WHERE phone=? ORDER BY id DESC LIMIT 1")
    .bind(phone).first<{ name: string }>();
  return row?.name ?? null;
}

export async function appointmentsForDay(db: D1Database, day: string, includeCancelled = false): Promise<Appt[]> {
  const r = await db.prepare(
    `SELECT * FROM appointments WHERE starts_at >= ? AND starts_at <= ? ${includeCancelled ? "" : "AND status='confirmed'"}
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
export async function audit(db: D1Database, now: Date, role: Role | "whatsapp", action: string, apptId: number | null, detail = "") {
  await db.prepare("INSERT INTO audit_log(at, role, action, appt_id, detail) VALUES (?,?,?,?,?)")
    .bind(iso(now), role, action, apptId, detail.slice(0, 300)).run();
}

export async function listAudit(db: D1Database, limit = 200) {
  return (await db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").bind(limit).all<{
    id: number; at: string; role: string; action: string; appt_id: number | null; detail: string;
  }>()).results;
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

export async function cleanup(db: D1Database, now: Date) {
  await db.batch([
    db.prepare("DELETE FROM processed_messages WHERE created_at < ?").bind(iso(addMin(now, -3 * 1440))),
    db.prepare("DELETE FROM sessions WHERE updated_at < ?").bind(iso(addMin(now, -1440))),
    db.prepare("DELETE FROM login_attempts WHERE at < ?").bind(iso(addMin(now, -1440))),
    db.prepare("DELETE FROM audit_log WHERE at < ?").bind(iso(addMin(now, -365 * 1440))),
  ]);
}
