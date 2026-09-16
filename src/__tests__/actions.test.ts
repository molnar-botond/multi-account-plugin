import { describe, expect, test, vi } from "vitest";
import { dispatchAction } from "../server/actions.js";

describe("dispatchAction", () => {
  test.each([
    ["next", "/multi-account next"],
    ["rediscover", "/multi-account rediscover"],
    ["reload", "/multi-account reload"],
  ] as const)("routes %s through an active Pi session", (action, command) => {
    const sendToSession = vi.fn(() => true);
    const result = dispatchAction(
      {
        sessionManager: { listActive: () => [{ id: "session-1" }] },
        sendToSession,
      },
      { sessionId: "session-1", action },
    );

    expect(result).toEqual({ ok: true });
    expect(sendToSession).toHaveBeenCalledWith("session-1", command);
  });

  test("rejects arbitrary commands and unknown sessions", () => {
    const context = {
      sessionManager: { listActive: () => [{ id: "session-1" }] },
      sendToSession: vi.fn(() => true),
    };

    expect(() =>
      dispatchAction(context, { sessionId: "session-1", action: "next; rm -rf /" }),
    ).toThrow("Unsupported action");
    expect(() => dispatchAction(context, { sessionId: "other", action: "next" })).toThrow(
      "Active session not found",
    );
    expect(context.sendToSession).not.toHaveBeenCalled();
  });
});
