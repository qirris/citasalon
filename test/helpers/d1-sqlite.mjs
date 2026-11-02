/**
 * Adaptador mínimo de D1 sobre SQLite real (node:sqlite).
 *
 * Cloudflare D1 es SQLite: este adaptador permite probar el SQL de `src/db.ts` y el flujo
 * del Consumer con transacciones de verdad, sin mocks y sin tocar la base local de Wrangler.
 * `batch()` abre una transacción, igual que D1: o se aplican todas las sentencias o ninguna.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url);
const read = (name) => readFileSync(new URL(name, ROOT), "utf8");

const normalize = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

class Statement {
  constructor(raw, sql, params = []) {
    this.raw = raw;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.raw, this.sql, params.map(normalize));
  }

  _statement() {
    return this.raw.prepare(this.sql);
  }

  async first(column) {
    const row = this._statement().get(...this.params);
    if (!row) return null;
    return column ? (row[column] ?? null) : row;
  }

  async all() {
    const results = this._statement().all(...this.params);
    return { results, success: true, meta: { changes: 0 } };
  }

  async run() {
    return this._runSync();
  }

  _runSync() {
    const r = this._statement().run(...this.params);
    return {
      success: true,
      meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
    };
  }
}

export class SqliteD1 {
  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql) {
    return new Statement(this.raw, sql);
  }

  async batch(statements) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((s) => s._runSync());
      this.raw.exec("COMMIT");
      return results;
    } catch (e) {
      try { this.raw.exec("ROLLBACK"); } catch { /* la transacción ya estaba cerrada */ }
      throw e;
    }
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  query(sql, ...params) {
    return this.raw.prepare(sql).all(...params);
  }

  close() {
    this.raw.close();
  }
}

/** Esquema completo para una base recién creada: schema.sql ya incluye base + Fase 2.
 * Las migraciones 0001..0004 son solo para actualizar bases existentes que las necesiten.
 */
export async function applySchema(db) {
  db.exec(read("schema.sql"));
}

export function createTestDb() {
  const db = new SqliteD1(":memory:");
  applySchema(db);
  return db;
}

/** Entorno mínimo para el bot y el Consumer. Sin token: nunca se llama a Meta. */
export function makeEnv(db, overrides = {}) {
  return {
    DB: db,
    SALON_NAME: "Peluqueria Ejemplo",
    SALON_ADDRESS: "Calle Ejemplo 1",
    SALON_PHONE: "600 000 000",
    SALON_TZ: "UTC",
    WHATSAPP_PHONE_ID: "",
    WHATSAPP_NUMBER: "",
    GRAPH_VERSION: "v25.0",
    REMINDER_TEMPLATE: "",
    REMINDER_TEMPLATE_LANG: "es",
    CANCEL_TEMPLATE: "",
    CANCEL_TEMPLATE_LANG: "es_ES",
    UPDATE_TEMPLATE: "",
    UPDATE_TEMPLATE_LANG: "es_ES",
    CREATE_TEMPLATE: "",
    CREATE_TEMPLATE_LANG: "es_ES",
    ...overrides,
  };
}

/** Servicio de WhatsApp falso: registra los envíos y permite simular fallos por llamada. */
export function fakeWhatsApp(script = []) {
  const sends = [];
  return {
    sends,
    async send(_env, to, payload) {
      const next = script.length ? script.shift() : { ok: true, simulated: true, wamid: `wamid-out-${sends.length + 1}` };
      sends.push({ to, payload, result: next });
      return next;
    },
  };
}

/** Servicio de bot falso: responde con eco y registra el orden real de procesamiento. */
export function fakeBot(handler) {
  const calls = [];
  return {
    calls,
    async handleMessage(_env, phone, text, _profile, _now, payload, session) {
      calls.push({ phone, text, payload, state: session.state });
      if (handler) return handler({ phone, text, payload, session, calls });
      return { replies: [`eco:${text}`], state: "MENU", data: {}, intent: null };
    },
  };
}

export async function insertAppointment(db, a) {
  const row = {
    phone: "34600000000", name: "Cliente", service_id: "corte_hombre", service_name: "Corte hombre",
    stylist: "Ana", starts_at: "2026-11-03T10:00", ends_at: "2026-11-03T10:30",
    status: "confirmed", reminder_sent: 0, source: "whatsapp", notes: "",
    created_at: "2026-11-01T09:00", updated_at: "2026-11-01T09:00", source_wamid: null,
    ...a,
  };
  const cols = Object.keys(row);
  const r = await db.prepare(
    `INSERT INTO appointments (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).bind(...cols.map((c) => row[c])).run();
  return db.prepare("SELECT * FROM appointments WHERE id=?").bind(r.meta.last_row_id).first();
}

/** Inicializa un bloqueo para un teléfono (para tests que adquieren locks). */
export async function initLock(db, phone, workerId, token, now) {
  await db.prepare(
    `INSERT INTO phone_locks (phone, worker_id, fencing_token, expires_at) VALUES (?, ?, ?, ?)`,
  ).bind(phone, workerId, token, now.toISOString()).run();
}
