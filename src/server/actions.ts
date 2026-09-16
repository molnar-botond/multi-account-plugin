export type MultiAccountAction = "next" | "rediscover" | "reload";

interface ActionContext {
  sessionManager: { listActive(): unknown[] };
  sendToSession(sessionId: string, text: string): boolean;
}

const COMMANDS: Record<MultiAccountAction, string> = {
  next: "/multi-account next",
  rediscover: "/multi-account rediscover",
  reload: "/multi-account reload",
};

export function dispatchAction(
  ctx: ActionContext,
  body: { sessionId?: unknown; action?: unknown },
): { ok: true } {
  if (typeof body.action !== "string" || !Object.hasOwn(COMMANDS, body.action)) {
    throw new Error("Unsupported action");
  }
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0 || body.sessionId.length > 200) {
    throw new Error("A valid sessionId is required");
  }
  const active = ctx.sessionManager.listActive() as Array<{ id?: unknown }>;
  if (!active.some((session) => session?.id === body.sessionId)) {
    throw new Error("Active session not found");
  }
  const delivered = ctx.sendToSession(body.sessionId, COMMANDS[body.action as MultiAccountAction]);
  if (!delivered) throw new Error("Session is not connected");
  return { ok: true };
}
