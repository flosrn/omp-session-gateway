import { describe, expect, test } from "bun:test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { pendingAskCount, syncAppBadge, type AppBadgeNavigator } from "../src/app-badge.ts";

function session(overrides: Partial<SessionMetadata>): SessionMetadata {
  return {
    instanceId: "badge-session-0001",
    generation: 1,
    startedAt: "2026-10-03T00:00:00.000Z",
    lastSeenAt: "2026-10-03T00:00:00.000Z",
    canView: true,
    canControl: true,
    inputRequired: false,
    ...overrides,
  };
}

const ask = { requestId: "badge-request-identity-01", since: "2026-10-03T00:00:00.000Z" };

describe("app badge", () => {
  test("counts only answerable asks, the same rule push pendingAskCount uses", () => {
    expect(pendingAskCount([
      session({ inputRequired: true, ask }),
      session({ instanceId: "view-only-session-01", inputRequired: true, canControl: false, ask }),
      session({ instanceId: "stale-fleet-session-1", inputRequired: true, canControl: false, available: false, ask }),
      session({ instanceId: "working-session-00001", busy: true }),
    ])).toBe(1);
  });

  test("sets a positive count, clears at zero, and never asks for permission", async () => {
    const calls: string[] = [];
    const badge: AppBadgeNavigator & { requestPermission(): Promise<string> } = {
      async setAppBadge(value?: number) { calls.push(`set:${value}`); },
      async clearAppBadge() { calls.push("clear"); },
      async requestPermission() { calls.push("permission"); return "granted"; },
    };
    await syncAppBadge(3, badge);
    await syncAppBadge(0, badge);
    await syncAppBadge(-2, badge);
    await syncAppBadge(Number.NaN, badge);
    expect(calls).toEqual(["set:3", "clear", "clear", "clear"]);
  });

  test("clears through setAppBadge(0) where clearAppBadge is missing, and tolerates no Badging API", async () => {
    const calls: number[] = [];
    await syncAppBadge(0, { async setAppBadge(value?: number) { calls.push(value ?? -1); } });
    await syncAppBadge(2, {});
    expect(calls).toEqual([0]);
  });

  test("leaves the latest count on the icon when writes settle out of order", async () => {
    const applied: number[] = [];
    const started: Array<{ value: number; release(): void }> = [];
    let nextStart = Promise.withResolvers<void>();
    const badge: AppBadgeNavigator = {
      setAppBadge(value?: number) {
        const { promise, resolve } = Promise.withResolvers<void>();
        started.push({ value: value ?? -1, release: () => { applied.push(value ?? -1); resolve(); } });
        nextStart.resolve();
        return promise;
      },
      async clearAppBadge() { applied.push(0); },
    };
    const writes = [syncAppBadge(2, badge), syncAppBadge(5, badge), syncAppBadge(0, badge)];
    try {
      await nextStart.promise;
      nextStart = Promise.withResolvers<void>();
      // Only the first write has started; the second waits for it, so it cannot finish first.
      expect(started.map(write => write.value)).toEqual([2]);
      started[0]!.release();
      await nextStart.promise;
      expect(started.map(write => write.value)).toEqual([2, 5]);
      started[1]!.release();
      await Promise.all(writes);
      expect(applied).toEqual([2, 5, 0]);
    } finally {
      // A failed assertion must not leave a write pending on this navigator's queue.
      for (const write of started) write.release();
    }
  });

  test("swallows a rejected badge write so the next one still applies", async () => {
    const applied: number[] = [];
    let reject = true;
    const badge: AppBadgeNavigator = {
      async setAppBadge(value?: number) {
        if (reject) { reject = false; throw new DOMException("not installed", "NotAllowedError"); }
        applied.push(value ?? -1);
      },
    };
    await syncAppBadge(1, badge);
    await syncAppBadge(4, badge);
    expect(applied).toEqual([4]);
  });
});
