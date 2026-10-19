// A temporary folder that is removed when the test file is done.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `install-${prefix}-`));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
