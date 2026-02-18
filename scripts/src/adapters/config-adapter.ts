import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config as dotenvConfig } from "dotenv";
import type { BotSettings } from "../core/bot-settings";

// import.meta.dir points to scripts/src/adapters
const ADAPTER_ROOT = import.meta.dir;
const SRC_ROOT = path.resolve(ADAPTER_ROOT, "..");
const SCRIPTS_ROOT = path.resolve(SRC_ROOT, "..");
const SKILL_ROOT = path.resolve(SCRIPTS_ROOT, "..");
const PROJECT_ROOT = path.resolve(SKILL_ROOT, "..", "..", "..");
const PROMPTS_ROOT = path.join(SRC_ROOT, "prompts");

// Load .env from project root
dotenvConfig({ path: path.join(PROJECT_ROOT, ".env") });

const SESSION_DIR = path.join(os.tmpdir(), "cc-discord-bot");
const SESSION_FILE = path.join(SESSION_DIR, "session_id.txt");
const ATTACHMENT_ROOT_DIR = path.join(PROJECT_ROOT, "tmp", "cc-discord-bot", "attachments");
const MAX_ATTACHMENT_BYTES_PER_FILE = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES_PER_MESSAGE = 50 * 1024 * 1024;
const ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const DEFAULT_CLAUDE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface Config {
  discordBotToken: string;
  allowedUserIds: string[];
  projectRoot: string;
  srcRoot: string;
  promptsRoot: string;
  appendSystemPromptPath: string;
  promptTemplatePath: string;
  sessionFile: string;
  sessionDir: string;
  claudeTimeout: number;
  claudeEnv: Record<string, string>;
  attachmentRootDir: string;
  maxAttachmentBytesPerFile: number;
  maxAttachmentBytesPerMessage: number;
  attachmentRetentionMs: number;
  attachmentDownloadTimeoutMs: number;
}

export function loadConfig(): Config {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is not set in .env");
  }

  const allowedIds = process.env.DISCORD_ALLOWED_USER_IDS;
  if (!allowedIds) {
    throw new Error("DISCORD_ALLOWED_USER_IDS is not set in .env");
  }

  const appendSystemPromptPath = path.join(PROMPTS_ROOT, "append-system-prompt.md");
  const promptTemplatePath = path.join(PROMPTS_ROOT, "prompt-template.md");
  if (!existsSync(appendSystemPromptPath)) {
    throw new Error(
      `Missing prompt file: ${appendSystemPromptPath}. Expected under scripts/src/prompts/.`,
    );
  }
  if (!existsSync(promptTemplatePath)) {
    throw new Error(
      `Missing prompt file: ${promptTemplatePath}. Expected under scripts/src/prompts/.`,
    );
  }

  return {
    discordBotToken: token,
    allowedUserIds: allowedIds.split(",").map((id) => id.trim()),
    projectRoot: PROJECT_ROOT,
    srcRoot: SRC_ROOT,
    promptsRoot: PROMPTS_ROOT,
    appendSystemPromptPath,
    promptTemplatePath,
    sessionFile: SESSION_FILE,
    sessionDir: SESSION_DIR,
    claudeTimeout: DEFAULT_CLAUDE_TIMEOUT_MS,
    claudeEnv: {},
    attachmentRootDir: ATTACHMENT_ROOT_DIR,
    maxAttachmentBytesPerFile: MAX_ATTACHMENT_BYTES_PER_FILE,
    maxAttachmentBytesPerMessage: MAX_ATTACHMENT_BYTES_PER_MESSAGE,
    attachmentRetentionMs: ATTACHMENT_RETENTION_MS,
    attachmentDownloadTimeoutMs: ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  };
}

export function applyBotSettingsToConfig(config: Config, settings: BotSettings): void {
  config.claudeTimeout = settings.claude_timeout_seconds * 1000;
  config.claudeEnv = settings.env;
}
