import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_DM_FILE_BYTES, prepareDmFiles } from "../../src/adapters/send-dm-adapter";

describe("prepareDmFiles", () => {
  let tempRoot = "";
  let projectRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "cc-discord-bot-send-test-"));
    projectRoot = path.join(tempRoot, "project");
    await mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("accepts files under project root and resolves absolute path", async () => {
    const relativeFile = "docs/report.txt";
    const fullPath = path.join(projectRoot, relativeFile);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, "hello");

    const result = await prepareDmFiles([relativeFile], projectRoot);
    const expectedPath = await realpath(fullPath);
    expect(result.length).toBe(1);
    expect(result[0]?.resolvedPath).toBe(expectedPath);
    expect(result[0]?.fileName).toBe("report.txt");
  });

  it("rejects files outside project root", async () => {
    const outsidePath = path.join(tempRoot, "outside.txt");
    await writeFile(outsidePath, "outside");

    await expect(prepareDmFiles([outsidePath], projectRoot)).rejects.toThrow(
      "File must be inside project root",
    );
  });

  it("rejects symlink paths that escape project root", async () => {
    const outsidePath = path.join(tempRoot, "outside-link-target.txt");
    await writeFile(outsidePath, "outside");

    const symlinkPath = path.join(projectRoot, "linked.txt");
    await symlink(outsidePath, symlinkPath);

    await expect(prepareDmFiles(["linked.txt"], projectRoot)).rejects.toThrow(
      "File must be inside project root",
    );
  });

  it("rejects non-file paths", async () => {
    const dirPath = path.join(projectRoot, "folder");
    await mkdir(dirPath, { recursive: true });

    await expect(prepareDmFiles(["folder"], projectRoot)).rejects.toThrow("Path is not a file");
  });

  it("rejects files larger than max dm size", async () => {
    const largeFilePath = path.join(projectRoot, "large.bin");
    const handle = await open(largeFilePath, "w");
    await handle.truncate(MAX_DM_FILE_BYTES + 1);
    await handle.close();

    await expect(prepareDmFiles(["large.bin"], projectRoot)).rejects.toThrow("File is too large");
  });
});
