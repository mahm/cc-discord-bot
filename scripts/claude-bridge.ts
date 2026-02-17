import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { Config } from "./config";

export interface ClaudeResponse {
  response: string;
  sessionId: string;
}

async function readSessionId(config: Config): Promise<string | null> {
  try {
    const content = await readFile(config.sessionFile, "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function writeSessionId(
  config: Config,
  sessionId: string
): Promise<void> {
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

export interface SendToClaudeOptions {
  bypassMode?: boolean;
}

async function ensureClaudeSandbox(config: Config): Promise<string> {
  const proc = Bun.spawn(
    [
      "docker",
      "sandbox",
      "run",
      "--detached",
      "--workspace",
      config.projectRoot,
      "claude",
    ],
    {
      cwd: config.projectRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    }
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const errorMsg =
      stderr.trim() ||
      stdout.trim() ||
      `Failed to ensure Docker sandbox (exit code ${exitCode})`;
    throw new Error(errorMsg);
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sandboxId = lines[lines.length - 1];

  if (!sandboxId || !/^[a-f0-9]{12,64}$/i.test(sandboxId)) {
    const joined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    throw new Error(
      `Failed to resolve Docker sandbox ID. Output: ${joined.slice(0, 500)}`
    );
  }

  return sandboxId;
}

export async function sendToClaude(
  message: string,
  config: Config,
  options?: SendToClaudeOptions
): Promise<ClaudeResponse> {
  if (!Bun.which("docker")) {
    throw new Error(
      "Docker CLI is required. Install Docker Desktop and enable Docker Sandbox."
    );
  }

  const sessionId = await readSessionId(config);

  // Build prompt from template with current datetime
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const templatePath = path.join(config.skillRoot, "PROMPT_TEMPLATE.md");
  const template = await readFile(templatePath, "utf-8");
  const prompt = template
    .replace("{{datetime}}", timeStr)
    .replace("{{message}}", message);

  // Build CLI args with append-system-prompt for concise responses
  const systemPromptFile = path.join(config.skillRoot, "APPEND_SYSTEM_PROMPT.md");
  const args = ["-p", "--output-format", "json",
    "--append-system-prompt-file", systemPromptFile];
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

  const logArgs = args.map((a, i) =>
    i === args.length - 1 ? `${a.slice(0, 100)}...` : a
  );
  console.log(
    `[claude] $ docker exec -w ${config.projectRoot} -e FORCE_COLOR=0 -e CLAUDECODE= -e MAH_TODO_CONFIG_DIR=${sandboxConfigDir} ${sandboxId} claude ${logArgs.join(" ")}`
  );

  const proc = Bun.spawn(["docker", ...dockerExecArgs], {
    cwd: config.projectRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Set up timeout
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
      const errorMsg =
        stderr.trim() ||
        stdout.trim() ||
        `Claude CLI exited with code ${exitCode}`;
      if (
        sessionId &&
        errorMsg.includes("No conversation found with session ID")
      ) {
        console.warn(
          "[claude] Session was not found in sandbox. Clearing session and retrying once."
        );
        await clearSession(config);
        return sendToClaude(message, config, options);
      }
      throw new Error(errorMsg);
    }

    // Parse JSON response
    let parsed: { result: string; session_id: string };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // If JSON parsing fails, treat stdout as plain text response
      throw new Error(
        `Failed to parse Claude response as JSON: ${stdout.slice(0, 500)}`
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
