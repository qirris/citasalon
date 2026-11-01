// Pruebas unitarias completas para el sistema de backups seguros (Cifrado AES-256-GCM, SHA-256 y Restauración)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createSecureBackup, restoreAndVerifyBackup } from "../src/backup.ts";

const TEST_BACKUP_DIR = path.resolve("backups_secure_test");
const TEST_SECRET_KEY = crypto.randomBytes(32); // Clave temporal de prueba de 32 bytes

test("Backup D1 Seguro: cifrado AES-256-GCM, SHA-256, metadatos y restauración verificada", () => {
  const sampleSql = `
    CREATE TABLE appointments (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO appointments VALUES (1, 'Carlos Test');
    CREATE TABLE sessions (phone TEXT PRIMARY KEY, state TEXT);
    INSERT INTO sessions VALUES ('34600111222', 'MENU');
  `;

  // 1. Crear backup cifrado
  const { backupPath, metaPath } = createSecureBackup(TEST_BACKUP_DIR, sampleSql, TEST_SECRET_KEY);

  assert.ok(fs.existsSync(backupPath), "el archivo cifrado debe existir");
  assert.ok(fs.existsSync(metaPath), "el archivo de metadatos debe existir");

  // 2. Restaurar y verificar con la misma clave
  const restoredSql = restoreAndVerifyBackup(backupPath, metaPath, TEST_SECRET_KEY);
  assert.equal(restoredSql.trim(), sampleSql.trim(), "el SQL restaurado debe coincidir exactamente con el original");

  // 3. Comprobar que falla con una clave incorrecta
  const wrongKey = crypto.randomBytes(32);
  assert.throws(() => {
    restoreAndVerifyBackup(backupPath, metaPath, wrongKey);
  }, /Unsupported state|auth|decrypt/i, "debe fallar al intentar descifrar con una clave incorrecta");

  // Limpieza
  fs.rmSync(TEST_BACKUP_DIR, { recursive: true, force: true });
});
