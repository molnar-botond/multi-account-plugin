import { beforeEach, describe, expect, it, vi } from "vitest";

const activateMultiAccount = vi.hoisted(() => vi.fn());

vi.mock("pi-multi-account", () => ({ default: activateMultiAccount }));

import activate from "../bridge/index.ts";

describe("multi-account bridge", () => {
  beforeEach(() => activateMultiAccount.mockReset());

  it("registers upstream without calling runtime actions during extension loading", async () => {
    const pi = {
      getCommands: vi.fn(() => {
        throw new Error("Extension runtime not initialized");
      }),
    };

    await expect(activate(pi as never)).resolves.toBeUndefined();
    expect(pi.getCommands).not.toHaveBeenCalled();
    expect(activateMultiAccount).toHaveBeenCalledOnce();
    expect(activateMultiAccount).toHaveBeenCalledWith(pi);
  });
});
