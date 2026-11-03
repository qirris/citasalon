// Descifra un backup .sql.enc generado por scripts/encrypt-backup.mjs.
// Verifica autenticidad GCM, tamaño y SHA-256 antes de escribir el SQL.
//
// Uso: BACKUP_ENCRYPTION_KEY=... node scripts/decrypt-backup.mjs <archivo.sql.enc> --out <archivo.sql>
//
// El SQL descifrado contiene datos personales: bórralo cuando termines la restauración.
// Nunca se imprime la clave ni el contenido SQL por consola.
import fs from "node:fs";
import path from "node:path";
import { openEnvelope } from "./backup-crypto.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const outIndex = args.indexOf("--out");
const out = outIndex !== -1 ? args[outIndex + 1] : null;
const passphrase = process.env.BACKUP_ENCRYPTION_KEY;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

if (!file) fail("Uso: node scripts/decrypt-backup.mjs <archivo.sql.enc> --out <archivo.sql>");
if (!out) fail("Debes indicar --out <archivo.sql>; no se imprime SQL por consola.");
if (!passphrase) fail("Falta BACKUP_ENCRYPTION_KEY en el entorno.");

let envelope;
try {
  envelope = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  fail("No se pudo leer o interpretar el archivo cifrado.");
}

let sql;
try {
  sql = openEnvelope(envelope, passphrase);
} catch (error) {
  fail(error.message);
}

const tmp = `${out}.tmp-${process.pid}`;
try {
  fs.writeFileSync(tmp, sql, { encoding: "utf8", mode: 0o600 });
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
  fail("No se pudo escribir el SQL descifrado.");
}

console.log(`OK: SQL verificado y escrito en ${path.basename(out)} (${Buffer.byteLength(sql, "utf8")} bytes).`);
