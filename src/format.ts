const useColor = (stream: NodeJS.WriteStream): boolean =>
  Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

function paint(code: string, text: string, stream: NodeJS.WriteStream = process.stdout): string {
  return useColor(stream) ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const style = {
  bold: (t: string) => paint("1", t),
  dim: (t: string) => paint("2", t),
  green: (t: string) => paint("32", t),
  yellow: (t: string) => paint("33", t),
  red: (t: string) => paint("31", t),
  cyan: (t: string) => paint("36", t),
  errRed: (t: string) => paint("31", t, process.stderr),
  errYellow: (t: string) => paint("33", t, process.stderr),
};

const ANSI = /\x1b\[[0-9;]*m/g;
export const visibleLength = (text: string): number => text.replace(ANSI, "").length;

/** Lay rows out in columns, padding by visible width so colors don't skew them. */
export function table(rows: string[][], gap = 2): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell))));
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat(widths[i]! - visibleLength(cell) + gap)))
      .join("")
      .trimEnd(),
  );
}

/** "3d 4h", "2h 5m", "12m": how long until something happens. */
export function duration(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** "just now", "5m ago", "2h ago", "3d ago". */
export function age(ms: number): string {
  if (ms < 60_000) return "just now";
  return `${duration(ms).split(" ")[0]} ago`;
}

/** A fixed-width bar for a 0..1 fraction, colored by how close to the limit it is. */
export function meter(fraction: number, threshold: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const percent = clamped * 100;
  if (percent >= threshold) return style.red(bar);
  if (percent >= threshold - 15) return style.yellow(bar);
  return style.green(bar);
}
