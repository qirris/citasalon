// Lee los nombres de la instalación desde wrangler.jsonc.
// Se usa en scripts que no deben llevar el nombre de una base concreta escrito a mano.
import fs from "node:fs";

const CONFIG = "wrangler.jsonc";

function readValue(pattern, label, file = CONFIG) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`No se pudo leer ${file}.`);
  }
  // Los comentarios // de wrangler.jsonc no contienen estas claves, así que basta
  // con buscar el primer valor JSON. No se parsea el archivo entero para no romper
  // por los comentarios (JSONC).
  const match = text.match(pattern);
  if (!match) {
    throw new Error(`No se encontró "${label}" en ${file}.`);
  }
  return match[1];
}

/** Nombre del Worker configurado para esta instalación. */
export function readWorkerName(file = CONFIG) {
  return readValue(/(?:^|\n)\s*"name"\s*:\s*"([^"]+)"/, "name", file);
}

/** Nombre de la base D1 configurada para esta instalación. */
export function readD1Name(file = CONFIG) {
  return readValue(/"database_name"\s*:\s*"([^"]+)"/, "database_name", file);
}
