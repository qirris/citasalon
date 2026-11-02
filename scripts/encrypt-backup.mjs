import { readFileSync, writeFileSync } from "node:fs";
import { encryptBackupSql } from "../src/backup.ts";
import crypto from "node:crypto";

const filePath = process.argv[2];
const key = process.env.BACKUP_ENCRYPTION_KEY;

if (!filePath || !key) {
  console.error("Uso: node scripts/encrypt-backup.mjs <file> (requiere BACKUP_ENCRYPTION_KEY)");
  process.exit(1);
}

// Asegurar clave de 32 bytes para AES-256
const secretKey = crypto.createHash("sha256").update(key).digest();

const sqlContent = readFileSync(filePath, "utf8");
const { encryptedData, iv, authTag } = encryptBackupSql(sqlContent, secretKey);

// Guardar metadatos y cifrado
const output = JSON.stringify({
  iv,
  authTag,
  encryptedData,
});

writeFileSync(filePath + ".enc", output);
console.log(`Backup cifrado guardado en ${filePath}.enc`);
