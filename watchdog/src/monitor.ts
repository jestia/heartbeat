// The watchdog's decision logic, kept free of I/O so it can be tested with a fake clock.
// index.ts feeds it heartbeats, timer ticks and bot commands, and delivers the messages it returns.

import { monthlyReport, restartNotesOn, weeklyReport } from "./reports";
import { formatDuration, nextLocal } from "./time";

export { formatDuration };

export interface Config {
  /** Silence longer than this marks a device as down. */
  timeoutMs: number;
  /** Repeat the alert this often while a device stays down. 0 disables reminders. */
  reminderMs: number;
  /** IANA zone used for report times and the weekly/monthly schedule. */
  timezone: string;
  /** Whether brief restarts are announced, until the owner chooses with /restarts. Defaults to true. */
  restartNotes?: boolean;
  /** Details the /fix command can quote, so the owner does not have to look them up. */
  help?: HelpInfo;
}

export interface HelpInfo {
  /** Name of the hotspot the device opens when it cannot join Wi-Fi. */
  hotspotName?: string;
  hotspotPassword?: string;
  /** Who to ask when the steps do not help. */
  contact?: string;
}

/** Someone who receives the alerts and may use the bot. */
export interface Person {
  chat: string;
  name: string;
}

/** What the device sends. Every field is optional so any HTTP client can act as a device. */
export interface Heartbeat {
  /** Changes every time the device boots; lets us tell a reboot from a network gap. */
  boot?: string;
  /** Why the device last booted, in whatever words the firmware uses. */
  reset?: string;
  rssi?: number;
  /** The chip's own temperature in °C. */
  temp?: number;
}

export interface Device {
  id: string;
  state: "up" | "down";
  lastSeen: number;
  /** When the current boot was first seen, i.e. roughly when the device powered up. */
  bootSeenAt: number;
  /** When the last down alert or reminder went out. Null while down means "not alerted yet" (alerts were paused). */
  lastAlertAt: number | null;
  boot: string | null;
  reset: string | null;
  rssi: number | null;
  /** Since when the Wi-Fi signal has been continuously weak. */
  weakSince?: number | null;
  /** When the weak-signal warning was last sent. */
  weakWarnedAt?: number | null;
  /** The chip's temperature in °C from the latest heartbeat, if the firmware reports it. */
  temp?: number | null;
  /** Since when the chip has been continuously hot, and when that was last reported. */
  hotSince?: number | null;
  hotWarnedAt?: number | null;
}

export type Cause = "power" | "network" | "restart" | "unknown";

/** One gap in the heartbeats, recorded when the device comes back. */
export interface Outage {
  id: string;
  /** Last heartbeat before the gap. */
  from: number;
  /** First heartbeat after it. */
  to: number;
  cause: Cause;
  /** True if the silence was long enough to trip the alert; false for a brief restart. */
  tripped: boolean;
}

export interface State {
  devices: Record<string, Device>;
  history: Outage[];
  /** Alerts are paused until this time. */
  muteUntil: number | null;
  /** The owner's choice about "restarted" notes for brief interruptions. Unset means the configured default. */
  restartNotes?: boolean;
  /** People who joined through the invitation link. Empty means the single configured chat is used. */
  people?: Person[];
  nextWeeklyAt: number | null;
  nextMonthlyAt: number | null;
}

export const newState = (): State => ({ devices: {}, history: [], muteUntil: null, nextWeeklyAt: null, nextMonthlyAt: null });

export const HISTORY_MAX = 300;
const MINUTE = 60_000;
// Warn after the signal has stayed this weak for this long; forget it once it clearly recovers.
export const WEAK_DBM = -80;
const RECOVERED_DBM = -75;
const WEAK_FOR_MS = 30 * MINUTE;
const WEAK_REPEAT_MS = 7 * 24 * 60 * MINUTE;
// Same idea for heat. A chip at 80 °C still works, but that is well above what this device needs.
export const HOT_C = 80;
const COOLED_C = 72;
const HOT_FOR_MS = 30 * MINUTE;
const HOT_REPEAT_MS = 24 * 60 * MINUTE;

export function isMuted(state: State, now: number): boolean {
  return state.muteUntil !== null && now < state.muteUntil;
}

/** Weekly check-in on Monday 09:00 and monthly summary on the 1st at 09:00, both local time. */
function ensureSchedule(state: State, now: number, cfg: Config): void {
  state.nextWeeklyAt ??= nextLocal(now, cfg.timezone, (p) => p.weekday === "Mon" && p.hour === 9);
  state.nextMonthlyAt ??= nextLocal(now, cfg.timezone, (p) => p.day === 1 && p.hour === 9);
}

// A power cut shows up as a power-on or brownout reset. ESPHome reports "power-on event",
// "brownout" or "power glitch detected"; other firmware says "POWERON_RESET", so match loosely.
function isPowerReset(reset: string | null): boolean {
  return reset !== null && /power|brown/i.test(reset);
}

// Anything else (ESPHome reboots itself after 15 min without Wi-Fi, updates, crashes) is hedged:
// the device only reports its latest restart, which can hide an earlier power-on.
function describeRestart(reset: string | null): string {
  if (isPowerReset(reset)) return `Power was lost: the device booted fresh (${reset}).`;
  if (reset) return `The device restarted, but not from a power-on (${reset}), so this was probably not a power cut.`;
  return "The device restarted, which usually means power was lost.";
}

function weakSignalWarning(d: Device, now: number): string | null {
  if (d.rssi === null) return null;
  if (d.rssi > RECOVERED_DBM) d.weakSince = null;
  else if (d.rssi <= WEAK_DBM) d.weakSince ??= now;
  if (d.weakSince == null || now - d.weakSince < WEAK_FOR_MS) return null;
  if (d.weakWarnedAt != null && now - d.weakWarnedAt < WEAK_REPEAT_MS) return null;
  d.weakWarnedAt = now;
  return (
    `📶 ${d.id} has had a weak Wi-Fi signal for ${formatDuration(now - d.weakSince)} (${d.rssi} dBm).\n` +
    "This can cause false alarms. Move it closer to the router or reposition its antenna."
  );
}

function heatWarning(d: Device, now: number): string | null {
  if (d.temp == null) return null;
  if (d.temp < COOLED_C) d.hotSince = null;
  else if (d.temp >= HOT_C) d.hotSince ??= now;
  if (d.hotSince == null || now - d.hotSince < HOT_FOR_MS) return null;
  if (d.hotWarnedAt != null && now - d.hotWarnedAt < HOT_REPEAT_MS) return null;
  d.hotWarnedAt = now;
  return (
    `🌡️ ${d.id} is running hot: its chip has been at ${HOT_C} °C or more for ${formatDuration(now - d.hotSince)} (now ${Math.round(d.temp)} °C).\n` +
    "Give it some air: keep it out of direct sun and away from heaters, and do not cover it."
  );
}

/** Apply one heartbeat. Mutates `state` and returns the messages to send. */
export function onHeartbeat(state: State, id: string, hb: Heartbeat, now: number, cfg: Config): string[] {
  ensureSchedule(state, now, cfg);
  const prev = state.devices[id];
  const boot = hb.boot ?? null;
  const reset = hb.reset ?? null;
  // Only call it a reboot when both sides report a boot id; a client that sends none never "reboots".
  const rebooted = prev !== undefined && boot !== null && prev.boot !== null && boot !== prev.boot;

  const device: Device = {
    id,
    state: "up",
    lastSeen: now,
    bootSeenAt: prev && !rebooted ? prev.bootSeenAt : now,
    lastAlertAt: null,
    boot: boot ?? prev?.boot ?? null,
    reset: reset ?? (rebooted ? null : (prev?.reset ?? null)),
    rssi: hb.rssi ?? null,
    weakSince: prev?.weakSince ?? null,
    weakWarnedAt: prev?.weakWarnedAt ?? null,
    temp: hb.temp ?? null,
    hotSince: prev?.hotSince ?? null,
    hotWarnedAt: prev?.hotWarnedAt ?? null,
  };
  state.devices[id] = device;

  const messages: string[] = [];
  if (!prev) {
    messages.push(`✅ ${id} is online. Monitoring started.`);
  } else if (prev.state === "down" || rebooted) {
    const bothKnown = boot !== null && prev.boot !== null;
    const cause: Cause = rebooted ? (isPowerReset(reset) ? "power" : reset ? "restart" : "unknown") : bothKnown ? "network" : "unknown";
    state.history.push({ id, from: prev.lastSeen, to: now, cause, tripped: prev.state === "down" });
    state.history.splice(0, Math.max(0, state.history.length - HISTORY_MAX));

    if (prev.state === "down") {
      const detail = rebooted
        ? describeRestart(reset)
        : bothKnown
          ? `Power stayed on: the device has been running for ${formatDuration(now - prev.bootSeenAt)}, so the network or internet was down.`
          : "";
      messages.push(`🟢 ${id} is back after ${formatDuration(now - prev.lastSeen)} of silence.${detail ? "\n" + detail : ""}`);
    } else if (restartNotesOn(state, cfg)) {
      // Rebooted but back before the timeout: an outage too short to trip the silence alert.
      messages.push(`⚡ ${id} restarted (${reset ?? "no reason reported"}).${isPowerReset(reset) ? " Power was briefly lost." : ""}`);
    }
  }

  if (isMuted(state, now)) return [];
  const weak = weakSignalWarning(device, now);
  if (weak) messages.push(weak);
  const hot = heatWarning(device, now);
  if (hot) messages.push(hot);
  return messages;
}

/** Check everything that depends on the clock. Mutates `state` and returns the messages to send. */
export function onTick(state: State, now: number, cfg: Config): string[] {
  ensureSchedule(state, now, cfg);
  const messages: string[] = [];
  if (state.muteUntil !== null && now >= state.muteUntil) {
    state.muteUntil = null;
    messages.push("🔔 The pause is over. Alerts are on again.");
  }
  const muted = isMuted(state, now);
  const hint = "Power or internet at that location is probably down.\nIf the power is on, send /fix for what to check.";

  for (const d of Object.values(state.devices)) {
    const silence = formatDuration(now - d.lastSeen);
    if (d.state === "up" && now - d.lastSeen >= cfg.timeoutMs) {
      d.state = "down";
      d.lastAlertAt = muted ? null : now;
      if (!muted) messages.push(`🔴 ${d.id} went silent. No heartbeat for ${silence}.\n${hint}`);
    } else if (d.state === "down" && !muted) {
      if (d.lastAlertAt === null) {
        // It went down while alerts were paused; say so now.
        d.lastAlertAt = now;
        messages.push(`🔴 ${d.id} is silent. No heartbeat for ${silence}.\n${hint}`);
      } else if (cfg.reminderMs > 0 && now - d.lastAlertAt >= cfg.reminderMs) {
        d.lastAlertAt = now;
        messages.push(`🔴 ${d.id} is still silent. Down for ${silence}.`);
      }
    }
  }

  if (state.nextWeeklyAt !== null && now >= state.nextWeeklyAt) {
    messages.push(weeklyReport(state, now, cfg));
    state.nextWeeklyAt = nextLocal(now, cfg.timezone, (p) => p.weekday === "Mon" && p.hour === 9);
  }
  if (state.nextMonthlyAt !== null && now >= state.nextMonthlyAt) {
    messages.push(monthlyReport(state, state.nextMonthlyAt, cfg));
    state.nextMonthlyAt = nextLocal(now, cfg.timezone, (p) => p.day === 1 && p.hour === 9);
  }
  return messages;
}

/** The next moment onTick could have something to do, or null if there is nothing to wait for. */
export function nextWake(state: State, cfg: Config): number | null {
  let next: number | null = null;
  const consider = (t: number | null) => {
    if (t !== null && (next === null || t < next)) next = t;
  };
  // While alerts are paused, nothing about a down device changes before the pause ends.
  const resume = state.muteUntil ?? 0;
  for (const d of Object.values(state.devices)) {
    if (d.state === "up") consider(d.lastSeen + cfg.timeoutMs);
    else if (d.lastAlertAt === null) consider(resume);
    else if (cfg.reminderMs > 0) consider(Math.max(d.lastAlertAt + cfg.reminderMs, resume));
  }
  consider(state.muteUntil);
  consider(state.nextWeeklyAt);
  consider(state.nextMonthlyAt);
  return next;
}
