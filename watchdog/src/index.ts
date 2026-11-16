import { DurableObject } from "cloudflare:workers";
import { type Config, type Heartbeat, type State, newState, nextWake, onHeartbeat, onTick } from "./monitor";
import { handleCommand, joinChat, leaveChat, recipients } from "./reports";
import { safeTimezone } from "./time";

export interface Env {
  MONITOR: DurableObjectNamespace<Monitor>;
  DEVICE_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  /** The one chat that receives alerts. Optional when people join through an invitation link instead. */
  TELEGRAM_CHAT_ID?: string;
  /** Proves that a call to /telegram really comes from Telegram. Needed for bot commands. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Whoever opens t.me/<bot>?start=<this code> starts receiving the alerts. Unset disables invitations. */
  CLAIM_CODE?: string;
  /** IANA zone such as "Europe/Amsterdam", for report times. Defaults to UTC. */
  TIMEZONE?: string;
  TIMEOUT_SECONDS?: string;
  REMINDER_MINUTES?: string;
  /** "off" silences the notes about brief restarts until someone sends /restarts on. */
  RESTART_MESSAGES?: string;
  /** Quoted by /fix so the person at home does not have to look them up. */
  SETUP_HOTSPOT_NAME?: string;
  SETUP_HOTSPOT_PASSWORD?: string;
  HELP_CONTACT?: string;
  /** Only overridden in local tests, to point at a fake Telegram. */
  TELEGRAM_API_BASE?: string;
}

const OUTBOX_RETRY_MS = 30_000;
const OUTBOX_MAX = 60;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,32}$/;

function numberVar(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

type Delivery = { ok: true } | { ok: false; error: string; gone: boolean };

/** `gone` means this chat will never accept the message: the person blocked the bot or the chat does not exist. */
async function sendTelegram(env: Env, chat: string, text: string): Promise<Delivery> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not set", gone: false };
  const base = env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
  try {
    const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    const body = (await res.text()).slice(0, 300);
    const gone = res.status === 403 || (res.status === 400 && /chat not found/i.test(body));
    return { ok: false, error: `Telegram answered ${res.status}: ${body}`, gone };
  } catch (err) {
    return { ok: false, error: `Telegram request failed: ${err}`, gone: false };
  }
}

type Meta = Pick<State, "muteUntil" | "restartNotes" | "people" | "nextWeeklyAt" | "nextMonthlyAt">;
interface Letter {
  chat: string;
  text: string;
}

/**
 * Holds every device's state and the single alarm that fires when something is due.
 * Alerts go through a stored outbox so one that fails to send is retried, never dropped.
 */
export class Monitor extends DurableObject<Env> {
  private state: State = newState();
  private outbox: Letter[] = [];
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
      // Earlier versions stored plain texts, all meant for the one configured chat.
      const letters = (stored.get("outbox") as (Letter | string)[]) ?? [];
      this.outbox = letters.flatMap((l) => (typeof l === "string" ? this.recipients.map((chat) => ({ chat, text: l })) : [l]));
      this.savedMeta = this.metaMark();
      this.savedHistory = this.historyMark();
    });
  }

  private get cfg(): Config {
    return {
      timeoutMs: numberVar(this.env.TIMEOUT_SECONDS, 120) * 1000,
      reminderMs: numberVar(this.env.REMINDER_MINUTES, 60) * 60_000,
      timezone: safeTimezone(this.env.TIMEZONE),
      restartNotes: this.env.RESTART_MESSAGES?.trim().toLowerCase() !== "off",
      help: { hotspotName: this.env.SETUP_HOTSPOT_NAME, hotspotPassword: this.env.SETUP_HOTSPOT_PASSWORD, contact: this.env.HELP_CONTACT },
    };
  }

  private get recipients(): string[] {
    return recipients(this.state, this.env.TELEGRAM_CHAT_ID);
  }

  private get meta(): Meta {
    const { muteUntil, restartNotes, people, nextWeeklyAt, nextMonthlyAt } = this.state;
    return { muteUntil, restartNotes, people, nextWeeklyAt, nextMonthlyAt };
  }
  private metaMark(): string {
    return JSON.stringify(this.meta);
  }
  private historyMark(): string {
    const h = this.state.history;
    return `${h.length}:${h[h.length - 1]?.to ?? 0}`;
  }

  async heartbeat(id: string, hb: Heartbeat): Promise<void> {
    await this.commit(this.toEveryone(onHeartbeat(this.state, id, hb, Date.now(), this.cfg)));
  }

  async alarm(): Promise<void> {
    await this.commit(this.toEveryone(onTick(this.state, Date.now(), this.cfg)));
  }

  /** A message typed to the bot. Returns the reply, or null if that chat has no business here. */
  async command(chat: string, text: string): Promise<string | null> {
    if (!this.recipients.includes(chat)) return null;
    let reply: string;
    if (/^\/leave(@\S*)?$/i.test(text.trim())) {
      reply = leaveChat(this.state, chat)
        ? "You will no longer receive these alerts. Open the invitation link again to come back."
        : "You are the configured owner of this device, so there is nothing to leave.";
    } else {
      reply = handleCommand(this.state, text, Date.now(), this.cfg);
    }
    await this.commit([]);
    return reply;
  }

  /** Someone opened the invitation link with the right code. Returns the welcome message. */
  async join(chat: string, name: string): Promise<string> {
    const { reply, announce } = joinChat(this.state, { chat, name }, this.env.TELEGRAM_CHAT_ID, Date.now(), this.cfg);
    const others = announce ? this.recipients.filter((c) => c !== chat).map((c) => ({ chat: c, text: announce })) : [];
    await this.commit(others);
    return reply;
  }

  async status(): Promise<Omit<Meta, "people"> & { devices: State["devices"]; outages: number; undelivered: number; people: number }> {
    // Chat ids stay inside; callers only learn how many people receive the alerts.
    return { ...this.meta, devices: this.state.devices, outages: this.state.history.length, undelivered: this.outbox.length, people: this.recipients.length };
  }

  async remove(id: string): Promise<boolean> {
    if (!(id in this.state.devices)) return false;
    delete this.state.devices[id];
    await this.commit([]);
    return true;
  }

  /** Sends a test message to everyone. Returns null on success, otherwise what went wrong. */
  async test(): Promise<string | null> {
    if (this.recipients.length === 0) return "Nobody receives the alerts yet: no chat is configured and nobody has opened the invitation link";
    for (const chat of this.recipients) {
      const sent = await sendTelegram(this.env, chat, "👋 Test message from your grid-heartbeat watchdog.");
      if (!sent.ok) return sent.error;
    }
    return null;
  }

  private toEveryone(texts: string[]): Letter[] {
    return texts.flatMap((text) => this.recipients.map((chat) => ({ chat, text })));
  }

  /** Persist state, queue and try to deliver messages, then arm the alarm for whatever comes next. */
  private async commit(letters: Letter[]): Promise<void> {
    if (letters.length) {
      this.outbox.push(...letters);
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
      const { chat, text } = this.outbox[0];
      const sent = await sendTelegram(this.env, chat, text);
      if (!sent.ok && !sent.gone) {
        console.error(`alert not delivered, will retry: ${sent.error}`);
        return;
      }
      if (!sent.ok) {
        // That person blocked the bot or deleted the chat. Stop writing to them instead of retrying forever.
        console.error(`dropping messages for a chat that no longer accepts them: ${sent.error}`);
        this.outbox = this.outbox.filter((l) => l.chat !== chat);
        if (leaveChat(this.state, chat)) {
          await this.ctx.storage.put("meta", this.meta);
          this.savedMeta = this.metaMark();
        }
      } else {
        this.outbox.shift();
      }
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

interface TelegramUpdate {
  message?: { text?: unknown; chat?: { id?: unknown }; from?: { first_name?: unknown } };
}

/** Telegram calls this for every message typed to the bot. The reply travels back in the response. */
async function telegramWebhook(request: Request, env: Env, monitor: DurableObjectStub<Monitor>): Promise<Response> {
  const given = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || !(await sameSecret(given, env.TELEGRAM_WEBHOOK_SECRET))) {
    return new Response("forbidden\n", { status: 403 });
  }
  let update: TelegramUpdate | null = null;
  try {
    update = await request.json();
  } catch {
    // not JSON; ignored below
  }
  const text = update?.message?.text;
  const chatId = update?.message?.chat?.id;
  if (typeof text !== "string" || (typeof chatId !== "number" && typeof chatId !== "string")) return new Response("ok\n");
  const chat = String(chatId);
  const answer = (reply: string) => Response.json({ method: "sendMessage", chat_id: chat, text: reply });

  // An invitation link arrives as "/start <code>". The right code adds this chat to the people who get alerts.
  const invitation = /^\/start(?:@\S+)?\s+(\S+)$/.exec(text.trim());
  if (invitation && env.CLAIM_CODE) {
    if (!(await sameSecret(invitation[1], env.CLAIM_CODE))) return answer("That invitation is not valid for this device. Ask the person who set it up for the current one.");
    const first = update?.message?.from?.first_name;
    const name = typeof first === "string" && first.trim() ? first.trim().slice(0, 40) : "Someone";
    return answer(await monitor.join(chat, name));
  }

  // Only people who receive the alerts may talk to the bot. Everyone else is acknowledged and ignored.
  const reply = await monitor.command(chat, text.slice(0, 200));
  return reply === null ? new Response("ok\n") : answer(reply);
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
      const error = await monitor.test();
      return error ? new Response(error + "\n", { status: 502 }) : new Response("sent\n");
    }
    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
