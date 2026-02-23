import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AttachmentInput, buildAttachmentPromptBlock } from "./attachments-adapter";
import type { Config } from "./config-adapter";

export interface ClaudeResponse {
  response: string;
  sessionId: string;
}

export interface SessionTarget {
  mode: "main" | "isolated";
  scheduleName?: string;
}

export interface SendToClaudeOptions {
  bypassMode?: boolean;
  attachments?: AttachmentInput[];
  source?: "dm" | "scheduler" | "manual";
  authorId?: string;
  sessionTarget?: SessionTarget;
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
let cachedSandboxId: string | null = null;
const DISCORD_USER_ID_PATTERN = /^\d{17,20}$/;
const FIXED_CLAUDE_ENV_KEYS = ["FORCE_COLOR", "CLAUDECODE"] as const;

export function buildProgressHint(
  source: SendToClaudeOptions["source"] | undefined,
  authorId: string | undefined,
): string {
  if (source !== "dm" || !authorId || !DISCORD_USER_ID_PATTERN.test(authorId)) {
    return "";
  }

  return [
    "処理が長くなる場合は、途中経過を先にDiscord DMで1-2文だけ送ってください。",
    `進捗DM送信コマンド: bun run .claude/skills/cc-discord-bot/scripts/src/main.ts send ${authorId} "<途中経過メッセージ>"`,
  ].join("\n");
}

export function renderPromptTemplate(
  template: string,
  input: {
    datetime: string;
    source: string;
    assistantContext: string;
    userInput: string;
  },
): string {
  return template
    .replace("{{datetime}}", input.datetime)
    .replace("{{source}}", input.source)
    .replace("{{assistant_context}}", input.assistantContext)
    .replace("{{user_input}}", input.userInput);
}

export function buildClaudeCliArgs(input: {
  appendSystemPromptPath: string;
  bypassMode?: boolean;
  sessionId?: string | null;
  prompt: string;
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--append-system-prompt-file",
    input.appendSystemPromptPath,
  ];

  if (input.bypassMode) {
    args.push("--dangerously-skip-permissions");
  }
  if (input.sessionId) {
    args.push("--resume", input.sessionId);
  }

  // Ensure prompt text is treated as a positional argument even when it starts with '-'.
  args.push("--", input.prompt);
  return args;
}

export function buildDockerExecEnvArgs(input: { extraEnv: Record<string, string> }): {
  args: string[];
  envKeys: string[];
  ignoredKeys: string[];
} {
  const fixedEnv: Record<(typeof FIXED_CLAUDE_ENV_KEYS)[number], string> = {
    FORCE_COLOR: "0",
    CLAUDECODE: "",
  };
  const args: string[] = [];
  const envKeys: string[] = [...FIXED_CLAUDE_ENV_KEYS];
  const ignoredKeys: string[] = [];

  for (const key of FIXED_CLAUDE_ENV_KEYS) {
    args.push("-e", `${key}=${fixedEnv[key]}`);
  }

  const extraEntries = Object.entries(input.extraEnv).sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of extraEntries) {
    if (Object.hasOwn(fixedEnv, key)) {
      ignoredKeys.push(key);
      continue;
    }
    args.push("-e", `${key}=${value}`);
    envKeys.push(key);
  }

  return { args, envKeys, ignoredKeys };
}

function resolveSessionFile(config: Config, target?: SessionTarget): string {
  if (!target || target.mode === "main") {
    return config.sessionFile;
  }
  const safeName = (target.scheduleName ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(config.sessionsDir, `${safeName}.txt`);
}

function resolveSessionDir(config: Config, target?: SessionTarget): string {
  if (!target || target.mode === "main") {
    return config.sessionDir;
  }
  return config.sessionsDir;
}

async function readSessionId(config: Config, target?: SessionTarget): Promise<string | null> {
  try {
    const content = await readFile(resolveSessionFile(config, target), "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function writeSessionId(
  config: Config,
  sessionId: string,
  target?: SessionTarget,
): Promise<void> {
  await mkdir(resolveSessionDir(config, target), { recursive: true });
  await writeFile(resolveSessionFile(config, target), sessionId, "utf-8");
}

export async function clearSession(config: Config, target?: SessionTarget): Promise<void> {
  try {
    await writeFile(resolveSessionFile(config, target), "", "utf-8");
  } catch {
    // File might not exist yet, that's fine
  }
}

export async function getSessionId(config: Config, target?: SessionTarget): Promise<string | null> {
  return readSessionId(config, target);
}

async function readSandboxId(config: Config): Promise<string | null> {
  try {
    const content = await readFile(config.sandboxIdFile, "utf-8");
    const id = content.trim();
    return id && /^[a-f0-9]{12,64}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function writeSandboxId(config: Config, sandboxId: string): Promise<void> {
  await mkdir(config.sessionDir, { recursive: true });
  await writeFile(config.sandboxIdFile, sandboxId, "utf-8");
}

async function clearSandboxId(config: Config): Promise<void> {
  cachedSandboxId = null;
  try {
    await writeFile(config.sandboxIdFile, "", "utf-8");
  } catch {
    // File might not exist yet
  }
}

const SANDBOX_GONE_PATTERNS = ["No such container", "is not running"];

function isSandboxGoneError(message: string): boolean {
  return SANDBOX_GONE_PATTERNS.some((pattern) => message.includes(pattern));
}

async function findSandboxForWorkspace(workspace: string): Promise<string | null> {
  const lsProc = Bun.spawn(["docker", "sandbox", "ls", "-q"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const lsOut = await new Response(lsProc.stdout).text();
  if ((await lsProc.exited) !== 0) return null;

  const ids = lsOut
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const id of ids) {
    const inspProc = Bun.spawn(["docker", "sandbox", "inspect", id], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const inspOut = await new Response(inspProc.stdout).text();
    if ((await inspProc.exited) !== 0) continue;

    try {
      const data = JSON.parse(inspOut);
      const entry = Array.isArray(data) ? data[0] : data;
      if (entry?.workspace === workspace) return id;
    } catch {}
  }
  return null;
}

async function removeSandbox(sandboxId: string): Promise<void> {
  const stopProc = Bun.spawn(["docker", "sandbox", "stop", sandboxId], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  await stopProc.exited;

  const rmProc = Bun.spawn(["docker", "sandbox", "rm", sandboxId], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const rmExit = await rmProc.exited;
  if (rmExit !== 0) {
    const stderr = await new Response(rmProc.stderr).text();
    console.warn(`[claude] Failed to remove sandbox ${sandboxId}: ${stderr.trim()}`);
  }
}

async function ensureClaudeSandbox(config: Config): Promise<string> {
  // 1. メモリキャッシュ → 2. ディスク → 3. 新規作成
  if (cachedSandboxId) {
    return cachedSandboxId;
  }

  const diskId = await readSandboxId(config);
  if (diskId) {
    cachedSandboxId = diskId;
    return diskId;
  }

  const proc = Bun.spawn(
    [
      "docker",
      "sandbox",
      "run",
      "--detached",
      "--credentials",
      "host",
      "--workspace",
      config.projectRoot,
      "claude",
    ],
    {
      cwd: config.projectRoot,
      stdin: "ignore",
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
    const errorOutput = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");

    // credentials 競合: 既存sandbox除去 → 再作成
    if (errorOutput.includes("already exists for this workspace, but with different credentials")) {
      console.warn("[claude] Credentials conflict detected. Removing existing sandbox.");
      const existingId = await findSandboxForWorkspace(config.projectRoot);
      if (existingId) {
        await removeSandbox(existingId);
        console.log(`[claude] Removed conflicting sandbox: ${existingId}`);
      }
      // 再帰で再試行(競合sandboxが除去済みなので新規作成に進む)
      return ensureClaudeSandbox(config);
    }

    throw new Error(errorOutput || `Failed to ensure Docker sandbox (exit code ${exitCode})`);
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sandboxId = lines[lines.length - 1];

  if (!sandboxId || !/^[a-f0-9]{12,64}$/i.test(sandboxId)) {
    const joined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");

    // credentials 競合(exit code 0 でもここに来る場合がある)
    if (joined.includes("already exists for this workspace, but with different credentials")) {
      console.warn("[claude] Credentials conflict detected. Removing existing sandbox.");
      const existingId = await findSandboxForWorkspace(config.projectRoot);
      if (existingId) {
        await removeSandbox(existingId);
        console.log(`[claude] Removed conflicting sandbox: ${existingId}`);
      }
      return ensureClaudeSandbox(config);
    }

    throw new Error(`Failed to resolve Docker sandbox ID. Output: ${joined.slice(0, 500)}`);
  }

  cachedSandboxId = sandboxId;
  await writeSandboxId(config, sandboxId);
  console.log(`[claude] Sandbox acquired and cached: ${sandboxId}`);
  return sandboxId;
}

async function runClaudeCommand(
  message: string,
  config: Config,
  options?: SendToClaudeOptions,
  retried = false,
): Promise<ClaudeResponse> {
  const sessionTarget = options?.sessionTarget;
  const sessionId = await readSessionId(config, sessionTarget);

  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const attachmentBlock = buildAttachmentPromptBlock(options?.attachments ?? []);
  const trimmedMessage = message.trim();
  const progressHint = buildProgressHint(options?.source, options?.authorId);
  const userInput = trimmedMessage || "(No text message was provided.)";
  const assistantContextParts: string[] = [];
  if (progressHint) {
    assistantContextParts.push(progressHint);
  }
  if (attachmentBlock) {
    assistantContextParts.push(attachmentBlock);
  }
  const assistantContext = assistantContextParts.join("\n\n") || "(No supplemental context)";

  const template = await readFile(config.promptTemplatePath, "utf-8");
  const source = options?.source ?? "unknown";
  const prompt = renderPromptTemplate(template, {
    datetime: timeStr,
    source,
    assistantContext,
    userInput,
  });

  const args = buildClaudeCliArgs({
    appendSystemPromptPath: config.appendSystemPromptPath,
    bypassMode: options?.bypassMode,
    sessionId,
    prompt,
  });

  let spawnArgs: string[];
  let logPrefix: string;

  if (!config.enableSandbox) {
    // ホストで直接 claude を実行
    spawnArgs = ["claude", ...args];
    const envKeys = Object.keys(config.claudeEnv).sort();
    logPrefix = `[claude] source=${source} mode=host env_keys=${envKeys.join(",") || "(none)"}`;
    console.log(
      `${logPrefix} $ claude ${args.map((a, i) => (i === args.length - 1 ? `${a.slice(0, 100)}...` : a)).join(" ")}`,
    );
  } else {
    // Docker sandbox 経由
    if (!Bun.which("docker")) {
      throw new Error("Docker CLI is required. Install Docker Desktop and enable Docker Sandbox.");
    }

    const sandboxId = await ensureClaudeSandbox(config);
    const dockerEnv = buildDockerExecEnvArgs({
      extraEnv: config.claudeEnv,
    });
    const dockerExecArgs = [
      "exec",
      "-w",
      config.projectRoot,
      ...dockerEnv.args,
      sandboxId,
      "claude",
      ...args,
    ];

    if (dockerEnv.ignoredKeys.length > 0) {
      console.warn(
        `[claude] Ignored env keys from settings.bot.json because they are reserved: ${dockerEnv.ignoredKeys.join(", ")}`,
      );
    }

    spawnArgs = ["docker", ...dockerExecArgs];
    const logArgs = args.map((a, i) => (i === args.length - 1 ? `${a.slice(0, 100)}...` : a));
    logPrefix = `[claude] source=${source} mode=sandbox env_keys=${dockerEnv.envKeys.join(",")}`;
    console.log(
      `${logPrefix} $ docker exec -w ${config.projectRoot} ${sandboxId} claude ${logArgs.join(" ")}`,
    );
  }

  const spawnEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      spawnEnv[key] = value;
    }
  }
  if (!config.enableSandbox) {
    spawnEnv.FORCE_COLOR = "0";
    spawnEnv.CLAUDECODE = "";
    for (const [key, value] of Object.entries(config.claudeEnv)) {
      spawnEnv[key] = value;
    }
  }

  const proc = Bun.spawn(spawnArgs, {
    cwd: config.projectRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv,
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

      // sandbox が消失した場合: キャッシュ無効化 + セッションクリア + リトライ
      if (!!config.enableSandbox && !retried && isSandboxGoneError(errorMsg)) {
        console.warn("[claude] Sandbox is no longer available. Invalidating cache and retrying.");
        await clearSandboxId(config);
        await clearSession(config, sessionTarget);
        return runClaudeCommand(message, config, options, true);
      }

      if (sessionId && !retried && errorMsg.includes("No conversation found with session ID")) {
        console.warn(
          "[claude] Session was not found in sandbox. Clearing session and retrying once.",
        );
        await clearSession(config, sessionTarget);
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
      await writeSessionId(config, newSessionId, sessionTarget);
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

const CLAUDE_AUTH_ERROR_PATTERNS = [
  "Expected token to be set for this request, but none was present",
  "Not logged in",
  "Please run /login",
];

export function isClaudeAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CLAUDE_AUTH_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}
