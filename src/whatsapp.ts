import type { BotMessage, Env } from "./types.ts";
import { diag, diagError } from "./debug.ts";

const clip = (t: string, n: number) => (t.length <= n ? t : t.slice(0, n - 1) + "…");

export type SendResult = { ok: boolean; simulated: boolean; status?: number; error?: string; wamid?: string };

async function post(env: Env, payload: object): Promise<SendResult> {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID || env.WHATSAPP_CONSOLE === "1") {
    console.log("[modo consola] ->", JSON.stringify(payload));
    return { ok: true, simulated: true };
  }
  const maskedTo = String((payload as any).to).slice(0, 2) + "…" + String((payload as any).to).slice(-2);
  diag(`send-post to=${maskedTo} type=${(payload as any).type}`);
  try {
    const r = await fetch(`https://graph.facebook.com/${env.GRAPH_VERSION || "v25.0"}/${env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const body = await r.text();
      diagError(`send-post FAILED status=${r.status} to=${maskedTo} body=${body.slice(0, 200)}`);
      return { ok: false, simulated: false, status: r.status, error: body.slice(0, 300) };
    }
    diag(`send-post OK status=${r.status} to=${maskedTo}`);
    const data = await r.json().catch(() => null) as { messages?: { id?: string }[] } | null;
    return { ok: true, simulated: false, wamid: data?.messages?.[0]?.id };
  } catch (e) {
    diagError("send-post NETWORK-ERROR to=" + maskedTo, e);
    return { ok: false, simulated: false };
  }
}

export function sendText(env: Env, to: string, body: string) {
  return post(env, {
    messaging_product: "whatsapp", to, type: "text",
    text: { body: clip(body, 4096), preview_url: false },
  });
}

function sendButtons(env: Env, to: string, body: string, buttons: { id: string; title: string }[]) {
  return post(env, {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "button",
      body: { text: clip(body, 1024) },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: clip(b.title, 20) } })) },
    },
  });
}

function sendList(env: Env, to: string, body: string, button: string, section: string,
  rows: { id: string; title: string; description?: string }[]) {
  return post(env, {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "list",
      body: { text: clip(body, 1024) },
      action: {
        button: clip(button, 20),
        sections: [{
          title: clip(section, 24),
          rows: rows.slice(0, 10).map((r) => ({
            id: r.id.slice(0, 200), title: clip(r.title, 24),
            ...(r.description ? { description: clip(r.description, 72) } : {}),
          })),
        }],
      },
    },
  });
}

export function send(env: Env, to: string, m: BotMessage) {
  if (typeof m === "string") return sendText(env, to, m);
  return m.type === "buttons" ? sendButtons(env, to, m.body, m.buttons) : sendList(env, to, m.body, m.button, m.section, m.rows);
}

/** Plantilla aprobada por Meta: necesaria para escribir al cliente pasadas 24 h desde su último mensaje */
export function sendTemplate(env: Env, to: string, name: string, lang: string, params: string[]) {
  return post(env, {
    messaging_product: "whatsapp", to, type: "template",
    template: {
      name, language: { code: lang },
      components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
    },
  });
}
