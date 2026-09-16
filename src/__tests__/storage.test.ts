import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { makeTempAgentDir, removeTempAgentDir } from "./test-helpers.js";
import { readDashboardState, updateProviderConfig } from "../server/storage.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(removeTempAgentDir));
});

async function tempDir(): Promise<string> {
  const dir = await makeTempAgentDir();
  tempDirs.push(dir);
  return dir;
}

describe("readDashboardState", () => {
  test("returns only redacted, allowlisted state", async () => {
    const dir = await tempDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "provider-failover.json"),
      JSON.stringify({
        enabled: true,
        autoContinue: true,
        showUsage: true,
        maxAutoContinuesPerPrompt: 8,
        fallbacks: ["anthropic-account-2/claude-sonnet-4-6"],
        continuationPrompt: "secret-ish operator text",
      }),
    );
    await writeFile(
      join(dir, "provider-failover-state.json"),
      JSON.stringify({
        stateVersion: 5,
        exhaustedUntilByProvider: { "anthropic-account-2": 2_000 },
        invalidatedByProvider: {
          "anthropic-account-3": { tokenHash: "do-not-return", at: 900, reason: "raw upstream error" },
        },
        usageByProvider: {
          "anthropic-account-2": {
            provider: "anthropic-account-2",
            family: "anthropic",
            fetchedAt: 1_000,
            credentialHash: "do-not-return",
            account: "botond@example.com",
            plan: "max",
            serviceable: false,
            primary: { usedPercent: 100, resetAt: 5_000, windowSeconds: 18_000 },
          },
        },
        pendingContinuationPrompt: "never return this",
        lastSwitches: [
          {
            from: "anthropic/claude-sonnet-4-6",
            to: "anthropic-account-2/claude-sonnet-4-6",
            reason: "rate limit token=secret",
            at: 800,
          },
        ],
      }),
    );

    const result = await readDashboardState(dir, 1_500);
    const serialized = JSON.stringify(result);

    expect(result.config).toEqual({
      enabled: true,
      autoContinue: true,
      showUsage: true,
      maxAutoContinuesPerPrompt: 8,
    });
    expect(result.accounts).toEqual([
      expect.objectContaining({
        provider: "anthropic-account-2",
        family: "anthropic",
        account: "botond@example.com",
        plan: "max",
        status: "cooling",
        cooldownUntil: 2_000,
      }),
      expect.objectContaining({ provider: "anthropic-account-3", status: "invalid" }),
    ]);
    expect(result.recentSwitches[0]).toEqual({
      from: "anthropic/claude-sonnet-4-6",
      to: "anthropic-account-2/claude-sonnet-4-6",
      at: 800,
    });
    expect(serialized).not.toContain("credentialHash");
    expect(serialized).not.toContain("tokenHash");
    expect(serialized).not.toContain("raw upstream error");
    expect(serialized).not.toContain("pendingContinuationPrompt");
    expect(serialized).not.toContain("secret-ish operator text");
    expect(serialized).not.toContain("rate limit token=secret");
  });
});

describe("updateProviderConfig", () => {
  test("updates only allowlisted fields and preserves upstream config", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "provider-failover.json"),
      JSON.stringify({ enabled: true, autoContinue: true, providerOrder: ["anthropic"] }),
    );

    const result = await updateProviderConfig(dir, {
      enabled: false,
      autoContinue: false,
      showUsage: true,
      maxAutoContinuesPerPrompt: 4,
    });
    const stored = JSON.parse(await readFile(join(dir, "provider-failover.json"), "utf8"));

    expect(result).toEqual({
      enabled: false,
      autoContinue: false,
      showUsage: true,
      maxAutoContinuesPerPrompt: 4,
    });
    expect(stored.providerOrder).toEqual(["anthropic"]);
  });

  test("rejects unknown, mistyped, and out-of-range values", async () => {
    const dir = await tempDir();
    await expect(updateProviderConfig(dir, { enabled: true, token: "bad" } as never)).rejects.toThrow(
      "Unsupported configuration field",
    );
    await expect(updateProviderConfig(dir, { enabled: "yes" } as never)).rejects.toThrow(
      "enabled must be a boolean",
    );
    await expect(updateProviderConfig(dir, { maxAutoContinuesPerPrompt: 100 })).rejects.toThrow(
      "between 1 and 32",
    );
  });
});
