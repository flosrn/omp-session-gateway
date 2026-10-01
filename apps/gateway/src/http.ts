import { createHmac } from "node:crypto";
import {
  INSTANCE_ID_PATTERN,
  MAX_FRAME_BYTES,
  MAX_PUSH_SUBSCRIPTION_BYTES,
  PUSH_API_VERSION,
  ProtocolValidationError,
  type LaunchMode,
  type SessionEvent,
  parseJsonFrame,
  parseLaunchRequest,
  parseNotificationRoute,
  parsePushSubscriptionRequest,
  parsePushUnsubscribeRequest,
} from "@omp-session-gateway/protocol";
import { createCloudflareAccessVerifier, type CloudflareAccessVerifier } from "./access.ts";
import { authorizeHttpRequest, isLoopbackAddress, requestHasValidMutationContext, type AuthorizationResult, type RequestPeer } from "./auth.ts";
import { createTailnetPresenceProbe } from "./tailnet.ts";
import type { GatewayConfig } from "./config.ts";
import { SafeLogger } from "./logger.ts";
import { SessionRegistry } from "./registry.ts";
import type { PushService } from "./push.ts";

import { StaticAssetStore } from "./static.ts";
import type { LaunchResolution } from "./omp-registry.ts";

/**
 * The launch side of the OMP reader, narrowed to what HTTP needs. Keeping it an interface means the
 * handler tests drive refusals without a live host, and the daemon binds the real socket client.
 */
export interface LaunchBroker {
  resolve(request: {
    readonly instanceId: string;
    readonly generation: number;
    readonly mode: LaunchMode;
    readonly requestId?: string;
  }): Promise<LaunchResolution>;
}

const API_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' wss://my.omp.sh; manifest-src 'self'; worker-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
};

interface RateBucket {
  count: number;
  resetAt: number;
}

class LaunchRateLimiter {
  readonly #buckets = new Map<string, RateBucket>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxBuckets: number;

  constructor(limit = 20, windowMs = 60_000, maxBuckets = 2_000) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#maxBuckets = maxBuckets;
  }

  allow(key: string, now = Date.now()): boolean {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      if (this.#buckets.size >= this.#maxBuckets) {
        for (const [candidate, value] of this.#buckets) {
          if (value.resetAt <= now) this.#buckets.delete(candidate);
        }
        if (this.#buckets.size >= this.#maxBuckets) return false;
      }
      this.#buckets.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    if (bucket.count >= this.#limit) return false;
    bucket.count += 1;
    return true;
  }
}

function withSecurityHeaders(response: Response, api: boolean): Response {
  const headers = api ? { ...SECURITY_HEADERS, ...API_HEADERS } : SECURITY_HEADERS;
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

function problem(status: number, code: string, message: string): Response {
  return withSecurityHeaders(
    Response.json({ code, message }, { status, headers: { "Content-Type": "application/problem+json" } }),
    true,
  );
}
function authenticationRefusal(
  mode: GatewayConfig["auth"]["mode"],
  reason: Extract<AuthorizationResult, { allowed: false }>["reason"],
  peer: RequestPeer | undefined,
): Response {
  if (mode !== "cloudflare-access") return problem(403, "forbidden", "Forbidden");
  if (reason === "keys_unavailable") return problem(503, "retry_later", "Try again shortly");
  // Missing, invalid, or expired assertions are the only Access refusals a new sign-in can fix.
  // A non-loopback peer shares the `unauthorized` reason with those, but it is not one of them.
  if (reason === "unauthorized" && peer !== undefined && isLoopbackAddress(peer.address)) {
    return problem(401, "authentication_required", "Sign in again");
  }
  return problem(403, "forbidden", "Forbidden");
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new ProtocolValidationError();
  }
  if (request.body === null) throw new ProtocolValidationError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) throw new ProtocolValidationError();
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const SSE_KEEPALIVE_MS = 5_000;

/**
 * @param stillAuthorized re-read on every keepalive. Authorization for this endpoint would otherwise
 * be evaluated once and never again, so a stream admitted while identity trust was sound would keep
 * delivering the session directory after the topology stopped justifying it, or after the Access
 * token that admitted it expired. The keepalive is already the stream's liveness tick, so this adds
 * a check rather than a timer. An asynchronous check is never overlapped with the next tick, and a
 * rejection counts as a refusal.
 *
 * Admission goes through `subscribeWithSnapshot` so the snapshot and the live subscription are one
 * step: a revision landing mid-handshake is replayed in order rather than lost, and teardown is
 * reachable from the first frame onward instead of only after the subscription is assigned.
 */
function eventStream(
  registry: SessionRegistry,
  keepaliveMs = SSE_KEEPALIVE_MS,
  stillAuthorized: () => boolean | Promise<boolean> = () => true,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let checking = false;
  const release = (): void => {
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    clearInterval(keepalive);
    keepalive = undefined;
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const close = (): void => {
          release();
          try {
            controller.close();
          } catch {
            // The peer may have errored the stream before Bun delivered cancel().
          }
        };
        const send = (event: SessionEvent): void => {
          if (closed) return;
          if ((controller.desiredSize ?? 1) < -32) {
            close();
            return;
          }
          try {
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          } catch {
            release();
          }
        };
        const tick = (authorized: boolean): void => {
          if (closed) return;
          if (!authorized) {
            close();
            return;
          }
          if ((controller.desiredSize ?? 1) < -32) {
            close();
            return;
          }
          try {
            controller.enqueue(encoder.encode("event: keepalive\ndata: {}\n\n"));
          } catch {
            release();
          }
        };
        const dispose = registry.subscribeWithSnapshot(send);
        // A stream abandoned during admission has no subscription handle to revoke yet, so revoke the
        // one admission just returned instead of leaving the listener attached to the registry.
        if (closed) {
          dispose();
          return;
        }
        unsubscribe = dispose;
        keepalive = setInterval(() => {
          if (closed || checking) return;
          let verdict: boolean | Promise<boolean>;
          try {
            verdict = stillAuthorized();
          } catch {
            close();
            return;
          }
          if (typeof verdict === "boolean") {
            tick(verdict);
            return;
          }
          checking = true;
          verdict.then(
            authorized => {
              checking = false;
              tick(authorized);
            },
            () => {
              checking = false;
              tick(false);
            },
          );
        }, keepaliveMs);
      },
      cancel() {
        release();
      },
    },
    { highWaterMark: 32 },
  );
  return withSecurityHeaders(
    new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    }),
    true,
  );
}
export function createHttpHandler(options: {
  readonly config: GatewayConfig;
  readonly registry: SessionRegistry;
  /** Brokers one capability per explicit launch, straight from the owning OMP host. */
  readonly launchResolver: LaunchBroker;
  readonly staticAssets: StaticAssetStore;
  readonly pushService?: PushService;
  readonly logger?: SafeLogger;
  readonly readinessToken?: string;
  readonly readinessInstance?: string;
  readonly sseKeepaliveMs?: number;
  /** Supplies wall-clock time for deterministic rate-window enforcement. */
  readonly now?: () => number;
  /**
   * Reports whether OMP's collaboration discovery directory is still readable. A daemon whose
   * discovery root turned into a symlink or another user's directory keeps serving HTTP while no
   * session can ever appear, so readiness must reflect discovery rather than process liveness.
   */
  readonly endpointHealthy?: () => boolean;
  /**
   * Whether Tailscale Serve is still the only path to this loopback listener, i.e. tailscaled owns a
   * TUN device. Injectable so tests can drive both topologies; the default measures the host.
   */
  readonly tailnetPresent?: () => boolean;
  /**
   * Verifies Cloudflare Access application tokens in `cloudflare-access` mode. Absent means the
   * handler builds one from `config.auth.cloudflareAccess`, fetching keys from that team's pinned
   * certs URL; tests inject one whose key transport is local.
   */
  readonly accessVerifier?: CloudflareAccessVerifier;
}): (request: Request, peer?: RequestPeer) => Promise<Response> {
  const { config, registry, staticAssets, launchResolver } = options;
  const logger = options.logger ?? new SafeLogger();
  const identityCapacity = config.auth.mode === "dev-localhost" ? 1 : config.auth.allowedLogins.length;
  // Each admitted identity can own exactly two keys (`launch` and `push`), so configured identities
  // can never deny one another merely by filling the bounded map.
  const limiter = new LaunchRateLimiter(20, 60_000, Math.max(2, identityCapacity * 2));
  const now = options.now ?? Date.now;
  const tailnetPresent = options.tailnetPresent ?? createTailnetPresenceProbe();
  // Built once so the remote key set and its rotation cache are shared by every request.
  const accessSettings = config.auth.cloudflareAccess;
  const accessVerifier =
    config.auth.mode !== "cloudflare-access"
      ? undefined
      : (options.accessVerifier ??
        (accessSettings === undefined ? undefined : createCloudflareAccessVerifier({ ...accessSettings, now })));
  // `tailscale-serve` mode trusts an identity header from any loopback peer, which is only sound
  // while Serve is the sole way in. Configuration may declare that no tailnet reaches this host at
  // all, which is how a loopback-only harness exercises the production identity path with no
  // Tailscale installed; on a host running userspace-mode tailscaled that declaration is false and
  // re-opens #98, so `doctor` reports it rather than letting it pass silently.
  const identityTrustDeclared = config.auth.trustIdentityWithoutTailnetDevice === true;
  if (identityTrustDeclared && config.auth.mode === "tailscale-serve") {
    // Declared trust disables the measurement, so without this the daemon's logs would be
    // byte-identical to a healthy host's. Emitted once at construction so the assertion is always on
    // the record, whether or not it happens to be true.
    logger.event("warn", "http.identity_trust_declared");
  }
  // Seeded sound so a healthy daemon says nothing at startup and only a change is reported. This
  // governs logging only; authorization always uses the measured value.
  let identityTrustLogged = true;
  return async (request, peer): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return problem(400, "bad_request", "Invalid request");
    }
    const clientRoute = request.method === "GET" && url.pathname === "/client/";
    const requestBootstrap = request.method === "GET" && parseNotificationRoute(url) !== undefined;
    const updateBootstrap = request.method === "GET" && url.pathname === "/update/";
    if (url.search !== "" && !requestBootstrap) {
      return problem(400, "bad_request", "Query parameters are not accepted");
    }


    if (url.pathname === "/api/v1/health" && request.method === "GET") {
      if (peer === undefined || !isLoopbackAddress(peer.address)) {
        return problem(403, "forbidden", "Forbidden");
      }
      // Behind a tunnel every public request is a loopback peer too. Readiness proofs are for the
      // local CLI only, and a tunnel inserts these headers itself, so their presence marks a request
      // that came from outside this host.
      if (
        config.auth.mode === "cloudflare-access" &&
        ["Cf-Ray", "Cf-Connecting-Ip", "Cf-Access-Jwt-Assertion", "Cf-Visitor", "X-Forwarded-For"].some(
          header => request.headers.get(header) !== null,
        )
      ) {
        return problem(403, "forbidden", "Forbidden");
      }
      const status = options.endpointHealthy?.() === false ? "degraded" : "ready";
      const challenge = request.headers.get("X-OMP-Readiness-Challenge");
      if (challenge === null) return withSecurityHeaders(Response.json({ status }), true);
      if (options.readinessToken === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)) {
        return problem(400, "bad_request", "Invalid readiness challenge");
      }
      const instance = options.readinessInstance ?? "";
      const proof = createHmac("sha256", options.readinessToken)
        .update(challenge)
        .update("\0")
        .update(instance)
        .digest("base64url");
      return withSecurityHeaders(
        Response.json({ status, proof, ...(instance === "" ? {} : { instance }) }),
        true,
      );
    }

    // Only `tailscale-serve` mode believes an identity header, so only it pays for the measurement.
    let serveOwnsIdentityHeaders = true;
    if (config.auth.mode === "tailscale-serve") {
      serveOwnsIdentityHeaders = identityTrustDeclared || tailnetPresent();
      if (serveOwnsIdentityHeaders !== identityTrustLogged) {
        identityTrustLogged = serveOwnsIdentityHeaders;
        // Logged on transition, not per request: this is one property of the host, and a per-request
        // line would be unbounded noise for a single operator-visible fact.
        logger.event(
          serveOwnsIdentityHeaders ? "info" : "error",
          serveOwnsIdentityHeaders ? "http.identity_trust_restored" : "http.identity_trust_unsound",
        );
      }
    }
    const authorization = await authorizeHttpRequest(request, peer, config, serveOwnsIdentityHeaders, accessVerifier);
    if (!authorization.allowed) {
      logger.event("warn", "http.authorization_denied", {
        identity_untrustworthy: authorization.reason === "identity_untrustworthy",
        keys_unavailable: authorization.reason === "keys_unavailable",
      });
      return authenticationRefusal(config.auth.mode, authorization.reason, peer);
    }
    if (url.pathname === "/api/v1/sessions" && request.method === "GET") {
      return withSecurityHeaders(Response.json(registry.snapshot()), true);
    }
    if (url.pathname === "/api/v1/events" && request.method === "GET") {
      // Re-checked per keepalive: an admitted stream must not outlive the topology that justified it,
      // nor the Access token that admitted it.
      const revalidate = authorization.revalidate;
      return eventStream(
        registry,
        options.sseKeepaliveMs,
        revalidate ?? (() => config.auth.mode !== "tailscale-serve" || identityTrustDeclared || tailnetPresent()),
      );
    }
    if (url.pathname === "/api/v1/push/config" && request.method === "GET" && options.pushService !== undefined) {
      return withSecurityHeaders(Response.json(options.pushService.configResponse()), true);
    }
    if (
      url.pathname === "/api/v1/push/subscription" &&
      (request.method === "POST" || request.method === "DELETE") &&
      options.pushService !== undefined
    ) {
      if (!requestHasValidMutationContext(request, config.http.publicOrigin)) {
        return problem(403, "forbidden", "Forbidden");
      }
      if (request.headers.get("Content-Type")?.toLowerCase() !== "application/json") {
        return problem(415, "unsupported_media_type", "Expected application/json");
      }
      if (!limiter.allow(`${authorization.identityKey}\0push`, now())) {
        return problem(429, "rate_limited", "Too many requests");
      }
      let body: unknown;
      try {
        body = parseJsonFrame(await readBoundedBody(request, MAX_PUSH_SUBSCRIPTION_BYTES));
      } catch {
        return problem(400, "bad_request", "Invalid request");
      }
      if (request.method === "POST") {
        let subscriptionRequest;
        try {
          subscriptionRequest = parsePushSubscriptionRequest(body);
        } catch {
          return problem(400, "bad_request", "Invalid request");
        }
        try {
          const detailLevel = await options.pushService.subscribe(authorization.identityKey, subscriptionRequest);
          return withSecurityHeaders(
            Response.json({ version: PUSH_API_VERSION, detailLevel }),
            true,
          );
        } catch {
          return problem(409, "subscription_rejected", "Push subscription could not be saved");
        }
      } else {
        let unsubscribeRequest;
        try {
          unsubscribeRequest = parsePushUnsubscribeRequest(body);
        } catch {
          return problem(400, "bad_request", "Invalid request");
        }
        await options.pushService.unsubscribe(authorization.identityKey, unsubscribeRequest);
      }
      return withSecurityHeaders(new Response(null, { status: 204 }), true);
    }


    const launchMatch = /^\/api\/v1\/sessions\/([^/]{1,384})\/launch$/u.exec(url.pathname);
    if (launchMatch !== null && request.method === "POST") {
      const encodedInstanceId = launchMatch[1];
      if (encodedInstanceId === undefined) return problem(400, "bad_request", "Invalid request");
      let instanceId: string;
      try {
        instanceId = decodeURIComponent(encodedInstanceId);
      } catch {
        return problem(400, "bad_request", "Invalid request");
      }
      if (!INSTANCE_ID_PATTERN.test(instanceId)) {
        return problem(400, "bad_request", "Invalid request");
      }
      if (!requestHasValidMutationContext(request, config.http.publicOrigin)) {
        return problem(403, "forbidden", "Forbidden");
      }
      if (request.headers.get("Content-Type")?.toLowerCase() !== "application/json") {
        return problem(415, "unsupported_media_type", "Expected application/json");
      }
      let launchRequest;
      try {
        const body = await readBoundedBody(request, Math.min(MAX_FRAME_BYTES, 4_096));
        launchRequest = parseLaunchRequest(parseJsonFrame(body));
      } catch {
        return problem(400, "bad_request", "Invalid request");
      }
      if (!limiter.allow(`${authorization.identityKey}\0launch`, now())) {
        return problem(429, "rate_limited", "Too many requests");
      }
      const resolution = await launchResolver.resolve({
        instanceId,
        generation: launchRequest.generation,
        mode: launchRequest.mode,
        ...(launchRequest.requestId === undefined ? {} : { requestId: launchRequest.requestId }),
      });
      if (resolution.status === "generation_mismatch") {
        return problem(409, "generation_mismatch", "Session changed; refresh and try again");
      }
      if (resolution.status === "request_mismatch") {
        return problem(409, "request_mismatch", "Request changed; refresh and try again");
      }
      if (resolution.status === "mode_unavailable") {
        return problem(409, "mode_unavailable", "Session no longer shares that access; refresh and try again");
      }
      if (resolution.status !== "ok") return problem(404, "not_found", "Session unavailable");
      // The broker may have waited past the admitting token's expiry. Refuse before the capability
      // is revealed; the refusal body must not contain it.
      if (authorization.revalidate !== undefined) {
        let stillAdmitted = false;
        try {
          stillAdmitted = await authorization.revalidate();
        } catch {
          stillAdmitted = false;
        }
        if (!stillAdmitted) return problem(401, "authentication_required", "Sign in again");
      }
      const response = Response.json({
        mode: launchRequest.mode,
        generation: launchRequest.generation,
        capability: resolution.capability.reveal(),
      });
      return withSecurityHeaders(response, true);
    }

    if (url.pathname.startsWith("/api/")) return problem(404, "not_found", "Not found");
    const staticResponse = staticAssets.response(
      clientRoute || requestBootstrap || updateBootstrap ? "/" : url.pathname,
    );
    return withSecurityHeaders(
      staticResponse ?? new Response("Not found", { status: 404 }),
      clientRoute || requestBootstrap || updateBootstrap,
    );
  };
}

export function startHttpServer(options: {
  readonly config: GatewayConfig;
  readonly registry: SessionRegistry;
  readonly launchResolver: LaunchBroker;
  readonly staticAssets: StaticAssetStore;
  readonly pushService?: PushService;
  readonly logger?: SafeLogger;
  readonly readinessToken: string;
  readonly readinessInstance?: string;
  readonly endpointHealthy?: () => boolean;
}): Bun.Server<undefined> {
  const handler = createHttpHandler(options);
  const server = Bun.serve({
    hostname: options.config.http.hostname,
    port: options.config.http.port,
    // Must exceed the five-second SSE keepalive interval or Bun repeatedly closes event streams.
    idleTimeout: 30,
    fetch(request, bunServer) {
      const address = bunServer.requestIP(request)?.address;
      return handler(request, address === undefined ? undefined : { address });
    },
  });
  options.logger?.event("info", "http.listening", { port: server.port ?? options.config.http.port });
  return server;
}
