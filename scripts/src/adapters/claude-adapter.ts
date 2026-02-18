import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AttachmentInput, buildAttachmentPromptBlock } from "./attachments-adapter";
import type { Config } from "./config-adapter";

export interface ClaudeResponse {
  response: string;
  sessionId: string;
}

export interface SendToClaudeOptions {
  bypassMode?: boolean;
  attachments?: AttachmentInput[];
  source?: "dm" | "scheduler" | "manual";
}

interface ClaudeJob {
  message: string;
  config: Config;
  options?: SendToClaudeOptions;
  resolve: (value: ClaudeResponse) => void;
  reject: (reason?: unknown) => void;
}

const claudeQueue: ClaudeJob[] = [];
let queueWorkerRunning = false;

async function readSessionId(config: Config): Promise<string | null> {
  try {
    const content = await readFile(config.sessionFile, "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function writeSessionId(config: Config, sessionId: string): Promise<void> {
  await mkdir(config.sessionDir, { recursive: true });
  await writeFile(config.sessionFile, sessionId, "utf-8");
}

export async function clearSession(config: Config): Promise<void> {
  try {
    await writeFile(config.sessionFile, "", "utf-8");
  } catch {
    // File might not exist yet, that's fine
  }
}

export async function getSessionId(config: Config): Promise<string | null> {
  return readSessionId(config);
}

async function ensureClaudeSandbox(config: Config): Promise<string> {
  const proc = Bun.spawn(
    ["docker", "sandbox", "run", "--detached", "--workspace", config.projectRoot, "claude"],
    {
      cwd: config.projectRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    },
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const errorMsg =
      stderr.trim() || stdout.trim() || `Failed to ensure Docker sandbox (exit code ${exitCode})`;
    throw new Error(errorMsg);
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sandboxId = lines[lines.length - 1];

  if (!sandboxId || !/^[a-f0-9]{12,64}$/i.test(sandboxId)) {
    const joined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`Failed to resolve Docker sandbox ID. Output: ${joined.slice(0, 500)}`);
  }

  return sandboxId;
}

async function runClaudeCommand(
  message: string,
  config: Config,
  options?: SendToClaudeOptions,
  retried = false,
): Promise<ClaudeResponse> {
  if (!Bun.which("docker")) {
    throw new Error("Docker CLI is required. Install Docker Desktop and enable Docker Sandbox.");
  }

  const sessionId = await readSessionId(config);

  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const attachmentBlock = buildAttachmentPromptBlock(options?.attachments ?? []);
  const trimmedMessage = message.trim();
  const promptMessageParts: string[] = [];
  if (trimmedMessage) {
    promptMessageParts.push(trimmedMessage);
  }
  if (attachmentBlock) {
    promptMessageParts.push(attachmentBlock);
  }
  if (promptMessageParts.length === 0) {
    promptMessageParts.push("(No text message was provided.)");
  }
  const promptMessage = promptMessageParts.join("\n\n");

  const template = await readFile(config.promptTemplatePath, "utf-8");
  const prompt = template.replace("{{datetime}}", timeStr).replace("{{message}}", promptMessage);

  const args = [
    "-p",
    "--output-format",
    "json",
    "--append-system-prompt-file",
    config.appendSystemPromptPath,
  ];
  if (options?.bypassMode) {
    args.push("--dangerously-skip-permissions");
  }
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  args.push(prompt);

  const sandboxId = await ensureClaudeSandbox(config);
  const sandboxConfigDir = path.join(config.projectRoot, ".config");
  const dockerExecArgs = [
    "exec",
    "-w",
    config.projectRoot,
    "-e",
    "FORCE_COLOR=0",
    "-e",
    "CLAUDECODE=",
    "-e",
    `MAH_TODO_CONFIG_DIR=${sandboxConfigDir}`,
    sandboxId,
    "claude",
    ...args,
  ];

  const source = options?.source ?? "unknown";
  const logArgs = args.map((a, i) => (i === args.length - 1 ? `${a.slice(0, 100)}...` : a));
  console.log(
    `[claude] source=${source} $ docker exec -w ${config.projectRoot} -e FORCE_COLOR=0 -e CLAUDECODE= -e MAH_TODO_CONFIG_DIR=${sandboxConfigDir} ${sandboxId} claude ${logArgs.join(" ")}`,
  );

  const proc = Bun.spawn(["docker", ...dockerExecArgs], {
    cwd: config.projectRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const timeout = setTimeout(() => {
    proc.kill();
  }, config.claudeTimeout);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode !== 0) {
      const errorMsg = stderr.trim() || stdout.trim() || `Claude CLI exited with code ${exitCode}`;

      if (sessionId && !retried && errorMsg.includes("No conversation found with session ID")) {
        console.warn(
          "[claude] Session was not found in sandbox. Clearing session and retrying once.",
        );
        await clearSession(config);
        return runClaudeCommand(message, config, options, true);
      }

      throw new Error(errorMsg);
    }

    let parsed: { result: string; session_id: string };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(
        [
          "Failed to parse Claude response as JSON",
          `source=${source}`,
          `stdout_len=${stdout.length}`,
          `stderr_len=${stderr.length}`,
          `stdout_head=${JSON.stringify(stdout.slice(0, 300))}`,
          `stderr_head=${JSON.stringify(stderr.slice(0, 300))}`,
        ].join("; "),
      );
    }

    const newSessionId = parsed.session_id;
    if (newSessionId) {
      await writeSessionId(config, newSessionId);
    }

    return {
      response: parsed.result,
      sessionId: newSessionId,
    };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

async function runQueue(): Promise<void> {
  if (queueWorkerRunning) {
    return;
  }

  queueWorkerRunning = true;

  try {
    while (claudeQueue.length > 0) {
      const job = claudeQueue.shift();
      if (!job) {
        continue;
      }

      try {
        const result = await runClaudeCommand(job.message, job.config, job.options);
        job.resolve(result);
      } catch (error) {
        job.reject(error);
      }
    }
  } finally {
    queueWorkerRunning = false;
    if (claudeQueue.length > 0) {
      void runQueue();
    }
  }
}

export async function sendToClaude(
  message: string,
  config: Config,
  options?: SendToClaudeOptions,
): Promise<ClaudeResponse> {
  return new Promise<ClaudeResponse>((resolve, reject) => {
    claudeQueue.push({ message, config, options, resolve, reject });
    void runQueue();
  });
}
