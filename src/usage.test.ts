import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { claude } from "./claude.js";
import { beginLogin, registerLogin } from "./homes.js";
import { availableAt, decide, peak } from "./policy.js";
import { load, normalize, type Account, type Registry } from "./registry.js";
import { collect, parseUsage, type AccountUsage, type Fetcher, type Limit } from "./usage.js";
import { fakeLogin, sandbox } from "./test-helpers.js";

// A real answer from the endpoint, trimmed.
const ANSWER = {
  five_hour: { utilization: 2.0, resets_at: "2026-11-05T17:49:59.815030+00:00" },
  seven_day: { utilization: 65.0, resets_at: "2026-11-06T06:59:59.815049+00:00" },
  seven_day_opus: null,
  limits: [
    { kind: "session", group: "session", percent: 2, resets_at: "2026-11-05T17:49:59.815030+00:00", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 65, resets_at: "2026-11-06T06:59:59.815049+00:00", scope: null },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 2,
      resets_at: "2026-11-06T06:59:59.815212+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
};

test("parseUsage reads every window from the limits list", () => {
  const limits = parseUsage(ANSWER);
  assert.deepEqual(
    limits.map((l) => [l.key, l.label, l.percent]),
    [
      ["session", "Session (5h)", 0.02],
      ["weekly", "Weekly", 0.65],
      ["weekly:Fable", "Weekly · Fable", 0.02],
    ],
  );
  assert.equal(limits[0]!.resetsAt, "2026-11-05T17:49:59.815Z");
});

test("parseUsage falls back to the five_hour and seven_day buckets", () => {
  const limits = parseUsage({ five_hour: ANSWER.five_hour, seven_day: ANSWER.seven_day });
  assert.deepEqual(limits.map((l) => l.key), ["session", "weekly"]);
  assert.equal(limits[1]!.percent, 0.65);
});

test("parseUsage survives junk", () => {
  assert.deepEqual(parseUsage(null), []);
  assert.deepEqual(parseUsage({ limits: [null, { percent: "x" }] }), []);
});

// ----------------------------------------------------------------- policy

const NOW = Date.parse("2026-11-05T12:00:00Z");
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const lim = (key: string, percent: number, resetH: number): Limit => ({ key, label: key, percent: percent / 100, resetsAt: inHours(resetH) });

function usage(limits: Limit[], extra: Partial<AccountUsage> = {}): AccountUsage {
  return { accountId: "x", limits, fetchedAt: NOW, status: "ok", message: "", stale: false, ...extra };
}

function registryWith(ids: string[], over: Partial<Registry> = {}): Registry {
  return {
    ...normalize(claude, {
      accounts: ids.map((id, i) => ({ id, label: id, home: i === 0 ? "" : `/h/${id}`, primary: i === 0 })),
    }),
    ...over,
  };
}

test("peak ignores windows that have already reset", () => {
  assert.equal(peak([lim("s", 99, -1), lim("w", 40, 24)], NOW), 40);
  assert.equal(peak([lim("s", 99, -1)], NOW), 0);
  assert.equal(peak([], NOW), undefined);
});

test("nothing happens below the threshold", () => {
  const r = registryWith(["main", "b"]);
  assert.equal(decide(r, new Map([["main", usage([lim("s", 94, 2)])]]), NOW), undefined);
});

test("manual mode suggests the account with the most room", () => {
  const r = registryWith(["main", "b", "c"]);
  const u = new Map([
    ["main", usage([lim("s", 96, 2)])],
    ["b", usage([lim("s", 60, 2)])],
    ["c", usage([lim("s", 10, 2)])],
  ]);
  const d = decide(r, u, NOW);
  assert.equal(d?.action, "notify");
  assert.equal(d && "to" in d ? d.to.id : "", "c");
});

test("auto mode switches, and an account near its own limit comes last", () => {
  const r = registryWith(["main", "b", "c"], { switch: "auto" });
  const u = new Map([
    ["main", usage([lim("w", 97, 50)])],
    ["b", usage([lim("w", 85, 50)])], // within 15 points of 95: near
    ["c", usage([lim("w", 70, 50)], { stale: true })],
  ]);
  const d = decide(r, u, NOW);
  assert.equal(d?.action, "switch");
  assert.equal(d && "to" in d ? d.to.id : "", "c");
});

test("fresh numbers beat stale ones when both have room", () => {
  const r = registryWith(["main", "b", "c"], { switch: "auto" });
  const u = new Map([
    ["main", usage([lim("w", 99, 50)])],
    ["b", usage([lim("w", 5, 50)], { stale: true })],
    ["c", usage([lim("w", 30, 50)])],
  ]);
  const d = decide(r, u, NOW);
  assert.equal(d && "to" in d ? d.to.id : "", "c");
});

test("signed-out accounts are never candidates", () => {
  const r = registryWith(["main", "b"]);
  const u = new Map([
    ["main", usage([lim("w", 99, 50)])],
    ["b", usage([lim("w", 1, 50)], { status: "signed-out" })],
  ]);
  assert.equal(decide(r, u, NOW), undefined);
});

test("the same alert is not repeated, and clears once back under", () => {
  const r = registryWith(["main", "b"], { alert: "notify:main:b" });
  const over = new Map([
    ["main", usage([lim("w", 99, 50)])],
    ["b", usage([lim("w", 1, 50)])],
  ]);
  assert.equal(decide(r, over, NOW), undefined);
  const under = new Map([["main", usage([lim("w", 10, 50)])]]);
  assert.deepEqual(decide(r, under, NOW), { action: "clear" });
});

test("when every account is over, say which frees up first", () => {
  const r = registryWith(["main", "b"]);
  const u = new Map([
    ["main", usage([lim("s", 99, 1), lim("w", 99, 100)])],
    ["b", usage([lim("s", 99, 3), lim("w", 20, 100)])],
  ]);
  const d = decide(r, u, NOW);
  assert.equal(d?.action, "exhausted");
  assert.ok(d && d.action === "exhausted" && d.soonest?.account.id === "b");
  // main's week holds it over for 100h even though its session resets in 1h.
  assert.equal(availableAt(u.get("main")!.limits, 95, NOW), Date.parse(inHours(100)));
});

test("exhausted says nothing when an account's limits are unknown", () => {
  const r = registryWith(["main", "b"]);
  const u = new Map([["main", usage([lim("w", 99, 50)])]]);
  assert.equal(decide(r, u, NOW), undefined);
});

// ----------------------------------------------------------------- collect

function fetcherFrom(status: number, body: unknown, calls: string[] = []): Fetcher {
  return async (url, init) => {
    calls.push(init.headers.Authorization!);
    return { status, headers: { get: () => null }, json: async () => body };
  };
}

let account: Account;

beforeEach(() => {
  const home = sandbox();
  fakeLogin(path.join(home, ".claude"), { accountId: "uuid-main", email: "me@work.com" });
  const pending = beginLogin(claude, "Personal");
  fakeLogin(pending, { accountId: "uuid-personal", email: "me@home.com", accessToken: "tok-personal" });
  account = registerLogin(claude, pending, "Personal");
});

test("collect asks with the account's own token, then reuses the fresh answer", async () => {
  const calls: string[] = [];
  const first = await collect(claude, account, { fetcher: fetcherFrom(200, ANSWER, calls) });
  assert.equal(first.status, "ok");
  assert.equal(first.limits.length, 3);
  assert.deepEqual(calls, ["Bearer tok-personal"]);
  const second = await collect(claude, account, { fetcher: fetcherFrom(200, ANSWER, calls) });
  assert.equal(second.status, "cached");
  assert.equal(calls.length, 1);
});

test("a failed check keeps the last numbers, marks them stale, and backs off", async () => {
  const now = Date.now();
  await collect(claude, account, { fetcher: fetcherFrom(200, ANSWER), now: now - 600_000 });
  const calls: string[] = [];
  const failed = await collect(claude, account, { fetcher: fetcherFrom(500, {}, calls), now });
  assert.equal(failed.status, "error");
  assert.equal(failed.stale, true);
  assert.equal(failed.limits.length, 3);
  const again = await collect(claude, account, { fetcher: fetcherFrom(200, ANSWER, calls), now: now + 1000 });
  assert.equal(again.status, "error", "still backing off");
  assert.equal(calls.length, 1);
  const forced = await collect(claude, account, { fetcher: fetcherFrom(200, ANSWER, calls), now: now + 2000, force: true });
  assert.equal(forced.status, "ok");
});

test("an expired token never reaches the network", async () => {
  const main = load(claude).accounts[0]!;
  fakeLogin(path.join(process.env.HOME!, ".claude"), { accountId: "uuid-main", email: "me@work.com", expiresAt: Date.now() - 1000 });
  const calls: string[] = [];
  const result = await collect(claude, main, { fetcher: fetcherFrom(200, ANSWER, calls) });
  assert.equal(result.status, "paused");
  assert.equal(calls.length, 0);
});

test("refused and unreachable checks report why", async () => {
  assert.equal((await collect(claude, account, { fetcher: fetcherFrom(401, {}) })).status, "refused");
  const offline: Fetcher = async () => {
    throw new Error("ENOTFOUND");
  };
  assert.equal((await collect(claude, account, { fetcher: offline, force: true })).status, "unreachable");
});

test("numbers cached for a different login are discarded", async () => {
  await collect(claude, account, { fetcher: fetcherFrom(200, ANSWER) });
  fakeLogin(account.home, { accountId: "uuid-someone-else", email: "x@y.com" });
  const result = await collect(claude, account, { fetcher: fetcherFrom(500, {}) });
  assert.equal(result.limits.length, 0);
});
