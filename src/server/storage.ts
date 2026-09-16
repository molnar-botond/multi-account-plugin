import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

export interface EditableConfig {
  enabled: boolean;
  autoContinue: boolean;
  showUsage: boolean;
  maxAutoContinuesPerPrompt: number;
}

export interface UsageWindowDto {
  usedPercent: number;
  resetAt: number;
  windowSeconds?: number;
}

export interface AccountDto {
  provider: string;
  family?: string;
  account?: string;
  plan?: string;
  serviceable?: boolean;
  status: "ready" | "cooling" | "invalid";
  cooldownUntil?: number;
  fetchedAt?: number;
  primary?: UsageWindowDto;
  secondary?: UsageWindowDto;
}

export interface DashboardState {
  engineVersion: string;
  config: EditableConfig;
  accounts: AccountDto[];
  recentSwitches: Array<{ from: string; to: string; at: number }>;
}

type JsonRecord = Record<string, unknown>;

const ENGINE_VERSION = "1.21.3";
const DEFAULT_CONFIG: EditableConfig = {
  enabled: true,
  autoContinue: true,
  showUsage: true,
  maxAutoContinuesPerPrompt: 8,
};
const EDITABLE_FIELDS = new Set<keyof EditableConfig>([
  "enabled",
  "autoContinue",
  "showUsage",
  "maxAutoContinuesPerPrompt",
]);

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

async function readJson(path: string): Promise<JsonRecord> {
  try {
    return record(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return {};
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeWindow(value: unknown): UsageWindowDto | undefined {
  const source = record(value);
  const usedPercent = finiteNumber(source.usedPercent);
  const resetAt = finiteNumber(source.resetAt);
  if (usedPercent === undefined || resetAt === undefined) return undefined;
  const windowSeconds = finiteNumber(source.windowSeconds);
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    resetAt,
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
  };
}

function editableConfig(source: JsonRecord): EditableConfig {
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CONFIG.enabled,
    autoContinue:
      typeof source.autoContinue === "boolean" ? source.autoContinue : DEFAULT_CONFIG.autoContinue,
    showUsage: typeof source.showUsage === "boolean" ? source.showUsage : DEFAULT_CONFIG.showUsage,
    maxAutoContinuesPerPrompt:
      typeof source.maxAutoContinuesPerPrompt === "number" &&
      Number.isInteger(source.maxAutoContinuesPerPrompt) &&
      source.maxAutoContinuesPerPrompt >= 1 &&
      source.maxAutoContinuesPerPrompt <= 32
        ? source.maxAutoContinuesPerPrompt
        : DEFAULT_CONFIG.maxAutoContinuesPerPrompt,
  };
}

export function validateConfigPatch(value: unknown): Partial<EditableConfig> {
  const source = record(value);
  for (const key of Object.keys(source)) {
    if (!EDITABLE_FIELDS.has(key as keyof EditableConfig)) {
      throw new Error(`Unsupported configuration field: ${key}`);
    }
  }
  for (const key of ["enabled", "autoContinue", "showUsage"] as const) {
    if (source[key] !== undefined && typeof source[key] !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
  }
  const max = source.maxAutoContinuesPerPrompt;
  if (
    max !== undefined &&
    (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > 32)
  ) {
    throw new Error("maxAutoContinuesPerPrompt must be an integer between 1 and 32");
  }
  return source as Partial<EditableConfig>;
}

export async function readDashboardState(agentDir: string, now = Date.now()): Promise<DashboardState> {
  const config = await readJson(join(agentDir, "provider-failover.json"));
  const state = await readJson(join(agentDir, "provider-failover-state.json"));
  const cooldowns = record(state.exhaustedUntilByProvider);
  const invalidated = record(state.invalidatedByProvider);
  const usageByProvider = record(state.usageByProvider);
  const providers = new Set<string>();

  const fallbacks = Array.isArray(config.fallbacks) ? config.fallbacks : [];
  for (const fallback of fallbacks) {
    if (typeof fallback === "string" && fallback.includes("/")) providers.add(fallback.split("/", 1)[0]);
  }
  for (const source of [cooldowns, invalidated, usageByProvider]) {
    for (const provider of Object.keys(source)) providers.add(provider);
  }

  const accounts = [...providers].filter((provider) => provider.length <= 200).sort().map((provider): AccountDto => {
    const usage = record(usageByProvider[provider]);
    const cooldownUntil = finiteNumber(cooldowns[provider]);
    const invalid = Object.hasOwn(invalidated, provider);
    const status: AccountDto["status"] = invalid
      ? "invalid"
      : cooldownUntil !== undefined && cooldownUntil > now
        ? "cooling"
        : "ready";
    const family = typeof usage.family === "string" ? usage.family.slice(0, 80) : undefined;
    const account = typeof usage.account === "string" ? usage.account.slice(0, 200) : undefined;
    const plan = typeof usage.plan === "string" ? usage.plan.slice(0, 80) : undefined;
    const serviceable = typeof usage.serviceable === "boolean" ? usage.serviceable : undefined;
    const fetchedAt = finiteNumber(usage.fetchedAt);
    const primary = safeWindow(usage.primary);
    const secondary = safeWindow(usage.secondary);
    return {
      provider,
      ...(family ? { family } : {}),
      ...(account ? { account } : {}),
      ...(plan ? { plan } : {}),
      ...(serviceable === undefined ? {} : { serviceable }),
      status,
      ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
      ...(fetchedAt === undefined ? {} : { fetchedAt }),
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
    };
  });

  const switches = Array.isArray(state.lastSwitches) ? state.lastSwitches : [];
  const recentSwitches = switches
    .slice(-10)
    .reverse()
    .flatMap((value) => {
      const item = record(value);
      return typeof item.from === "string" && typeof item.to === "string" && finiteNumber(item.at) !== undefined
        ? [{ from: item.from.slice(0, 200), to: item.to.slice(0, 200), at: item.at as number }]
        : [];
    });

  return { engineVersion: ENGINE_VERSION, config: editableConfig(config), accounts, recentSwitches };
}

export async function updateProviderConfig(
  agentDir: string,
  rawPatch: unknown,
): Promise<EditableConfig> {
  const patch = validateConfigPatch(rawPatch);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const path = join(agentDir, "provider-failover.json");
  const handle = await open(path, "a", 0o600);
  await handle.close();
  await chmod(path, 0o600);
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 5, minTimeout: 20 } });
  try {
    const current = await readJson(path);
    const next = { ...current, ...patch };
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
    return editableConfig(next);
  } finally {
    await release();
  }
}
