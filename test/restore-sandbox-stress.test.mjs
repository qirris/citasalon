// Pruebas de resistencia extremas para la validación y restauración de respaldos D1
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createSecureBackup, restoreAndVerifyBackup } from "../src/backup.ts";
import { validateAndRestoreBackupToSandbox } from "../src/restore-sandbox.ts";

const TEST_DIR = path.resolve("backups_stress_test");
const SECRET_KEY = crypto.randomBytes(32);

const fullValidSql = `
  CREATE TABLE appointments (id INTEGER PRIMARY KEY, name TEXT, phone TEXT, starts_at TEXT, ends_at TEXT, stylist TEXT, status TEXT);
  CREATE TABLE sessions (phone TEXT PRIMARY KEY, state TEXT);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT);
  CREATE TABLE inbox_messages (id TEXT PRIMARY KEY, status TEXT);
  CREATE TABLE sent_messages (id INTEGER PRIMARY KEY, status TEXT);
  INSERT INTO appointments VALUES (1, 'Ana', '34600111222', '2026-11-02T10:00', '2026-11-02T10:30', 'Ana', 'confirmed');
`;

test("Resistencia Backup: rechazo de SQL con tablas ausentes", () => {
  const incompleteSql = "CREATE TABLE appointments (id INTEGER PRIMARY KEY, name TEXT);"; // Faltan sesiones, settings, etc.
  const { backupPath, metaPath } = createSecureBackup(TEST_DIR, incompleteSql, SECRET_KEY);

  const report = validateAndRestoreBackupToSandbox(backupPath, metaPath, SECRET_KEY);
  assert.equal(report.isValid, false, "debe rechazar un backup con tablas ausentes");
  assert.ok(report.errors.some(e => e.includes("Falta la tabla obligatoria")));
});

test("Resistencia Backup: rechazo de metadatos o hash manipulados", () => {
  const { backupPath, metaPath } = createSecureBackup(TEST_DIR, fullValidSql, SECRET_KEY);

  // Manipular el hash en el archivo de metadatos para que difiera del SQL cifrado
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  meta.checksumSha256 = "1111111111111111111111111111111111111111111111111111111111111111";
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  // Al alterar el JSON de metadatos y restaurar, el hash descifrado no coincidirá con el meta.checksumSha256
  assert.throws(() => {
    restoreAndVerifyBackup(backupPath, metaPath, SECRET_KEY);
  }, /Alerta de integridad/, "debe lanzar error al detectar hash manipulado en metadatos");
});

test("Resistencia Backup: rechazo de SQL truncado o inválido", () => {
  const truncatedSql = "CREATE TABLE appointments (id INTEGER PRIMARY KEY, name TEXT; -- truncado";
  const { backupPath, metaPath } = createSecureBackup(TEST_DIR, truncatedSql, SECRET_KEY);

  const report = validateAndRestoreBackupToSandbox(backupPath, metaPath, SECRET_KEY);
  assert.equal(report.isValid, false, "debe rechazar un volcado SQL truncado o con sintaxis inválida");
});

test("Resistencia Backup: restauración repetida exitosa", () => {
  const { backupPath, metaPath } = createSecureBackup(TEST_DIR, fullValidSql, SECRET_KEY);

  const report1 = validateAndRestoreBackupToSandbox(backupPath, metaPath, SECRET_KEY);
  assert.equal(report1.isValid, true);

  const report2 = validateAndRestoreBackupToSandbox(backupPath, metaPath, SECRET_KEY);
  assert.equal(report2.isValid, true, "la restauración repetida sobre sandbox limpio debe ser igualmente exitosa");

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
