import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  fleetHostSummary,
  observedSessionFromFleet,
  parseBoundedJson,
  parseFleetBridgeSnapshot,
  parseFleetLinkOutcome,
  type FleetBridgeSnapshot,
  type FleetHostSummary,
  type FleetLinkOutcome,
  type LaunchMode,
  type ObservedSessionInput,
} from "@omp-session-gateway/protocol";
import type { FederationConfig } from "./config.ts";
import type { LaunchBroker } from "./http.ts";
import type { LaunchResolution } from "./omp-registry.ts";
import type { SessionRegistry } from "./registry.ts";
import { isWriteOperation, type WorkspaceRequest } from "./workspace.ts";

/** Room for every machine at the hub's 200-session cap, with headroom; anything larger is refused. */
export const MAX_FLEET_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_FILE_BYTES = 4_096;
const TOKEN_PATTERN = /^[\x21-\x7e]{16,1024}$/u;
/** The bridge talks over a Unix socket; the host part is fixed and never routed anywhere. */
const BRIDGE_ORIGIN = "http://localhost";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
/** The hub waits up to 15 s on the owning machine for a link; leave room for its answer. */
const DEFAULT_OPEN_TIMEOUT_MS = 20_000;
const BRIDGE_UNAVAILABLE = "gateway bridge unavailable";

/**
 * The directory identity of one fleet session: SHA-256(host + "\0" + native OMP instance id),
 * lowercase hex. Two machines running the same native id get two cards; it names a session, it
 * authorizes nothing.
 */
export function fleetInstanceId(host: string, nativeInstanceId: string): string {
  return createHash("sha256").update(`${host}\0${nativeInstanceId}`, "utf8").digest("hex");
}

/**
 * Reads the bridge bearer per request, so a rotated token takes effect without a restart. The file
 * must be a regular, owner-only file of this user, opened without following a link and confirmed
 * to be the very inode that was checked. The token never appears in an error or a log.
 */
export async function readBridgeToken(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("unsafe federation token file");
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const file = await open(path, flags);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) {
      throw new Error("changed federation token file");
    }
    if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) {
      throw new Error("unsafe federation token file permissions");
    }
    if (info.size === 0 || info.size > MAX_TOKEN_FILE_BYTES) throw new Error("federation token file has an invalid size");
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await file.read(buffer, 0, info.size, 0);
    const token = buffer.subarray(0, bytesRead).toString("utf8").trim();
    buffer.fill(0);
    if (!TOKEN_PATTERN.test(token)) throw new Error("federation token file is malformed");
    return token;
  } finally {
    await file.close();
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("oversized bridge response");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("oversized bridge response");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type BridgeFetch = (input: string, init: RequestInit & { unix: string }) => Promise<Response>;

export interface FleetBridgeClientOptions {
  readonly socketPath: string;
  readonly tokenFile: string;
  readonly requestTimeoutMs?: number;
  readonly openTimeoutMs?: number;
  /** Test seam; defaults to Bun's `fetch`, which speaks HTTP over the Unix socket. */
  readonly fetch?: BridgeFetch;
}

/** Native identity the bridge resolves; never the hashed directory id. */
export interface FleetOpenTarget {
  readonly host: string;
  readonly instanceId: string;
  readonly generation: number;
}

/**
 * The HarnessOS bridge's two routes over its private socket. Every reply is bounded, typed exactly,
 * and refused on any surprise — a redirect, a non-JSON body, an unknown key — so the gateway fails
 * closed instead of guessing at a peer it cannot read.
 */
export class FleetBridgeClient {
  readonly #socketPath: string;
  readonly #tokenFile: string;
  readonly #requestTimeoutMs: number;
  readonly #openTimeoutMs: number;
  readonly #fetch: BridgeFetch;

  constructor(options: FleetBridgeClientOptions) {
    this.#socketPath = options.socketPath;
    this.#tokenFile = options.tokenFile;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.#fetch = options.fetch ?? (fetch as unknown as BridgeFetch);
  }

  async sessions(): Promise<FleetBridgeSnapshot> {
    const { status, body } = await this.#request("/gateway/sessions", { method: "GET" }, this.#requestTimeoutMs);
    if (status !== 200) throw new Error("bridge refused the session listing");
    return parseFleetBridgeSnapshot(body);
  }

  /**
   * Success is only a 200 carrying a control link; an error outcome is only a non-2xx carrying
   * `{error}`. Any other pairing is a peer fault and surfaces as `unavailable`, never as a link.
   */
  async open(target: FleetOpenTarget): Promise<FleetLinkOutcome> {
    let reply: { status: number; body: unknown };
    try {
      reply = await this.#request(
        "/gateway/open",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ host: target.host, instanceId: target.instanceId, generation: target.generation }),
        },
        this.#openTimeoutMs,
      );
    } catch {
      return { ok: false, error: "unavailable" };
    }
    let outcome: FleetLinkOutcome;
    try {
      outcome = parseFleetLinkOutcome(reply.body);
    } catch {
      return { ok: false, error: "invalid-link" };
    }
    if (outcome.ok !== (reply.status === 200)) return { ok: false, error: "invalid-link" };
    return outcome;
  }

  async workspace(request: WorkspaceRequest): Promise<{ status: number; body: unknown }> {
    return this.#request("/gateway/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }, isWriteOperation(request.operation) ? 35_000 : 20_000);
  }

  async #request(
    path: "/gateway/sessions" | "/gateway/open" | "/gateway/workspace",
    init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string },
    timeoutMs: number,
  ): Promise<{ status: number; body: unknown }> {
    const socket = await lstat(this.#socketPath);
    if (!socket.isSocket()) throw new Error("federation socket is not a socket");
    const token = await readBridgeToken(this.#tokenFile);
    const response = await this.#fetch(`${BRIDGE_ORIGIN}${path}`, {
      ...init,
      headers: { ...init.headers, Accept: "application/json", Authorization: `Bearer ${token}` },
      unix: this.#socketPath,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("bridge reply is not JSON");
    }
    const bytes = await readBoundedResponse(response, MAX_FLEET_RESPONSE_BYTES);
    return { status: response.status, body: parseBoundedJson(bytes, MAX_FLEET_RESPONSE_BYTES) };
  }
}

/** The bridge-facing half `FleetFederation` needs; `FleetBridgeClient` is the real one. */
export interface FleetBridge {
  sessions(): Promise<FleetBridgeSnapshot>;
  open(target: FleetOpenTarget): Promise<FleetLinkOutcome>;
}

export interface FleetFederationOptions {
  readonly registry: SessionRegistry;
  readonly bridge: FleetBridge;
  readonly pollSeconds: number;
  readonly onEvent?: (event: string, detail: Readonly<Record<string, number | boolean>>) => void;
  /** Test seam for freshness; defaults to `performance.now()`. */
  readonly monotonicNowMs?: () => number;
  /** False leaves the first poll and the interval to the caller (tests drive `poll()`). */
  readonly autoStart?: boolean;
}

interface HostReading {
  readonly summary: FleetHostSummary;
  readonly capturedAtMs: number;
}

/**
 * Fleet directory source plus its launch broker. One poll lists every machine through the bridge
 * and reconciles the registry with it; a failed poll keeps every card but turns it unavailable and
 * marks every machine stale, so a bridge outage never reads as a fleet of finished sessions and
 * never leaves an old reading launchable. Rounds never overlap: a caller arriving mid-round joins it.
 */
export class FleetFederation implements LaunchBroker {
  readonly #registry: SessionRegistry;
  readonly #bridge: FleetBridge;
  readonly #intervalMs: number;
  readonly #onEvent: NonNullable<FleetFederationOptions["onEvent"]>;
  readonly #now: () => number;
  #hosts = new Map<string, HostReading>();
  #lastSuccessMs: number | undefined;
  #healthy = false;
  #inFlight: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;

  constructor(options: FleetFederationOptions) {
    if (!Number.isSafeInteger(options.pollSeconds) || options.pollSeconds < 1) throw new Error("invalid fleet poll interval");
    this.#registry = options.registry;
    this.#bridge = options.bridge;
    this.#intervalMs = options.pollSeconds * 1_000;
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#now = options.monotonicNowMs ?? (() => performance.now());
    // Pending until a listing succeeds, so an empty directory is not a healthy fleet.
    this.#registry.setFleetStatus("unreachable");
    if (options.autoStart !== false) this.start();
  }

  /** True only while the last poll read a valid fleet listing; readiness follows it. */
  get healthy(): boolean {
    return this.#healthy;
  }

  start(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.poll(), this.#intervalMs);
    void this.poll();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  poll(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#inFlight ??= this.#round().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #round(): Promise<void> {
    let snapshot: FleetBridgeSnapshot;
    try {
      snapshot = await this.#bridge.sessions();
    } catch {
      if (!this.#stopped) this.#markBridgeDown();
      return;
    }
    if (this.#stopped) return;
    const capturedAtMs = this.#now();
    const observed: ObservedSessionInput[] = [];
    let skipped = 0;
    for (const host of snapshot.hosts) {
      for (const session of host.sessions) {
        const input = observedSessionFromFleet(host, session, fleetInstanceId(host.host, session.instanceId));
        if (input === undefined) skipped += 1;
        else observed.push(input);
      }
    }
    const result = this.#registry.reconcile({ observed, retained: new Set() });
    this.#hosts = new Map(snapshot.hosts.map(host => [host.host, { summary: fleetHostSummary(host), capturedAtMs }]));
    this.#registry.setHosts([...this.#hosts.values()].map(reading => reading.summary), "ok");
    this.#lastSuccessMs = capturedAtMs;
    this.#healthy = true;
    if (result.inserted > 0 || result.removed > 0 || skipped > 0) {
      this.#onEvent("fleet.directory_changed", {
        inserted: result.inserted,
        removed: result.removed,
        skipped,
        hosts: snapshot.hosts.length,
      });
    }
  }

  /**
   * Keeps the last cards on screen but unlaunchable, and ages every machine's reading by the time
   * since it was captured. Never refreshes liveness: the registry TTL still retires a card the
   * bridge stops vouching for.
   */
  #markBridgeDown(): void {
    const wasHealthy = this.#healthy;
    this.#healthy = false;
    const retained = new Set(
      this.#registry.snapshot().sessions.filter(session => session.host !== undefined).map(session => session.instanceId),
    );
    this.#registry.reconcile({ observed: [], retained });
    const now = this.#now();
    this.#registry.setHosts(
      [...this.#hosts.values()].map(({ summary, capturedAtMs }) =>
        summary.status === "never"
          ? { ...summary, error: BRIDGE_UNAVAILABLE }
          : {
              host: summary.host,
              status: "stale" as const,
              ageSeconds: (summary.ageSeconds ?? 0) + Math.max(0, Math.floor((now - capturedAtMs) / 1_000)),
              error: BRIDGE_UNAVAILABLE,
            },
      ),
      "unreachable",
    );
    if (wasHealthy) this.#onEvent("fleet.poll_failed", { retained: retained.size });
  }

  /**
   * Brokers one Control launch. The registry must show the exact card — identity, generation,
   * request, availability — before the bridge is asked, the federation's own reading of that
   * machine must still be live and recent, and the registry must still show it after the link
   * comes back. View is refused outright: the bridge brokers Control only, and returning a Control
   * link for a View request would hand out more than was asked for. Nothing is cached.
   */
  async resolve(request: {
    readonly instanceId: string;
    readonly generation: number;
    readonly mode: LaunchMode;
    readonly requestId?: string;
  }): Promise<LaunchResolution> {
    const before = this.#authorize(request);
    if (before.status !== "ok") return before;
    const { host, originalInstanceId } = before;
    const outcome = await this.#bridge.open({ host, instanceId: originalInstanceId, generation: request.generation });
    if (!outcome.ok) {
      if (outcome.error === "stale-generation") return { status: "generation_mismatch" };
      return { status: "missing" };
    }
    const after = this.#authorize(request);
    if (after.status !== "ok") return after;
    if (after.host !== host || after.originalInstanceId !== originalInstanceId) return { status: "missing" };
    return { status: "ok", capability: outcome.capability };
  }

  #authorize(request: {
    readonly instanceId: string;
    readonly generation: number;
    readonly mode: LaunchMode;
    readonly requestId?: string;
  }):
    | { readonly status: "ok"; readonly host: string; readonly originalInstanceId: string }
    | Exclude<LaunchResolution, { readonly status: "ok" }> {
    const authorized = this.#registry.authorizeLaunch(
      request.instanceId,
      request.generation,
      request.mode,
      request.requestId,
    );
    if (authorized.status !== "ok") return { status: authorized.status };
    if (request.mode !== "control") return { status: "mode_unavailable" };
    const { session } = authorized;
    if (
      session.host === undefined ||
      session.originalInstanceId === undefined ||
      session.available !== true ||
      session.hostStatus !== "live" ||
      fleetInstanceId(session.host, session.originalInstanceId) !== request.instanceId
    ) {
      return { status: "missing" };
    }
    // The registry is only as current as the last poll; a machine is launchable only while the
    // federation itself read it live within two intervals plus one listing timeout.
    const reading = this.#hosts.get(session.host);
    const lastSuccess = this.#lastSuccessMs;
    if (
      !this.#healthy ||
      reading?.summary.status !== "live" ||
      lastSuccess === undefined ||
      this.#now() - lastSuccess > this.#intervalMs * 2 + DEFAULT_REQUEST_TIMEOUT_MS
    ) {
      return { status: "missing" };
    }
    return { status: "ok", host: session.host, originalInstanceId: session.originalInstanceId };
  }
}

/** Boot factory: the fleet source and launch broker for one gateway, started immediately. */
export function startFleetFederation(options: {
  readonly federation: FederationConfig;
  readonly registry: SessionRegistry;
  readonly onEvent?: FleetFederationOptions["onEvent"];
}): FleetFederation {
  return new FleetFederation({
    registry: options.registry,
    bridge: new FleetBridgeClient({
      socketPath: options.federation.socketPath,
      tokenFile: options.federation.tokenFile,
    }),
    pollSeconds: options.federation.pollSeconds,
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
}
