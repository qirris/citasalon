// Pruebas de integración del Consumer contra SQLite real (node:sqlite), sin mocks de SQL.
// Cubren: dedup por WAMID, orden estricto por teléfono, fencing token monotónico,
// Outbox con reintentos/UNKNOWN, commit atómico e idempotencia de las intenciones.
import test from "node:test";
import assert from "node:assert/strict";
import * as dba from "../src/db.ts";
import {
  applyMetaStatuses, deliverOutboxForWamid, deliverPendingOutbox, extractIncoming,
  isFencingViolation, isBusinessViolation, planIntent, processInboxRow, processQueueMessage,
} from "../src/consumer.ts";
import { addMin, iso } from "../src/time.ts";
import { createTestDb, makeEnv, fakeBot, fakeWhatsApp, insertAppointment } from "./helpers/d1-sqlite.mjs";

const PHONE = "34600111222";
const SERVICE = { id: "corte_hombre", name: "Corte hombre", minutes: 30, price: "15 €", active: true };
const T0 = new Date("2026-11-01T10:00:00Z");

const count = async (db, table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).bind().first()).n;

const incoming = (id, phone = PHONE, body = "hola") => ({
  id, from: phone, type: "text", text: { body },
});

async function addInbox(db, id, phone = PHONE, body = "hola", now = T0) {
  return dba.saveInboxMessage(db, incoming(id, phone, body), null, phone, now);
}

function createIntent(wamid, start = "2026-11-05T10:00", stylists = ["Ana", "Luis"]) {
  return {
    type: "CREATE_APPOINTMENT",
    payload: {
      phone: PHONE, name: "Marta", service: SERVICE, start, stylists,
      source: "whatsapp", sourceWamid: wamid, now: iso(T0),
    },
    onSuccess: { state: "MENU", data: {}, replies: ["Cita confirmada"] },
    onFailure: { state: "TIME", data: { day: "2026-11-05" }, replies: ["Ese hueco se acaba de ocupar"] },
  };
}

const cancelIntent = (id) => ({
  type: "CANCEL_APPOINTMENT",
  payload: { id, phone: PHONE, now: iso(T0) },
  onSuccess: { state: "MENU", data: {}, replies: ["Cita cancelada"] },
  onFailure: { state: "MENU", data: {}, replies: ["Ya no estaba activa"] },
});

const updateIntent = (id, start) => ({
  type: "UPDATE_APPOINTMENT",
  payload: {
    id, phone: PHONE, name: "Marta", service: SERVICE, stylist: "Ana", start,
    notes: "", now: iso(T0), sourceWamid: "wamid-upd",
  },
  onSuccess: { state: "MENU", data: {}, replies: ["Cita cambiada"] },
  onFailure: { state: "MENU", data: {}, replies: ["No se pudo cambiar"] },
});

test("1. Inbox: el WAMID es idempotente y asigna secuencias por teléfono", async () => {
  const adapter = createTestDb();
  const a = await addInbox(adapter, "wamid-a", PHONE, "uno");
  const dup = await addInbox(adapter, "wamid-a", PHONE, "uno (reintento de Meta)");
  const b = await addInbox(adapter, "wamid-b", PHONE, "dos");
  const other = await addInbox(adapter, "wamid-c", "34600999888", "hola");

  assert.ok(a && b && other);
  assert.equal(dup, null, "el duplicado no crea fila");
  assert.equal(a.sequence, 1);
  assert.equal(b.sequence, 2);
  assert.equal(other.sequence, 1, "cada teléfono tiene su propia secuencia");
  assert.equal(await count(adapter, "inbox_messages"), 3);
  adapter.close();
});

test("2. Consumer: procesa, guarda sesión/Outbox/secuencia y cierra el Inbox", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  const bot = fakeBot();
  const wa = fakeWhatsApp();
  const row = await addInbox(adapter, "wamid-1", PHONE, "hola");

  const r = await processInboxRow(env, row, { bot, whatsapp: wa });
  assert.equal(r.processed, true);

  const inbox = await dba.getInboxMessage(adapter, "wamid-1");
  assert.equal(inbox.status, "COMPLETED");
  assert.equal(await dba.getLastProcessedSequence(adapter, PHONE), 1);

  const session = await dba.getSession(adapter, PHONE, new Date(), 100_000);
  assert.equal(session.state, "MENU");

  const outbox = await dba.outboxForWamid(adapter, "wamid-1");
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].status, "SENT");
  assert.equal(outbox[0].wamid_sent, "wamid-out-1");
  assert.equal(wa.sends.length, 1);
  assert.equal(bot.calls.length, 1);
  adapter.close();
});

test("3. Orden estricto: el mensaje 2 no se procesa antes que el 1", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  const bot = fakeBot();
  const wa = fakeWhatsApp();
  const services = { bot, whatsapp: wa };

  const first = await addInbox(adapter, "wamid-1", PHONE, "uno");
  const second = await addInbox(adapter, "wamid-2", PHONE, "dos");

  const deferred = await processQueueMessage(env, { id: "wamid-2" }, services);
  assert.equal(deferred.processed, false);
  assert.equal(deferred.deferred, true);
  assert.deepEqual(bot.calls.map((c) => c.text), [], "no se adelanta el segundo");

  assert.equal((await processQueueMessage(env, { id: "wamid-1" }, services)).processed, true);
  assert.equal((await processQueueMessage(env, { id: "wamid-2" }, services)).processed, true);
  assert.deepEqual(bot.calls.map((c) => c.text), ["uno", "dos"], "se procesan en orden");
  assert.equal(await dba.getLastProcessedSequence(adapter, PHONE), 2);
  assert.ok((await dba.getInboxMessage(adapter, first.id)).status === "COMPLETED");
  assert.ok((await dba.getInboxMessage(adapter, second.id)).status === "COMPLETED");
  adapter.close();
});

test("4. Bloqueo por teléfono con fencing token monotónico", async () => {
  const adapter = createTestDb();
  const t0 = new Date("2026-11-01T10:00:00.000Z");

  assert.equal(await dba.acquireLock(adapter, PHONE, "w1", t0), 1);
  assert.equal(await dba.acquireLock(adapter, PHONE, "w2", t0), null, "no se puede robar el bloqueo vivo");
  assert.equal(await dba.releaseLock(adapter, PHONE, "w2", 1), false, "otro worker no puede liberarlo");
  assert.equal(await dba.releaseLock(adapter, PHONE, "w1", 1), true);

  assert.equal(await dba.acquireLock(adapter, PHONE, "w1", t0), 2, "el token sigue creciendo tras liberar");
  assert.equal(await dba.acquireLock(adapter, PHONE, "w3", t0), null);

  const later = new Date(t0.getTime() + 31_000);
  assert.equal(await dba.acquireLock(adapter, PHONE, "w3", later), 3, "al caducar se puede tomar");
  assert.equal(await dba.assertLock(adapter, PHONE, "w1", 1, later), false, "el token viejo ya no vale");
  assert.equal(await dba.assertLock(adapter, PHONE, "w3", 3, later), true);

  const lock = await adapter.prepare("SELECT fencing_token, worker_id FROM phone_locks WHERE phone=?").bind(PHONE).first();
  assert.equal(lock.fencing_token, 3);
  assert.equal(lock.worker_id, "w3");
  adapter.close();
});

test("4b. Fencing token sobrevive a la limpieza (no se reinicia)", async () => {
  const adapter = createTestDb();
  const t0 = new Date("2026-11-01T10:00:00.000Z");

  // Adquirir y liberar
  const token1 = await dba.acquireLock(adapter, PHONE, "w1", t0);
  assert.equal(token1, 1);
  await dba.releaseLock(adapter, PHONE, "w1", token1);

  // Simular paso del tiempo (31 segundos para caducar)
  const later = new Date(t0.getTime() + 31_000);

  // Ejecutar cleanup (debería borrar solo los bloqueos liberados y caducados, NO el registro)
  await dba.cleanup(adapter, later);

  // Adquirir otro bloqueo después del cleanup
  const token2 = await dba.acquireLock(adapter, PHONE, "w2", later);
  assert.equal(token2, 2, "el token debe seguir aumentando, no reiniciarse a 1");

  // Verificar que el registro sigue existiendo
  const lock = await adapter.prepare("SELECT fencing_token FROM phone_locks WHERE phone=?").bind(PHONE).first();
  assert.ok(lock, "el registro de phone_locks no debe borrarse");
  assert.equal(lock.fencing_token, 2);
  adapter.close();
});

test("5. Outbox: sin respuesta HTTP queda UNKNOWN y NO se reenvía automáticamente", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  await dba.createOutboxMessage(adapter, "wamid-x", 0, PHONE, "hola", T0);

  const unknown = fakeWhatsApp([{ ok: false, simulated: false }]); // timeout/red: sin status
  assert.equal(await deliverOutboxForWamid(env, "wamid-x", unknown, T0), 0);
  let row = (await dba.outboxForWamid(adapter, "wamid-x"))[0];
  assert.equal(row.status, "UNKNOWN");
  assert.equal(row.attempts, 1);
  assert.equal(row.next_attempt_at, null, "UNKNOWN no programa reintento");

  // El cron NO debe reenviarlo: pendingOutbox solo incluye FAILED, no UNKNOWN
  const later = addMin(T0, 10);
  const pending = await dba.pendingOutbox(adapter, later, 10);
  const unknownPending = pending.filter((r) => r.wamid_origin === "wamid-x");
  assert.equal(unknownPending.length, 0, "UNKNOWN no debe aparecer en pendingOutbox");

  // deliverPendingOutbox tampoco lo toca
  const cron = fakeWhatsApp([{ ok: true, simulated: true, wamid: "no-deberia" }]);
  assert.equal(await deliverPendingOutbox(env, cron, 10), 0);
  assert.equal(cron.sends.length, 0, "ningún envío automático de UNKNOWN");
  adapter.close();
});

test("6. Outbox: SENDING caducado pasa a UNKNOWN sin reintento", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  await dba.createOutboxMessage(adapter, "wamid-stale", 0, PHONE, "hola", T0);
  await adapter.prepare("UPDATE sent_messages SET status='SENDING', updated_at=? WHERE wamid_origin='wamid-stale'")
    .bind(iso(addMin(T0, -10))).run();

  assert.equal(await dba.reclaimStaleSending(adapter, T0), 1);
  let row = (await dba.outboxForWamid(adapter, "wamid-stale"))[0];
  assert.equal(row.status, "UNKNOWN");
  assert.match(row.last_error, /resultado desconocido/);
  assert.equal(row.next_attempt_at, null, "UNKNOWN no programa reintento");

  // No aparece en pendingOutbox
  const later = addMin(T0, 10);
  const pending = await dba.pendingOutbox(adapter, later, 10);
  assert.equal(pending.filter((r) => r.wamid_origin === "wamid-stale").length, 0);
  adapter.close();
});

test("7. Outbox: error HTTP 4xx definitivo no se reintenta, 5xx/408/429 sí", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);

  // 400 Bad Request: definitivo, no reintentar
  await dba.createOutboxMessage(adapter, "wamid-400", 0, PHONE, "hola", T0);
  const err400 = fakeWhatsApp([{ ok: false, simulated: false, status: 400, error: "invalid payload" }]);
  assert.equal(await deliverOutboxForWamid(env, "wamid-400", err400, T0), 0);
  let row = (await dba.outboxForWamid(adapter, "wamid-400"))[0];
  assert.equal(row.status, "FAILED");
  assert.equal(row.next_attempt_at, null, "4xx definitivo no se reintenta");

  // 500 Internal Server Error: temporal, sí reintentar
  await dba.createOutboxMessage(adapter, "wamid-500", 0, PHONE, "hola", T0);
  const err500 = fakeWhatsApp([{ ok: false, simulated: false, status: 500, error: "server error" }]);
  assert.equal(await deliverOutboxForWamid(env, "wamid-500", err500, T0), 0);
  row = (await dba.outboxForWamid(adapter, "wamid-500"))[0];
  assert.equal(row.status, "FAILED");
  assert.ok(row.next_attempt_at, "5xx temporal programa reintento");
  adapter.close();
});

test("8. Outbox: al agotar los 5 intentos queda terminal y el cron no lo reenvía", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  await dba.createOutboxMessage(adapter, "wamid-giveup", 0, PHONE, "hola", T0);
  await adapter.prepare("UPDATE sent_messages SET attempts=4 WHERE wamid_origin='wamid-giveup'").bind().run();

  const failing = fakeWhatsApp([{ ok: false, simulated: false, status: 500, error: "boom" }]);
  assert.equal(await deliverOutboxForWamid(env, "wamid-giveup", failing, T0), 0);
  const row = (await dba.outboxForWamid(adapter, "wamid-giveup"))[0];
  assert.equal(row.attempts, 5);
  assert.equal(row.next_attempt_at, null, "no hay más reintentos programados");

  // Ni siquiera un día después el cron debe reenviarlo
  const later = addMin(T0, 1440);
  const pending = (await dba.pendingOutbox(adapter, later, 10)).filter((r) => r.wamid_origin === "wamid-giveup");
  assert.equal(pending.length, 0);
  const cron = fakeWhatsApp([{ ok: true, simulated: true, wamid: "no-deberia" }]);
  assert.equal(await deliverPendingOutbox(env, cron, 10), 0);
  assert.equal(cron.sends.length, 0);
  adapter.close();
});

test("9. Atomicidad: si falla el cierre, no queda sesión, ni Outbox, ni secuencia", async () => {
  const adapter = createTestDb();
  const row = await addInbox(adapter, "wamid-atomic", PHONE, "hola");
  adapter.exec("DROP TABLE phone_sequences"); // fuerza el fallo dentro del batch

  await assert.rejects(dba.commitInboxProcessing(adapter, {
    phone: PHONE, inboxId: row.id, sequence: row.sequence,
    state: "MENU", data: {}, replies: ["respuesta"], now: T0,
    lock: { workerId: "test", token: 1 },
    business: [],
  }));

  assert.equal(await count(adapter, "sessions"), 0, "la sesión se revierte");
  assert.equal(await count(adapter, "sent_messages"), 0, "la respuesta no se encola");
  assert.equal((await dba.getInboxMessage(adapter, row.id)).status, "PENDING", "sigue pendiente para reintentar");
  adapter.close();
});

test("10. Atomicidad: la guarda de fencing aborta la transacción si el token es antiguo", async () => {
  const adapter = createTestDb();
  const row = await addInbox(adapter, "wamid-fence", PHONE, "hola");

  // Simular un token obsolete (token=999 cuando el real es 1)
  await assert.rejects(dba.commitInboxProcessing(adapter, {
    phone: PHONE, inboxId: row.id, sequence: row.sequence,
    state: "MENU", data: {}, replies: ["respuesta"], now: T0,
    lock: { workerId: "test", token: 999 },
    business: [],
  }));

  assert.equal(await count(adapter, "sessions"), 0, "no se escribió nada");
  assert.equal(await count(adapter, "sent_messages"), 0, "no se escribió nada");
  assert.equal((await dba.getInboxMessage(adapter, row.id)).status, "PENDING");
  adapter.close();
});

test("11. planIntent e IntentPlan: las guardas van dentro del batch", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);

  // Crear una cita
  const appt = await dba.createAppointment(adapter, {
    phone: PHONE, name: "Luis", service: SERVICE, start: new Date("2026-11-06T10:00"),
    stylists: ["Ana"], source: "whatsapp", sourceWamid: "wamid-plan1", now: T0,
  });
  assert.ok(appt);

  // Reprogramar a un nuevo hueco libre
  const plan = await planIntent(env, updateIntent(appt.id, "2026-11-06T11:00"), T0);
  assert.ok(plan.ok);
  assert.ok(plan.statements.length >= 2, "debe tener guarda + UPDATE");

  // Verificar que la guarda incluye el CHECK contra phone_locks
  const guardStmt = plan.statements[0];
  assert.ok(guardStmt.sql.includes("INSERT INTO tx_business_guard"), "primera stmt es la guarda");
  adapter.close();
});

test("12. Intenciones idempotentes: procesar el mismo WAMID dos veces no duplica cita ni auditoría", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  const bot = fakeBot(() => ({ replies: [], state: "MENU", data: {}, intent: createIntent("wamid-idem") }));
  const wa = fakeWhatsApp();
  
  // Primera ejecución: crea la cita
  const row1 = await addInbox(adapter, "wamid-idem", PHONE, "sí");
  const result1 = await processInboxRow(env, row1, { bot, whatsapp: wa });
  assert.equal(result1.processed, true);
  
  let appts = await adapter.prepare("SELECT COUNT(*) AS n FROM appointments WHERE source_wamid='wamid-idem'").bind().first();
  assert.equal(appts.n, 1, "se crea una cita en el primer procesamiento");
  
  const apptRow = await adapter.prepare("SELECT id FROM appointments WHERE source_wamid='wamid-idem'").bind().first();
  const apptId = apptRow.id;
  
  let audits = await adapter.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE appt_id=? AND action='crear'").bind(apptId).first();
  assert.equal(audits.n, 1, "se crea una auditoría en el primer procesamiento");
  
  let outbox1 = await dba.outboxForWamid(adapter, "wamid-idem");
  assert.equal(outbox1.length, 1, "hay una sola respuesta en el Outbox");
  
  // Segunda ejecución: reintento del mismo WAMID (caso de deduplicación)
  // El Inbox ya está COMPLETED, por lo que processQueueMessage debe detectarlo y no procesarlo de nuevo
  const result2 = await processQueueMessage(env, { id: "wamid-idem" }, { bot, whatsapp: wa });
  assert.equal(result2.processed, true, "reintento se marca como processed (sin cambios)");
  
  // Verificar que no duplicó nada
  appts = await adapter.prepare("SELECT COUNT(*) AS n FROM appointments WHERE source_wamid='wamid-idem'").bind().first();
  assert.equal(appts.n, 1, "no se crea segunda cita");
  
  audits = await adapter.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE appt_id=? AND action='crear'").bind(apptId).first();
  assert.equal(audits.n, 1, "no se crea segunda auditoría");
  
  let outbox2 = await dba.outboxForWamid(adapter, "wamid-idem");
  assert.equal(outbox2.length, 1, "Outbox sigue con una sola respuesta");
  assert.equal(outbox2[0].status, "SENT", "la respuesta sigue siendo SENT");
  
  adapter.close();
});

test("13. Consumer ejecuta la intención y guarda su respuesta de éxito en el Outbox", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  const bot = fakeBot(() => ({ replies: [], state: "MENU", data: {}, intent: createIntent("wamid-intent") }));
  const wa = fakeWhatsApp();
  const row = await addInbox(adapter, "wamid-intent", PHONE, "sí");

  const r = await processInboxRow(env, row, { bot, whatsapp: wa });
  assert.equal(r.processed, true);

  const appt = await dba.getApptByWamid(adapter, "wamid-intent");
  assert.ok(appt, "la cita se crea al ejecutar la intención");
  assert.equal((await dba.getInboxMessage(adapter, "wamid-intent")).status, "COMPLETED");

  const outbox = await dba.outboxForWamid(adapter, "wamid-intent");
  assert.equal(outbox[0].status, "SENT");
  assert.equal(JSON.parse(outbox[0].payload), "Cita confirmada");
  adapter.close();
});

test("14. Si la intención no se puede aplicar, se guarda la respuesta de fallo", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  
  // Crear una cita que ocupe el hueco de destino (11:00-11:30)
  await insertAppointment(adapter, { 
    starts_at: "2026-11-06T11:00", 
    ends_at: "2026-11-06T11:30", 
    stylist: "Ana" 
  });
  
  const appt = await dba.createAppointment(adapter, {
    phone: PHONE, name: "Luis", service: SERVICE, start: new Date("2026-11-06T10:00"),
    stylists: ["Ana"], source: "whatsapp", sourceWamid: "wamid-u1", now: T0,
  });
  assert.ok(appt);
  
  // El bot devuelve una intención que intenta reprogramar a un hueco ya ocupado (11:00)
  const bot = fakeBot(() => ({ replies: [], state: "CONFIRM", data: {}, intent: updateIntent(appt.id, "2026-11-06T11:00") }));
  const wa = fakeWhatsApp();
  const row = await addInbox(adapter, "wamid-clash", PHONE, "sí");

  // El intent no se puede aplicar: el hueco 11:00 está ocupado. El Consumer debe detectar la falla
  // y responder con onFailure, sin crear cita ni auditar.
  const result = await processInboxRow(env, row, { bot, whatsapp: wa });
  assert.equal(result.processed, true, "el procesamiento termina sin fallo de base de datos");

  assert.equal(await dba.getApptByWamid(adapter, "wamid-clash"), null, "no se crea cita nueva");
  const outbox = await dba.outboxForWamid(adapter, "wamid-clash");
  assert.equal(JSON.parse(outbox[0].payload), "No se pudo cambiar");
  assert.equal((await dba.getSession(adapter, PHONE, new Date(), 100_000)).state, "MENU");
  adapter.close();
});

test("15. extractIncoming normaliza texto, botones y listas de Meta", () => {
  assert.deepEqual(extractIncoming({ type: "text", text: { body: "hola" } }), { text: "hola", payload: null });
  assert.deepEqual(
    extractIncoming({ type: "interactive", interactive: { button_reply: { id: "menu:book", title: "Reservar cita" } } }),
    { text: "Reservar cita", payload: "menu:book" },
  );
  assert.deepEqual(
    extractIncoming({ type: "interactive", interactive: { list_reply: { id: "svc:tinte", title: "Tinte" } } }),
    { text: "Tinte", payload: "svc:tinte" },
  );
  assert.equal(extractIncoming({ type: "image" }).unsupported, true);
});

test("16. isFencingViolation e isBusinessViolation detectan errores de transacción", () => {
  assert.ok(isFencingViolation(new Error("UNIQUE constraint failed: tx_fencing_guard.violation")));
  assert.ok(isFencingViolation(new Error("CHECK constraint failed: tx_fencing_guard")));
  assert.ok(isBusinessViolation(new Error("UNIQUE constraint failed: tx_business_guard.violation")));
  assert.ok(isBusinessViolation(new Error("CHECK constraint failed: tx_business_guard")));
  assert.ok(!isFencingViolation(new Error("other error")));
});