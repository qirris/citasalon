// Script validador de configuración previa a la instalación en un salón real
import fs from "node:fs";
import path from "node:path";

export interface SalonValidationResult {
  isReady: boolean;
  missingFields: string[];
  warnings: string[];
}

/**
 * Comprueba que la estructura y los datos mínimos de configuración de la peluquería
 * estén presentes antes de proceder a una instalación productiva.
 */
export function validateSalonConfig(dataDir: string): SalonValidationResult {
  const missingFields: string[] = [];
  const warnings: string[] = [];

  const leemePath = path.join(dataDir, "LEEME.md");
  if (!fs.existsSync(leemePath)) {
    missingFields.push("Falta el archivo de descripción de la peluquería (LEEME.md en datos-salon/).");
  }

  // Comprobar existencia de directorios o archivos de configuración base
  if (!fs.existsSync("wrangler.jsonc")) {
    missingFields.push("Falta el archivo de configuración wrangler.jsonc.");
  }

  if (!fs.existsSync("schema.sql")) {
    missingFields.push("Falta el esquema SQL base (schema.sql).");
  }

  return {
    isReady: missingFields.length === 0,
    missingFields,
    warnings
  };
}
