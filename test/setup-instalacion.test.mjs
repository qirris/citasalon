// Comprueba que la instalación de un salón nuevo no reutiliza recursos de otra
// instalación: Worker, D1 y cola propios, sin nombres fijos escritos a mano.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readD1Name, readWorkerName } from "../scripts/d1-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function tempConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pelu-config-"));
  const file = path.join(dir, "wrangler.jsonc");
  fs.writeFileSync(file, contents);
  return { file, dir };
}

test("Config: lee el Worker y la D1 reales de wrangler.jsonc", () => {
  const config = read("wrangler.jsonc");
  const worker = readWorkerName();
  const db = readD1Name();

  assert.match(worker, /^[a-z0-9][a-z0-9-]{0,62}$/);
  assert.match(db, /^[a-z0-9][a-z0-9-]{0,62}$/);
  assert.ok(config.includes(`"name": "${worker}"`), "el Worker leído debe ser el del archivo");
  assert.ok(config.includes(`"database_name": "${db}"`), "la D1 leída debe ser la del archivo");
  assert.ok(config.includes(`"database_id"`), "debe haber un database_id");
});

test("Config: falla con un mensaje claro si falta el nombre de la D1", () => {
  const { file, dir } = tempConfig('{ "name": "salon-prueba" }\n');
  try {
    assert.throws(() => readD1Name(file), /No se encontró "database_name"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Config: falla con un mensaje claro si falta el nombre del Worker", () => {
  const { file, dir } = tempConfig('{ "database_name": "salon-prueba" }\n');
  try {
    assert.throws(() => readWorkerName(file), /No se encontró "name"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setup.ps1: pide Worker, D1 y cola propios y actualiza wrangler.jsonc", () => {
  const script = read("setup.ps1");

  // Nombres configurables, no fijos.
  assert.ok(script.includes('Nombre del Worker'), "debe pedir el nombre del Worker");
  assert.ok(script.includes('Nombre de la D1'), "debe pedir el nombre de la D1");
  assert.ok(script.includes('Nombre de la cola'), "debe pedir el nombre de la cola");

  // Debe parchear las tres claves y las dos apariciones de la cola.
  assert.ok(script.includes(`'(?m)^(\\s*"name"\\s*:\\s*")[^"]*(")'`), "debe parchear el nombre del Worker");
  assert.ok(script.includes(`'("database_name"\\s*:\\s*")[^"]*(")'`), "debe parchear database_name");
  assert.ok(script.includes(`'("database_id"\\s*:\\s*")[^"]*(")'`), "debe parchear database_id");
  assert.ok(script.includes(`'("queue"\\s*:\\s*")[^"]*(")'`), "debe parchear las colas");
  assert.ok(script.includes('"queue"') && script.includes('$queueName'), "debe usar la cola elegida");

  // No debe reutilizar una D1 existente ni desplegar sin crear la base.
  assert.ok(/NO se reutiliza automáticamente/.test(script), "debe abortar si la D1 ya existe");
  assert.ok(script.includes("--file=schema.sql"), "debe aplicar el esquema completo");
  assert.ok(/queues create \$queueName/.test(script), "debe crear la cola elegida");
  assert.ok(/wrangler deploy/.test(script), "debe desplegar el Worker");
});

test("Backup: usa el nombre de D1 de la configuración, no uno fijo", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.backup, "node scripts/backup-d1.mjs");

  const backup = read("scripts/backup-d1.mjs");
  assert.ok(backup.includes("readD1Name"), "debe leer el nombre de wrangler.jsonc");
  assert.ok(!/d1 export citasalon/.test(backup), "no debe llevar una D1 concreta escrita a mano");
  assert.ok(/backups\/backup\.sql/.test(backup), "debe exportar a backups/backup.sql");
});
