import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUSH_API_VERSION,
  SecretCapability,
  parseAttentionPushMessage,
  parseSessionEvent,
  parseSessionListResponse,
  type FleetBridgeHost,
  type FleetBridgeSession,
  type FleetBridgeSnapshot,
  type FleetLinkOutcome,
  type SessionEvent,
} from "@omp-session-gateway/protocol";
import type { GatewayConfig } from "../src/config.ts";
import {
  FleetBridgeClient,
  FleetFederation,
  fleetInstanceId,
  readBridgeToken,
  type BridgeFetch,
  type FleetBridge,
  type FleetOpenTarget,
} from "../src/federation.ts";
import { PushService, type PushTransport } from "../src/push.ts";
import { SessionRegistry, type RegistryClock } from "../src/registry.ts";

const CONTROL_URL = `https://my.omp.sh/#room-1.${"k".repeat(64)}`;
const TOKEN = ["BRIDGE", "TOKEN", "CANARY", "0123456789"].join("_");

class FakeClock implements RegistryClock {
  monotonic = 1_000;
  wall = Date.parse("2026-10-01T00:00:00.000Z");
  monotonicNowMs(): number {
    return this.monotonic;
  }
  wallNowIso(): string {
    return new Date(this.wall).toISOString();
  }
  advance(milliseconds: number): void {
    this.monotonic += milliseconds;
    this.wall += milliseconds;
  }
}

function session(overrides: Partial<FleetBridgeSession> = {}): FleetBridgeSession {
  return {
    instanceId: "native-instance-1",
    generation: 1,
    sessionId: "session-1",
    title: "Fleet session",
    pid: 4242,
    cwd: "/srv/repo",
    model: { provider: "fixture", id: "model" },
    roomSince: Date.parse("2026-10-01T00:00:00.000Z"),
    state: "idle",
    guests: 0,
    relayConnected: true,
    tmuxSession: null,
    canControl: true,
    ...overrides,
  };
}

function host(name: string, sessions: FleetBridgeSession[], status: FleetBridgeHost["status"] = "live"): FleetBridgeHost {
  return { host: name, source: "hub", status, ageSeconds: status === "never" ? null : 2, error: null, sessions };
}

class FakeBridge implements FleetBridge {
  listing: FleetBridgeSnapshot | Error = { hosts: [] };
  opens: FleetOpenTarget[] = [];
  outcome: FleetLinkOutcome = { ok: true, capability: SecretCapability.from(CONTROL_URL) };
  /** Runs while `open` is in flight, to change the directory under the launch. */
  duringOpen: (() => Promise<void> | void) | undefined;

  async sessions(): Promise<FleetBridgeSnapshot> {
    if (this.listing instanceof Error) throw this.listing;
    return this.listing;
  }

  async open(target: FleetOpenTarget): Promise<FleetLinkOutcome> {
    this.opens.push(target);
    await this.duringOpen?.();
    return this.outcome;
  }
}

function fixture(): { clock: FakeClock; registry: SessionRegistry; bridge: FakeBridge; federation: FleetFederation } {
  const clock = new FakeClock();
  const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 100, clock });
  const bridge = new FakeBridge();
  const federation = new FleetFederation({
    registry,
    bridge,
    pollSeconds: 3,
    autoStart: false,
    monotonicNowMs: () => clock.monotonicNowMs(),
  });
  return { clock, registry, bridge, federation };
}

describe("fleet federation", () => {
  test("one native id on two machines becomes two machine-qualified cards", async () => {
    const { registry, bridge, federation } = fixture();
    bridge.listing = { hosts: [host("mac", [session()]), host("gapicore", [session()])] };
    await federation.poll();
    const listed = parseSessionListResponse(JSON.parse(JSON.stringify(registry.snapshot())));
    const ids = listed.sessions.map(card => card.instanceId).sort();
    expect(ids).toEqual([fleetInstanceId("gapicore", "native-instance-1"), fleetInstanceId("mac", "native-instance-1")].sort());
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.every(id => /^[0-9a-f]{64}$/u.test(id))).toBe(true);
    expect(listed.hosts?.map(entry => entry.host)).toEqual(["mac", "gapicore"]);

    const target = fleetInstanceId("gapicore", "native-instance-1");
    const launched = await federation.resolve({ instanceId: target, generation: 1, mode: "control" });
    expect(launched.status).toBe("ok");
    expect(bridge.opens).toEqual([{ host: "gapicore", instanceId: "native-instance-1", generation: 1 }]);
  });

  test("an empty or never-read machine still appears in the host summary", async () => {
    const { registry, bridge, federation } = fixture();
    bridge.listing = { hosts: [host("mac", []), host("orin", [], "never")] };
    await federation.poll();
    expect(registry.snapshot().hosts).toEqual([
      { host: "mac", status: "live", ageSeconds: 2 },
      { host: "orin", status: "never", ageSeconds: null },
    ]);
  });

  test("View is refused on a fleet card without asking the bridge", async () => {
    const { bridge, federation } = fixture();
    bridge.listing = { hosts: [host("mac", [session()])] };
    await federation.poll();
    const id = fleetInstanceId("mac", "native-instance-1");
    expect(await federation.resolve({ instanceId: id, generation: 1, mode: "view" })).toEqual({ status: "mode_unavailable" });
    expect(bridge.opens).toEqual([]);
  });

  const { canControl: _unreported, ...accessUnreported } = session();
  test.each<[string, FleetBridgeHost["status"], FleetBridgeSession]>([
    ["stale machine", "stale", session()],
    ["unknown generation", "live", session({ generation: null })],
    ["unknown start", "live", session({ roomSince: null })],
    ["access not reported", "live", accessUnreported],
    ["view-only share", "live", session({ canControl: false })],
  ])("%s cannot launch", async (_label, status, listed) => {
    const { bridge, federation } = fixture();
    bridge.listing = { hosts: [host("mac", [listed], status)] };
    await federation.poll();
    const result = await federation.resolve({ instanceId: fleetInstanceId("mac", "native-instance-1"), generation: 1, mode: "control" });
    expect(result.status).not.toBe("ok");
    expect(bridge.opens).toEqual([]);
  });

  test("a bridge outage keeps cards visible, unavailable, unlaunchable and never re-live", async () => {
    const { clock, registry, bridge, federation } = fixture();
    bridge.listing = { hosts: [host("mac", [session({ state: "working" })])] };
    await federation.poll();
    expect(federation.healthy).toBe(true);
    bridge.listing = new Error("socket refused");
    clock.advance(3_000);
    await federation.poll();
    expect(federation.healthy).toBe(false);
    const [card] = registry.snapshot().sessions;
    expect(card).toMatchObject({ available: false, hostStatus: "stale", canControl: false });
    expect(card).not.toHaveProperty("busy");
    expect(registry.snapshot().hosts?.[0]).toMatchObject({ host: "mac", status: "stale", ageSeconds: 5 });
    const id = fleetInstanceId("mac", "native-instance-1");
    expect((await federation.resolve({ instanceId: id, generation: 1, mode: "control" })).status).toBe("missing");
    // Outages do not refresh liveness: the TTL still retires the card.
    clock.advance(36_000);
    await federation.poll();
    expect(registry.snapshot().sessions).toEqual([]);
  });

  test("a bridge rejection since boot is not an empty healthy fleet, and a later outage keeps stale metadata only", async () => {
    const rejected = fixture();
    expect(rejected.registry.snapshot()).toMatchObject({ sessions: [], fleetStatus: "unreachable" });
    expect(rejected.registry.snapshot()).not.toHaveProperty("hosts");
    rejected.bridge.listing = new Error("socket refused");
    await rejected.federation.poll();
    const down = parseSessionListResponse(JSON.parse(JSON.stringify(rejected.registry.snapshot())));
    expect(down).toMatchObject({ sessions: [], hosts: [], fleetStatus: "unreachable" });
    expect(JSON.stringify(down)).not.toMatch(/capability|token|https:|#room/u);
    const repeated = rejected.registry.revision;
    await rejected.federation.poll();
    expect(rejected.registry.revision).toBe(repeated);

    const healthy = fixture();
    healthy.bridge.listing = { hosts: [] };
    await healthy.federation.poll();
    const empty = parseSessionListResponse(JSON.parse(JSON.stringify(healthy.registry.snapshot())));
    expect(empty).toMatchObject({ sessions: [], hosts: [], fleetStatus: "ok" });
    expect(empty.fleetStatus).not.toBe(down.fleetStatus);

    const outage = fixture();
    outage.bridge.listing = { hosts: [host("mac", [session({ state: "working" })])] };
    await outage.federation.poll();
    outage.bridge.listing = new Error("socket refused");
    outage.clock.advance(3_000);
    await outage.federation.poll();
    const retained = parseSessionListResponse(JSON.parse(JSON.stringify(outage.registry.snapshot())));
    expect(retained.fleetStatus).toBe("unreachable");
    expect(retained.hosts?.[0]).toMatchObject({ host: "mac", status: "stale", error: "gateway bridge unavailable" });
    expect(retained.sessions[0]).toMatchObject({
      host: "mac",
      originalInstanceId: "native-instance-1",
      available: false,
      canControl: false,
      hostStatus: "stale",
    });
    expect(retained.sessions[0]).not.toHaveProperty("busy");
    expect(JSON.stringify(retained)).not.toMatch(/capability|token|https:|#room/u);
    const id = fleetInstanceId("mac", "native-instance-1");
    expect((await outage.federation.resolve({ instanceId: id, generation: 1, mode: "control" })).status).toBe("missing");
    expect(outage.bridge.opens).toEqual([]);
  });

  test("a stale reading never raises a stop, and its return does not either", async () => {
    const { clock, registry, bridge, federation } = fixture();
    const stops: unknown[] = [];
    registry.subscribeActivityStops(event => stops.push(event));
    bridge.listing = { hosts: [host("mac", [session({ state: "working" })])] };
    await federation.poll();
    bridge.listing = { hosts: [host("mac", [session({ state: "idle" })], "stale")] };
    clock.advance(3_000);
    await federation.poll();
    bridge.listing = { hosts: [host("mac", [session({ state: "idle" })])] };
    clock.advance(3_000);
    await federation.poll();
    expect(stops).toEqual([]);
    // A genuine edge on a live machine still counts.
    bridge.listing = { hosts: [host("mac", [session({ state: "working" })])] };
    await federation.poll();
    bridge.listing = { hosts: [host("mac", [session({ state: "idle" })])] };
    await federation.poll();
    expect(stops).toHaveLength(1);
  });

  test.each([
    ["generation advances", (bridge: FakeBridge) => { bridge.listing = { hosts: [host("mac", [session({ generation: 2 })])] }; }, "generation_mismatch"],
    ["machine goes stale", (bridge: FakeBridge) => { bridge.listing = { hosts: [host("mac", [session()], "stale")] }; }, "missing"],
    ["bridge drops", (bridge: FakeBridge) => { bridge.listing = new Error("down"); }, "missing"],
    ["session ends", (bridge: FakeBridge) => { bridge.listing = { hosts: [host("mac", [])] }; }, "missing"],
  ] as const)("a link is withheld when the %s during open", async (_label, change, status) => {
    const { bridge, federation } = fixture();
    bridge.listing = { hosts: [host("mac", [session()])] };
    await federation.poll();
    bridge.duringOpen = async () => {
      change(bridge);
      await federation.poll();
    };
    const result = await federation.resolve({ instanceId: fleetInstanceId("mac", "native-instance-1"), generation: 1, mode: "control" });
    expect(result).toEqual({ status });
  });

  test("a stale-generation refusal from the bridge reads as a generation mismatch", async () => {
    const { bridge, federation } = fixture();
    bridge.listing = { hosts: [host("mac", [session()])] };
    await federation.poll();
    bridge.outcome = { ok: false, error: "stale-generation" };
    const id = fleetInstanceId("mac", "native-instance-1");
    expect(await federation.resolve({ instanceId: id, generation: 1, mode: "control" })).toEqual({ status: "generation_mismatch" });
  });

  test("host summary snapshots pass the browser parser and only material changes spend a revision", async () => {
    const { clock, registry, bridge, federation } = fixture();
    const events: SessionEvent[] = [];
    registry.subscribe(event => events.push(parseSessionEvent(JSON.parse(JSON.stringify(event)))));
    bridge.listing = { hosts: [host("mac", [])] };
    await federation.poll();
    bridge.listing = { hosts: [{ ...host("mac", []), ageSeconds: 7 }] };
    clock.advance(3_000);
    await federation.poll();
    expect(events.filter(event => event.type === "snapshot")).toHaveLength(1);
    bridge.listing = { hosts: [host("mac", [], "stale")] };
    await federation.poll();
    expect(events.filter(event => event.type === "snapshot").at(-1)).toMatchObject({ hosts: [{ host: "mac", status: "stale" }] });
  });
});

describe("fleet push targets", () => {
  test("attention carries the machine-qualified id and a stale machine is never notified", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-gateway-fleet-push-"));
    const config: GatewayConfig = {
      http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://127.0.0.1:4317" },
      auth: { mode: "dev-localhost", allowedLogins: [] },
      omp: { discoveryDir: join(root, "omp"), queryTimeoutMs: 1_500 },
      registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 100 },
      paths: {
        configDir: join(root, "config"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        tokenPath: join(root, "config", "readiness-token"),
        configPath: join(root, "config", "config.json"),
      },
    };
    const payloads: string[] = [];
    const transport: PushTransport = { async send(_subscription, payload) { payloads.push(payload); } };
    const { bridge, registry, federation } = fixture();
    const service = await PushService.open({ config, registry, transport });
    await service.subscribe("dev-localhost", {
      version: PUSH_API_VERSION,
      detailLevel: "private",
      subscription: { endpoint: "https://push.example.test/send/1", expirationTime: null, keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) } },
    });
    bridge.listing = { hosts: [host("mac", [session({ state: "needs-input" })], "stale"), host("gapicore", [session({ state: "needs-input" })])] };
    await federation.poll();
    await service.flush();
    const attention = payloads.map(payload => parseAttentionPushMessage(JSON.parse(payload))).filter(message => message.type === "attention");
    expect(attention.map(message => message.instanceId)).toEqual([fleetInstanceId("gapicore", "native-instance-1")]);
    await service.stop();
  });
});

describe("fleet bridge client", () => {
  async function client(reply: () => Response): Promise<{ bridge: FleetBridgeClient; requests: Request[] }> {
    const root = await mkdtemp(join(tmpdir(), "omp-gateway-bridge-"));
    const tokenFile = join(root, "bridge.key");
    await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    const requests: Request[] = [];
    const fakeFetch: BridgeFetch = async (input, init) => {
      requests.push(new Request(input, init));
      return reply();
    };
    // A real socket path is checked with lstat; point it at a bound Unix socket.
    const socketPath = join(root, "hub.sock");
    const server = Bun.listen({ unix: socketPath, socket: { data() {} } });
    process.once("beforeExit", () => server.stop(true));
    return { bridge: new FleetBridgeClient({ socketPath, tokenFile, fetch: fakeFetch }), requests };
  }

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  test.each([
    ["redirecting link", { url: `https://evil.example/#room.${"k".repeat(64)}` }],
    ["query string", { url: `https://my.omp.sh/?x=1#room.${"k".repeat(64)}` }],
    ["short key", { url: "https://my.omp.sh/#room.short" }],
    ["extra key", { url: CONTROL_URL, access: "control" }],
    ["unknown error", { error: "nope" }],
  ])("a %s fails closed", async (_label, body) => {
    const { bridge } = await client(() => json(200, body));
    expect(await bridge.open({ host: "mac", instanceId: "native-instance-1", generation: 1 })).toEqual({
      ok: false,
      error: "invalid-link",
    });
  });

  test("a link paired with an error status is refused", async () => {
    const { bridge } = await client(() => json(503, { url: CONTROL_URL }));
    expect((await bridge.open({ host: "mac", instanceId: "native-instance-1", generation: 1 })).ok).toBe(false);
  });

  test("a well-formed control link is wrapped and the bearer goes only in the header", async () => {
    const { bridge, requests } = await client(() => json(200, { url: CONTROL_URL }));
    const outcome = await bridge.open({ host: "mac", instanceId: "native-instance-1", generation: 1 });
    if (!outcome.ok) throw new Error("expected a link");
    expect(outcome.capability.reveal()).toBe(CONTROL_URL);
    expect(requests[0]?.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(await requests[0]?.json()).toEqual({ host: "mac", instanceId: "native-instance-1", generation: 1 });
  });

  test.each([
    ["non-JSON listing", () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })],
    ["unknown listing key", () => json(200, { hosts: [], extra: true })],
    ["duplicate machine", () => json(200, { hosts: [host("mac", []), host("mac", [])] })],
    ["duplicate native id on one machine", () => json(200, { hosts: [host("mac", [session(), session()])] })],
    ["zero generation", () => json(200, { hosts: [host("mac", [session({ generation: 0 })])] })],
    ["oversized listing", () => new Response("x".repeat(2 * 1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } })],
    ["refused token", () => json(401, { error: "token-refused" })],
  ])("a %s fails the poll", async (_label, reply) => {
    const { bridge } = await client(reply);
    await expect(bridge.sessions()).rejects.toThrow();
  });
});

describe("bridge token file", () => {
  test("refuses a group-readable file and a symlink without echoing the token", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-gateway-token-"));
    const path = join(root, "bridge.key");
    await writeFile(path, `${TOKEN}\n`, { mode: 0o600 });
    expect(await readBridgeToken(path)).toBe(TOKEN);
    await chmod(path, 0o640);
    const loose = await readBridgeToken(path).catch((error: Error) => error.message);
    expect(loose).not.toContain("CANARY");
    await expect(readBridgeToken(path)).rejects.toThrow();
    await chmod(path, 0o600);
    const link = join(root, "link.key");
    await symlink(path, link);
    await expect(readBridgeToken(link)).rejects.toThrow();
  });
});
