import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { claude } from "./claude.js";
import { homesRoot } from "./paths.js";
import { load } from "./registry.js";
import { fakeLogin, sandbox } from "./test-helpers.js";
import { startUi } from "./ui.js";

let ui: { url: string; close: () => Promise<void> };
let base: string;
let token: string;
let home: string;

/**
 * A stand-in for `claude auth login` that behaves like the real one without a
 * terminal: it prints the sign-in link and the paste prompt, then signs the
 * home in only when it's given the right code.
 */
function fakeClaudeLogin(dir: string): string {
  const script = path.join(dir, "node_modules", "fake", "cli.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(
    script,
    `const fs = require("fs"), path = require("path");
const home = process.env.CLAUDE_CONFIG_DIR;
process.stdout.write("Opening browser to sign in\\u2026\\nIf the browser didn't open, visit: https://claude.example/oauth?code=true\\nPaste code here if prompted > ");
let input = "";
process.stdin.on("data", (d) => {
  input += d;
  if (!input.includes("\\n")) return;
  if (input.trim() !== "good-code") { console.log("Invalid code"); process.exit(1); }
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-ui", emailAddress: "ui@example.com" } }));
  fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600000, subscriptionType: "pro" } }));
  console.log("Login successful.");
  process.exit(0);
});
`,
  );
  if (process.platform === "win32") {
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\fake\\cli.js" %*\r\n`);
    return shim;
  }
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return bin;
}

function request(method: string, url: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(url, { method, headers: { "content-type": "application/json", ...options.headers } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        let body: unknown = data;
        try {
          body = JSON.parse(data);
        } catch {
          // html
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

const api = (method: string, route: string, body?: unknown) =>
  request(method, base + route, { body, headers: { "x-agent-switch-token": token } });

before(async () => {
  home = sandbox();
  fakeLogin(path.join(home, ".claude"), { accountId: "uuid-main", email: "me@work.com" });
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  process.env.AGENT_SWITCH_CLAUDE_BIN = fakeClaudeLogin(bin);
  process.env.AGENT_SWITCH_BROWSER = process.platform === "win32" ? "rem" : "true";
  process.env.AGENT_SWITCH_NO_NOTIFY = "1";
  ui = await startUi({ open: false, log: () => undefined });
  const url = new URL(ui.url);
  base = url.origin;
  token = url.searchParams.get("t")!;
});

after(async () => {
  await ui.close();
});

test("the page needs the token, and the API needs it as a header", async () => {
  assert.equal((await request("GET", `${base}/`)).status, 403);
  assert.equal((await request("GET", `${base}/?t=wrong`)).status, 403);
  const page = await request("GET", ui.url);
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>agent-switch<\/title>/);
  assert.equal((await request("GET", `${base}/api/state`)).status, 403);
  assert.equal((await request("GET", `${base}/api/state?t=${token}`)).status, 403, "a token in the URL isn't enough for the API");
});

test("requests for any other host name are refused (DNS rebinding)", async () => {
  const res = await request("GET", `${base}/api/state`, { headers: { host: "evil.example", "x-agent-switch-token": token } });
  assert.equal(res.status, 403);
});

test("state comes straight from agent-switch status", async () => {
  const { status, body } = await api("GET", "/api/state");
  assert.equal(status, 200);
  assert.equal(body.active, "main");
  assert.equal(body.accounts[0].email, "me@work.com");
  assert.ok("usage" in body);
});

test("add signs in through the page: link shown, code relayed, account registered", async () => {
  const start = await api("POST", "/api/add", { name: "Personal" });
  assert.equal(start.status, 200);
  const job = start.body.job;
  const seen: { event: string; detail: string }[] = [];
  let cursor = 0;
  let sentCode = false;
  for (let i = 0; i < 150; i++) {
    const { body } = await api("GET", `/api/jobs/${job}?after=${cursor}`);
    cursor = body.next;
    seen.push(...body.events);
    if (!sentCode && seen.some((e) => e.event === "prompt")) {
      assert.equal((await api("POST", `/api/jobs/${job}/code`, { code: "good-code" })).status, 200);
      sentCode = true;
    }
    if (body.done) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const events = seen.map((e) => e.event);
  assert.ok(events.includes("status"), "progress was reported");
  assert.deepEqual(seen.find((e) => e.event === "url")?.detail, "https://claude.example/oauth?code=true");
  const done = seen.find((e) => e.event === "done");
  assert.ok(done, `finished: ${JSON.stringify(seen)}`);
  assert.equal(JSON.parse(done!.detail).accounts[0].email, "ui@example.com");
  assert.ok(load(claude).accounts.some((a) => a.label === "Personal"));
});

test("use, rename and mode act through the CLI", async () => {
  assert.equal((await api("POST", "/api/use", { id: "personal" })).body.current.id, "personal");
  assert.equal((await api("POST", "/api/rename", { id: "personal", label: "Home" })).body.label, "Home");
  assert.deepEqual((await api("POST", "/api/mode", { mode: "auto", threshold: "80" })).body, { switch: "auto", threshold: 80 });
  const state = (await api("GET", "/api/state")).body;
  assert.equal(state.active, "personal");
  assert.equal(state.accounts[1].label, "Home");
});

test("errors from the CLI come back as messages", async () => {
  const res = await api("POST", "/api/use", { id: "nobody" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /No Claude account named "nobody"/);
});

test("cancelling a sign-in leaves nothing behind", async () => {
  const { body } = await api("POST", "/api/add", { name: "Abandoned" });
  for (let i = 0; i < 100; i++) {
    const poll = await api("GET", `/api/jobs/${body.job}`);
    if (poll.body.events.some((e: { event: string }) => e.event === "prompt")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await api("POST", `/api/jobs/${body.job}/cancel`, {});
  let final: { event: string }[] = [];
  for (let i = 0; i < 100; i++) {
    const poll = await api("GET", `/api/jobs/${body.job}`);
    final = poll.body.events;
    if (poll.body.done) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(final.some((e) => e.event === "error"));
  assert.ok(!fs.existsSync(path.join(homesRoot("claude"), "abandoned")), "the half-made home was removed");
  assert.ok(!load(claude).accounts.some((a) => a.label === "Abandoned"));
});

test("only one sign-in runs at a time", async () => {
  const first = await api("POST", "/api/add", { name: "One" });
  const second = await api("POST", "/api/add", { name: "Two" });
  assert.equal(second.status, 409);
  await api("POST", `/api/jobs/${first.body.job}/cancel`, {});
});

test("Connect claude hooks the shell up through agent-switch setup", async () => {
  process.env.SHELL = "/bin/bash";
  assert.equal((await api("GET", "/api/state")).body.shell.hooked, false);
  const res = await api("POST", "/api/setup", {});
  assert.equal(res.status, 200);
  assert.equal(res.body.added.length, 1);
  assert.equal((await api("GET", "/api/state")).body.shell.hooked, true);
});
