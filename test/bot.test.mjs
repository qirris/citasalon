// Pruebas del bot conversacional contra SQLite real (sin mocks de SQL).
// Comprueban dos cosas: la conversación (estados/respuestas) y que el bot NO escribe en D1.
import test from "node:test";
import assert from "node:assert/strict";
import { handleMessage, asText } from "../src/bot.ts";
import { createTestDb, makeEnv, insertAppointment } from "./helpers/d1-sqlite.mjs";

const PHONE = "34600111222";
// Lunes 2 de noviembre de 2026, 08:00 (hora del salón = UTC en las pruebas).
const NOW = new Date("2026-11-02T08:00:00Z");

function setup() {
  const db = createTestDb();
  return { db, env: makeEnv(db) };
}

const count = async (db, table) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).bind().first()).n;

/** Envía un turno conservando el estado que devolvió el anterior. */
function send(env, prev, text, payload = null, wamid = null) {
  return handleMessage(env, PHONE, text, "Cliente", NOW, payload, {
    state: prev?.state ?? "MENU",
    data: prev?.data ?? {},
    ...(wamid ? { wamid } : {}),
  });
}

const optionsOf = (result) => result.replies.flatMap((m) => typeof m === "string"
  ? []
  : (m.type === "buttons" ? m.buttons : m.rows ?? []));
const textsOf = (result) => result.replies.map(asText).join("\n");

test("1. 'Hola' muestra el menú y el bot no escribe la sesión", async () => {
  const { db, env } = setup();
  const r = await handleMessage(env, PHONE, "Hola", "Cliente", NOW);
  assert.equal(r.state, "MENU");
  assert.equal(r.intent, null);
  assert.match(asText(r.replies[0]), /Soy el asistente/);
  assert.equal(await count(db, "sessions"), 0, "handleMessage no debe guardar la sesión");
  db.close();
});

test("2. Texto desconocido en MENU no repite el saludo completo", async () => {
  const { db, env } = setup();
  const r = await handleMessage(env, PHONE, "asdf", "Cliente", NOW, null, { state: "MENU", data: {} });
  const t = textsOf(r);
  assert.match(t, /No te he entendido bien/);
  assert.doesNotMatch(t, /Soy el asistente/);
  assert.equal(r.state, "MENU");
  db.close();
});

test("3. Reserva guiada: MENU -> SERVICE -> STYLIST -> DAY -> TIME", async () => {
  const { db, env } = setup();
  let r = await send(env, null, "Reservar cita", "menu:book");
  assert.equal(r.state, "SERVICE");
  assert.ok(optionsOf(r).some((x) => x.id === "svc:corte_hombre"));

  r = await send(env, r, "Corte hombre", "svc:corte_hombre");
  assert.equal(r.state, "STYLIST");
  assert.ok(optionsOf(r).some((x) => x.id === "stylist:Ana"));

  r = await send(env, r, "Ana", "stylist:Ana");
  assert.equal(r.state, "DAY");
  assert.ok(Array.isArray(r.data.days) && r.data.days.length > 0);

  r = await send(env, r, "", `day:${r.data.days[0]}`);
  assert.equal(r.state, "TIME");
  assert.ok(r.replies.length > 0);
  assert.equal(await count(db, "appointments"), 0);
  db.close();
});

/** Lleva la conversación hasta CONFIRM eligiendo el primer hueco disponible. */
async function reachConfirm(env) {
  let r = await send(env, null, "Reservar cita", "menu:book");
  r = await send(env, r, "Corte hombre", "svc:corte_hombre");
  r = await send(env, r, "Ana", "stylist:Ana");
  r = await send(env, r, "", `day:${r.data.days[0]}`);
  while (r.state === "TIME") {
    const period = optionsOf(r).find((x) => x.id.startsWith("period:"));
    if (period) {
      r = await send(env, r, "", period.id);
      continue;
    }
    const slot = optionsOf(r).find((x) => x.id.startsWith("time:"));
    assert.ok(slot, "debería haber una hora libre");
    r = await send(env, r, "", slot.id);
  }
  return r; // NAME
}

test("4. Confirmar devuelve intención CREATE con respuesta de éxito, sin tocar D1", async () => {
  const { db, env } = setup();
  let r = await reachConfirm(env);
  assert.equal(r.state, "NAME");

  r = await send(env, r, "Marta");
  assert.equal(r.state, "CONFIRM");
  assert.match(textsOf(r), /¿La confirmo\?/);

  r = await send(env, r, "sí", "confirm:yes", "wamid-in-1");
  assert.equal(r.intent?.type, "CREATE_APPOINTMENT");
  assert.equal(r.intent.payload.sourceWamid, "wamid-in-1");
  assert.match(textsOf({ replies: r.intent.onSuccess.replies }), /Cita confirmada/);

  assert.equal(await count(db, "appointments"), 0, "el bot no crea la cita");
  assert.equal(await count(db, "sessions"), 0, "el bot no guarda la sesión");
  db.close();
});

test("5. Cancelar devuelve intención CANCEL y deja la cita intacta", async () => {
  const { db, env } = setup();
  const appt = await insertAppointment(db, { phone: PHONE, starts_at: "2026-11-04T10:00", ends_at: "2026-11-04T10:30" });

  let r = await send(env, null, "mis citas");
  assert.equal(r.state, "CANCEL_PICK");
  assert.ok(optionsOf(r).some((x) => x.id === `appt:${appt.id}`));

  r = await send(env, r, "", `appt:${appt.id}`);
  assert.equal(r.state, "CANCEL_CONFIRM");

  r = await send(env, r, "", "cancel:yes");
  assert.equal(r.intent?.type, "CANCEL_APPOINTMENT");
  assert.equal(r.intent.payload.id, appt.id);
  assert.match(textsOf({ replies: r.intent.onSuccess.replies }), /Cita cancelada/);

  const after = await db.prepare("SELECT status FROM appointments WHERE id=?").bind(appt.id).first();
  assert.equal(after.status, "confirmed", "el bot no cancela por su cuenta");
  db.close();
});

test("6. Reprogramar devuelve intención UPDATE sin mover la cita", async () => {
  const { db, env } = setup();
  const appt = await insertAppointment(db, { phone: PHONE, starts_at: "2026-11-04T10:00", ends_at: "2026-11-04T10:30" });

  let r = await send(env, null, "mis citas");
  r = await send(env, r, "", `appt:${appt.id}`);
  r = await send(env, r, "", "resched:yes");
  assert.equal(r.state, "RESCHED_DAY");

  r = await send(env, r, "", `day:${r.data.days[0]}`);
  assert.equal(r.state, "RESCHED_TIME");
  while (r.state === "RESCHED_TIME") {
    const period = optionsOf(r).find((x) => x.id.startsWith("period:"));
    if (period) { r = await send(env, r, "", period.id); continue; }
    const slot = optionsOf(r).find((x) => x.id.startsWith("time:"));
    assert.ok(slot, "debería haber una hora libre para reprogramar");
    r = await send(env, r, "", slot.id);
  }
  assert.equal(r.state, "RESCHED_FINAL");

  r = await send(env, r, "", "resched:yes", "wamid-in-2");
  assert.equal(r.intent?.type, "UPDATE_APPOINTMENT");
  assert.equal(r.intent.payload.sourceWamid, "wamid-in-2");
  assert.match(textsOf({ replies: r.intent.onSuccess.replies }), /Cita cambiada/);

  const after = await db.prepare("SELECT starts_at FROM appointments WHERE id=?").bind(appt.id).first();
  assert.equal(after.starts_at, "2026-11-04T10:00", "el bot no mueve la cita");
  db.close();
});
