import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "multi-account-plugin-"));
}

export function removeTempAgentDir(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true });
}
