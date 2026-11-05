import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { claude } from "./claude.js";
import { diagnose } from "./doctor.js";
import { beginLogin, registerLogin } from "./homes.js";
import type { Account } from "./registry.js";
import { fakeLogin, sandbox } from "./test-helpers.js";

let home: string;
let personal: Account;

beforeEach(() => {
  home = sandbox();
  process.env.AGENT_SWITCH_CLAUDE_BIN = "/bin/true";
  fakeLogin(path.join(home, ".claude"), { accountId: "uuid-main", email: "me@work.com" });
  const pending = beginLogin(claude, "Personal");
  fakeLogin(pending, { accountId: "uuid-personal", email: "me@home.com" });
  personal = registerLogin(claude, pending, "Personal");
});

const messages = (level: string) =>
  diagnose(claude)
    .filter((f) => f.level === level)
    .map((f) => f.message)
    .join("\n");

test("a healthy setup has no failures", { skip: process.platform !== "linux" }, () => {
  assert.equal(messages("fail"), "");
});

test("doctor flags a shared login file", { skip: process.platform !== "linux" }, () => {
  const creds = path.join(personal.home, ".credentials.json");
  fs.rmSync(creds);
  fs.symlinkSync(path.join(home, ".claude", ".credentials.json"), creds);
  assert.match(messages("fail"), /login file is a link/);
});

test("doctor flags a signed-out account and missing shared links", () => {
  fs.rmSync(path.join(personal.home, "projects"));
  assert.match(messages("warn"), /not sharing projects/);
  fs.rmSync(path.join(personal.home, ".credentials.json"));
  assert.match(messages("fail"), /Personal \(me@home.com\): not signed in/);
});

test("doctor notices when the shell function is installed", () => {
  assert.match(messages("warn"), /won't use agent-switch yet/);
  fs.writeFileSync(path.join(home, ".bashrc"), 'eval "$(agent-switch shell-init)"\n');
  assert.doesNotMatch(messages("warn"), /won't use agent-switch yet/);
});
