import { spawn } from "node:child_process";
import path from "node:path";

export class RunFolderOpenError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "RunFolderOpenError";
    this.code = code;
    this.status = status;
  }
}

export async function revealRunArtifact(filePath, {
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  if (platform !== "win32") {
    throw new RunFolderOpenError("EXPLORER_NOT_SUPPORTED", "Opening a task folder is only supported on Windows.", 501);
  }
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new RunFolderOpenError("INVALID_RUN_ARTIFACT", "The task artifact path is invalid.", 500);
  }

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl("explorer.exe", ["/select,", path.resolve(filePath)], {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: false,
      });
    } catch {
      reject(new RunFolderOpenError("EXPLORER_OPEN_FAILED", "Windows Explorer could not be opened."));
      return;
    }

    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      operation();
    };
    child.once("error", () => finish(() => reject(
      new RunFolderOpenError("EXPLORER_OPEN_FAILED", "Windows Explorer could not be opened."),
    )));
    child.once("spawn", () => finish(() => {
      child.unref?.();
      resolve();
    }));
  });

  return { opened: true };
}
