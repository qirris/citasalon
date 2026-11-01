// Pruebas del webhook (ingesta al Inbox) y del consumidor end-to-end dentro del proceso,
// contra SQLite real. Nunca se llama a Meta: el servicio de WhatsApp es falso.
import test from "node:test";
import assert from "node:assert/strict";
import * as dba from "../src/db.ts";
import { processMessage, extractMessages, extractStatuses } from "../src/index.ts";
import { applyMetaStatuses, deliverOutboxForWamid, processInboxRow } from "../src/consumer.ts";
import { createTestDb, makeEnv, fakeBot, fakeWhatsApp } from "./helpers/d1-sqlite.mjs";

const PHONE = "34600111222";

const textMsg = (id, body = "hola", phone = PHONE) => ({ id, from: phone, type: "text", text: { body } });

const count = async (db, table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).bind().first()).n;

test("1. Webhook: guarda en Inbox, procesa y descarta la entrega duplicada del mismo WAMID", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  const bot = fakeBot();
  const wa = fakeWhatsApp();
  const msg = textMsg("wamid-wh-1");

  await processMessage(env, msg, "Cliente", { bot, whatsapp: wa });
  await processMessage(env, msg, "Cliente", { bot, whatsapp: wa }); // Meta reintenta el mismo WAMID

  assert.equal(await count(adapter, "inbox_messages"), 1);
  assert.equal(bot.calls.length, 1, "el bot solo procesa una vez");
  assert.equal(wa.sends.length, 1, "el cliente recibe una sola respuesta");
  assert.equal((await dba.getInboxMessage(adapter, "wamid-wh-1")).status, "COMPLETED");
  adapter.close();
});

test("2. Webhook: dos teléfonos se procesan en paralelo sin bloquearse", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  const bot = fakeBot();
  const wa = fakeWhatsApp();

  await Promise.all([
    processMessage(env, textMsg("wamid-a", "hola", "34600111222"), null, { bot, whatsapp: wa }),
    processMessage(env, textMsg("wamid-b", "hola", "34600333444"), null, { bot, whatsapp: wa }),
  ]);

  assert.equal(await count(adapter, "inbox_messages"), 2);
  assert.equal(await count(adapter, "sessions"), 2);
  assert.equal(wa.sends.length, 2);
  // El webhook normaliza el teléfono (Meta lo manda sin "+").
  assert.equal(await dba.getLastProcessedSequence(adapter, "+34600111222"), 1);
  assert.equal(await dba.getLastProcessedSequence(adapter, "+34600333444"), 1);
  adapter.close();
});

test("3. Webhook: los tipos no soportados reciben una respuesta amable", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  const bot = fakeBot();
  const wa = fakeWhatsApp();

  await processMessage(env, { id: "wamid-img", from: PHONE, type: "image" }, null, { bot, whatsapp: wa });

  assert.equal(bot.calls.length, 0, "el bot no interpreta una imagen");
  assert.equal(wa.sends.length, 1);
  assert.match(JSON.stringify(wa.sends[0].payload), /Solo entiendo texto y botones/);
  adapter.close();
});

test("4. Webhook: un fallo del bot deja el mensaje para reintento y no lo pierde", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  const bot = {
    calls: [],
    async handleMessage() {
      this.calls.push(1);
      throw new Error("fallo simulado de base de datos");
    },
  };
  const wa = fakeWhatsApp();

  await processMessage(env, textMsg("wamid-fail"), null, { bot, whatsapp: wa });

  const row = await dba.getInboxMessage(adapter, "wamid-fail");
  assert.equal(row.status, "FAILED");
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /fallo simulado/);
  assert.ok(row.next_attempt_at, "queda programado un reintento");
  assert.equal(wa.sends.length, 0);
  adapter.close();
});

test("5. Tras agotar los reintentos el Inbox pasa a DEAD y el cliente recibe aviso", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  const row = await dba.saveInboxMessage(adapter, textMsg("wamid-dead"), null, PHONE, new Date());
  await adapter.prepare("UPDATE inbox_messages SET attempts=4 WHERE id=?").bind("wamid-dead").run();

  const bot = { async handleMessage() { throw new Error("siempre falla"); } };
  const wa = fakeWhatsApp();
  const result = await processInboxRow(env, row, { bot, whatsapp: wa });

  assert.equal(result.processed, false);
  const inbox = await dba.getInboxMessage(adapter, "wamid-dead");
  assert.equal(inbox.status, "DEAD");
  assert.equal(inbox.attempts, 5);
  assert.equal(inbox.next_attempt_at, null, "ya no se reintenta");
  assert.equal(wa.sends.length, 1, "el cliente recibe un aviso");
  assert.match(JSON.stringify(wa.sends[0].payload), /Lo siento/);
  adapter.close();
});

test("6. Los acuses de Meta actualizan el Outbox por WAMID enviado", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  await dba.createOutboxMessage(adapter, "wamid-origen", 0, PHONE, "hola", new Date());
  await dba.markOutboxSent(adapter, "wamid-origen", 0, "wamid-out-99", "accepted", new Date());

  assert.equal(await applyMetaStatuses(env, [{ id: "wamid-out-99", status: "delivered" }]), 1);
  const row = (await dba.outboxForWamid(adapter, "wamid-origen"))[0];
  assert.equal(row.meta_status, "delivered");
  adapter.close();
});

test("7. extractMessages y extractStatuses leen el payload real de Meta", () => {
  const payload = {
    entry: [{
      changes: [{
        value: {
          contacts: [{ wa_id: PHONE, profile: { name: "Cliente" } }],
          messages: [textMsg("wamid-1")],
          statuses: [{ id: "wamid-out-1", status: "read" }],
        },
      }],
    }],
  };
  const msgs = [...extractMessages(payload)];
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].profile, "Cliente");
  assert.deepEqual([...extractStatuses(payload)], [{ id: "wamid-out-1", status: "read" }]);
});

test("8. deliverOutboxForWamid no reenvía lo ya SENT", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  const wa = fakeWhatsApp();
  await dba.createOutboxMessage(adapter, "wamid-sent", 0, PHONE, "hola", new Date());
  await dba.markOutboxSent(adapter, "wamid-sent", 0, "wamid-out", "accepted", new Date());
  assert.equal(await deliverOutboxForWamid(env, "wamid-sent", wa, new Date()), 0);
  assert.equal(wa.sends.length, 0);
  adapter.close();
});
