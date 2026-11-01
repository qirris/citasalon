// Módulo de copias de seguridad locales D1: exportación, cifrado AES-256-GCM, SHA-256, metadatos y restauración con verificación
// @ts-ignore
import fs from "node:fs";
// @ts-ignore
import path from "node:path";
// @ts-ignore
import crypto from "node:crypto";

export interface BackupMetadata {
  version: string;
  timestamp: string;
  algorithm: string;
  checksumSha256: string;
  sizeBytes: number;
  tables: string[];
}

const ALGORITHM = "aes-256-gcm";

/**
 * Cifra un texto SQL usando AES-256-GCM (cifrado autenticado).
 */
export function encryptBackupSql(sqlContent: string, secretKey: any): { encryptedData: string, iv: string, authTag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, secretKey, iv);

  let encrypted = cipher.update(sqlContent, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return {
    encryptedData: encrypted,
    iv: iv.toString("hex"),
    authTag
  };
}

/**
 * Descifra un backup cifrado con AES-256-GCM validando su autenticidad.
 */
export function decryptBackupSql(encryptedData: string, secretKey: any, ivHex: string, authTagHex: string): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, secretKey, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  let decrypted = decipher.update(encryptedData, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Calcula el hash SHA-256 de un contenido.
 */
export function computeChecksum(content: string | Uint8Array): string {
  const hashSum = crypto.createHash("sha256");
  hashSum.update(content);
  return hashSum.digest("hex");
}

/**
 * Crea una copia de seguridad completa (esquema y datos) cifrada y con metadatos.
 */
export function createSecureBackup(outputDir: string, dbSqlContent: string, secretKey: any): { backupPath: string, metaPath: string } {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFilename = `d1-secure-backup-${timestamp}.enc`;
  const metaFilename = `d1-secure-backup-${timestamp}.json`;

  const backupPath = path.join(outputDir, backupFilename);
  const metaPath = path.join(outputDir, metaFilename);

  const checksumSha256 = computeChecksum(dbSqlContent);
  const { encryptedData, iv, authTag } = encryptBackupSql(dbSqlContent, secretKey);

  const payload = JSON.stringify({
    iv,
    authTag,
    data: encryptedData
  }, null, 2);

  fs.writeFileSync(backupPath, payload, "utf-8");
  const stats = fs.statSync(backupPath);

  const metadata: BackupMetadata = {
    version: "2.0",
    timestamp: new Date().toISOString(),
    algorithm: ALGORITHM,
    checksumSha256,
    sizeBytes: stats.size,
    tables: ["appointments", "sessions", "inbox_messages", "sent_messages", "settings", "audit_log"]
  };

  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), "utf-8");

  return { backupPath, metaPath };
}

/**
 * Restaura y verifica una copia de seguridad cifrada, comprobando su integridad SHA-256
 * y autenticidad del cifrado.
 */
export function restoreAndVerifyBackup(backupPath: string, metaPath: string, secretKey: any): string {
  if (!fs.existsSync(backupPath) || !fs.existsSync(metaPath)) {
    throw new Error("Archivos de respaldo o metadatos no encontrados.");
  }

  const meta: BackupMetadata = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  const payload = JSON.parse(fs.readFileSync(backupPath, "utf-8"));

  // Verificar primero el SHA-256 del payload o los metadatos antes o después de descifrar
  // Descifrar y validar autenticidad (AuthTag)
  const decryptedSql = decryptBackupSql(payload.data, secretKey, payload.iv, payload.authTag);

  // Comprobar SHA-256 del contenido original descifrado
  const currentChecksum = computeChecksum(decryptedSql);
  if (currentChecksum !== meta.checksumSha256) {
    throw new Error("¡Alerta de integridad! El contenido descifrado no coincide con el hash SHA-256 original.");
  }

  return decryptedSql;
}
