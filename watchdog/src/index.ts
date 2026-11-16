import { DurableObject } from "cloudflare:workers";
import { type Config, type Heartbeat, type State, newState, nextWake, onHeartbeat, onTick } from "./monitor";
import { handleCommand } from "./reports";
import { safeTimezone } from "./time";

export interface Env {
  MONITOR: DurableObjectNamespace<Monitor>;
  DEVICE_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  /** Proves that a call to /telegram really comes from Telegram. Needed for bot commands. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** IANA zone such as "Europe/Amsterdam", for report times. Defaults to UTC. */
  TIMEZONE?: string;
  TIMEOUT_SECONDS?: string;
  REMINDER_MINUTES?: string;
  /** Only overridden in local tests, to point at a fake Telegram. */
  TELEGRAM_API_BASE?: string;
}

const OUTBOX_RETRY_MS = 30_000;
const OUTBOX_MAX = 20;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,32}$/;

function numberVar(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Returns null on success, otherwise a description of what went wrong. */
async function sendTelegram(env: Env, text: string): Promise<string | null> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set";
  }
  const base = env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
  try {
    const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return null;
    return `Telegram answered ${res.status}: ${(await res.text()).slice(0, 300)}`;
  } catch (err) {
    return `Telegram request failed: ${err}`;
  }
}

type Meta = Pick<State, "muteUntil" | "restartNotes" | "nextWeeklyAt" | "nextMonthlyAt">;

/**
 * Holds every device's state and the single alarm that fires when something is due.
 * Alerts go through a stored outbox so one that fails to send is retried, never dropped.
 */
export class Monitor extends DurableObject<Env> {
  private state: State = newState();
  private outbox: string[] = [];
  private flushing: Promise<void> | null = null;
  // What is already in storage, so the rarely-changing parts are only written when they change.
  private savedMeta = "";
  private savedHistory = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<unknown>(["devices", "history", "meta", "outbox"]);
      this.state = {
        ...newState(),
        devices: (stored.get("devices") as State["devices"]) ?? {},
        history: (stored.get("history") as State["history"]) ?? [],
        ...((stored.get("meta") as Meta) ?? {}),
      };
      this.outbox = (stored.get("outbox") as string[]) ?? [];
      this.savedMeta = this.metaMark();
      this.savedHistory = this.historyMark();
    });
  }

  private get cfg(): Config {
    return {
      timeoutMs: numberVar(this.env.TIMEOUT_SECONDS, 120) * 1000,
      reminderMs: numberVar(this.env.REMINDER_MINUTES, 60) * 60_000,
      timezone: safeTimezone(this.env.TIMEZONE),
    };
  }

  private get meta(): Meta {
    const { muteUntil, restartNotes, nextWeeklyAt, nextMonthlyAt } = this.state;
    return { muteUntil, restartNotes, nextWeeklyAt, nextMonthlyAt };
  }
  private metaMark(): string {
    return JSON.stringify(this.meta);
  }
  private historyMark(): string {
    const h = this.state.history;
    return `${h.length}:${h[h.length - 1]?.to ?? 0}`;
  }

  async heartbeat(id: string, hb: Heartbeat): Promise<void> {
    await this.commit(onHeartbeat(this.state, id, hb, Date.now(), this.cfg));
  }

  async alarm(): Promise<void> {
    await this.commit(onTick(this.state, Date.now(), this.cfg));
  }

  /** A message typed to the bot. Returns the reply. */
  async command(text: string): Promise<string> {
    const reply = handleCommand(this.state, text, Date.now(), this.cfg);
    await this.commit([]);
    return reply;
  }

  async status(): Promise<Meta & { devices: State["devices"]; outages: number; undelivered: number }> {
    return { devices: this.state.devices, outages: this.state.history.length, undelivered: this.outbox.length, ...this.meta };
  }

  async remove(id: string): Promise<boolean> {
    if (!(id in this.state.devices)) return false;
    delete this.state.devices[id];
    await this.commit([]);
    return true;
  }

  /** Persist state, queue and try to deliver messages, then arm the alarm for whatever comes next. */
  private async commit(messages: string[]): Promise<void> {
    if (messages.length) {
      this.outbox.push(...messages);
      // If Telegram stays unreachable, keep the most recent alerts rather than growing forever.
      this.outbox.splice(0, Math.max(0, this.outbox.length - OUTBOX_MAX));
    }
    const changed: Record<string, unknown> = { devices: this.state.devices, outbox: this.outbox };
    if (this.metaMark() !== this.savedMeta) changed.meta = this.meta;
    if (this.historyMark() !== this.savedHistory) changed.history = this.state.history;
    await this.ctx.storage.put(changed);
    this.savedMeta = this.metaMark();
    this.savedHistory = this.historyMark();
    await this.flush();

    const wake = nextWake(this.state, this.cfg);
    const retry = this.outbox.length ? Date.now() + OUTBOX_RETRY_MS : null;
    const next = wake !== null && retry !== null ? Math.min(wake, retry) : (wake ?? retry);
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
  }

  // Awaiting Telegram lets other heartbeats run, so serialize flushes to avoid sending a message twice.
  private flush(): Promise<void> {
    this.flushing ??= this.drainOutbox().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async drainOutbox(): Promise<void> {
    while (this.outbox.length) {
      const error = await sendTelegram(this.env, this.outbox[0]);
      if (error) {
        console.error(`alert not delivered, will retry: ${error}`);
        return;
      }
      this.outbox.shift();
      await this.ctx.storage.put("outbox", this.outbox);
    }
  }
}

/** Compares two secrets without leaking, through timing, how much of them matched. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  // Hash both sides so the comparison is constant-time regardless of length.
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function parseHeartbeat(body: string): Heartbeat {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  return {
    boot: typeof r.boot === "string" || typeof r.boot === "number" ? String(r.boot).slice(0, 64) : undefined,
    reset: typeof r.reset === "string" && r.reset ? r.reset.slice(0, 100) : undefined,
    rssi: typeof r.rssi === "number" && Number.isFinite(r.rssi) ? r.rssi : undefined,
  };
}

/** Telegram calls this for every message typed to the bot. The reply travels back in the response. */
async function telegramWebhook(request: Request, env: Env, monitor: DurableObjectStub<Monitor>): Promise<Response> {
  const given = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || !(await sameSecret(given, env.TELEGRAM_WEBHOOK_SECRET))) {
    return new Response("forbidden\n", { status: 403 });
  }
  let update: { message?: { text?: unknown; chat?: { id?: unknown } } } | null = null;
  try {
    update = await request.json();
  } catch {
    // not JSON; ignored below
  }
  const text = update?.message?.text;
  // Only the owner's chat may talk to the bot. Everything else is acknowledged and ignored.
  if (typeof text !== "string" || String(update?.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) {
    return new Response("ok\n");
  }
  const reply = await monitor.command(text.slice(0, 200));
  return Response.json({ method: "sendMessage", chat_id: env.TELEGRAM_CHAT_ID, text: reply });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const [, root, id, extra] = pathname.split("/");
    const monitor = env.MONITOR.get(env.MONITOR.idFromName("monitor"));
    const route = `${request.method} /${root}`;

    if (route === "POST /telegram" && id === undefined) return telegramWebhook(request, env, monitor);

    const bearer = request.headers.get("Authorization") ?? "";
    if (!env.DEVICE_TOKEN || !(await sameSecret(bearer, `Bearer ${env.DEVICE_TOKEN}`))) {
      return new Response("unauthorized\n", { status: 401 });
    }

    if (route === "POST /hb" && id && extra === undefined) {
      if (!DEVICE_ID.test(id)) return new Response("bad device id\n", { status: 400 });
      await monitor.heartbeat(id, parseHeartbeat(await request.text()));
      return new Response("ok\n");
    }
    if (route === "GET /status" && id === undefined) {
      return Response.json(await monitor.status());
    }
    if (route === "DELETE /devices" && id && extra === undefined) {
      return (await monitor.remove(id))
        ? new Response("removed\n")
        : new Response("no such device\n", { status: 404 });
    }
    if (route === "POST /test" && id === undefined) {
      const error = await sendTelegram(env, "👋 Test message from your grid-heartbeat watchdog.");
      return error ? new Response(error + "\n", { status: 502 }) : new Response("sent\n");
    }
    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
