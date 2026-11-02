import test from "node:test";
import assert from "node:assert/strict";
import { SqliteD1 } from "./helpers/d1-sqlite.mjs";
import fs from "node:fs";
import path from "node:path";

const ROOT = new URL("../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, ROOT), "utf8");

test("Migraciones: actualización desde esquema base antiguo preserva datos y aplica Fase 2", async () => {
  // Crear base con un esquema base minimalista (sin source_wamid ni inbox)
  const db = new SqliteD1(":memory:");
  db.exec(`
    CREATE TABLE appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      service_id TEXT NOT NULL,
      service_name TEXT NOT NULL,
      stylist TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      reminder_sent INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'whatsapp',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Inyectar datos iniciales
  db.exec("INSERT INTO appointments (phone, name, service_id, service_name, stylist, starts_at, ends_at, created_at, updated_at) VALUES ('123', 'Cliente Antiguo', '1', 'Svc', 'Ana', '2026-11-01T10:00', '2026-11-01T10:30', '2026-11-01T09:00', '2026-11-01T09:00')");
  
  const countAntes = db.query("SELECT COUNT(*) as n FROM appointments")[0].n;

  // Aplicar migraciones en orden
  db.exec(read("migrations/0001_appointments_source_wamid.sql"));
  db.exec(read("migrations/0002_whatsapp_inbox_outbox.sql"));
  db.exec(read("migrations/0003_inbox_retry_columns.sql"));
  db.exec(read("migrations/0004_transaction_guards.sql"));

  const countDespues = db.query("SELECT COUNT(*) as n FROM appointments")[0].n;
  assert.equal(countAntes, countDespues, "Los datos no se deben perder al migrar");
  
  const cliente = db.query("SELECT name FROM appointments WHERE id=1")[0];
  assert.equal(cliente.name, "Cliente Antiguo");

  // Verificar existencia de tablas críticas de Fase 2
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
  assert.ok(tables.includes("appointments"), "appointments debe existir");
  assert.ok(tables.includes("inbox_messages"), "inbox_messages debe existir");
  assert.ok(tables.includes("tx_fencing_guard"), "tx_fencing_guard debe existir");

  db.close();
});
