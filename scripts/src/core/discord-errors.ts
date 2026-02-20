const TERMINAL_DISCORD_CODES = new Set<number>([10_003, 10_008, 50_001, 50_013]);

function readNumericField(error: unknown, field: "code" | "status"): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const maybeValue = (error as Record<string, unknown>)[field];
  return typeof maybeValue === "number" ? maybeValue : null;
}

export function parseDiscordCode(error: unknown): number | null {
  return readNumericField(error, "code");
}

export function parseDiscordStatus(error: unknown): number | null {
  return readNumericField(error, "status");
}

export function isTerminalDiscordError(error: unknown): boolean {
  const code = parseDiscordCode(error);
  if (code === null) {
    return false;
  }
  return TERMINAL_DISCORD_CODES.has(code);
}

export function classifyDiscordError(error: unknown): "terminal" | "retryable" {
  if (isTerminalDiscordError(error)) {
    return "terminal";
  }
  return "retryable";
}
