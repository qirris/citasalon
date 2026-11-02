import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SqliteD1, createTestDb } from "./helpers/d1-sqlite.mjs";
import { createSecureBackup, restoreAndVerifyBackup } from "../src/backup.ts";

test("Backup y Restauración: Flujo completo cifrado de punta a punta", () => {
  const TEST_DIR = path.resolve("backups_full_flow_test");
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const sampleSql = `
    CREATE TABLE appointments (id INTEGER PRIMARY KEY, phone TEXT, name TEXT);
    INSERT INTO appointments VALUES (1, '34600000000', 'Carlos Cliente');
  `;

  const secretKey = crypto.randomBytes(32);

  // 1. Crear backup cifrado usando las funciones oficiales de src/backup.ts
  const { backupPath, metaPath } = createSecureBackup(TEST_DIR, sampleSql, secretKey);

  assert.ok(fs.existsSync(backupPath), "el archivo cifrado debe existir");
  assert.ok(fs.existsSync(metaPath), "el archivo de metadatos debe existir");

  // 2. Comprobar que el archivo cifrado NO contiene texto plano del SQL
  const encContent = fs.readFileSync(backupPath, "utf8");
  assert.equal(encContent.includes("Carlos Cliente"), false, "El archivo cifrado no debe exponer datos en texto plano");

  // 3. Descifrar y restaurar usando la función oficial
  const restoredSql = restoreAndVerifyBackup(backupPath, metaPath, secretKey);
  const isolatedDb = new SqliteD1(":memory:");
  isolatedDb.exec(restoredSql);

  const row = isolatedDb.query("SELECT * FROM appointments WHERE id=1")[0];
  assert.equal(row.name, "Carlos Cliente", "Los datos restaurados deben coincidir exactamente con los originales");

  // Limpieza
  isolatedDb.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
