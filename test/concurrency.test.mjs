// Pruebas avanzadas de concurrencia, fiabilidad y robustez del Consumer y el Inbox
import test from "node:test";
import assert from "node:assert/strict";
import * as dba from "../src/db.ts";
import { processInboxRow } from "../src/consumer.ts";
import { createTestDb, makeEnv, fakeWhatsApp } from "./helpers/d1-sqlite.mjs";

const PHONE_A = "34600111222";
const PHONE_B = "34600333444";
const NOW = new Date("2026-11-01T10:00:00Z");

const dummyMsg = (id, text = "hola") => ({ id, from: PHONE_A, type: "text", text: { body: text } });

test("Concurrencia masiva y duplicados: múltiples webhooks simultáneos con el mismo WAMID", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  let botCalls = 0;
  const bot = {
    handleMessage: async () => {
      botCalls++;
      return { replies: ["Hola"], state: "MENU", data: {}, intent: null };
    }
  };
  const wa = fakeWhatsApp();

  const wamid = "wamid-concurrent-dup";
  const rows = await Promise.all([
    dba.saveInboxMessage(adapter, dummyMsg(wamid), "Cliente A", PHONE_A, NOW),
    dba.saveInboxMessage(adapter, dummyMsg(wamid), "Cliente A", PHONE_A, NOW),
    dba.saveInboxMessage(adapter, dummyMsg(wamid), "Cliente A", PHONE_A, NOW),
  ]);

  const validRows = rows.filter(Boolean);
  assert.equal(validRows.length, 1, "el WAMID solo crea una entrada única en el Inbox");

  const res = await processInboxRow(env, validRows[0], { bot, whatsapp: wa }, NOW);
  assert.equal(res.processed, true);
  assert.equal(botCalls, 1, "el bot solo se ejecuta una vez");

  adapter.close();
});

test("Orden estricto por teléfono: el mensaje 2 espera al mensaje 1", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  const executionOrder = [];

  const bot = {
    handleMessage: async (env, phone, text) => {
      executionOrder.push(text);
      return { replies: [`Respuesta a ${text}`], state: "MENU", data: {}, intent: null };
    }
  };
  const wa = fakeWhatsApp();

  const r1 = await dba.saveInboxMessage(adapter, dummyMsg("wamid-seq-1", "primero"), "Cliente", PHONE_A, NOW);
  const r2 = await dba.saveInboxMessage(adapter, dummyMsg("wamid-seq-2", "segundo"), "Cliente", PHONE_A, NOW);

  const res2 = await processInboxRow(env, r2, { bot, whatsapp: wa }, NOW);
  assert.equal(res2.processed, false, "el mensaje 2 se pospone porque el 1 está pendiente");

  const res1 = await processInboxRow(env, r1, { bot, whatsapp: wa }, NOW);
  assert.equal(res1.processed, true);

  const res2Retry = await processInboxRow(env, r2, { bot, whatsapp: wa }, NOW);
  assert.equal(res2Retry.processed, true);

  assert.deepEqual(executionOrder, ["primero", "segundo"], "se respeta estrictamente el orden de llegada por teléfono");

  adapter.close();
});

test("Aislamiento entre teléfonos distintos: procesamiento en paralelo sin bloqueos", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  const processedPhones = [];

  const bot = {
    handleMessage: async (env, phone) => {
      processedPhones.push(phone);
      return { replies: ["OK"], state: "MENU", data: {}, intent: null };
    }
  };
  const wa = fakeWhatsApp();

  const rA = await dba.saveInboxMessage(adapter, dummyMsg("wamid-phone-a"), "Cliente A", PHONE_A, NOW);
  const rB = await dba.saveInboxMessage(adapter, { ...dummyMsg("wamid-phone-b"), from: PHONE_B }, "Cliente B", PHONE_B, NOW);

  const resB = await processInboxRow(env, rB, { bot, whatsapp: wa }, NOW);
  assert.equal(resB.processed, true);

  const resA = await processInboxRow(env, rA, { bot, whatsapp: wa }, NOW);
  assert.equal(resA.processed, true);

  assert.deepEqual(processedPhones, [PHONE_B, PHONE_A]);

  adapter.close();
});

test("Simulación local de Queue y reintentos del Consumer", async () => {
  const adapter = createTestDb();
  const env = makeEnv(adapter);
  let attempts = 0;

  const bot = {
    handleMessage: async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("Fallo temporal simulado");
      }
      return { replies: ["Éxito tras reintentos"], state: "MENU", data: {}, intent: null };
    }
  };
  const wa = fakeWhatsApp();

  const row = await dba.saveInboxMessage(adapter, dummyMsg("wamid-queue-retry"), "Cliente", PHONE_A, NOW);

  // Primer intento: falla
  await processInboxRow(env, row, { bot, whatsapp: wa }, NOW);
  let updatedRow = await dba.getInboxMessage(adapter, "wamid-queue-retry");
  assert.equal(updatedRow.status, "FAILED");
  assert.equal(updatedRow.attempts, 1);

  // Simulamos el paso del tiempo o la recarga del cron actualizando el next_attempt_at y pasándolo a PENDING
  await adapter.prepare("UPDATE inbox_messages SET status='PENDING', next_attempt_at=? WHERE id=?").bind(NOW.toISOString(), "wamid-queue-retry").run();
  updatedRow = await dba.getInboxMessage(adapter, "wamid-queue-retry");

  // Segundo intento: éxito
  await processInboxRow(env, updatedRow, { bot, whatsapp: wa }, NOW);
  const finalRow = await dba.getInboxMessage(adapter, "wamid-queue-retry");
  assert.equal(finalRow.status, "COMPLETED");

  adapter.close();
});
