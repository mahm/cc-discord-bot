export const SEND_USAGE = "Usage: bun run main.ts send <userId> [--file <path>]... [message]";

export interface SendCommand {
  userId: string;
  message: string;
  filePaths: string[];
}

type ParseSendCommandResult =
  | {
      ok: true;
      value: SendCommand;
    }
  | {
      ok: false;
      error: string;
      usage: string;
    };

export function parseSendCommandArgs(args: string[]): ParseSendCommandResult {
  const userId = args[0]?.trim();
  if (!userId) {
    return {
      ok: false,
      error: "Missing userId for send command",
      usage: SEND_USAGE,
    };
  }

  const filePaths: string[] = [];
  const messageTokens: string[] = [];

  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--file") {
      const next = args[i + 1];
      if (!next) {
        return {
          ok: false,
          error: "Missing file path after --file",
          usage: SEND_USAGE,
        };
      }
      filePaths.push(next);
      i += 1;
      continue;
    }
    messageTokens.push(token);
  }

  const message = messageTokens.join(" ").trim();
  if (!message && filePaths.length === 0) {
    return {
      ok: false,
      error: "Either message or --file is required",
      usage: SEND_USAGE,
    };
  }

  return {
    ok: true,
    value: {
      userId,
      message,
      filePaths,
    },
  };
}
