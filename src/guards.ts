/**
 * Guarda de fencing: obliga a que el bloqueo siga vivo y el token sea el correcto.
 * Si el token es antiguo (otro worker tomó el bloqueo), el SELECT falla y el batch revierte.
 */
export function lockGuardStatement(db: D1Database, phone: string, workerId: string, token: number, now: Date) {
  return db.prepare(
    "SELECT 1 FROM phone_locks WHERE phone=? AND worker_id=? AND fencing_token=? AND expires_at > ?",
  ).bind(phone, workerId, token, now.toISOString());
}
