#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const HELP = `agent-switch ${version}: several Claude Code subscriptions on one machine

Usage: agent-switch <command> [args]

Commands are added milestone by milestone; see docs/DESIGN.md.
`;

export async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(version);
    return 0;
  }
  process.stdout.write(HELP);
  return command === undefined || command === "help" || command === "--help" || command === "-h" ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`agent-switch: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
