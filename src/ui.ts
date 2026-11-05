import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { CANCEL_LINE } from "./login.js";
import { platform } from "./platform.js";

/**
 * `agent-switch ui`: a page on 127.0.0.1 that is only a display. Every action
 * runs an agent-switch command and relays its JSON or its sign-in events, the
 * way a desktop panel would; no account logic lives here.
 */

const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
const PAGE = fileURLToPath(new URL("../assets/ui.html", import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run agent-switch itself with these arguments. */
export function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

interface Job {
  id: string;
  child: ChildProcessWithoutNullStreams;
  events: { event: string; detail: string }[];
  done: boolean;
}

function startJob(args: string[]): Job {
  const child = spawn(process.execPath, [CLI, ...args, "--events"], {
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const job: Job = { id: randomBytes(6).toString("hex"), child, events: [], done: false };
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^@@agent-switch (\S+) ?(.*)$/.exec(line.trim());
      if (match) job.events.push({ event: match[1]!, detail: match[2]! });
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) job.events.push({ event: "output", detail: text });
  });
  child.on("exit", (code) => {
    job.done = true;
    if (!job.events.some((e) => e.event === "done" || e.event === "error")) {
      job.events.push({ event: "error", detail: code === null ? "Sign-in cancelled." : "The sign-in stopped unexpectedly." });
    }
  });
  child.on("error", (error) => {
    job.done = true;
    job.events.push({ event: "error", detail: error.message });
  });
  return job;
}

/**
 * Ask the sign-in to stop through its stdin, so it cleans up on every OS
 * (on Windows a kill skips all cleanup). Kill it only if it doesn't listen.
 */
function cancelJob(job: Job): void {
  if (job.done) return;
  try {
    job.child.stdin.write(CANCEL_LINE + "\n");
  } catch {
    // stdin already closed
  }
  const timer = setTimeout(() => {
    if (!job.done) job.child.kill("SIGTERM");
  }, 5_000);
  timer.unref();
}

function openBrowser(url: string): void {
  const os = platform();
  const [cmd, args] =
    os === "darwin" ? ["open", [url]] : os === "win32" ? ["cmd", ["/c", "start", '""', url]] : ["xdg-open", [url]];
  try {
    // cmd's `start` takes its empty window title verbatim.
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true, windowsVerbatimArguments: os === "win32" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The URL is printed too.
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(raw || "{}");
        resolve(typeof parsed === "object" && parsed !== null ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

const text = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/** Turn a CLI result into an HTTP answer: its JSON, or its error message. */
function relay(res: http.ServerResponse, result: CliResult): void {
  if (result.code !== 0) {
    send(res, 400, { error: (result.stderr || result.stdout).trim().replace(/^Usage: /, "") || "That didn't work." });
    return;
  }
  try {
    send(res, 200, JSON.parse(result.stdout));
  } catch {
    send(res, 200, { ok: true });
  }
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface UiOptions {
  port?: number;
  open?: boolean;
  log: (line: string) => void;
}

export async function startUi(options: UiOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const token = randomBytes(24).toString("hex");
  const jobs = new Map<string, Job>();
  let port = 0;
  let closing: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => (closing = resolve));

  const server = http.createServer(async (req, res) => {
    // Only this machine, by this exact address: blocks DNS rebinding.
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: "Forbidden" });
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (req.method === "GET" && url.pathname === "/") {
      if (!sameToken(url.searchParams.get("t") ?? "", token)) return send(res, 403, { error: "Open the link agent-switch printed." });
      return send(res, 200, fs.readFileSync(PAGE, "utf8"));
    }
    if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
    // A custom header can't be sent cross-origin without a preflight we never allow.
    if (!sameToken(text(req.headers["x-agent-switch-token"]), token)) return send(res, 403, { error: "Forbidden" });

    const route = `${req.method} ${url.pathname}`;
    const body = req.method === "POST" ? await readBody(req) : {};
    const jobMatch = /^\/api\/jobs\/([0-9a-f]+)(\/(code|cancel))?$/.exec(url.pathname);

    if (route === "GET /api/state") {
      return relay(res, await runCli(["status", "--json", ...(url.searchParams.get("refresh") ? ["--refresh"] : [])]));
    }
    if (route === "POST /api/use") return relay(res, await runCli(["use", text(body.id), "--json"]));
    if (route === "POST /api/rename") return relay(res, await runCli(["rename", text(body.id), text(body.label), "--json"]));
    if (route === "POST /api/remove") return relay(res, await runCli(["remove", text(body.id), "--json"]));
    if (route === "POST /api/mode") {
      return relay(res, await runCli(["mode", text(body.mode), ...(body.threshold ? [text(body.threshold)] : []), "--json"]));
    }
    if (route === "POST /api/add" || route === "POST /api/login") {
      if ([...jobs.values()].some((j) => !j.done)) return send(res, 409, { error: "A sign-in is already in progress." });
      const args = route === "POST /api/add" ? ["add", ...(text(body.name) ? [text(body.name)] : [])] : ["login", text(body.id)];
      const job = startJob(args);
      jobs.set(job.id, job);
      return send(res, 200, { job: job.id });
    }
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]!);
      if (!job) return send(res, 404, { error: "No such sign-in." });
      if (req.method === "GET" && !jobMatch[2]) {
        const after = Number(url.searchParams.get("after") ?? 0) || 0;
        return send(res, 200, { events: job.events.slice(after), next: job.events.length, done: job.done });
      }
      if (req.method === "POST" && jobMatch[3] === "code") {
        const code = text(body.code).trim();
        if (!code || job.done) return send(res, 400, { error: "Nothing is waiting for a code." });
        job.child.stdin.write(code + "\n");
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && jobMatch[3] === "cancel") {
        cancelJob(job);
        return send(res, 200, { ok: true });
      }
    }
    if (route === "POST /api/quit") {
      send(res, 200, { ok: true });
      setTimeout(() => closing?.(), 50);
      return;
    }
    return send(res, 404, { error: "Not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/?t=${token}`;

  const close = async () => {
    for (const job of jobs.values()) cancelJob(job);
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  finished.then(close).then(() => process.exit(0));

  options.log(`agent-switch is open at ${url}`);
  options.log("Keep this running while you use the page. Press Ctrl+C to stop.");
  if (options.open !== false) openBrowser(url);
  return { url, close };
}
