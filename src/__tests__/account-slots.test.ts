import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { prepareDashboardLoginSlot } from "../server/account-slots.js";
import { makeTempAgentDir, removeTempAgentDir } from "./test-helpers.js";

const tempDirs: string[] = [];
afterEach(async () => Promise.all(tempDirs.splice(0).map(removeTempAgentDir)));

async function tempDir(): Promise<string> {
  const dir = await makeTempAgentDir();
  tempDirs.push(dir);
  return dir;
}

describe("prepareDashboardLoginSlot", () => {
  test("copies the current OAuth credential to the next alias without exposing it", async () => {
    const dir = await tempDir();
    const authPath = join(dir, "auth.json");
    const credential = { type: "oauth", access: "secret-access", refresh: "secret-refresh", expires: 123 };
    await writeFile(authPath, JSON.stringify({
      anthropic: credential,
      "anthropic-account-2": { type: "oauth", access: "other-access", refresh: "other-refresh", expires: 123 },
    }));
    await chmod(authPath, 0o644);

    const result = await prepareDashboardLoginSlot(dir, "anthropic");
    const stored = JSON.parse(await readFile(authPath, "utf8"));

    expect(result).toEqual({ provider: "anthropic", targetProvider: "anthropic-account-3", copied: true });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(stored.anthropic).toEqual(credential);
    expect(stored["anthropic-account-3"]).toEqual(credential);
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });

  test("reuses an identical alias after a cancelled login", async () => {
    const dir = await tempDir();
    const credential = { type: "oauth", access: "same-access", refresh: "same-refresh", expires: 123 };
    await writeFile(join(dir, "auth.json"), JSON.stringify({
      anthropic: credential,
      "anthropic-account-2": credential,
    }), { mode: 0o600 });

    await expect(prepareDashboardLoginSlot(dir, "anthropic")).resolves.toEqual({
      provider: "anthropic",
      targetProvider: "anthropic-account-2",
      copied: true,
    });
  });

  test("allows a first login when auth.json does not exist", async () => {
    const dir = await tempDir();
    await expect(prepareDashboardLoginSlot(dir, "anthropic")).resolves.toEqual({
      provider: "anthropic",
      targetProvider: "anthropic",
      copied: false,
    });
  });

  test("rejects unsupported providers and exhausted slots", async () => {
    const dir = await tempDir();
    await expect(prepareDashboardLoginSlot(dir, "zai")).rejects.toThrow("Unsupported OAuth provider");
    const full = Object.fromEntries([
      ["anthropic", { type: "oauth", access: "a", refresh: "r", expires: 1 }],
      ...Array.from({ length: 9 }, (_, i) => [
        `anthropic-account-${i + 2}`,
        { type: "oauth", access: `a${i}`, refresh: `r${i}`, expires: 1 },
      ]),
    ]);
    await writeFile(join(dir, "auth.json"), JSON.stringify(full), { mode: 0o600 });
    await expect(prepareDashboardLoginSlot(dir, "anthropic")).rejects.toThrow("No free account slot");
  });
});
