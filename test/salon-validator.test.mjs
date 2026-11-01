// Pruebas unitarias para el validador de instalación del salón
import test from "node:test";
import assert from "node:assert/strict";
import { validateSalonConfig } from "../src/salon-validator.ts";

test("Validador de configuración de salón: detecta datos correctamente", () => {
  const result = validateSalonConfig("datos-salon");
  assert.equal(result.isReady, true, "la configuración actual con datos-salon debe ser válida");
  assert.equal(result.missingFields.length, 0);
});
