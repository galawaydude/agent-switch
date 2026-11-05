/** Display-safe facts about who a home is signed in as. */
export interface Identity {
  /** Stable account id from the provider; empty when nobody is signed in. */
  accountId: string;
  email: string;
  org: string;
  plan: string;
}

/** Everything agent-switch needs to know about one agent CLI. */
export interface Provider {
  id: string;
  name: string;
  /** The CLI's executable name. */
  binary: string;
  /** Environment variable that points the CLI at a config home. */
  homeEnv: string;
  /** Environment variable Omarchy's wrapper reads to pin a session's home. */
  omarchyPinEnv: string;
  /** The login the CLI uses by default; it becomes the primary account. */
  primaryHome(): string;
  /** Directories every account shares with the primary home. */
  sharedDirs: readonly string[];
  /** Files every account shares with the primary home. */
  sharedFiles: readonly string[];
  /** Copy settings that live beside the login into a new account's home. */
  carrySettings(newHome: string): void;
  identity(home: string): Identity;
  /** Whether the home holds a login at all (expired or not). */
  signedIn(home: string): boolean;
  /** Argument vector that signs a home in, run with `homeEnv` set. */
  loginArgs: readonly string[];
  /** Files that make up a login, which must never be shared or copied. */
  credentialFiles: readonly string[];
  /** Domain the browser sign-in happens on, for user-facing hints. */
  site: string;
}
