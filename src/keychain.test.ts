import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { claude, readOauth } from "./claude.js";
import { keychainAccount, keychainService } from "./credentials.js";
import { beginLogin, registerLogin, removeHome } from "./homes.js";
import { fakeAccountFile, fakeLogin, sandbox } from "./test-helpers.js";

/**
 * Exercises the real macOS Keychain. It only runs where asked to (CI sets
 * AGENT_SWITCH_KEYCHAIN_TEST), so a developer's own Keychain is never touched.
 */
const enabled = process.platform === "darwin" && Boolean(process.env.AGENT_SWITCH_KEYCHAIN_TEST);

test("a real Keychain login is read, registered and removed", { skip: !enabled }, () => {
  const home = sandbox();
  fakeLogin(path.join(home, ".claude"), { accountId: "uuid-main", email: "me@work.com" });
  const accountHome = beginLogin(claude, "Personal");
  fakeAccountFile(accountHome, { accountId: "uuid-ci", email: "ci@example.com" });
  const service = keychainService(accountHome);
  const secret = JSON.stringify({
    claudeAiOauth: { accessToken: "ci-token", refreshToken: "ci-refresh", expiresAt: Date.now() + 3_600_000, subscriptionType: "pro", rateLimitTier: "" },
  });
  const added = spawnSync("security", ["add-generic-password", "-U", "-A", "-a", keychainAccount(), "-s", service, "-w", secret], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(added.status, 0, added.stderr);
  try {
    assert.equal(claude.signedIn(accountHome), true);
    assert.equal(readOauth(accountHome)?.accessToken, "ci-token");
    const account = registerLogin(claude, accountHome, "Personal");
    assert.equal(account.plan, "Pro");
    removeHome(claude, account.home);
    const after = spawnSync("security", ["find-generic-password", "-a", keychainAccount(), "-s", service], { timeout: 15_000 });
    assert.notEqual(after.status, 0, "the Keychain item was deleted");
  } finally {
    spawnSync("security", ["delete-generic-password", "-a", keychainAccount(), "-s", service], { timeout: 15_000 });
  }
});
