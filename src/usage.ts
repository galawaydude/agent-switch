import { readOauth } from "./claude.js";
import { isRecord, readRecord, str, writeJsonAtomic } from "./fsutil.js";
import { cachePath } from "./paths.js";
import type { Provider } from "./provider.js";
import { accountHome, type Account } from "./registry.js";

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
/** Reuse an answer this recent instead of asking again. */
export const FRESH_MS = 5 * 60_000;

export interface Limit {
  /** Stable key for the window, e.g. "session", "weekly", "weekly:Fable". */
  key: string;
  label: string;
  /** Fraction used, 0..1. */
  percent: number;
  /** ISO time the window resets; empty when unknown. */
  resetsAt: string;
}

export type UsageStatus =
  | "ok" // fresh numbers
  | "cached" // reused within FRESH_MS
  | "paused" // access token expired; last numbers kept until Claude Code renews it
  | "signed-out" // no login in the home
  | "refused" // Anthropic rejected the token
  | "rate-limited"
  | "unreachable"
  | "error";

export interface AccountUsage {
  accountId: string;
  limits: Limit[];
  /** When `limits` were measured, ms since epoch; 0 when never. */
  fetchedAt: number;
  status: UsageStatus;
  message: string;
  /** Whether `limits` are older than this check. */
  stale: boolean;
}

interface CacheFile {
  accountId: string;
  limits: Limit[];
  fetchedAt: number;
  /** Don't ask again before this time (ms since epoch). */
  retryAfter: number;
  /** Why the last check failed, repeated while backing off. */
  lastStatus?: UsageStatus;
  lastMessage?: string;
}

/** How long to wait after a failed check before asking again. */
export const BACKOFF_MS = 60_000;
export const REFUSED_BACKOFF_MS = 10 * 60_000;

// ------------------------------------------------------------------ parsing

/** The endpoint answers percentages: 0.6 means 0.6%, not 60%. */
function fraction(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number.parseFloat(str(value).replace("%", ""));
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(1, n / 100);
}

function resetTime(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const raw = str(value).trim();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

const KIND_LABELS: Record<string, [string, string]> = {
  session: ["session", "Session (5h)"],
  weekly_all: ["weekly", "Weekly"],
};

/**
 * Turn the usage endpoint's answer into limit windows. Current answers carry a
 * `limits` list naming every window, model-scoped ones included; older ones
 * only the `five_hour` and `seven_day` buckets.
 */
export function parseUsage(payload: unknown): Limit[] {
  if (!isRecord(payload)) return [];
  const limits: Limit[] = [];
  if (Array.isArray(payload.limits)) {
    for (const entry of payload.limits) {
      if (!isRecord(entry)) continue;
      const percent = fraction(entry.percent);
      if (percent === undefined) continue;
      const kind = str(entry.kind);
      let [key, label] = KIND_LABELS[kind] ?? [kind || "limit", kind.replace(/_/g, " ") || "Limit"];
      const scope = isRecord(entry.scope) ? entry.scope : undefined;
      const model = scope && isRecord(scope.model) ? str(scope.model.display_name) || str(scope.model.id) : "";
      if (model) {
        const group = str(entry.group) === "session" ? "Session" : "Weekly";
        key = `${str(entry.group) || kind}:${model}`;
        label = `${group} · ${model}`;
      }
      if (limits.some((l) => l.key === key)) continue;
      limits.push({ key, label, percent, resetsAt: resetTime(entry.resets_at) });
    }
  }
  if (limits.length) return limits;
  for (const [field, key, label] of [
    ["five_hour", "session", "Session (5h)"],
    ["seven_day", "weekly", "Weekly"],
  ] as const) {
    const bucket = payload[field];
    if (!isRecord(bucket)) continue;
    const percent = fraction(bucket.utilization);
    if (percent !== undefined) limits.push({ key, label, percent, resetsAt: resetTime(bucket.resets_at) });
  }
  return limits;
}

// ------------------------------------------------------------------ probing

type ProbeResult =
  | { ok: true; limits: Limit[] }
  | { ok: false; status: UsageStatus; message: string; retryAfter?: number };

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export async function probe(accessToken: string, fetcher: Fetcher = fetch as unknown as Fetcher, timeoutMs = 8_000): Promise<ProbeResult> {
  let response: Awaited<ReturnType<Fetcher>>;
  try {
    response = await fetcher(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
        "User-Agent": "agent-switch",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, status: "unreachable", message: "Couldn't reach Anthropic's usage endpoint." };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: "refused", message: "Anthropic refused this sign-in. Run `agent-switch login <account>`." };
  }
  if (response.status === 429) {
    const seconds = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    const wait = Number.isFinite(seconds) ? Math.max(seconds, 30) : 120;
    return { ok: false, status: "rate-limited", message: "Anthropic is rate limiting usage checks.", retryAfter: Date.now() + wait * 1000 };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, status: "error", message: `Anthropic's usage endpoint answered ${response.status}.` };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: "error", message: "Anthropic's usage endpoint sent an unreadable answer." };
  }
  const limits = parseUsage(payload);
  if (!limits.length) return { ok: false, status: "error", message: "Anthropic's usage endpoint returned no limits." };
  return { ok: true, limits };
}

// ------------------------------------------------------------------- caching

function readCache(provider: Provider, account: Account): CacheFile | undefined {
  const data = readRecord(cachePath(provider.id, account.id));
  if (!Array.isArray(data.limits)) return undefined;
  const limits = data.limits.filter(
    (l): l is Limit => isRecord(l) && typeof l.key === "string" && typeof l.percent === "number" && typeof l.label === "string",
  );
  return {
    accountId: str(data.accountId),
    limits: limits.map((l) => ({ ...l, resetsAt: str(l.resetsAt) })),
    fetchedAt: Number(data.fetchedAt) || 0,
    retryAfter: Number(data.retryAfter) || 0,
    lastStatus: (str(data.lastStatus) || undefined) as UsageStatus | undefined,
    lastMessage: str(data.lastMessage) || undefined,
  };
}

function writeCache(provider: Provider, account: Account, cache: CacheFile): void {
  try {
    writeJsonAtomic(cachePath(provider.id, account.id), cache);
  } catch {
    // A cache we can't write only costs a check next time.
  }
}

export interface CollectOptions {
  /** Ask Anthropic even if the cached answer is fresh. */
  force?: boolean;
  freshMs?: number;
  fetcher?: Fetcher;
  timeoutMs?: number;
  now?: number;
}

/**
 * The limits for one account: a fresh cached answer, a new one from Anthropic,
 * or, when neither is possible, the last good numbers marked stale. Never
 * throws, and never refreshes a token (only Claude Code does that).
 */
export async function collect(provider: Provider, account: Account, options: CollectOptions = {}): Promise<AccountUsage> {
  const now = options.now ?? Date.now();
  const home = accountHome(provider, account);
  const identity = provider.identity(home);
  let cache = readCache(provider, account);
  // Numbers measured for whoever was signed in here before don't count.
  if (cache && identity.accountId && cache.accountId && cache.accountId !== identity.accountId) cache = undefined;
  const base = { accountId: identity.accountId, limits: cache?.limits ?? [], fetchedAt: cache?.fetchedAt ?? 0 };
  const kept = (status: UsageStatus, message: string): AccountUsage => ({ ...base, status, message, stale: base.fetchedAt > 0 });

  const oauth = readOauth(home);
  if (!oauth || !provider.signedIn(home)) {
    return { ...kept("signed-out", `Not signed in. Run \`agent-switch login ${account.id}\`.`), limits: [], stale: false };
  }
  if (cache && !options.force && now - cache.fetchedAt < (options.freshMs ?? FRESH_MS)) {
    return { ...base, status: "cached", message: "", stale: false };
  }
  if (cache && cache.retryAfter > now && !options.force) {
    return kept(cache.lastStatus ?? "error", cache.lastMessage ?? "The last check failed; showing the last numbers.");
  }
  if (!oauth.accessToken || (oauth.expiresAt && oauth.expiresAt <= now)) {
    return kept("paused", `Sign-in token expired; numbers update once ${provider.name} runs as ${account.label} again.`);
  }

  const result = await probe(oauth.accessToken, options.fetcher, options.timeoutMs);
  if (result.ok) {
    writeCache(provider, account, { accountId: identity.accountId, limits: result.limits, fetchedAt: now, retryAfter: 0 });
    return { accountId: identity.accountId, limits: result.limits, fetchedAt: now, status: "ok", message: "", stale: false };
  }
  // Back off so a network outage doesn't slow down every launch.
  const backoff = result.status === "refused" ? REFUSED_BACKOFF_MS : BACKOFF_MS;
  writeCache(provider, account, {
    accountId: identity.accountId || cache?.accountId || "",
    limits: base.limits,
    fetchedAt: base.fetchedAt,
    retryAfter: result.retryAfter ?? now + backoff,
    lastStatus: result.status,
    lastMessage: result.message,
  });
  return kept(result.status, result.message);
}

export async function collectAll(provider: Provider, accounts: Account[], options: CollectOptions = {}): Promise<Map<string, AccountUsage>> {
  const results = await Promise.all(accounts.map((a) => collect(provider, a, options)));
  return new Map(accounts.map((a, i) => [a.id, results[i]!]));
}
