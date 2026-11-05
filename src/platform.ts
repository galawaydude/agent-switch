export type Platform = "linux" | "darwin" | "win32" | "other";

/**
 * The platform agent-switch behaves as. AGENT_SWITCH_PLATFORM overrides it,
 * so tests can exercise the macOS and Windows paths on any machine.
 */
export function platform(): Platform {
  const forced = process.env.AGENT_SWITCH_PLATFORM;
  const value = forced || process.platform;
  return value === "linux" || value === "darwin" || value === "win32" ? value : "other";
}

export const isMac = (): boolean => platform() === "darwin";
export const isWindows = (): boolean => platform() === "win32";
