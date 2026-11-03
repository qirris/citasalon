// Formato de backup cifrado del workflow (v3): un único archivo .sql.enc
// con metadatos de integridad embebidos. Reutiliza el cifrado de src/backup.ts.
import crypto from "node:crypto";
import { encryptBackupSql, decryptBackupSql, computeChecksum } from "../src/backup.ts";

export const BACKUP_FORMAT = "peluqueria-d1-backup";
export const BACKUP_FORMAT_VERSION = 3;
const ALGORITHM = "aes-256-gcm";

/** Deriva una clave de 32 bytes a partir de la contraseña del secreto BACKUP_ENCRYPTION_KEY. */
export function deriveKey(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 16) {
    throw new Error("BACKUP_ENCRYPTION_KEY ausente o demasiado corta (mínimo 16 caracteres).");
  }
  return crypto.createHash("sha256").update(passphrase, "utf8").digest();
}

function assertHex(value, field) {
  if (typeof value !== "string" || value.length === 0 || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`Archivo de backup inválido: campo "${field}" ausente o mal formado.`);
  }
}

/** Cifra el SQL y devuelve el sobre completo. Verifica el descifrado antes de devolverlo. */
export function createEnvelope(sqlContent, passphrase) {
  if (typeof sqlContent !== "string" || sqlContent.trim().length === 0) {
    throw new Error("El SQL del backup está vacío.");
  }
  const key = deriveKey(passphrase);
  const checksumSha256 = computeChecksum(sqlContent);
  const { encryptedData, iv, authTag } = encryptBackupSql(sqlContent, key);

  const envelope = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    algorithm: ALGORITHM,
    kdf: "sha256",
    createdAt: new Date().toISOString(),
    sizeBytes: Buffer.byteLength(sqlContent, "utf8"),
    checksumSha256,
    iv,
    authTag,
    data: encryptedData,
  };

  // Verificación obligatoria: el sobre debe poder descifrarse y coincidir byte a byte.
  const recovered = openEnvelope(envelope, passphrase);
  if (recovered !== sqlContent) {
    throw new Error("La verificación de descifrado del backup ha fallado.");
  }
  return envelope;
}

/** Valida estructura, descifra (GCM) y comprueba tamaño y SHA-256. */
export function openEnvelope(envelope, passphrase) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("El archivo de backup no es un JSON válido.");
  }
  if (envelope.format !== BACKUP_FORMAT || envelope.version !== BACKUP_FORMAT_VERSION) {
    throw new Error("Formato de backup no reconocido o versión no soportada.");
  }
  if (envelope.algorithm !== ALGORITHM) {
    throw new Error("Algoritmo de cifrado no soportado.");
  }
  assertHex(envelope.iv, "iv");
  assertHex(envelope.authTag, "authTag");
  assertHex(envelope.data, "data");
  assertHex(envelope.checksumSha256, "checksumSha256");
  if (typeof envelope.sizeBytes !== "number" || !Number.isFinite(envelope.sizeBytes) || envelope.sizeBytes <= 0) {
    throw new Error('Archivo de backup inválido: campo "sizeBytes" ausente o mal formado.');
  }

  let sql;
  try {
    sql = decryptBackupSql(envelope.data, deriveKey(passphrase), envelope.iv, envelope.authTag);
  } catch {
    // No se propaga el error original para no filtrar detalles criptográficos.
    throw new Error("No se pudo descifrar el backup: clave incorrecta o archivo manipulado.");
  }

  if (Buffer.byteLength(sql, "utf8") !== envelope.sizeBytes) {
    throw new Error("El tamaño del SQL descifrado no coincide con el declarado.");
  }
  if (computeChecksum(sql) !== envelope.checksumSha256) {
    throw new Error("El SHA-256 del SQL descifrado no coincide: archivo manipulado.");
  }
  return sql;
}
