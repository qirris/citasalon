// Exporta la D1 remota de ESTA instalación sin llevar el nombre escrito a mano.
// El nombre se lee de wrangler.jsonc, que `setup.ps1` actualiza al instalar.
//
// Uso: npm run backup
//
// El SQL resultante contiene datos personales: no se sube a Git (backups/ está ignorado).
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { readD1Name } from "./d1-config.mjs";

let dbName;
try {
  dbName = readD1Name();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}

// El nombre se interpola en una orden de shell: solo se acepta el formato de D1.
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(dbName)) {
  console.error(`ERROR: el nombre de D1 "${dbName}" no es válido.`);
  process.exit(1);
}

fs.mkdirSync("backups", { recursive: true });

const result = spawnSync(
  `npx wrangler d1 export "${dbName}" --remote --output backups/backup.sql`,
  { stdio: "inherit", shell: true },
);

if (result.error) {
  console.error(`ERROR: no se pudo ejecutar wrangler: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`ERROR: el export de D1 falló (código ${result.status}).`);
  process.exit(result.status ?? 1);
}

console.log(`OK: D1 '${dbName}' exportada a backups/backup.sql`);
