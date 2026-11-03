// Cifra un SQL de D1 ya validado y escribe un único archivo .sql.enc
// con metadatos de integridad embebidos (AES-256-GCM).
//
// Uso: BACKUP_ENCRYPTION_KEY=... node scripts/encrypt-backup.mjs backups/backup.sql [--out backups/backup.sql.enc]
//
// La clave se lee solo del entorno. Nunca se imprime ni se escribe en disco.
import fs from "node:fs";
import path from "node:path";
import { createEnvelope } from "./backup-crypto.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const outIndex = args.indexOf("--out");
const out = outIndex !== -1 ? args[outIndex + 1] : file ? `${file}.enc` : null;
const passphrase = process.env.BACKUP_ENCRYPTION_KEY;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

if (!file || !out) fail("Uso: node scripts/encrypt-backup.mjs <archivo.sql> [--out <archivo.sql.enc>]");
if (!passphrase) fail("Falta BACKUP_ENCRYPTION_KEY en el entorno; no se genera ningún artefacto.");

let sql;
try {
  sql = fs.readFileSync(file, "utf8");
} catch {
  fail("No se pudo leer el archivo SQL de entrada.");
}
if (sql.trim().length === 0) fail("El archivo SQL de entrada está vacío.");

let envelope;
try {
  envelope = createEnvelope(sql, passphrase);
} catch (error) {
  fail(error.message);
}

const tmp = `${out}.tmp-${process.pid}`;
try {
  fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, out);
  try {
    fs.chmodSync(out, 0o600);
  } catch {
    // En sistemas sin permisos POSIX (Windows) no aplica.
  }
} catch {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // Limpieza best-effort.
  }
  fail("No se pudo escribir el archivo cifrado; no se publica ningún artefacto.");
}

console.log(`OK: backup cifrado y verificado en ${path.basename(out)} (${envelope.sizeBytes} bytes de SQL).`);
