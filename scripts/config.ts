import os from "os";
import path from "path";
import { config as dotenvConfig } from "dotenv";

// import.meta.dir (Bun) points to scripts/
// scripts -> cc-discord-bot -> skills -> .claude -> project root
const SCRIPT_DIR = import.meta.dir;
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROJECT_ROOT = path.resolve(SKILL_ROOT, "..", "..", "..");

// Load .env from project root
dotenvConfig({ path: path.join(PROJECT_ROOT, ".env") });

const SESSION_DIR = path.join(os.tmpdir(), "cc-discord-bot");
const SESSION_FILE = path.join(SESSION_DIR, "session_id.txt");
const ATTACHMENT_ROOT_DIR = path.join(
  PROJECT_ROOT,
  "tmp",
  "cc-discord-bot",
  "attachments"
);
const MAX_ATTACHMENT_BYTES_PER_FILE = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES_PER_MESSAGE = 50 * 1024 * 1024;
const ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30 * 1000;

export interface Config {
  discordBotToken: string;
  allowedUserIds: string[];
  projectRoot: string;
  skillRoot: string;
  sessionFile: string;
  sessionDir: string;
  claudeTimeout: number;
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

  return {
    discordBotToken: token,
    allowedUserIds: allowedIds.split(",").map((id) => id.trim()),
    projectRoot: PROJECT_ROOT,
    skillRoot: SKILL_ROOT,
    sessionFile: SESSION_FILE,
    sessionDir: SESSION_DIR,
    claudeTimeout: 5 * 60 * 1000, // 5 minutes
    attachmentRootDir: ATTACHMENT_ROOT_DIR,
    maxAttachmentBytesPerFile: MAX_ATTACHMENT_BYTES_PER_FILE,
    maxAttachmentBytesPerMessage: MAX_ATTACHMENT_BYTES_PER_MESSAGE,
    attachmentRetentionMs: ATTACHMENT_RETENTION_MS,
    attachmentDownloadTimeoutMs: ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  };
}
