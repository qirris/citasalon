// Pruebas unitarias para la validación y restauración segura en Sandbox de D1
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createSecureBackup } from "../src/backup.ts";
import { validateAndRestoreBackupToSandbox } from "../src/restore-sandbox.ts";

const TEST_DIR = path.resolve("backups_sandbox_test");
const SECRET_KEY = crypto.randomBytes(32);

test("Sandbox de Restauración D1: validación, ejecución en SQLite temporal y detección de errores", () => {
  const validSql = `
    CREATE TABLE appointments (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE sessions (phone TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT);
    CREATE TABLE inbox_messages (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE sent_messages (id INTEGER PRIMARY KEY, status TEXT);

    INSERT INTO appointments VALUES (1, 'Ana Restaurada');
    INSERT INTO sessions VALUES ('34600111222', 'MENU');
    INSERT INTO settings VALUES ('salonName', 'Salon Test');
    INSERT INTO audit_log VALUES (1, 'crear');
    INSERT INTO inbox_messages VALUES ('wamid-1', 'COMPLETED');
    INSERT INTO sent_messages VALUES (1, 'SENT');
  `;

  const { backupPath, metaPath } = createSecureBackup(TEST_DIR, validSql, SECRET_KEY);

  // 1. Restauración y validación exitosa
  const report = validateAndRestoreBackupToSandbox(backupPath, metaPath, SECRET_KEY);
  assert.equal(report.isValid, true, "el informe de restauración debe ser válido");
  assert.ok(report.tablesFound.includes("appointments"));
  assert.equal(report.rowCounts["appointments"], 1);

  // 2. Intento con clave incorrecta
  const wrongKey = crypto.randomBytes(32);
  const badReport = validateAndRestoreBackupToSandbox(backupPath, metaPath, wrongKey);
  assert.equal(badReport.isValid, false, "debe rechazar la restauración con clave incorrecta");
  assert.ok(badReport.errors.length > 0);

  // Limpieza
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
