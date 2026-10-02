import { describe, expect, test } from "bun:test";
import type { PathHealth } from "../upstream/src/lib/client";
import {
  installBrowserConnectionRecovery,
  type BrowserRecoveryEnvironment,
} from "../upstream/src/lib/browser-recovery";

class FakeRecoveryWindow extends EventTarget {
  readonly timers = new Map<number, { callback: () => void; delay: number }>();
  now = 1_000;
  #nextTimer = 1;

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  setTimeout(callback: () => void, delay = 0): number {
    const handle = this.#nextTimer;
    this.#nextTimer += 1;
    this.timers.set(handle, { callback, delay });
    return handle;
  }

  pendingDelays(): number[] {
    return [...this.timers.values()].map(timer => timer.delay).sort((left, right) => left - right);
  }

  runNextTimer(): void {
    const next = [...this.timers.entries()].sort(([, left], [, right]) => left.delay - right.delay)[0];
    if (next === undefined) throw new Error("missing recovery timer");
    const [handle, timer] = next;
    this.timers.delete(handle);
    this.now += timer.delay;
    timer.callback();
  }
}

class FakeRecoveryDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

interface RecoveryHarness {
  readonly connection: EventTarget;
  readonly document: FakeRecoveryDocument;
  readonly deferredAborts: Array<() => void>;
  readonly environment: BrowserRecoveryEnvironment;
  readonly fetches: Array<{ input: string; init: RequestInit | undefined }>;
  readonly health: PathHealth[];
  readonly refreshed: { count: number };
  readonly relayMeasurements: { count: number };
  readonly window: FakeRecoveryWindow;
}

type ProbeResult = boolean | number | "hang" | "deferred-abort" | "network" | "opaqueredirect";

function recoveryHarness(results: readonly ProbeResult[]): RecoveryHarness {
  const connection = new EventTarget();
  const document = new FakeRecoveryDocument();
  const window = new FakeRecoveryWindow();
  const fetches: Array<{ input: string; init: RequestInit | undefined }> = [];
  const deferredAborts: Array<() => void> = [];
  const health: PathHealth[] = [];
  const refreshed = { count: 0 };
  const relayMeasurements = { count: 0 };
  const responses = [...results];
  const environment: BrowserRecoveryEnvironment = {
    connection,
    document,
    now: () => window.now,
    random: () => 0.5,
    window,
    async fetch(input, init): Promise<Response> {
      fetches.push({ input: String(input), init });
      const result = responses.shift();
      if (result === "hang" || result === "deferred-abort") {
        return await new Promise<Response>((_resolve, reject) => {
          const abort = (): void => reject(new DOMException("probe timed out", "AbortError"));
          const handleAbort = result === "deferred-abort"
            ? (): void => { deferredAborts.push(abort); }
            : abort;
          if (init?.signal?.aborted === true) handleAbort();
          else init?.signal?.addEventListener("abort", handleAbort, { once: true });
        });
      }
      if (result === "network") throw new TypeError("Failed to fetch");
      if (result === "opaqueredirect") {
        // Response.type is read-only on a constructed Response; only the probe's read fields matter.
        const opaque = { status: 0, ok: false, type: "opaqueredirect" } as Response;
        return opaque;
      }
      return new Response(null, { status: typeof result === "number" ? result : result === false ? 503 : 200 });
    },
  };
  return { connection, deferredAborts, document, environment, fetches, health, refreshed, relayMeasurements, window };
}

describe("collaboration browser network recovery", () => {
  test("uses a connection change only to trigger gateway and relay measurements", async () => {
    const harness = recoveryHarness([true, true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
      () => {
        harness.relayMeasurements.count += 1;
      },
    );

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.window.pendingDelays()).toEqual([15_000]);

    harness.connection.dispatchEvent(new Event("change"));
    expect(harness.health.at(-1)?.state).toBe("healthy");
    await settle();
    expect(harness.refreshed.count).toBe(0);
    expect(harness.relayMeasurements.count).toBe(1);
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.window.pendingDelays()).toEqual([15_000]);
    expect(harness.fetches).toHaveLength(2);
    expect(harness.fetches[1]?.init?.cache).toBe("no-store");

    dispose();
    expect(harness.window.timers.size).toBe(0);
  });

  test("discards an event-cancelled probe before measuring the replacement", async () => {
    const harness = recoveryHarness(["hang", true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
      () => {
        harness.relayMeasurements.count += 1;
      },
    );

    harness.window.runNextTimer();
    await settle();
    harness.window.dispatchEvent(new Event("offline"));
    await settle();
    expect(harness.health.map(state => state.state)).toEqual(["checking"]);
    expect(harness.window.pendingDelays()).toEqual([0]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.refreshed.count).toBe(0);
    expect(harness.relayMeasurements.count).toBe(1);

    dispose();
  });

  test("discards a hide-cancelled probe after rapid foregrounding", async () => {
    const harness = recoveryHarness(["deferred-abort", true]);
    const relayPauses: boolean[] = [];
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
      () => {
        harness.relayMeasurements.count += 1;
      },
      paused => relayPauses.push(paused),
    );

    harness.window.runNextTimer();
    await settle();
    harness.document.visibilityState = "hidden";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    expect(harness.deferredAborts).toHaveLength(1);

    harness.document.visibilityState = "visible";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    harness.deferredAborts.shift()?.();
    await settle();
    expect(harness.health.map(state => state.state)).toEqual(["checking"]);
    expect(relayPauses).toEqual([false, true]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(relayPauses).toEqual([false, true, false]);
    expect(harness.relayMeasurements.count).toBe(1);

    dispose();
  });

  test("pauses relay probes while hidden and remeasures after foregrounding", async () => {
    const harness = recoveryHarness([true, true]);
    const relayPauses: boolean[] = [];
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
      () => {
        harness.relayMeasurements.count += 1;
      },
      paused => relayPauses.push(paused),
    );

    harness.window.runNextTimer();
    await settle();
    harness.document.visibilityState = "hidden";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    expect(harness.window.timers.size).toBe(0);

    harness.document.visibilityState = "visible";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(relayPauses).toEqual([false, true, false]);
    expect(harness.relayMeasurements.count).toBe(1);
    expect(harness.health.at(-1)?.state).toBe("healthy");

    dispose();
    expect(relayPauses.at(-1)).toBe(true);
  });

  test("keeps relay probes paused until foreground gateway recovery succeeds", async () => {
    const harness = recoveryHarness([true, false, true, true]);
    const relayPauses: boolean[] = [];
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
      () => {
        harness.relayMeasurements.count += 1;
      },
      paused => relayPauses.push(paused),
    );

    harness.window.runNextTimer();
    await settle();
    harness.document.visibilityState = "hidden";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    harness.document.visibilityState = "visible";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(harness.health.at(-1)?.state).toBe("degraded");
    expect(relayPauses).toEqual([false, true]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("checking");
    expect(relayPauses).toEqual([false, true]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(relayPauses).toEqual([false, true, false]);
    expect(harness.relayMeasurements.count).toBe(1);

    dispose();
  });

  test("uses hysteresis and full jitter across a measured gateway outage", async () => {
    const harness = recoveryHarness([false, false, true, true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
    );

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("degraded");
    expect(harness.window.pendingDelays()).toEqual([2_000]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("unreachable");
    expect((harness.health.at(-1)?.retryAt ?? 0) - harness.window.now).toBe(1_000);
    expect(harness.window.pendingDelays()).toEqual([1_000]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("checking");
    expect(harness.refreshed.count).toBe(1);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.refreshed.count).toBe(1);

    dispose();
  });

  test("recovers after an offline signal without waiting for an online event", async () => {
    const harness = recoveryHarness([true, false, true, true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
    );

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");

    harness.window.dispatchEvent(new Event("offline"));
    await settle();
    expect(harness.health.at(-1)?.state).toBe("degraded");

    harness.connection.dispatchEvent(new Event("change"));
    await settle();
    expect(harness.health.at(-1)?.state).toBe("checking");
    expect(harness.refreshed.count).toBe(1);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.fetches).toHaveLength(4);

    dispose();
  });

  test("times out a silent health probe before recovering the relay", async () => {
    const harness = recoveryHarness(["hang", true, true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
    );

    harness.window.runNextTimer();
    await settle();
    expect(harness.window.pendingDelays()).toEqual([3_000]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("degraded");
    expect(harness.refreshed.count).toBe(0);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("checking");
    expect(harness.refreshed.count).toBe(1);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");

    dispose();
  });

  test("probes through the edge with manual redirects and the AJAX marker", async () => {
    const harness = recoveryHarness([true]);
    const dispose = installBrowserConnectionRecovery(() => {}, harness.environment);
    harness.window.runNextTimer();
    await settle();
    const init = harness.fetches[0]?.init;
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(init?.credentials).toBe("same-origin");
    dispose();
  });

  test.each([401, 403, "opaqueredirect"] as const)("treats a %s probe as a terminal refusal", async refusal => {
    const harness = recoveryHarness([true, refusal, true, true]);
    const denials: number[] = [];
    const relayPauses: boolean[] = [];
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
      () => {
        harness.relayMeasurements.count += 1;
      },
      paused => relayPauses.push(paused),
      () => denials.push(harness.fetches.length),
    );
    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");

    harness.window.runNextTimer();
    await settle();
    expect(denials).toEqual([2]);
    expect(relayPauses.at(-1)).toBe(true);
    // A refusal is not an outage: no retry is scheduled, published, or refreshed into.
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.window.timers.size).toBe(0);

    for (const type of ["online", "pageshow"]) harness.window.dispatchEvent(new Event(type));
    harness.connection.dispatchEvent(new Event("change"));
    harness.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(harness.fetches).toHaveLength(2);
    expect(harness.refreshed.count).toBe(0);
    expect(harness.relayMeasurements.count).toBe(0);
    expect(denials).toEqual([2]);
    dispose();
  });

  test.each([503, 502, 404, "network", "hang"] as const)("keeps %s on the transient retry path", async failure => {
    const harness = recoveryHarness([failure, true, true]);
    const denials: string[] = [];
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
      undefined,
      undefined,
      () => denials.push("denied"),
    );
    harness.window.runNextTimer();
    await settle();
    if (failure === "hang") {
      harness.window.runNextTimer();
      await settle();
    }
    expect(harness.health.at(-1)?.state).toBe("degraded");

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("checking");
    expect(harness.refreshed.count).toBe(1);
    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(denials).toEqual([]);
    dispose();
  });
});
