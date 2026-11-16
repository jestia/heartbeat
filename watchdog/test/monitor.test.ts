import { describe, expect, it } from "vitest";
import { type Config, type State, formatDuration, newState, nextWake, onHeartbeat, onTick } from "../src/monitor";
import { fixText, handleCommand, joinChat, leaveChat, parseDuration, recipients } from "../src/reports";
import { localParts, nextLocal } from "../src/time";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const cfg: Config = { timeoutMs: 2 * MIN, reminderMs: 60 * MIN, timezone: "UTC" };
const POWERON = "power-on event";
// Wednesday 4 Nov 2026, 12:00 UTC. Tests use real dates because the reports talk about weekdays and months.
const T0 = Date.UTC(2026, 10, 4, 12);
// Alerts only; the weekly and monthly reports are tested on their own.
const tick = (s: State, now: number, c = cfg) => onTick(s, now, c).filter((m) => !m.startsWith("✅ Weekly") && !m.startsWith("📊"));

describe("formatDuration", () => {
  it("picks sensible units", () => {
    expect(formatDuration(45 * SEC)).toBe("45 s");
    expect(formatDuration(3 * MIN)).toBe("3 min");
    expect(formatDuration(60 * MIN)).toBe("1 h");
    expect(formatDuration(72 * MIN)).toBe("1 h 12 min");
    expect(formatDuration(51 * HOUR)).toBe("2 d 3 h");
  });
});

describe("alerts", () => {
  it("announces a new device once and stays quiet on regular heartbeats", () => {
    const s = newState();
    expect(onHeartbeat(s, "home", { boot: "a" }, T0, cfg)).toEqual(["✅ home is online. Monitoring started."]);
    expect(onHeartbeat(s, "home", { boot: "a" }, T0 + 30 * SEC, cfg)).toEqual([]);
    expect(tick(s, T0 + 60 * SEC)).toEqual([]);
    expect(nextWake(s, cfg)).toBe(T0 + 30 * SEC + cfg.timeoutMs);
  });

  it("alerts exactly once when heartbeats stop, then reminds", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, cfg);
    expect(tick(s, T0 + cfg.timeoutMs - 1)).toEqual([]);
    const alert = tick(s, T0 + cfg.timeoutMs);
    expect(alert).toHaveLength(1);
    expect(alert[0]).toContain("🔴 home went silent. No heartbeat for 2 min.");
    expect(s.devices.home.state).toBe("down");

    expect(tick(s, T0 + cfg.timeoutMs + MIN)).toEqual([]);
    expect(nextWake(s, cfg)).toBe(T0 + cfg.timeoutMs + cfg.reminderMs);
    expect(tick(s, T0 + cfg.timeoutMs + cfg.reminderMs)).toEqual(["🔴 home is still silent. Down for 1 h 2 min."]);
  });

  it("sends no reminders when reminders are off", () => {
    const quiet: Config = { ...cfg, reminderMs: 0 };
    const s = newState();
    onHeartbeat(s, "home", {}, T0, quiet);
    expect(tick(s, T0 + cfg.timeoutMs, quiet)).toHaveLength(1);
    expect(tick(s, T0 + 5 * HOUR, quiet)).toEqual([]);
    // Only the weekly and monthly reports remain to wake up for.
    expect(nextWake(s, quiet)).toBe(Math.min(s.nextWeeklyAt!, s.nextMonthlyAt!));
  });

  it("blames power when the device comes back with a new boot id and a power-on reset", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a", reset: POWERON }, T0, cfg);
    tick(s, T0 + cfg.timeoutMs);
    const [msg] = onHeartbeat(s, "home", { boot: "b", reset: POWERON }, T0 + 25 * MIN, cfg);
    expect(msg).toContain("🟢 home is back after 25 min of silence.");
    expect(msg).toContain("Power was lost");
    expect(s.devices.home.bootSeenAt).toBe(T0 + 25 * MIN);
    expect(s.history).toEqual([{ id: "home", from: T0, to: T0 + 25 * MIN, cause: "power", tripped: true }]);
  });

  it("blames the network when the same boot comes back", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a", reset: POWERON }, T0, cfg);
    tick(s, T0 + cfg.timeoutMs);
    const [msg] = onHeartbeat(s, "home", { boot: "a", reset: POWERON }, T0 + 25 * MIN, cfg);
    expect(msg).toContain("Power stayed on: the device has been running for 25 min");
    expect(s.history[0].cause).toBe("network");
  });

  it("does not blame power when the device restarted itself", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a", reset: POWERON }, T0, cfg);
    tick(s, T0 + cfg.timeoutMs);
    const [msg] = onHeartbeat(s, "home", { boot: "b", reset: "Reboot request from wifi" }, T0 + 25 * MIN, cfg);
    expect(msg).toContain("not from a power-on (Reboot request from wifi)");
    expect(msg).not.toContain("Power was lost");
    expect(s.history[0]).toMatchObject({ cause: "restart", tripped: true });
  });

  it("reports and records a reboot that was too short to trip the silence alert", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, cfg);
    expect(onHeartbeat(s, "home", { boot: "b", reset: "brownout" }, T0 + 20 * SEC, cfg)).toEqual(["⚡ home restarted (brownout). Power was briefly lost."]);
    expect(onHeartbeat(s, "home", { boot: "c", reset: "Reboot request from ota" }, T0 + 40 * SEC, cfg)).toEqual(["⚡ home restarted (Reboot request from ota)."]);
    expect(s.history.map((o) => [o.cause, o.tripped])).toEqual([["power", false], ["restart", false]]);
  });

  it("gives no cause for clients that send no boot id", () => {
    const s = newState();
    onHeartbeat(s, "curl", {}, T0, cfg);
    expect(onHeartbeat(s, "curl", {}, T0 + 30 * SEC, cfg)).toEqual([]);
    tick(s, T0 + 30 * SEC + cfg.timeoutMs);
    expect(onHeartbeat(s, "curl", {}, T0 + 10 * MIN, cfg)).toEqual(["🟢 curl is back after 9 min of silence."]);
    expect(s.history[0].cause).toBe("unknown");
  });

  it("tracks devices independently and wakes for the earliest deadline", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, cfg);
    onHeartbeat(s, "cabin", { boot: "x" }, T0 + 90 * SEC, cfg);
    expect(nextWake(s, cfg)).toBe(T0 + cfg.timeoutMs);
    const alerts = tick(s, T0 + cfg.timeoutMs);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("home went silent");
    expect(s.devices.cabin.state).toBe("up");
    expect(nextWake(s, cfg)).toBe(T0 + 90 * SEC + cfg.timeoutMs);
  });

  it("keeps working with devices stored by the previous version", () => {
    const s = newState();
    s.devices.home = { id: "home", state: "up", lastSeen: T0, bootSeenAt: T0 - DAY, lastAlertAt: null, boot: "a", reset: POWERON, rssi: -60 };
    expect(onHeartbeat(s, "home", { boot: "a", reset: POWERON, rssi: -61 }, T0 + 30 * SEC, cfg)).toEqual([]);
    expect(s.devices.home.bootSeenAt).toBe(T0 - DAY);
  });
});

describe("pausing alerts", () => {
  it("stays quiet while paused, then reports a device that is still down", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, cfg);
    expect(handleCommand(s, "/mute 2h", T0 + MIN, cfg)).toContain("🔕 Alerts are paused for 2 h, until Wed 14:01.");
    expect(tick(s, T0 + cfg.timeoutMs)).toEqual([]);
    expect(s.devices.home.state).toBe("down");
    // Nothing to do until the pause ends, so the alarm must not spin.
    expect(nextWake(s, cfg)).toBe(T0 + MIN + 2 * HOUR);
    expect(tick(s, T0 + HOUR)).toEqual([]);

    const after = tick(s, T0 + MIN + 2 * HOUR);
    expect(after[0]).toBe("🔔 The pause is over. Alerts are on again.");
    expect(after[1]).toContain("🔴 home is silent. No heartbeat for 2 h 1 min.");
    expect(tick(s, T0 + MIN + 2 * HOUR + MIN)).toEqual([]);
  });

  it("drops the recovery message while paused but still records the outage", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, cfg);
    handleCommand(s, "/mute 1h", T0, cfg);
    tick(s, T0 + cfg.timeoutMs);
    expect(onHeartbeat(s, "home", { boot: "b", reset: POWERON }, T0 + 20 * MIN, cfg)).toEqual([]);
    expect(s.history).toHaveLength(1);
    onHeartbeat(s, "home", { boot: "b", reset: POWERON }, T0 + HOUR - 30 * SEC, cfg);
    expect(tick(s, T0 + HOUR)).toEqual(["🔔 The pause is over. Alerts are on again."]);
  });

  it("alerts at once when unpaused with a device down", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, cfg);
    handleCommand(s, "/mute 1d", T0, cfg);
    tick(s, T0 + cfg.timeoutMs);
    expect(handleCommand(s, "/unmute", T0 + 30 * MIN, cfg)).toBe("🔔 Alerts are on again.");
    expect(nextWake(s, cfg)).toBeLessThanOrEqual(T0 + 30 * MIN);
    expect(tick(s, T0 + 30 * MIN)[0]).toContain("🔴 home is silent. No heartbeat for 30 min.");
    expect(handleCommand(s, "/unmute", T0 + 31 * MIN, cfg)).toBe("Alerts were not paused.");
  });

  it("does not let reminders spin the alarm during a pause", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, cfg);
    tick(s, T0 + cfg.timeoutMs); // alerted
    handleCommand(s, "/mute 3h", T0 + 10 * MIN, cfg);
    expect(tick(s, T0 + 90 * MIN)).toEqual([]);
    expect(nextWake(s, cfg)).toBe(T0 + 10 * MIN + 3 * HOUR);
  });

  it("understands durations and rejects nonsense", () => {
    expect(parseDuration("30m")).toBe(30 * MIN);
    expect(parseDuration("2 h")).toBe(2 * HOUR);
    expect(parseDuration("1,5h")).toBe(90 * MIN);
    expect(parseDuration("1d")).toBe(DAY);
    expect(parseDuration("soon")).toBeNull();
    const s = newState();
    expect(handleCommand(s, "/mute forever", T0, cfg)).toContain("Tell me how long");
    expect(handleCommand(s, "/mute 30d", T0, cfg)).toContain("Tell me how long");
    expect(s.muteUntil).toBeNull();
    expect(handleCommand(s, "/mute", T0, cfg)).toContain("paused for 1 h");
  });
});

describe("weak Wi-Fi warning", () => {
  const beat = (s: State, t: number, rssi: number) => onHeartbeat(s, "home", { boot: "a", rssi }, t, cfg);

  it("warns after 30 minutes of weak signal, and not again for a week", () => {
    const s = newState();
    beat(s, T0, -84);
    let warned: string[] = [];
    for (let t = T0 + 30 * SEC; t < T0 + 30 * MIN; t += 30 * SEC) warned.push(...beat(s, t, -84));
    expect(warned).toEqual([]);
    const [msg] = beat(s, T0 + 30 * MIN, -85);
    expect(msg).toContain("📶 home has had a weak Wi-Fi signal for 30 min (-85 dBm).");
    warned = [];
    for (let t = T0 + 31 * MIN; t < T0 + 6 * DAY; t += 10 * MIN) warned.push(...beat(s, t, -84));
    expect(warned).toEqual([]);
    expect(beat(s, T0 + 7 * DAY + 31 * MIN, -84)).toHaveLength(1);
  });

  it("ignores short dips and resets once the signal recovers", () => {
    const s = newState();
    beat(s, T0, -84);
    beat(s, T0 + 20 * MIN, -70); // recovered
    expect(beat(s, T0 + 21 * MIN, -84)).toEqual([]);
    expect(beat(s, T0 + 45 * MIN, -84)).toEqual([]); // weak for 24 min only
    expect(beat(s, T0 + 52 * MIN, -84)).toHaveLength(1);
  });

  it("does not treat a borderline signal as recovered", () => {
    const s = newState();
    beat(s, T0, -84);
    beat(s, T0 + 15 * MIN, -78); // between the two thresholds: still counts
    expect(beat(s, T0 + 30 * MIN, -84)).toHaveLength(1);
  });
});

describe("local time", () => {
  it("finds the next Monday 09:00 across a daylight-saving change", () => {
    const monday9 = (p: ReturnType<typeof localParts>) => p.weekday === "Mon" && p.hour === 9;
    // Friday 23 Oct 2026 in Amsterdam is UTC+2; clocks go back on Sunday 25 Oct, so Monday 09:00 is 08:00 UTC.
    const t = nextLocal(Date.UTC(2026, 9, 23, 12), "Europe/Amsterdam", monday9);
    expect(new Date(t).toISOString()).toBe("2026-10-26T08:00:00.000Z");
    // A week earlier it is still 07:00 UTC.
    expect(new Date(nextLocal(Date.UTC(2026, 9, 16, 12), "Europe/Amsterdam", monday9)).toISOString()).toBe("2026-10-19T07:00:00.000Z");
    // Exactly at the moment itself, the next one is a week later.
    expect(nextLocal(t, "Europe/Amsterdam", monday9)).toBe(t + 7 * DAY);
  });
});

describe("reports", () => {
  const ams: Config = { ...cfg, timezone: "Europe/Amsterdam" };

  function withHistory(): State {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a", reset: POWERON, rssi: -58 }, Date.UTC(2026, 9, 1, 8), ams);
    s.history.push(
      { id: "home", from: Date.UTC(2026, 9, 14, 1, 15), to: Date.UTC(2026, 9, 14, 2, 41), cause: "power", tripped: true },
      { id: "home", from: Date.UTC(2026, 9, 20, 17, 0), to: Date.UTC(2026, 9, 20, 17, 22), cause: "network", tripped: true },
      { id: "home", from: Date.UTC(2026, 9, 28, 9, 0), to: Date.UTC(2026, 9, 28, 9, 1), cause: "restart", tripped: false },
      { id: "home", from: Date.UTC(2026, 10, 2, 12, 0), to: Date.UTC(2026, 10, 2, 12, 4), cause: "power", tripped: false },
    );
    return s;
  }

  it("sends the weekly check-in on Monday 09:00 local time and schedules the next", () => {
    const s = withHistory();
    const monday = Date.UTC(2026, 10, 9, 8); // 09:00 in Amsterdam (UTC+1 in November)
    s.nextWeeklyAt = monday;
    s.nextMonthlyAt = monday + 30 * DAY;
    onHeartbeat(s, "home", { boot: "a", reset: POWERON, rssi: -58 }, monday - 10 * SEC, ams);
    expect(onTick(s, monday - 1, ams)).toEqual([]);
    expect(onTick(s, monday, ams)).toEqual([
      "✅ Weekly check-in\n🟢 home is online. Last 7 days: 1 outage, 4 min of silence in total (1 power). Wi-Fi signal: good (-58 dBm).",
    ]);
    expect(s.nextWeeklyAt).toBe(monday + 7 * DAY);
    expect(onTick(s, monday + SEC, ams)).toEqual([]);
  });

  it("says so in the weekly check-in when nothing happened or the device is down", () => {
    const s = newState();
    const monday = Date.UTC(2026, 10, 9, 8);
    onHeartbeat(s, "home", { boot: "a", rssi: -70 }, monday - 3 * HOUR, ams);
    onTick(s, monday - 2 * HOUR, ams); // goes down
    s.nextWeeklyAt = monday;
    const [report] = onTick(s, monday, ams).filter((m) => m.includes("Weekly"));
    expect(report).toBe("⚠️ Weekly check-in\n🔴 home has been silent for 3 h. Last 7 days: no outages.");
  });

  it("sends last month's summary on the 1st, ignoring brief self-restarts", () => {
    const s = withHistory();
    const first = Date.UTC(2026, 10, 1, 8); // 1 Nov 09:00 Amsterdam
    s.nextMonthlyAt = first;
    s.nextWeeklyAt = first + 30 * DAY;
    onHeartbeat(s, "home", { boot: "a", reset: POWERON, rssi: -58 }, first - 10 * SEC, ams);
    expect(onTick(s, first, ams)).toEqual([
      "📊 October: 2 outages, 1 h 48 min of silence in total (1 power, 1 network).\nLongest: 1 h 26 min on 14 Oct 03:15.",
    ]);
    expect(new Date(s.nextMonthlyAt!).toISOString()).toBe("2026-12-01T08:00:00.000Z");
  });

  it("still names the right month when the summary is delivered days late", () => {
    const s = withHistory();
    const first = Date.UTC(2026, 10, 1, 8);
    s.nextMonthlyAt = first;
    s.nextWeeklyAt = first + 30 * DAY;
    onHeartbeat(s, "home", { boot: "a", reset: POWERON, rssi: -58 }, first + 5 * DAY, ams);
    expect(onTick(s, first + 5 * DAY, ams)[0]).toContain("📊 October: 2 outages");
  });

  it("reports a month without outages", () => {
    const s = newState();
    const first = Date.UTC(2026, 10, 1, 8);
    s.nextMonthlyAt = first;
    s.nextWeeklyAt = first + 30 * DAY;
    expect(onTick(s, first, ams)).toEqual(["📊 October: no outages."]);
  });

  it("answers /status for a healthy device", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a", reset: POWERON, rssi: -58 }, T0 - 3 * DAY, ams);
    onHeartbeat(s, "home", { boot: "a", reset: POWERON, rssi: -72 }, T0 - 12 * SEC, ams);
    expect(handleCommand(s, "/status", T0, ams)).toBe(
      "🟢 home is online\nLast heartbeat: 12 s ago\nRunning for 3 d without a restart\nWi-Fi signal: okay (-72 dBm)\n\nAlerts after 2 min of silence.",
    );
  });

  it("answers /status for a silent device and shows a pause", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, ams);
    onTick(s, T0 + cfg.timeoutMs, ams);
    handleCommand(s, "/mute 2h", T0 + 20 * MIN, ams);
    expect(handleCommand(s, "/status@MyHomeBot", T0 + 23 * MIN, ams)).toBe(
      "🔴 home has been silent for 23 min\nLast heartbeat: 4 Nov 13:00\n\nAlerts after 2 min of silence.\n🔕 Alerts are paused until Wed 15:20.",
    );
    expect(handleCommand(newState(), "/status", T0, ams)).toBe("No device has reported yet.");
  });

  it("answers /history newest first, with this month's total", () => {
    const s = withHistory();
    expect(handleCommand(s, "/history", Date.UTC(2026, 10, 4, 12), ams)).toBe(
      [
        "Recent outages, newest first:",
        "• 2 Nov 13:00 · 4 min · power cut (brief)",
        "• 28 Oct 10:00 · 1 min · device restart",
        "• 20 Oct 19:00 · 22 min · network or internet",
        "• 14 Oct 03:15 · 1 h 26 min · power cut",
        "",
        "This month so far: 1 outage, 4 min of silence in total (1 power).",
      ].join("\n"),
    );
    expect(handleCommand(newState(), "/history", T0, ams)).toBe("No outages recorded yet.");
  });

  it("lists an outage that is still going on", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, ams);
    onTick(s, T0 + cfg.timeoutMs, ams);
    expect(handleCommand(s, "/history", T0 + 40 * MIN, ams)).toContain("• 4 Nov 13:00 · 40 min so far · still silent");
  });

  it("can switch off the notes about brief restarts, which are still recorded", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, cfg);
    expect(handleCommand(s, "/restarts", T0, cfg)).toBe("Messages about brief restarts are on.\nSend /restarts off or /restarts on to change it.");
    expect(handleCommand(s, "/restarts OFF", T0, cfg)).toBe("Messages about brief restarts are off. They still appear in /history and the reports.");
    expect(onHeartbeat(s, "home", { boot: "b", reset: POWERON }, T0 + 20 * SEC, cfg)).toEqual([]);
    expect(s.history).toEqual([{ id: "home", from: T0, to: T0 + 20 * SEC, cause: "power", tripped: false }]);
    expect(handleCommand(s, "/status", T0 + 30 * SEC, cfg)).toContain("Messages about brief restarts are off.");
    expect(handleCommand(s, "/history", T0 + 30 * SEC, cfg)).toContain("20 s · power cut (brief)");

    // A real outage is still announced and resolved as before.
    tick(s, T0 + 20 * SEC + cfg.timeoutMs);
    expect(onHeartbeat(s, "home", { boot: "c", reset: POWERON }, T0 + 10 * MIN, cfg)[0]).toContain("🟢 home is back");

    expect(handleCommand(s, "/restarts on", T0 + 11 * MIN, cfg)).toBe("Messages about brief restarts are on.");
    expect(onHeartbeat(s, "home", { boot: "d", reset: POWERON }, T0 + 11 * MIN + 20 * SEC, cfg)).toEqual(["⚡ home restarted (power-on event). Power was briefly lost."]);
  });

  it("uses the configured default for brief-restart notes until the owner chooses", () => {
    const quiet: Config = { ...cfg, restartNotes: false };
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, quiet);
    expect(onHeartbeat(s, "home", { boot: "b", reset: POWERON }, T0 + 20 * SEC, quiet)).toEqual([]);
    expect(handleCommand(s, "/restarts", T0, quiet)).toContain("are off");
    expect(handleCommand(s, "/restarts on", T0, quiet)).toBe("Messages about brief restarts are on.");
    expect(onHeartbeat(s, "home", { boot: "c", reset: POWERON }, T0 + 40 * SEC, quiet)).toHaveLength(1);
  });

  it("explains itself for anything it does not understand", () => {
    const s = newState();
    for (const text of ["/start", "/help", "hello", "/nonsense"]) expect(handleCommand(s, text, T0, cfg)).toContain("/status - is it alive right now");
  });

  it("keeps the history bounded", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "0" }, T0, cfg);
    for (let i = 1; i <= 320; i++) onHeartbeat(s, "home", { boot: String(i), reset: POWERON }, T0 + i * 10 * SEC, cfg);
    expect(s.history).toHaveLength(300);
    expect(s.history[299].to).toBe(T0 + 320 * 10 * SEC);
  });
});

describe("help for the person at home", () => {
  const helped: Config = { ...cfg, timeoutMs: 15 * MIN, help: { hotspotName: "heartbeat-ayse setup", hotspotPassword: "3f9a12c0b7de", contact: "Burak" } };

  it("points to /fix in the alert", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, helped);
    expect(tick(s, T0 + 15 * MIN, helped)[0]).toBe(
      "🔴 home went silent. No heartbeat for 15 min.\nPower or internet at that location is probably down.\nIf the power is on, send /fix for what to check.",
    );
  });

  it("says all is well when the device is online", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a", rssi: -58 }, T0 - 12 * SEC, helped);
    const text = fixText(s, T0, helped);
    expect(text).toContain("Everything looks fine right now.\n🟢 home is online, last heartbeat 12 s ago, Wi-Fi signal good (-58 dBm).");
    expect(text).toContain("An alert only comes after 15 min of silence");
    expect(text).not.toContain("weak side");
    onHeartbeat(s, "home", { boot: "a", rssi: -79 }, T0, helped);
    expect(fixText(s, T0, helped)).toContain("weak side");
  });

  it("walks through the checks when the device is silent, quoting the hotspot details", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, helped);
    tick(s, T0 + 15 * MIN, helped);
    const text = handleCommand(s, "/fix", T0 + 23 * MIN, helped);
    expect(text).toContain("home has been silent for 23 min. Check these in order:");
    expect(text).toContain('join the Wi-Fi network called "heartbeat-ayse setup". Its password is 3f9a12c0b7de.');
    expect(text).toContain("Still silent? Then ask Burak.");
    expect(text.match(/^\d\./gm)).toEqual(["1.", "2.", "3.", "4.", "5."]);
  });

  it("still helps when no details were configured, or the device never connected", () => {
    const s = newState();
    const text = fixText(s, T0, cfg);
    expect(text).toContain("The device has not connected yet. Check these in order:");
    expect(text).toContain('whose name ends in "setup". Its password is on the card that came with the device.');
    expect(text).toContain("ask the person who set the device up");
  });
});

describe("invitations", () => {
  const ayse = { chat: "111", name: "Ayşe" };
  const burak = { chat: "222", name: "Burak" };

  it("sends alerts to the configured chat until someone joins, then to everyone who joined", () => {
    const s = newState();
    expect(recipients(s, "999")).toEqual(["999"]);
    expect(recipients(s, undefined)).toEqual([]);
    const first = joinChat(s, burak, undefined, T0, cfg);
    expect(first.reply).toContain("👋 Hello Burak! I watch the small device plugged in at home.");
    expect(first.reply).toContain("The device has not connected yet.");
    expect(first.announce).toBeNull();
    const second = joinChat(s, ayse, undefined, T0, cfg);
    expect(second.announce).toBe("👤 Ayşe now also receives these alerts.");
    expect(recipients(s, undefined)).toEqual(["222", "111"]);
  });

  it("welcomes with the device's current state and the alert time", () => {
    const s = newState();
    onHeartbeat(s, "home", { boot: "a" }, T0, cfg);
    const { reply } = joinChat(s, ayse, undefined, T0 + SEC, { ...cfg, timeoutMs: 15 * MIN });
    expect(reply).toContain("out for more than 15 min");
    expect(reply).toContain("🟢 home is online.");
    expect(reply).toContain("/fix - what to check if something seems wrong");
  });

  it("does not add the same person twice", () => {
    const s = newState();
    joinChat(s, ayse, undefined, T0, cfg);
    expect(joinChat(s, ayse, undefined, T0, cfg).announce).toBeNull();
    expect(s.people).toHaveLength(1);
  });

  it("keeps the configured owner on the list when the first person joins by link", () => {
    const s = newState();
    const { announce } = joinChat(s, ayse, "999", T0, cfg);
    expect(recipients(s, "999")).toEqual(["999", "111"]);
    expect(announce).toBe("👤 Ayşe now also receives these alerts.");
  });

  it("stops at five people", () => {
    const s = newState();
    for (let i = 1; i <= 5; i++) joinChat(s, { chat: String(i), name: `P${i}` }, undefined, T0, cfg);
    const sixth = joinChat(s, { chat: "6", name: "P6" }, undefined, T0, cfg);
    expect(sixth.reply).toContain("already has 5 people");
    expect(s.people).toHaveLength(5);
  });

  it("lets people leave, and mentions /leave in the help only when it applies", () => {
    const s = newState();
    expect(handleCommand(s, "/help", T0, cfg)).not.toContain("/leave");
    joinChat(s, burak, undefined, T0, cfg);
    joinChat(s, ayse, undefined, T0, cfg);
    expect(handleCommand(s, "/help", T0, cfg)).toContain("/leave - stop receiving these alerts");
    expect(leaveChat(s, "222")).toBe(true);
    expect(leaveChat(s, "222")).toBe(false);
    expect(recipients(s, undefined)).toEqual(["111"]);
  });
});
