import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/agent/agent.ts";
import { createChannel } from "../src/channels/telegram/index.ts";
import type { ChannelAdapter, ChannelSink } from "../src/core/channel.ts";
import type { PlaceWake } from "../src/core/wake.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { ALLOWED_PHOTO, ALLOWED_USER, OTHER_PHOTO, OTHER_USER, allowlistUpdates } from "./support/telegram-allowlist.ts";
import { TOKEN, fakeTelegram, updates } from "./support/telegram.ts";

let dir: string;
let telegram: Awaited<ReturnType<typeof fakeTelegram>>;
let channel: ChannelAdapter;

beforeEach(async () => {
  vi.stubEnv("TELEGRAM_ALLOWED_USER_IDS", undefined);
  dir = mkdtempSync(join(tmpdir(), "pots-telegram-allowlist-"));
  secrets();
  telegram = await fakeTelegram();
  channel = createChannel({ id: "telegram", type: "telegram", secrets: join(dir, "telegram.env") }, { botDir: dir, botName: "Pots", log: () => {} }, telegram.url);
});

afterEach(async () => {
  await channel.stop();
  await telegram.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function secrets(ids?: string) {
  writeFileSync(join(dir, "telegram.env"), `TELEGRAM_BOT_TOKEN=${TOKEN}\n${ids === undefined ? "" : `export TELEGRAM_ALLOWED_USER_IDS='${ids}'\n`}`);
}

function sink(receive: ChannelSink["receive"], logs: string[] = []): ChannelSink {
  return { receive, newestMessage: async () => undefined, threads: async () => [], places: async () => [], lastAlive: () => undefined, form: async () => undefined, formOpened: async () => {}, formOpening: async () => undefined, log: (message) => logs.push(message) };
}

const polls = () => telegram.calls.filter((call) => call.method === "getUpdates");
const through = async (offset: number) => vi.waitFor(() => expect(polls().some((call) => call.params.offset === offset)).toBe(true), { timeout: 5_000 });

describe("Telegram allowed users", () => {
  it("keeps the unrestricted default when both settings are absent", async () => {
    const stored: string[] = [];
    telegram.push(updates.dm, updates.mention);
    await channel.start(sink(async (id) => { stored.push(id); }));
    await through(updates.mention.update_id + 1);
    expect(stored).toEqual([`update:${updates.dm.update_id}`, `update:${updates.mention.update_id}`]);
  });

  it.each(["file", "process"])("filters every inbound payload using the %s setting before storage or callback acknowledgement", async (source) => {
    if (source === "file") {
      secrets(" 111, 111 ");
      vi.stubEnv("TELEGRAM_ALLOWED_USER_IDS", "222"); // The per-channel file takes precedence.
    } else vi.stubEnv("TELEGRAM_ALLOWED_USER_IDS", "111");
    const inputs = allowlistUpdates();
    const stored: string[] = [];
    const logs: string[] = [];
    telegram.push(...inputs.map((input) => input.update));
    await channel.start(sink(async (id) => { stored.push(id); }, logs));
    await through(inputs.at(-1)!.update.update_id + 1);
    expect(stored).toEqual(inputs.filter((input) => input.allowed).map((input) => `update:${input.update.update_id}`));
    await vi.waitFor(() => expect(telegram.calls.filter((call) => call.method === "answerCallbackQuery").map((call) => call.params.callback_query_id)).toEqual(["owner-click"]));
    expect(logs).toEqual([]); // Rejections do not disclose IDs, message data or tokens in logs.
    expect(process.env.TELEGRAM_ALLOWED_USER_IDS).toBe(source === "file" ? "222" : "111");
    expect(process.env.TELEGRAM_BOT_TOKEN).not.toBe(TOKEN);
  });

  it("accepts several user IDs, with whitespace and duplicates", async () => {
    secrets("111, 222,111");
    const stored: string[] = [];
    telegram.push(updates.dm, updates.mention);
    await channel.start(sink(async (id) => { stored.push(id); }));
    await through(updates.mention.update_id + 1);
    expect(stored).toHaveLength(2);
  });

  it.each(["", " ", ",", "111,", ",111", "111,,222", "@alice", "111,bad-id", "-100200", "0", "00111", "1.5", "1e3", "+111", "9007199254740992", "111 # comment"])("fails closed on invalid file configuration (%j), without exposing its value or contacting Telegram", async (value) => {
    secrets(value);
    vi.stubEnv("TELEGRAM_ALLOWED_USER_IDS", "111"); // Invalid file content cannot fall back to a valid process value.
    await expect(channel.start(sink(async () => {}))).rejects.toThrow(/^TELEGRAM_ALLOWED_USER_IDS must be a nonempty comma-separated list of positive integer Telegram user IDs$/);
    expect(telegram.calls).toEqual([]);
  });

  it.each(["", "bad-id"])("also fails closed on invalid process configuration (%j)", async (value) => {
    vi.stubEnv("TELEGRAM_ALLOWED_USER_IDS", value);
    await expect(channel.start(sink(async () => {}))).rejects.toThrow("TELEGRAM_ALLOWED_USER_IDS must be");
    expect(telegram.calls).toEqual([]);
  });

  it("advances past a rejected-only batch and continues receiving allowed updates", async () => {
    secrets("111");
    const stored: string[] = [];
    telegram.push(updates.mention); // Bob, rejected.
    await channel.start(sink(async (id) => { stored.push(id); }));
    await through(updates.mention.update_id + 1);
    expect(stored).toEqual([]);
    telegram.push({ ...updates.dm, update_id: 1100 });
    await through(1101);
    expect(stored).toEqual(["update:1100"]);
  });

  it("does not skip an allowed update whose store failed after a rejected update", { timeout: 10_000 }, async () => {
    secrets("111");
    const stored: string[] = [];
    let failed = false;
    telegram.push({ ...updates.mention, update_id: 1100 }, { ...updates.dm, update_id: 1101 }, { ...updates.mention, update_id: 1102 });
    await channel.start(sink(async (id) => {
      if (!failed) { failed = true; throw new Error("disk full"); }
      stored.push(id);
    }));
    await through(1103);
    expect(polls().slice(0, 3).map((call) => call.params.offset)).toEqual([undefined, 1101, 1103]);
    expect(stored).toEqual(["update:1101"]);
  });

  it("reloads the file only when the channel starts again", async () => {
    secrets("111");
    const stored: string[] = [];
    await channel.start(sink(async (id) => { stored.push(id); }));
    secrets("222");
    telegram.push(updates.dm, updates.mention);
    await through(updates.mention.update_id + 1);
    expect(stored).toEqual([`update:${updates.dm.update_id}`]);
    await channel.stop();
    await channel.start(sink(async (id) => { stored.push(id); }));
    telegram.push({ ...updates.dm, update_id: 1100 }, { ...updates.mention, update_id: 1101 });
    await through(1102);
    expect(stored).toEqual([`update:${updates.dm.update_id}`, "update:1101"]);
  });

  it("keeps each channel's file local instead of exporting its restriction", async () => {
    secrets("111");
    const otherTelegram = await fakeTelegram();
    const otherFile = join(dir, "other.env");
    writeFileSync(otherFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_ALLOWED_USER_IDS=222\n`);
    const other = createChannel({ id: "telegram-other", type: "telegram", secrets: otherFile }, { botDir: dir, botName: "Other", log: () => {} }, otherTelegram.url);
    const stored: string[] = [], otherStored: string[] = [];
    try {
      telegram.push(updates.dm, updates.mention);
      otherTelegram.push(updates.dm, updates.mention);
      await channel.start(sink(async (id) => { stored.push(id); }));
      await other.start(sink(async (id) => { otherStored.push(id); }));
      await through(updates.mention.update_id + 1);
      await vi.waitFor(() => expect(otherTelegram.calls.some((call) => call.method === "getUpdates" && call.params.offset === updates.mention.update_id + 1)).toBe(true));
      expect(stored).toEqual([`update:${updates.dm.update_id}`]);
      expect(otherStored).toEqual([`update:${updates.mention.update_id}`]);
      expect(process.env.TELEGRAM_ALLOWED_USER_IDS).toBeUndefined();
    } finally { await other.stop(); await otherTelegram.close(); }
  });

  it("blocks unauthorized inbox rows, log events, downloads and wakes through the real gateway", { timeout: 10_000 }, async () => {
    secrets("111");
    const sql = await openDatabase(":memory:");
    const wakes: PlaceWake[] = [];
    const gateway = await Gateway.open(sql, {
      bot: "allowlist-test", judge: () => undefined,
      settings: () => ({ debounceMs: 10, debounceMaxMs: 30, judgeThreshold: 0.5, judgeContextMessages: 20 }),
      fallbackWakeMinutes: () => 120, fireTimer: async () => ({ submission: "timer" }),
      filesDir: join(dir, "files"), print: () => {},
    });
    const inputs = allowlistUpdates();
    const allowed = inputs.filter((input) => input.allowed);
    for (const photo of [ALLOWED_PHOTO, OTHER_PHOTO]) telegram.files.set(`photos/${photo}.jpg`, new TextEncoder().encode("jpeg"));
    try {
      await gateway.start({ name: "Test", isWorkingOn: () => false, responsibilities: async () => "", deliver: async (wake) => { wakes.push(wake); return { submission: `wake-${wakes.length}` }; } }, [channel]);
      telegram.push(...inputs.map((input) => input.update));
      await through(inputs.at(-1)!.update.update_id + 1);
      await vi.waitFor(async () => {
        const rows = await sql.all<{ event_id: string; state: string }>("SELECT event_id,state FROM gw_inbox ORDER BY rowid");
        expect(rows).toEqual(allowed.map((input) => ({ event_id: `update:${input.update.update_id}`, state: "done" })));
        expect((await sql.get<{ n: number }>("SELECT count(*) AS n FROM gw_events WHERE wake IS NULL"))!.n).toBe(0);
      });
      const events = await sql.all<{ inbox_event: string; person: string }>("SELECT inbox_event,person FROM gw_events ORDER BY id");
      expect(events.map((event) => event.inbox_event)).toEqual(allowed.map((input) => `update:${input.update.update_id}`));
      expect(events.some((event) => event.person === `telegram:@${OTHER_USER.id}`)).toBe(false);
      const delivered = wakes.flatMap((wake) => wake.events);
      expect(delivered).toHaveLength(allowed.length);
      expect(delivered.some((event) => event.person?.address === `telegram:@${OTHER_USER.id}`)).toBe(false);
      expect(telegram.calls.filter((call) => call.method === "getFile").map((call) => call.params.file_id)).toEqual([ALLOWED_PHOTO]);
      const photo = delivered.find((event) => event.files?.length)?.files?.[0];
      expect(photo?.path).toBeDefined();
      expect(readFileSync(photo!.path!, "utf8")).toBe("jpeg");
      expect(telegram.calls.filter((call) => call.method === "answerCallbackQuery").map((call) => call.params.callback_query_id)).toEqual(["owner-click"]);
      // The ingress restriction must not filter out the bot's own outbound history.
      await gateway.send("allowlist-send", `telegram:#${ALLOWED_USER.id}`, "still connected");
      await vi.waitFor(async () => expect((await sql.get<{ n: number }>("SELECT count(*) AS n FROM gw_events WHERE from_me=1"))!.n).toBe(1));
    } finally { await gateway.stop(); await sql.close(); }
  });
});
