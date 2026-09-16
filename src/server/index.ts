import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import { prepareDashboardLoginSlot } from "./account-slots.js";
import { dispatchAction } from "./actions.js";
import { readDashboardState, updateProviderConfig } from "./storage.js";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

export default async function registerPlugin(ctx: ServerPluginContext): Promise<void> {
  ctx.fastify.get("/api/plugins/multi-account/status", async () => readDashboardState(agentDir()));

  ctx.fastify.put("/api/plugins/multi-account/config", async (request, reply) => {
    try {
      return { config: await updateProviderConfig(agentDir(), request.body) };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  ctx.fastify.post("/api/plugins/multi-account/action", async (request, reply) => {
    try {
      const result = dispatchAction(
        {
          sessionManager: ctx.sessionManager,
          sendToSession: (sessionId, text) => ctx.sendToSession(sessionId, text),
        },
        (request.body ?? {}) as { sessionId?: unknown; action?: unknown },
      );
      return result;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  ctx.fastify.post("/api/plugins/multi-account/accounts/prepare-login", async (request, reply) => {
    const body = (request.body ?? {}) as { provider?: unknown };
    try {
      if (typeof body.provider !== "string") throw new Error("provider is required");
      return await prepareDashboardLoginSlot(agentDir(), body.provider);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  ctx.logger.info("multi-account dashboard companion ready");
}
