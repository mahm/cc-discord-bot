export const EMPTY_RESPONSE_MAX_RETRIES = 3;
export const EMPTY_RESPONSE_RETRY_DELAY_MS = 1000;

export interface RetryableClaudeResponse {
  response: string;
}

export interface EmptyResponseRetryOptions {
  source: "dm" | "scheduler" | "manual" | "unknown";
  maxRetries?: number;
  delayMs?: number;
  context?: string;
  logger?: Pick<typeof console, "warn">;
}

interface RetryResult<T extends RetryableClaudeResponse> {
  result: T;
  attempts: number;
}

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = async (ms: number) =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function runWithEmptyResponseRetry<T extends RetryableClaudeResponse>(
  runner: () => Promise<T>,
  options: EmptyResponseRetryOptions,
  sleep: Sleep = defaultSleep,
): Promise<RetryResult<T>> {
  const maxRetries = options.maxRetries ?? EMPTY_RESPONSE_MAX_RETRIES;
  const delayMs = options.delayMs ?? EMPTY_RESPONSE_RETRY_DELAY_MS;
  const logger = options.logger ?? console;

  let lastResult: T | null = null;
  const maxAttempts = maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runner();
    lastResult = result;

    if (result.response.trim().length > 0) {
      return { result, attempts: attempt };
    }

    if (attempt < maxAttempts) {
      const context = options.context ? `, ${options.context}` : "";
      logger.warn(
        `[claude-retry] Empty response detected (source=${options.source}, attempt=${attempt}/${maxAttempts}${context}). Retrying...`,
      );
      await sleep(delayMs);
    }
  }

  return {
    result: lastResult as T,
    attempts: maxAttempts,
  };
}
