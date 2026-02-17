import { mkdir, readdir, rm, stat, writeFile } from "fs/promises";
import type { Dirent } from "fs";
import path from "path";
import type { Message } from "discord.js";
import type { Config } from "./config";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);

const PDF_EXTENSIONS = new Set([".pdf"]);

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".log",
]);

export interface AttachmentInput {
  name: string;
  contentType: string;
  size: number;
  path: string;
}

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

function sanitizeFilename(name: string, index: number): string {
  const base = path.basename(name || `attachment-${index + 1}`);
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return `attachment-${index + 1}`;
  }
  return sanitized;
}

function inferContentType(contentType: string | null, name: string): string {
  if (contentType) {
    return contentType.toLowerCase();
  }

  const extension = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image/*";
  if (PDF_EXTENSIONS.has(extension)) return "application/pdf";
  if (TEXT_EXTENSIONS.has(extension)) return "text/*";
  return "application/octet-stream";
}

function isAllowedAttachmentType(contentType: string, name: string): boolean {
  if (contentType.startsWith("image/")) return true;
  if (contentType.startsWith("text/")) return true;
  if (contentType === "application/pdf") return true;

  const extension = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return true;
  if (PDF_EXTENSIONS.has(extension)) return true;
  if (TEXT_EXTENSIONS.has(extension)) return true;

  return false;
}

async function downloadAttachment(
  url: string,
  timeoutMs: number
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new AttachmentError(
        `Failed to download attachment (HTTP ${response.status})`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    if (error instanceof AttachmentError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new AttachmentError("Attachment download timed out");
    }
    throw new AttachmentError("Failed to download attachment");
  } finally {
    clearTimeout(timeout);
  }
}

export async function collectMessageAttachments(
  message: Message,
  config: Config
): Promise<AttachmentInput[]> {
  const attachments = Array.from(message.attachments.values());
  if (attachments.length === 0) {
    return [];
  }

  const declaredTotalBytes = attachments.reduce(
    (sum, attachment) => sum + attachment.size,
    0
  );
  if (declaredTotalBytes > config.maxAttachmentBytesPerMessage) {
    throw new AttachmentError(
      `Attachment total size exceeds limit (${config.maxAttachmentBytesPerMessage} bytes)`
    );
  }

  const messageDir = path.join(config.attachmentRootDir, message.id);
  await mkdir(messageDir, { recursive: true });

  const result: AttachmentInput[] = [];
  let downloadedTotalBytes = 0;

  try {
    for (const [index, attachment] of attachments.entries()) {
      const originalName = attachment.name || `attachment-${index + 1}`;
      const contentType = inferContentType(attachment.contentType, originalName);

      if (!isAllowedAttachmentType(contentType, originalName)) {
        throw new AttachmentError(
          `Unsupported attachment type: ${originalName} (${contentType})`
        );
      }

      if (attachment.size > config.maxAttachmentBytesPerFile) {
        throw new AttachmentError(
          `Attachment is too large: ${originalName} (${attachment.size} bytes)`
        );
      }

      const binary = await downloadAttachment(
        attachment.url,
        config.attachmentDownloadTimeoutMs
      );
      if (binary.length > config.maxAttachmentBytesPerFile) {
        throw new AttachmentError(
          `Attachment is too large after download: ${originalName} (${binary.length} bytes)`
        );
      }

      downloadedTotalBytes += binary.length;
      if (downloadedTotalBytes > config.maxAttachmentBytesPerMessage) {
        throw new AttachmentError(
          `Attachment total size exceeds limit (${config.maxAttachmentBytesPerMessage} bytes)`
        );
      }

      const safeName = sanitizeFilename(originalName, index);
      const filePath = path.join(
        messageDir,
        `${String(index + 1).padStart(2, "0")}-${safeName}`
      );
      await writeFile(filePath, binary);

      result.push({
        name: originalName,
        contentType,
        size: binary.length,
        path: filePath,
      });
    }

    return result;
  } catch (error) {
    await rm(messageDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function buildAttachmentPromptBlock(attachments: AttachmentInput[]): string {
  if (attachments.length === 0) {
    return "";
  }

  const lines = [
    "添付ファイル情報:",
    ...attachments.map(
      (attachment, index) =>
        `${index + 1}. name=${attachment.name} type=${attachment.contentType} size=${attachment.size} path=${attachment.path}`
    ),
    "必要に応じて上記 path のファイルを読んで内容を反映してください。",
  ];
  return lines.join("\n");
}

export async function cleanupExpiredAttachments(config: Config): Promise<void> {
  const root = config.attachmentRootDir;
  let entries: Dirent[];

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    const targetPath = path.join(root, entry.name);
    try {
      const info = await stat(targetPath);
      if (now - info.mtimeMs > config.attachmentRetentionMs) {
        await rm(targetPath, { recursive: true, force: true });
      }
    } catch {
      // Ignore per-entry errors to avoid blocking message processing.
    }
  }
}
