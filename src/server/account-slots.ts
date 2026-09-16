import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

const SUPPORTED = new Set(["anthropic", "openai-codex"]);

type AuthData = Record<string, unknown>;

function isOAuthCredential(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Record<string, unknown>;
  return (
    credential.type === "oauth" &&
    typeof credential.access === "string" &&
    typeof credential.refresh === "string"
  );
}

function isSameOAuthCredential(left: Record<string, unknown>, right: unknown): boolean {
  return isOAuthCredential(right) && left.refresh === right.refresh && left.access === right.access;
}

async function readAuth(path: string): Promise<AuthData> {
  try {
    const content = await readFile(path, "utf8");
    if (!content.trim()) return {};
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid shape");
    }
    return parsed as AuthData;
  } catch {
    throw new Error("Pi authentication store is unavailable");
  }
}

async function atomicWrite(path: string, data: AuthData): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function prepareDashboardLoginSlot(
  agentDir: string,
  provider: string,
): Promise<{ provider: string; targetProvider: string; copied: boolean }> {
  if (!SUPPORTED.has(provider)) throw new Error("Unsupported OAuth provider");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const path = join(agentDir, "auth.json");
  const handle = await open(path, "a", 0o600);
  await handle.close();
  await chmod(path, 0o600);
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 5, minTimeout: 20 } });
  try {
    const auth = await readAuth(path);
    const current = auth[provider];
    if (current === undefined) return { provider, targetProvider: provider, copied: false };
    if (!isOAuthCredential(current)) {
      throw new Error(`${provider} is not authenticated with OAuth`);
    }
    let targetProvider: string | undefined;
    for (let slot = 2; slot <= 10; slot++) {
      const candidate = `${provider}-account-${slot}`;
      if (isSameOAuthCredential(current, auth[candidate])) {
        return { provider, targetProvider: candidate, copied: true };
      }
    }
    for (let slot = 2; slot <= 10; slot++) {
      const candidate = `${provider}-account-${slot}`;
      if (!Object.hasOwn(auth, candidate)) {
        targetProvider = candidate;
        break;
      }
    }
    if (!targetProvider) throw new Error("No free account slot (maximum 10 accounts)");
    auth[targetProvider] = current;
    await atomicWrite(path, auth);
    return { provider, targetProvider, copied: true };
  } finally {
    await release();
  }
}
