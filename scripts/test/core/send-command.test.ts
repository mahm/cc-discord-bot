import { describe, expect, it } from "bun:test";
import { parseSendCommandArgs } from "../../src/core/send-command";

describe("parseSendCommandArgs", () => {
  it("parses legacy message-only send command", () => {
    const result = parseSendCommandArgs(["123456789012345678", "hello", "world"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.userId).toBe("123456789012345678");
      expect(result.value.message).toBe("hello world");
      expect(result.value.filePaths).toEqual([]);
    }
  });

  it("parses file-only send command", () => {
    const result = parseSendCommandArgs(["123456789012345678", "--file", "notes/todo.md"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.message).toBe("");
      expect(result.value.filePaths).toEqual(["notes/todo.md"]);
    }
  });

  it("parses multiple files with message", () => {
    const result = parseSendCommandArgs([
      "123456789012345678",
      "--file",
      "docs/a.txt",
      "--file",
      "docs/b.txt",
      "送っておきます",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.message).toBe("送っておきます");
      expect(result.value.filePaths).toEqual(["docs/a.txt", "docs/b.txt"]);
    }
  });

  it("fails when userId is missing", () => {
    const result = parseSendCommandArgs([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Missing userId");
    }
  });

  it("fails when --file path is missing", () => {
    const result = parseSendCommandArgs(["123456789012345678", "--file"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Missing file path after --file");
    }
  });

  it("fails when both message and files are missing", () => {
    const result = parseSendCommandArgs(["123456789012345678"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Either message or --file is required");
    }
  });
});
