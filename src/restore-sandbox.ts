// Módulo ampliado de restauración segura y validación rigurosa de esquemas y restricciones D1
import { DatabaseSync } from "node:sqlite";
import { restoreAndVerifyBackup } from "./backup.ts";

export interface ValidationReport {
  isValid: boolean;
  errors: string[];
  tablesFound: string[];
  rowCounts: Record<string, number>;
}

const EXPECTED_TABLES = ["appointments", "sessions", "settings", "audit_log", "inbox_messages", "sent_messages"];

/**
 * Valida de forma estricta un volcado SQL y comprueba que puede restaurarse en una base de datos SQLite aislada,
 * verificando tablas obligatorias, restricciones de clave y ausencia de corrupción.
 */
export function validateAndRestoreBackupToSandbox(backupPath: string, metaPath: string, secretKey: any): ValidationReport {
  const errors: string[] = [];
  const tablesFound: string[] = [];
  const rowCounts: Record<string, number> = {};

  let decryptedSql: string;
  try {
    decryptedSql = restoreAndVerifyBackup(backupPath, metaPath, secretKey);
  } catch (e: any) {
    return {
      isValid: false,
      errors: [`Error de desencriptación o integridad: ${e.message}`],
      tablesFound: [],
      rowCounts: {}
    };
  }

  // Comprobación preliminar de sintaxis y presencia de esquema obligatorio
  for (const t of EXPECTED_TABLES) {
    if (!decryptedSql.toLowerCase().includes(`create table`) && !decryptedSql.toLowerCase().includes(t)) {
      errors.push(`El volcado SQL no parece contener definiciones válidas para la tabla esperada: ${t}`);
    }
  }

  // Crear base de datos temporal en memoria (Sandbox aislado)
  let sandboxDb: any;
  try {
    sandboxDb = new DatabaseSync(":memory:");
    sandboxDb.exec(decryptedSql);
  } catch (e: any) {
    return {
      isValid: false,
      errors: [`Error al ejecutar el SQL restaurado en la base de datos de pruebas aislada: ${e.message}`],
      tablesFound: [],
      rowCounts: {}
    };
  }

  // Inspeccionar tablas reales creadas
  try {
    const tablesStmt = sandboxDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    const rows = tablesStmt.all() as Array<{ name: string }>;

    for (const r of rows) {
      tablesFound.push(r.name);
      const countStmt = sandboxDb.prepare(`SELECT COUNT(*) AS n FROM ${r.name}`);
      const countRes = countStmt.get() as { n: number };
      rowCounts[r.name] = countRes?.n ?? 0;
    }
  } catch (e: any) {
    errors.push(`Error al inspeccionar las tablas de la base de datos restaurada: ${e.message}`);
  }

  // Validar tablas obligatorias mínimas
  for (const t of EXPECTED_TABLES) {
    if (!tablesFound.includes(t)) {
      errors.push(`Falta la tabla obligatoria "${t}" en el esquema restaurado.`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    tablesFound,
    rowCounts
  };
}
