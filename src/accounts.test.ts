import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { claude, planLabel } from "./claude.js";
import { adopt, beginLogin, importOmarchy, linkShared, recover, registerLogin, RECEIPT } from "./homes.js";
import { accountEnv } from "./launch.js";
import { homesRoot, registryPath } from "./paths.js";
import { AccountError, find, load, normalize, remove, rename, save, setMode, use } from "./registry.js";
import { fakeLogin, sandbox } from "./test-helpers.js";

let home: string;

beforeEach(() => {
  home = sandbox();
  fakeLogin(path.join(home, ".claude"), { accountId: "uuid-main", email: "me@work.com", org: "Work" });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
});

/** Simulate `add`: a pending home that a login was completed in. */
function addAccount(label: string, accountId: string, email: string) {
  const pending = beginLogin(claude, label);
  fakeLogin(pending, { accountId, email, tier: "", subscription: "pro" });
  return registerLogin(claude, pending, label);
}

test("plan labels read like Claude's own", () => {
  assert.equal(planLabel("default_claude_max_5x", "max"), "Max 5x");
  assert.equal(planLabel("default_claude_max_20x", "max"), "Max 20x");
  assert.equal(planLabel("", "pro"), "Pro");
  assert.equal(planLabel("", ""), "");
});

test("a fresh registry has the primary login as Main", () => {
  const registry = load(claude);
  assert.equal(registry.accounts.length, 1);
  assert.deepEqual(
    { id: registry.accounts[0]!.id, primary: registry.accounts[0]!.primary, email: registry.accounts[0]!.email, plan: registry.accounts[0]!.plan },
    { id: "main", primary: true, email: "me@work.com", plan: "Max 5x" },
  );
  assert.equal(registry.active, "main");
  assert.equal(registry.switch, "manual");
  assert.equal(registry.threshold, 95);
});

test("normalize repairs a damaged registry", () => {
  const registry = normalize(claude, {
    active: "ghost",
    switch: "sideways",
    threshold: 7,
    accounts: [
      { id: "x", label: "X", home: "/somewhere" },
      { id: "x", label: "dup", home: "/elsewhere" },
      { id: "nohome", label: "No home" },
      { id: "main", primary: true, home: "/should/clear" },
      "junk",
    ],
  });
  assert.deepEqual(registry.accounts.map((a) => a.id), ["main", "x"]);
  assert.equal(registry.accounts[0]!.home, "");
  assert.equal(registry.active, "main");
  assert.equal(registry.switch, "manual");
  assert.equal(registry.threshold, 50);
});

test("adding an account gives it its own login and shares everything else", () => {
  const account = addAccount("Personal", "uuid-personal", "me@home.com");
  assert.equal(account.id, "personal");
  assert.equal(account.plan, "Pro");
  assert.equal(account.home, path.join(homesRoot("claude"), "personal"));
  const projects = path.join(account.home, "projects");
  assert.ok(fs.lstatSync(projects).isSymbolicLink());
  assert.equal(fs.readlinkSync(projects), path.join(home, ".claude", "projects"));
  assert.ok(fs.lstatSync(path.join(account.home, "settings.json")).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(account.home, ".credentials.json")).isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(account.home, RECEIPT)));
  assert.equal(fs.statSync(account.home).mode & 0o777, 0o700);
  assert.equal(load(claude).accounts.length, 2);
});

test("new accounts carry MCP servers and trust from the primary account file", () => {
  const file = path.join(home, ".claude.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.mcpServers = { foo: { command: "foo" } };
  data.hasCompletedOnboarding = true;
  data.secretThing = "stay";
  fs.writeFileSync(file, JSON.stringify(data));
  const account = addAccount("Personal", "uuid-personal", "me@home.com");
  const carried = JSON.parse(fs.readFileSync(path.join(account.home, ".claude.json"), "utf8"));
  assert.deepEqual(carried.mcpServers, { foo: { command: "foo" } });
  assert.equal(carried.hasCompletedOnboarding, true);
  assert.equal(carried.secretThing, undefined);
  assert.equal(carried.oauthAccount.emailAddress, "me@home.com");
});

test("signing in as an account that's already added is refused and cleaned up", () => {
  const pending = beginLogin(claude, "Again");
  fakeLogin(pending, { accountId: "uuid-main", email: "me@work.com" });
  assert.throws(() => registerLogin(claude, pending, "Again"), /already added/);
  assert.equal(fs.existsSync(pending), false);
  assert.equal(load(claude).accounts.length, 1);
});

test("an unfinished sign-in adds nothing", () => {
  const pending = beginLogin(claude, "Nope");
  assert.throws(() => registerLogin(claude, pending, "Nope"), /didn't finish/);
  assert.equal(fs.existsSync(pending), false);
});

test("a clashing name gets a number instead of losing the sign-in", () => {
  addAccount("Side", "uuid-a", "a@x.com");
  const second = addAccount("Side", "uuid-b", "b@x.com");
  assert.equal(second.label, "Side 2");
  assert.equal(second.id, "side-2");
});

test("use switches the active account, cycles with next, and finds by label or email", () => {
  addAccount("Personal", "uuid-personal", "me@home.com");
  assert.equal(use(claude, "personal").current.id, "personal");
  assert.equal(use(claude, "next").current.id, "main");
  assert.equal(use(claude, "me@home.com").current.id, "personal");
  assert.equal(use(claude, "MAIN").current.id, "main");
  assert.throws(() => use(claude, "nobody"), AccountError);
});

test("rename changes the label and refuses a clash", () => {
  addAccount("Personal", "uuid-personal", "me@home.com");
  assert.equal(rename(claude, "personal", "Home").label, "Home");
  assert.equal(find(load(claude), "home")!.id, "personal");
  assert.throws(() => rename(claude, "personal", "Main"), /already/);
});

test("remove deletes our home without following its links, and never the primary", () => {
  const account = addAccount("Personal", "uuid-personal", "me@home.com");
  fs.writeFileSync(path.join(home, ".claude", "projects", "keep.txt"), "x");
  use(claude, "personal");
  const { deletedHome } = remove(claude, "personal");
  assert.equal(deletedHome, true);
  assert.equal(fs.existsSync(account.home), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "projects", "keep.txt")), true);
  assert.equal(load(claude).active, "main");
  assert.throws(() => remove(claude, "main"), /can't be removed/);
});

test("mode validates and stores the threshold", () => {
  assert.equal(setMode(claude, "auto", "80").threshold, 80);
  assert.equal(load(claude).switch, "auto");
  assert.throws(() => setMode(claude, "auto", "20"), /50 to 100/);
  assert.throws(() => setMode(claude, "yolo"), /manual or auto/);
});

test("recover registers a home that was moved into place but never saved", () => {
  const account = addAccount("Personal", "uuid-personal", "me@home.com");
  // Simulate a crash after the move: registry lacks the entry, receipt remains.
  const registry = load(claude);
  registry.accounts = registry.accounts.filter((a) => a.id !== "personal");
  save(claude, registry);
  fs.writeFileSync(path.join(account.home, RECEIPT), JSON.stringify({ label: "Personal", owner: 0, entry: account }));
  const recovered = recover(claude);
  assert.deepEqual(recovered.map((a) => a.id), ["personal"]);
  assert.ok(find(load(claude), "personal"));
  assert.equal(fs.existsSync(path.join(account.home, RECEIPT)), false);
});

test("recover finishes a completed sign-in whose add process died, and drops empty ones", () => {
  const done = beginLogin(claude, "Late");
  fakeLogin(done, { accountId: "uuid-late", email: "late@x.com" });
  fs.writeFileSync(path.join(done, RECEIPT), JSON.stringify({ label: "Late", owner: 999999999 }));
  const empty = beginLogin(claude, "Empty");
  fs.writeFileSync(path.join(empty, RECEIPT), JSON.stringify({ label: "Empty", owner: 999999999 }));
  const recovered = recover(claude);
  assert.deepEqual(recovered.map((a) => a.label), ["Late"]);
  assert.equal(fs.existsSync(empty), false);
});

test("adopt registers an existing signed-in home in place and refuses duplicates", () => {
  const elsewhere = path.join(home, "other-claude");
  fakeLogin(elsewhere, { accountId: "uuid-other", email: "o@x.com" });
  const account = adopt(claude, elsewhere, "Other");
  assert.equal(account.home, fs.realpathSync(elsewhere));
  assert.ok(fs.lstatSync(path.join(elsewhere, "projects")).isSymbolicLink());
  assert.throws(() => adopt(claude, elsewhere, "Again"), /already added/);
  assert.throws(() => adopt(claude, path.join(home, ".claude"), "Main"), /already the Main/);
  // Removing an adopted account leaves its home alone.
  assert.equal(remove(claude, "other").deletedHome, false);
  assert.ok(fs.existsSync(path.join(elsewhere, ".credentials.json")));
});

test("import omarchy adopts Omarchy's added accounts", () => {
  const omarchyHome = path.join(home, ".local", "state", "omarchy", "agents", "accounts", "claude", "personal");
  fakeLogin(omarchyHome, { accountId: "uuid-personal", email: "me@home.com" });
  fs.writeFileSync(
    path.join(home, ".local", "state", "omarchy", "agents", "accounts", "claude.json"),
    JSON.stringify({ accounts: [{ id: "main", primary: true, home: "" }, { id: "personal", label: "personal", home: omarchyHome }] }),
  );
  const result = importOmarchy(claude);
  assert.deepEqual(result.added.map((a) => a.id), ["personal"]);
  assert.equal(importOmarchy(claude).skipped.length, 1);
});

test("linkShared never replaces a file an account wrote for itself", () => {
  const dir = path.join(home, "acct");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "settings.json"), '{"own":true}');
  linkShared(claude, dir);
  assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), '{"own":true}');
  linkShared(claude, dir); // idempotent
});

test("accountEnv points added accounts at their home and leaves Main implicit", () => {
  const account = addAccount("Personal", "uuid-personal", "me@home.com");
  const registry = load(claude);
  const main = registry.accounts[0]!;
  const envMain = accountEnv(claude, main, { CLAUDE_CONFIG_DIR: "/x", PATH: "/bin" });
  assert.equal(envMain.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(envMain.OMARCHY_AGENT_CLAUDE_HOME, "");
  const envPersonal = accountEnv(claude, account, { PATH: "/bin" });
  assert.equal(envPersonal.CLAUDE_CONFIG_DIR, account.home);
  assert.equal(envPersonal.OMARCHY_AGENT_CLAUDE_HOME, account.home);
  assert.equal(envPersonal.AGENT_SWITCH_ACCOUNT, "personal");
});

test("the registry file is private", () => {
  addAccount("Personal", "uuid-personal", "me@home.com");
  assert.equal(fs.statSync(registryPath("claude")).mode & 0o777, 0o600);
  const raw = fs.readFileSync(registryPath("claude"), "utf8");
  assert.ok(!raw.includes("access-"), "tokens must never enter the registry");
});
