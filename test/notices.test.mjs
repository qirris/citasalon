import test from "node:test";
import assert from "node:assert/strict";

import { handlePanel } from "../src/panels.ts";
import { createSession } from "../src/auth.ts";
import {
  cancellationParams, changedForNotice, creationParams, notifyCancellation, notifyCreation,
  notifyUpdate, updateParams,
} from "../src/notices.ts";
import { fmtDay, hhmm, parseDT, startOfDay } from "../src/time.ts";

const PHONE = "+34600111222";
const CLIENT = "Cliente Prueba";

function futureDate() {
  const d = new Date(Date.now() + 86400000);
  while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const DATE = futureDate();
const STARTS = `${DATE}T10:00`;
const ENDS = `${DATE}T10:45`;

function makeAppt(overrides = {}) {
  return {
    id: 1,
    phone: PHONE,
    name: CLIENT,
    service_id: "corte_mujer",
    service_name: "Corte mujer",
    stylist: "Ana",
    starts_at: STARTS,
    ends_at: ENDS,
    status: "confirmed",
    reminder_sent: 0,
    source: "admin",
    notes: "",
    created_at: `${DATE}T09:00`,
    updated_at: `${DATE}T09:00`,
    ...overrides,
  };
}

function makeDB(rows) {
  const appts = rows.map((r) => ({ ...r }));
  const audit = [];
  const db = {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) {
          args = a;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM rate_limits")) return { n: 0 };
          if (sql.includes("FROM appointments WHERE id =")) {
            const row = appts.find((a) => a.id === args[0]);
            return row ? { ...row } : null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM settings")) return { results: [] };
          if (sql.includes("FROM audit_log")) return { results: audit };
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO rate_limits")) return { meta: { changes: 1 } };
          if (sql.includes("INSERT INTO audit_log")) {
            audit.push({ at: args[0], role: args[1], action: args[2], appt_id: args[3], detail: args[4] });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO appointments")) {
            // Creación desde panel: args = [phone,name,service_id,service_name,stylist,starts_at,ends_at,source,notes,created_at,updated_at,stylist,end,start]
            const [phone, name, service_id, service_name, stylist, starts_at, ends_at, source, notes, created_at, updated_at] = args;
            const id = appts.length ? Math.max(...appts.map((a) => a.id)) + 1 : 1;
            const row = { id, phone, name, service_id, service_name, stylist, starts_at, ends_at,
              status: "confirmed", reminder_sent: 0, source, notes, created_at, updated_at };
            appts.push(row);
            return { meta: { changes: 1, last_row_id: id } };
          }
          if (sql.includes("UPDATE appointments SET status=")) {
            const [status, , id] = args;
            const row = appts.find((a) => a.id === id);
            if (!row || row.status === status) return { meta: { changes: 0 } };
            row.status = status;
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET name=?")) {
            const [name, phone, service_id, service_name, stylist, starts_at, ends_at, notes, updated_at] = args;
            const id = args[10];
            const row = appts.find((a) => a.id === id);
            if (!row || row.status !== "confirmed") return { meta: { changes: 0 } };
            const clash = appts.some((o) => o.id !== id && o.status !== "cancelled"
              && o.stylist === stylist && o.starts_at < ends_at && o.ends_at > starts_at);
            if (clash) return { meta: { changes: 0 } };
            Object.assign(row, { name, phone, service_id, service_name, stylist, starts_at, ends_at, notes, updated_at });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { db, appts, audit };
}

function makeEnv(db, overrides = {}) {
  return {
    DB: db,
    SALON_NAME: "Salón Prueba",
    SALON_ADDRESS: "Calle Prueba 1",
    SALON_PHONE: "600000000",
    SALON_TZ: "UTC",
    WHATSAPP_PHONE_ID: "",
    WHATSAPP_NUMBER: "",
    GRAPH_VERSION: "v25.0",
    REMINDER_TEMPLATE: "",
    REMINDER_TEMPLATE_LANG: "es",
    CANCEL_TEMPLATE: "aviso_cita_cancelada",
    CANCEL_TEMPLATE_LANG: "es_ES",
    UPDATE_TEMPLATE: "aviso_cita_actualizada",
    UPDATE_TEMPLATE_LANG: "es_ES",
    CREATE_TEMPLATE: "confirmacion_reserva_peluqueria",
    CREATE_TEMPLATE_LANG: "es_ES",
    SESSION_SECRET: "secreto-de-prueba",
    ...overrides,
  };
}

function captureConsole(t) {
  const payloads = [];
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const wrap = (...args) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    lines.push(line);
    const m = line.match(/\[modo consola\] -> (.*)$/);
    if (m) payloads.push(JSON.parse(m[1]));
  };
  console.log = wrap;
  console.warn = wrap;
  console.error = wrap;
  t.after(() => {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  });
  return { payloads, lines };
}

async function panelPost(env, role, path, fields) {
  const sid = await createSession(env, role);
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { cookie: `sid=${sid}`, origin: "http://localhost" },
    body: new URLSearchParams(fields),
  });
}

test("cancelación: plantilla, idioma y los tres parámetros en orden", async (t) => {
  const { payloads } = captureConsole(t);
  const { db } = makeDB([makeAppt()]);
  const env = makeEnv(db);
  const appt = makeAppt();

  const result = await notifyCancellation(env, appt);

  assert.equal(result?.ok, true);
  assert.equal(payloads.length, 1);
  const payload = payloads[0];
  assert.equal(payload.to, PHONE);
  assert.equal(payload.template.name, "aviso_cita_cancelada");
  assert.equal(payload.template.language.code, "es_ES");
  const params = payload.template.components[0].parameters.map((p) => p.text);
  assert.deepEqual(params, cancellationParams(appt));
  assert.equal(params.length, 3);
  assert.deepEqual(params, ["Corte mujer", fmtDay(startOfDay(parseDT(STARTS))), "10:00"]);
});

test("actualización: plantilla, idioma y los cuatro parámetros en orden", async (t) => {
  const { payloads } = captureConsole(t);
  const { db } = makeDB([makeAppt()]);
  const env = makeEnv(db);
  const appt = makeAppt();

  const result = await notifyUpdate(env, appt);

  assert.equal(result?.ok, true);
  const payload = payloads[0];
  assert.equal(payload.to, PHONE);
  assert.equal(payload.template.name, "aviso_cita_actualizada");
  assert.equal(payload.template.language.code, "es_ES");
  const params = payload.template.components[0].parameters.map((p) => p.text);
  assert.deepEqual(params, updateParams(appt));
  assert.equal(params.length, 4);
  assert.deepEqual(params, ["Corte mujer", fmtDay(startOfDay(parseDT(STARTS))), "10:00", "Ana"]);
});

test("sin plantilla o sin idioma configurado no se envía nada", async (t) => {
  const { payloads } = captureConsole(t);
  const { db } = makeDB([makeAppt()]);
  const appt = makeAppt();

  assert.equal(await notifyCancellation(makeEnv(db, { CANCEL_TEMPLATE_LANG: "" }), appt), null);
  assert.equal(await notifyCancellation(makeEnv(db, { CANCEL_TEMPLATE: "" }), appt), null);
  assert.equal(await notifyUpdate(makeEnv(db, { UPDATE_TEMPLATE_LANG: "" }), appt), null);
  assert.equal(await notifyUpdate(makeEnv(db, { UPDATE_TEMPLATE: "" }), appt), null);
  assert.equal(payloads.length, 0);
});

test("sin teléfono de cliente no se envía nada", async (t) => {
  const { payloads } = captureConsole(t);
  const { db } = makeDB([makeAppt()]);
  const env = makeEnv(db);

  assert.equal(await notifyCancellation(env, makeAppt({ phone: "" })), null);
  assert.equal(await notifyUpdate(env, makeAppt({ phone: "   " })), null);
  assert.equal(payloads.length, 0);
});

test("solo se avisa si cambia fecha/hora, servicio o peluquero", () => {
  const before = makeAppt();
  assert.equal(changedForNotice(before, { ...before }), false);
  assert.equal(changedForNotice(before, { ...before, name: "Otro", phone: "+34600999888" }), false);
  assert.equal(changedForNotice(before, { ...before, starts_at: `${DATE}T11:00` }), true);
  assert.equal(changedForNotice(before, { ...before, service_id: "tinte", service_name: "Tinte" }), true);
  assert.equal(changedForNotice(before, { ...before, stylist: "Luis" }), true);
});

test("un rechazo de Meta se registra sin datos personales y no lanza", async (t) => {
  const { db } = makeDB([makeAppt()]);
  const env = makeEnv(db);
  const { lines } = captureConsole(t);

  const rejected = await notifyCancellation(env, makeAppt(), async () => ({ ok: false, simulated: false }));
  assert.equal(rejected?.ok, false);
  assert.equal(rejected?.simulated, false);
  assert.ok(lines.some((l) => l.includes("Meta rechazó")));

  const thrown = await notifyUpdate(env, makeAppt(), async () => { throw new Error("fallo simulado"); });
  assert.equal(thrown?.ok, false);

  const all = lines.join("\n");
  assert.ok(!all.includes(PHONE));
  assert.ok(!all.includes(CLIENT));
});

test("cancelación desde recepción: guarda y envía el aviso", async (t) => {
  const { payloads } = captureConsole(t);
  const { db, appts, audit } = makeDB([makeAppt()]);
  const env = makeEnv(db);
  const req = await panelPost(env, "staff", "/recepcion/cita/1/cancelar", {});

  const res = await handlePanel(req, env);

  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /ok=cancelada/);
  assert.equal(appts[0].status, "cancelled");
  assert.equal(audit.at(-1).action, "cancelar");
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].template.name, "aviso_cita_cancelada");
  assert.equal(payloads[0].to, PHONE);
  assert.equal(payloads[0].template.components[0].parameters.length, 3);
});

test("cancelación repetida: no guarda de nuevo ni duplica el aviso", async (t) => {
  const { payloads } = captureConsole(t);
  const { db, appts } = makeDB([makeAppt()]);
  const env = makeEnv(db);

  const first = await handlePanel(await panelPost(env, "staff", "/recepcion/cita/1/cancelar", {}), env);
  const second = await handlePanel(await panelPost(env, "staff", "/recepcion/cita/1/cancelar", {}), env);

  assert.equal(first.status, 303);
  assert.equal(second.status, 303);
  assert.equal(appts[0].status, "cancelled");
  assert.equal(payloads.length, 1);
});

test("cancelación desde recepción sin idioma configurado: guarda sin enviar", async (t) => {
  const { payloads } = captureConsole(t);
  const { db, appts } = makeDB([makeAppt()]);
  const env = makeEnv(db, { CANCEL_TEMPLATE_LANG: "" });

  const res = await handlePanel(await panelPost(env, "staff", "/recepcion/cita/1/cancelar", {}), env);

  assert.equal(res.status, 303);
  assert.equal(appts[0].status, "cancelled");
  assert.equal(payloads.length, 0);
});

test("actualización desde administración: envía la plantilla con cuatro parámetros", async (t) => {
  const { payloads } = captureConsole(t);
  const { db, appts, audit } = makeDB([makeAppt()]);
  const env = makeEnv(db);
  const req = await panelPost(env, "admin", "/admin/cita/1", {
    date: DATE, time: "11:00", service_id: "corte_mujer", stylist: "Ana",
    name: CLIENT, phone: PHONE, notes: "",
  });

  const res = await handlePanel(req, env);

  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /ok=guardada/);
  assert.equal(appts[0].starts_at, `${DATE}T11:00`);
  assert.equal(audit.at(-1).action, "editar");
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].to, PHONE);
  assert.equal(payloads[0].template.name, "aviso_cita_actualizada");
  assert.equal(payloads[0].template.language.code, "es_ES");
  assert.deepEqual(
    payloads[0].template.components[0].parameters.map((p) => p.text),
    ["Corte mujer", fmtDay(startOfDay(parseDT(`${DATE}T11:00`))), "11:00", "Ana"],
  );
});

test("actualización sin cambios reales: no envía aviso", async (t) => {
  const { payloads } = captureConsole(t);
  const { db, appts } = makeDB([makeAppt()]);
  const env = makeEnv(db);
  const req = await panelPost(env, "admin", "/admin/cita/1", {
    date: DATE, time: "10:00", service_id: "corte_mujer", stylist: "Ana",
    name: CLIENT, phone: PHONE, notes: "",
  });

  const res = await handlePanel(req, env);

  assert.equal(res.status, 303);
  assert.equal(appts[0].starts_at, STARTS);
  assert.equal(payloads.length, 0);
});

test("actualización con conflicto 409: no guarda ni envía aviso", async (t) => {
  const { payloads } = captureConsole(t);
  const { db, appts } = makeDB([
    makeAppt(),
    makeAppt({ id: 2, name: "Otra clienta", phone: "+34600777888", starts_at: `${DATE}T11:00`, ends_at: `${DATE}T11:45` }),
  ]);
  const env = makeEnv(db);
  const req = await panelPost(env, "admin", "/admin/cita/1", {
    date: DATE, time: "11:00", service_id: "corte_mujer", stylist: "Ana",
    name: CLIENT, phone: PHONE, notes: "",
  });

  const res = await handlePanel(req, env);

  assert.equal(res.status, 409);
  assert.equal(appts[0].starts_at, STARTS);
  assert.equal(payloads.length, 0);
});

test("Meta rechaza el aviso: la cancelación sigue guardada y el log no expone secretos ni datos", async (t) => {
  const { lines } = captureConsole(t);
  const { db, appts, audit } = makeDB([makeAppt()]);
  const env = makeEnv(db, { WHATSAPP_TOKEN: "token-secreto", WHATSAPP_PHONE_ID: "123456" });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{"error":{"code":190,"message":"Token caducado"}}', { status: 401 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const res = await handlePanel(await panelPost(env, "staff", "/recepcion/cita/1/cancelar", {}), env);

  assert.equal(res.status, 303);
  assert.equal(appts[0].status, "cancelled");
  assert.equal(audit.at(-1).action, "cancelar");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.template.name, "aviso_cita_cancelada");
  assert.equal(calls[0].body.to, PHONE);
  assert.ok(lines.some((l) => l.includes("Meta rechazó")));
  const all = lines.join("\n");
  assert.ok(!all.includes("token-secreto"));
  assert.ok(!all.includes(PHONE));
  assert.ok(!all.includes(CLIENT));
});

test("creación: plantilla, idioma y los cuatro parámetros en orden", async (t) => {
  const { payloads } = captureConsole(t);
  const { db } = makeDB([]);
  const env = makeEnv(db);
  const appt = makeAppt();

  const result = await notifyCreation(env, appt);

  assert.equal(result?.ok, true);
  assert.equal(payloads.length, 1);
  const payload = payloads[0];
  assert.equal(payload.to, PHONE);
  assert.equal(payload.template.name, "confirmacion_reserva_peluqueria");
  assert.equal(payload.template.language.code, "es_ES");
  const params = payload.template.components[0].parameters.map((p) => p.text);
  assert.deepEqual(params, creationParams(appt));
  assert.equal(params.length, 4);
  assert.deepEqual(params, ["Corte mujer", fmtDay(startOfDay(parseDT(STARTS))), "10:00", "Ana"]);
});

test("creación desde recepción: guarda y envía una sola confirmación", async (t) => {
  const { payloads } = captureConsole(t);
  const { db, appts, audit } = makeDB([]);
  const env = makeEnv(db);
  const req = await panelPost(env, "staff", "/recepcion/nueva", {
    date: DATE, time: "10:00", service_id: "corte_mujer", stylist: "Ana",
    name: CLIENT, phone: PHONE, notes: "",
  });

  const res = await handlePanel(req, env);

  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /ok=creada/);
  assert.equal(appts.length, 1);
  assert.equal(appts[0].status, "confirmed");
  assert.equal(audit.at(-1).action, "crear");
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].to, PHONE);
  assert.equal(payloads[0].template.name, "confirmacion_reserva_peluqueria");
  assert.equal(payloads[0].template.components[0].parameters.length, 4);
});

test("creación desde administración: guarda y envía la confirmación", async (t) => {
  const { payloads } = captureConsole(t);
  const { db, appts } = makeDB([]);
  const env = makeEnv(db);
  const req = await panelPost(env, "admin", "/admin/nueva", {
    date: DATE, time: "10:00", service_id: "corte_mujer", stylist: "Ana",
    name: CLIENT, phone: PHONE, notes: "",
  });

  const res = await handlePanel(req, env);

  assert.equal(res.status, 303);
  assert.equal(appts.length, 1);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].template.name, "confirmacion_reserva_peluqueria");
});

test("creación sin teléfono: guarda la cita pero no envía nada", async (t) => {
  const { payloads } = captureConsole(t);
  const { db, appts } = makeDB([]);
  const env = makeEnv(db);
  const req = await panelPost(env, "staff", "/recepcion/nueva", {
    date: DATE, time: "10:00", service_id: "corte_mujer", stylist: "Ana",
    name: CLIENT, phone: "", notes: "",
  });

  const res = await handlePanel(req, env);

  assert.equal(res.status, 303);
  assert.equal(appts.length, 1);
  assert.equal(appts[0].phone, "");
  assert.equal(payloads.length, 0);
});

test("error al guardar la cita: no se envía nada", async (t) => {
  const { payloads } = captureConsole(t);
  const base = makeDB([]);
  const db = {
    prepare(sql) {
      if (sql.includes("INSERT INTO appointments")) {
        const stmt = {
          bind() { return stmt; },
          async run() { return { meta: { changes: 0 } }; },
        };
        return stmt;
      }
      return base.db.prepare(sql);
    },
  };
  const env = makeEnv(db);
  const req = await panelPost(env, "staff", "/recepcion/nueva", {
    date: DATE, time: "10:00", service_id: "corte_mujer", stylist: "Ana",
    name: CLIENT, phone: PHONE, notes: "",
  });

  const res = await handlePanel(req, env);

  assert.equal(res.status, 422);
  assert.equal(base.appts.length, 0);
  assert.equal(payloads.length, 0);
});

test("Meta rechaza la confirmación: la cita permanece guardada", async (t) => {
  const { lines } = captureConsole(t);
  const { db, appts, audit } = makeDB([]);
  const env = makeEnv(db, { WHATSAPP_TOKEN: "token-secreto", WHATSAPP_PHONE_ID: "123456" });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{"error":{"code":131047,"message":"Re-engagement message"}}', { status: 400 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const res = await handlePanel(await panelPost(env, "staff", "/recepcion/nueva", {
    date: DATE, time: "10:00", service_id: "corte_mujer", stylist: "Ana",
    name: CLIENT, phone: PHONE, notes: "",
  }), env);

  assert.equal(res.status, 303);
  assert.equal(appts.length, 1);
  assert.equal(appts[0].status, "confirmed");
  assert.equal(audit.at(-1).action, "crear");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.template.name, "confirmacion_reserva_peluqueria");
  assert.ok(lines.some((l) => l.includes("Meta rechazó")));
  const all = lines.join("\n");
  assert.ok(!all.includes("token-secreto"));
  assert.ok(!all.includes(PHONE));
  assert.ok(!all.includes(CLIENT));
});

test("creación sin plantilla configurada: no envía nada ni falla", async (t) => {
  const { payloads } = captureConsole(t);
  const { db, appts } = makeDB([]);
  const env = makeEnv(db, { CREATE_TEMPLATE: "" });

  assert.equal(await notifyCreation(env, makeAppt()), null);

  const res = await handlePanel(await panelPost(env, "staff", "/recepcion/nueva", {
    date: DATE, time: "10:00", service_id: "corte_mujer", stylist: "Ana",
    name: CLIENT, phone: PHONE, notes: "",
  }), env);

  assert.equal(res.status, 303);
  assert.equal(appts.length, 1);
  assert.equal(payloads.length, 0);
});

