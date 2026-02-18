import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_DM_FILE_BYTES = 25 * 1024 * 1024;

export interface PreparedDmFile {
  inputPath: string;
  resolvedPath: string;
  fileName: string;
  size: number;
}

function isWithinProjectRoot(resolvedPath: string, projectRootResolved: string): boolean {
  const relative = path.relative(projectRootResolved, resolvedPath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function prepareDmFiles(
  filePaths: string[],
  projectRoot: string,
): Promise<PreparedDmFile[]> {
  if (filePaths.length === 0) {
    return [];
  }

  const projectRootResolved = await realpath(projectRoot);
  const prepared: PreparedDmFile[] = [];

  for (const inputPath of filePaths) {
    const normalizedInput = inputPath.trim();
    if (!normalizedInput) {
      throw new Error("Empty file path is not allowed");
    }

    const absoluteCandidate = path.isAbsolute(normalizedInput)
      ? normalizedInput
      : path.join(projectRootResolved, normalizedInput);

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(absoluteCandidate);
    } catch {
      throw new Error(`File not found: ${inputPath}`);
    }

    if (!isWithinProjectRoot(resolvedPath, projectRootResolved)) {
      throw new Error(`File must be inside project root: ${inputPath}`);
    }

    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) {
      throw new Error(`Path is not a file: ${inputPath}`);
    }

    if (fileStat.size > MAX_DM_FILE_BYTES) {
      throw new Error(
        `File is too large (${fileStat.size} bytes > ${MAX_DM_FILE_BYTES}): ${inputPath}`,
      );
    }

    prepared.push({
      inputPath,
      resolvedPath,
      fileName: path.basename(resolvedPath),
      size: fileStat.size,
    });
  }

  return prepared;
}
