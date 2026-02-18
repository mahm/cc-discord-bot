export const DISCORD_MAX_LENGTH = 2000;
export const EMPTY_RESPONSE_FALLBACK_MESSAGE = "（エージェントが応答できませんでした）";

export interface SendChunksOptions {
  fallbackMessage?: string;
  source: "dm" | "scheduler" | "unknown";
  context?: string;
}

export function splitMessage(text: string): string[] {
  if (text.trim().length === 0) return [];
  if (text.length <= DISCORD_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      if (remaining.trim().length > 0) {
        chunks.push(remaining);
      }
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n", DISCORD_MAX_LENGTH);
    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf(" ", DISCORD_MAX_LENGTH);
    }
    if (splitIndex <= 0) {
      splitIndex = DISCORD_MAX_LENGTH;
    }

    const chunk = remaining.slice(0, splitIndex);
    if (chunk.trim().length > 0) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks.filter((chunk) => chunk.trim().length > 0);
}

export async function sendChunksWithFallback(
  sender: (chunk: string) => Promise<unknown>,
  text: string,
  options: SendChunksOptions,
): Promise<number> {
  const chunks = splitMessage(text).filter((chunk) => chunk.trim().length > 0);

  if (chunks.length === 0) {
    const context = options.context ? `, ${options.context}` : "";
    console.warn(
      `[discord-send] Empty response suppressed (source=${options.source}, originalLength=${text.length}${context})`,
    );

    const fallback = options.fallbackMessage?.trim();
    if (fallback) {
      await sender(fallback);
      return 1;
    }
    return 0;
  }

  for (const chunk of chunks) {
    await sender(chunk);
  }

  return chunks.length;
}

export function isSkipResponse(text: string): boolean {
  const normalized = text.trim();
  return normalized.startsWith("[SKIP]") || normalized.endsWith("[SKIP]");
}
