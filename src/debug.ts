import type { Env } from './types';

/**
 * Sistema centralizado de diagnóstico y logging.
 * 
 * Controla la emisión de mensajes [DIAG] mediante una variable de entorno DEBUG.
 * Producción: DEBUG=false (por defecto).
 * Desarrollo local: DEBUG=true (configurado en .dev.vars o wrangler.jsonc).
 * Node.js: DEBUG se lee de process.env
 * Cloudflare Workers: DEBUG se lee de env.DEBUG (binding de wrangler.jsonc)
 * 
 * Los errores, advertencias y mensajes críticos SIEMPRE se emiten, independientemente de DEBUG.
 */

let debugEnv: Env | undefined;

/**
 * Establece el contexto de entorno para lecturas de DEBUG en Cloudflare Workers.
 * En Node.js (tests), esto es opcional; se usa process.env directamente.
 * En Workers, DEBE llamarse una vez con el contexto env del Worker.
 */
export function setDebugContext(env: Env): void {
  debugEnv = env;
}

/**
 * Retorna true si DEBUG está activado.
 * En Node.js: verifica process.env.DEBUG
 * En Cloudflare Workers: verifica env.DEBUG (debe haberse llamado setDebugContext antes)
 * Por defecto: false (producción).
 */
export function isDebugEnabled(): boolean {
  // En Cloudflare Workers
  if (debugEnv) {
    const value = debugEnv.DEBUG;
    return value === 'true' || value === '1' || value === 'yes';
  }
  
  // En Node.js (tests y desarrollo local)
  if (typeof process !== 'undefined') {
    return process.env?.DEBUG === 'true' || process.env?.DEBUG === '1';
  }
  
  // Por defecto: false
  return false;
}

/**
 * Emite un log de diagnóstico si DEBUG está activado.
 * Utiliza console.log para que no contamine stderr.
 */
export function diag(message: string, ...args: any[]): void {
  if (isDebugEnabled()) {
    console.log(`[DIAG] ${message}`, ...args);
  }
}

/**
 * Emite una advertencia de diagnóstico si DEBUG está activado.
 * Utiliza console.warn para que sea claramente visible en desarrollo.
 */
export function diagWarn(message: string, ...args: any[]): void {
  if (isDebugEnabled()) {
    console.warn(`[DIAG] ${message}`, ...args);
  }
}

/**
 * Emite un error de diagnóstico SIEMPRE (nunca se oculta).
 * Los errores son críticos y deben ser visibles.
 */
export function diagError(message: string, ...args: any[]): void {
  console.error(`[DIAG] ${message}`, ...args);
}

/**
 * Emite un mensaje de error importante (no de diagnóstico).
 * Se utiliza cuando el error es operativo pero no es diagnóstico interno.
 */
export function error(message: string, ...args: any[]): void {
  console.error(message, ...args);
}
