import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { SecretCapability } from "@omp-session-gateway/protocol";
import { AccessKeysUnavailable, createCloudflareAccessVerifier, type CloudflareAccessVerifier } from "../src/access.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHttpHandler, type LaunchBroker } from "../src/http.ts";
import { SafeLogger } from "../src/logger.ts";
import { SessionRegistry } from "../src/registry.ts";
import { StaticAssetStore } from "../src/static.ts";

const TEAM = "https://team.cloudflareaccess.com";
const AUDIENCE = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
const ORIGIN = "https://sessions.example.com";
const peer = { address: "127.0.0.1" } as const;

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JWK;
}

async function signingKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" } };
}

/** A clock and a JWKS endpoint the test controls, behind the verifier's real remote key-set cache. */
function fixture(initialKeys: readonly SigningKey[]) {
  const state = { nowMs: Date.UTC(2026, 9, 1, 12), keys: [...initialKeys], fetched: [] as string[] };
  const verifier = createCloudflareAccessVerifier({
    teamDomain: TEAM,
    audience: AUDIENCE,
    now: () => state.nowMs,
    cooldownMs: 0,
    fetch: async url => {
      state.fetched.push(url);
      return Response.json({ keys: state.keys.map(key => key.jwk) });
    },
  });
  return { state, verifier };
}

async function token(
  key: SigningKey,
  nowMs: number,
  claims: JWTPayload & Record<string, unknown> = {},
  omit: readonly string[] = [],
  header: Record<string, unknown> = {},
): Promise<string> {
  const nowSeconds = Math.floor(nowMs / 1_000);
  const payload: Record<string, unknown> = {
    aud: [AUDIENCE],
    email: "user@example.com",
    exp: nowSeconds + 60,
    iat: nowSeconds,
    nbf: nowSeconds,
    iss: TEAM,
    type: "app",
    identity_nonce: "nonce",
    sub: "7335d417-61da-459d-899c-0a01c76a2f94",
    country: "US",
    ...claims,
  };
  for (const claim of omit) delete payload[claim];
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT", ...header }).sign(key.privateKey);
}

let keyA: SigningKey;
let keyB: SigningKey;
let impostor: SigningKey;
let assetRoot = "";
let assets: StaticAssetStore;

beforeAll(async () => {
  [keyA, keyB] = await Promise.all([signingKey("kid-a"), signingKey("kid-b")]);
  // Same `kid` as A but a different key pair: a forger who copied the published key id.
  impostor = await signingKey("kid-a");
  assetRoot = await mkdtemp(join(tmpdir(), "gateway-access-assets-"));
  await writeFile(join(assetRoot, "index.html"), "<!doctype html><title>OMP Sessions</title>");
  assets = await StaticAssetStore.load(assetRoot);
});

afterAll(async () => {
  await rm(assetRoot, { recursive: true, force: true });
});

describe("Cloudflare Access token verification", () => {
  test("accepts a signed app token and fetches keys only from the pinned team certs URL", async () => {
    const { state, verifier } = fixture([keyA]);
    const identity = await verifier.verify(await token(keyA, state.nowMs));
    expect(identity).toEqual({
      email: "user@example.com",
      subject: "7335d417-61da-459d-899c-0a01c76a2f94",
      expiresAtMs: (Math.floor(state.nowMs / 1_000) + 60) * 1_000,
    });
    expect(state.fetched).toEqual([`${TEAM}/cdn-cgi/access/certs`]);
  });

  test("refuses a token signed by any key the team does not publish", async () => {
    const { state, verifier } = fixture([keyA]);
    expect(await verifier.verify(await token(impostor, state.nowMs))).toBeUndefined();
    expect(await verifier.verify(await token(keyB, state.nowMs))).toBeUndefined();
  });

  test("refuses a token for another application or issuer", async () => {
    const { state, verifier } = fixture([keyA]);
    expect(await verifier.verify(await token(keyA, state.nowMs, { aud: ["f".repeat(64)] }))).toBeUndefined();
    expect(await verifier.verify(await token(keyA, state.nowMs, { iss: "https://other.cloudflareaccess.com" }))).toBeUndefined();
    expect(await verifier.verify(await token(keyA, state.nowMs, { iss: `${TEAM}/` }))).toBeUndefined();
  });

  test("enforces expiry exactly, with no clock tolerance after exp", async () => {
    const { state, verifier } = fixture([keyA]);
    const issued = await token(keyA, state.nowMs);
    const expiresAtMs = (Math.floor(state.nowMs / 1_000) + 60) * 1_000;
    state.nowMs = expiresAtMs - 1;
    expect(await verifier.verify(issued)).toBeDefined();
    state.nowMs = expiresAtMs;
    expect(await verifier.verify(issued)).toBeUndefined();
    state.nowMs = expiresAtMs + 10_000;
    expect(await verifier.verify(issued)).toBeUndefined();
  });

  test("refuses tokens not yet valid or issued in the future", async () => {
    const { state, verifier } = fixture([keyA]);
    const nowSeconds = Math.floor(state.nowMs / 1_000);
    expect(await verifier.verify(await token(keyA, state.nowMs, { nbf: nowSeconds + 120 }))).toBeUndefined();
    expect(await verifier.verify(await token(keyA, state.nowMs, { iat: nowSeconds + 120, exp: nowSeconds + 600 }))).toBeUndefined();
    // `nbf` is optional; absent, the token is judged on the others.
    expect(await verifier.verify(await token(keyA, state.nowMs, {}, ["nbf"]))).toBeDefined();
  });

  test("requires exp, iat, sub and email", async () => {
    const { state, verifier } = fixture([keyA]);
    for (const claim of ["exp", "iat", "sub", "email"]) {
      expect(await verifier.verify(await token(keyA, state.nowMs, {}, [claim]))).toBeUndefined();
    }
  });

  test("refuses service-token and org tokens: only a person's app token is identity", async () => {
    const { state, verifier } = fixture([keyA]);
    const serviceToken = await token(keyA, state.nowMs, { sub: "", common_name: "e367826f93b8d71185e03fe518aff3b4.access" }, [
      "email",
    ]);
    expect(await verifier.verify(serviceToken)).toBeUndefined();
    // Even with an email attached, a `common_name` marks a service credential.
    expect(await verifier.verify(await token(keyA, state.nowMs, { common_name: "client.access" }))).toBeUndefined();
    expect(await verifier.verify(await token(keyA, state.nowMs, { sub: "" }))).toBeUndefined();
    expect(await verifier.verify(await token(keyA, state.nowMs, { type: "org" }))).toBeUndefined();
    expect(await verifier.verify(await token(keyA, state.nowMs, {}, ["type"]))).toBeUndefined();
  });

  test("refuses unsigned, symmetric and malformed assertions", async () => {
    const { state, verifier } = fixture([keyA]);
    const valid = await token(keyA, state.nowMs);
    const [header, payload] = valid.split(".");
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "kid-a" })).toString("base64url")}.${payload}.`;
    expect(await verifier.verify(none)).toBeUndefined();
    const hs256 = await new SignJWT({ aud: [AUDIENCE], iss: TEAM, email: "user@example.com", sub: "s", type: "app" })
      .setProtectedHeader({ alg: "HS256", kid: "kid-a" })
      .setIssuedAt(Math.floor(state.nowMs / 1_000))
      .setExpirationTime(Math.floor(state.nowMs / 1_000) + 60)
      .sign(new TextEncoder().encode("a".repeat(64)));
    expect(await verifier.verify(hs256)).toBeUndefined();
    for (const malformed of ["", "a.b", `${valid}, ${valid}`, `${header}.${payload}`, `${valid}.extra`, "x".repeat(20_000)]) {
      expect(await verifier.verify(malformed)).toBeUndefined();
    }
  });

  test("follows key rotation and stops accepting a key once it leaves the published set", async () => {
    const { state, verifier } = fixture([keyA]);
    expect(await verifier.verify(await token(keyA, state.nowMs))).toBeDefined();
    // Cloudflare publishes the new key alongside the previous one.
    state.keys = [keyB, keyA];
    expect(await verifier.verify(await token(keyB, state.nowMs))).toBeDefined();
    expect(state.fetched.length).toBe(2);
    expect(await verifier.verify(await token(keyA, state.nowMs))).toBeDefined();

    // Once A is gone from the set, a refetch no longer yields it.
    const { state: later, verifier: fresh } = fixture([keyB]);
    expect(await fresh.verify(await token(keyA, later.nowMs))).toBeUndefined();
    expect(await fresh.verify(await token(keyB, later.nowMs))).toBeDefined();
  });

  test("an unreachable or failing key endpoint is key-set unavailability, not a rejected token", async () => {
    const assertion = await token(keyA, Date.now());
    const unavailable = createCloudflareAccessVerifier({
      teamDomain: TEAM,
      audience: AUDIENCE,
      fetch: async () => new Response("nope", { status: 503 }),
    });
    await expect(unavailable.verify(assertion)).rejects.toBeInstanceOf(AccessKeysUnavailable);
    const failing = createCloudflareAccessVerifier({
      teamDomain: TEAM,
      audience: AUDIENCE,
      fetch: async () => {
        throw new TypeError("network down");
      },
    });
    await expect(failing.verify(assertion)).rejects.toBeInstanceOf(AccessKeysUnavailable);
    const redirecting = createCloudflareAccessVerifier({
      teamDomain: TEAM,
      audience: AUDIENCE,
      fetch: async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/keys" } }),
    });
    await expect(redirecting.verify(assertion)).rejects.toBeInstanceOf(AccessKeysUnavailable);
    const timingOut = createCloudflareAccessVerifier({
      teamDomain: TEAM,
      audience: AUDIENCE,
      fetch: async () => {
        throw new DOMException("request timed out", "TimeoutError");
      },
    });
    await expect(timingOut.verify(assertion)).rejects.toBeInstanceOf(AccessKeysUnavailable);
  });

  test("a key fetch that outlasts the token rejects it on the current clock", async () => {
    const issuedAt = Date.UTC(2026, 9, 1, 12);
    const state = { nowMs: issuedAt };
    const verifier = createCloudflareAccessVerifier({
      teamDomain: TEAM,
      audience: AUDIENCE,
      now: () => state.nowMs,
      fetch: async () => {
        state.nowMs += 61_000;
        return Response.json({ keys: [keyA.jwk] });
      },
    });
    expect(await verifier.verify(await token(keyA, issuedAt))).toBeUndefined();
  });

  test("refuses to construct against anything but an exact cloudflareaccess.com team origin", () => {
    for (const teamDomain of ["https://evil.example", `${TEAM}/`, "http://team.cloudflareaccess.com"]) {
      expect(() => createCloudflareAccessVerifier({ teamDomain, audience: AUDIENCE })).toThrow();
    }
    expect(() => createCloudflareAccessVerifier({ teamDomain: TEAM, audience: "short" })).toThrow();
  });
});

function accessConfig(allowedLogins: readonly string[] = ["user@example.com"]): GatewayConfig {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: ORIGIN },
    auth: { mode: "cloudflare-access", allowedLogins, cloudflareAccess: { teamDomain: TEAM, audience: AUDIENCE } },
    omp: { discoveryDir: "/private/omp/run/collab-hosts", queryTimeoutMs: 1_500 },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 10 },
    paths: {
      configDir: "/private/config",
      stateDir: "/private/state",
      runtimeDir: "/private/run",
      tokenPath: "/private/config/readiness-token",
      configPath: "/private/config/config.json",
    },
  };
}

function registry(): SessionRegistry {
  const value = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
  value.reconcile({
    observed: [
      {
        instanceId: "http-instance-000001",
        generation: 3,
        pid: 1234,
        sessionId: "session-three",
        title: "Safe session",
        cwdLabel: "repository",
        model: "fixture/model",
        startedAt: "2026-07-19T00:00:00.000Z",
        inputRequired: false,
        canControl: true,
      },
    ],
    retained: new Set(),
  });
  return value;
}

function handlerFor(
  verifier: CloudflareAccessVerifier,
  options: {
    lines?: string[];
    sseKeepaliveMs?: number;
    config?: GatewayConfig;
    resolve?: LaunchBroker["resolve"];
  } = {},
) {
  const sessions = registry();
  return createHttpHandler({
    config: options.config ?? accessConfig(),
    registry: sessions,
    staticAssets: assets,
    accessVerifier: verifier,
    readinessToken: "R".repeat(43),
    ...(options.sseKeepaliveMs === undefined ? {} : { sseKeepaliveMs: options.sseKeepaliveMs }),
    ...(options.lines === undefined ? {} : { logger: new SafeLogger({ write: line => options.lines?.push(line) }) }),
    // Access mode must never consult the tailnet; a probe that throws proves it.
    tailnetPresent: () => {
      throw new Error("tailnet probed in Access mode");
    },
    launchResolver: {
      async resolve(launch) {
        if (options.resolve !== undefined) return options.resolve(launch);
        const authorization = sessions.authorizeLaunch(launch.instanceId, launch.generation, launch.mode, launch.requestId);
        if (authorization.status !== "ok") return authorization;
        return { status: "ok", capability: SecretCapability.from("ACCESS__CONTROL__CANARY__0000000000") };
      },
    },
  });
}

function request(path: string, assertion: string | undefined, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (assertion !== undefined) headers.set("Cf-Access-Jwt-Assertion", assertion);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}
function launch(assertion: string): Request {
  return request("/api/v1/sessions/http-instance-000001/launch", assertion, {
    method: "POST",
    headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "control", generation: 3 }),
  });
}

describe("Cloudflare Access HTTP admission", () => {
  test("admits a verified, allowlisted identity to the API and the static shell", async () => {
    const { state, verifier } = fixture([keyA]);
    const handler = handlerFor(verifier);
    const assertion = await token(keyA, state.nowMs, { email: " User@Example.COM " });
    const sessions = await handler(request("/api/v1/sessions", assertion), peer);
    expect(sessions.status).toBe(200);
    expect((await sessions.json()).sessions).toHaveLength(1);
    expect((await handler(request("/", assertion), peer)).status).toBe(200);
  });

  test("forged identity headers without a signed assertion are refused everywhere, shell included", async () => {
    const { verifier } = fixture([keyA]);
    const handler = handlerFor(verifier);
    const forged = {
      "Tailscale-User-Login": "user@example.com",
      "Cf-Access-Authenticated-User-Email": "user@example.com",
    };
    for (const path of ["/", "/index.html", "/api/v1/sessions", "/api/v1/events"]) {
      const response = await handler(request(path, undefined, { headers: forged }), peer);
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe("authentication_required");
    }
  });

  test("invalid signatures and expired assertions require authentication, not a retry", async () => {
    const { state, verifier } = fixture([keyA]);
    const handler = handlerFor(verifier);
    const assertions = [
      await token(impostor, state.nowMs),
      await token(keyA, state.nowMs - 3_600_000),
    ];
    for (const assertion of assertions) {
      const response = await handler(request("/api/v1/sessions", assertion), peer);
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe("authentication_required");
    }
  });

  test("refuses a valid token whose login is not allowlisted, and any non-loopback peer", async () => {
    const { state, verifier } = fixture([keyA]);
    const handler = handlerFor(verifier);
    const disallowed = await handler(request("/api/v1/sessions", await token(keyA, state.nowMs, { email: "intruder@example.com" })), peer);
    expect(disallowed.status).toBe(403);
    expect((await disallowed.json()).code).toBe("forbidden");
    const assertion = await token(keyA, state.nowMs);
    const remote = await handler(request("/api/v1/sessions", assertion), { address: "203.0.113.7" });
    expect(remote.status).toBe(403);
    expect((await remote.json()).code).toBe("forbidden");
    const missingPeer = await handler(request("/api/v1/sessions", assertion));
    expect(missingPeer.status).toBe(403);
    expect((await missingPeer.json()).code).toBe("forbidden");
  });

  test("without Access settings or a verifier the mode fails closed", async () => {
    const { cloudflareAccess: _omitted, ...auth } = accessConfig().auth;
    const config = { ...accessConfig(), auth };
    const handler = createHttpHandler({
      config,
      registry: registry(),
      staticAssets: assets,
      launchResolver: { resolve: async () => ({ status: "missing" }) },
      tailnetPresent: () => true,
    });
    const response = await handler(request("/api/v1/sessions", "a.b.c", { headers: { "Tailscale-User-Login": "user@example.com" } }), peer);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("forbidden");
  });

  test("a key-set outage is retryable and is not an expired sign-in", async () => {
    const lines: string[] = [];
    const verifier = createCloudflareAccessVerifier({
      teamDomain: TEAM,
      audience: AUDIENCE,
      fetch: async () => {
        throw new TypeError("network down");
      },
    });
    const handler = handlerFor(verifier, { lines });
    const assertion = await token(keyA, Date.now());
    const response = await handler(request("/api/v1/sessions", assertion), peer);
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).toContain("retry_later");
    expect(body).not.toContain("authentication_required");
    const output = lines.join("\n");
    expect(output).toContain("keys_unavailable");
    expect(output).not.toContain(assertion);
    expect(output).not.toContain("example.com");
    expect(output).not.toContain("JWT");
    expect(output).not.toContain("network down");
  });

  test("a launch that crosses token expiry does not release the capability", async () => {
    const { state, verifier } = fixture([keyA]);
    const assertion = await token(keyA, state.nowMs);
    const handler = handlerFor(verifier, {
      resolve: async () => {
        state.nowMs += 61_000;
        return { status: "ok", capability: SecretCapability.from("ACCESS__CONTROL__CANARY__0000000000") };
      },
    });
    const response = await handler(launch(assertion), peer);
    const body = await response.text();
    expect(response.status).toBe(401);
    expect(body).toContain("authentication_required");
    expect(body).not.toContain("ACCESS__CONTROL__CANARY");
  });

  test("a slow launch still releases the capability while the token remains valid", async () => {
    const { state, verifier } = fixture([keyA]);
    const assertion = await token(keyA, state.nowMs);
    const handler = handlerFor(verifier, {
      resolve: async () => {
        state.nowMs += 1_000;
        return { status: "ok", capability: SecretCapability.from("ACCESS__CONTROL__CANARY__0000000000") };
      },
    });
    const response = await handler(launch(assertion), peer);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("ACCESS__CONTROL__CANARY");
  });

  test("keeps exact Origin checks on mutations for an authenticated identity", async () => {
    const { state, verifier } = fixture([keyA]);
    const handler = handlerFor(verifier);
    const assertion = await token(keyA, state.nowMs);
    const launch = (origin: string): Request =>
      request("/api/v1/sessions/http-instance-000001/launch", assertion, {
        method: "POST",
        headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "control", generation: 3 }),
      });
    expect((await handler(launch("https://evil.example"), peer)).status).toBe(403);
    expect((await handler(launch(ORIGIN), peer)).status).toBe(200);
  });

  test("never logs the assertion or the identity it carries", async () => {
    const { state, verifier } = fixture([keyA]);
    const lines: string[] = [];
    const handler = handlerFor(verifier, { lines });
    const expired = await token(keyA, state.nowMs - 3_600_000, { email: "user@example.com" });
    await handler(request("/api/v1/sessions", expired), peer);
    await handler(request("/api/v1/sessions", await token(keyA, state.nowMs, { email: "intruder@example.com" })), peer);
    const output = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(output).not.toContain(expired.split(".")[1]!);
    expect(output).not.toContain("example.com");
    expect(output).not.toContain("JWT");
  });

  test("readiness proofs are refused to requests that arrived through the tunnel", async () => {
    const { verifier } = fixture([keyA]);
    const handler = handlerFor(verifier);
    expect((await handler(new Request("http://127.0.0.1:4317/api/v1/health"), peer)).status).toBe(200);
    for (const header of ["Cf-Ray", "Cf-Connecting-Ip", "Cf-Access-Jwt-Assertion", "X-Forwarded-For"]) {
      const response = await handler(new Request(`${ORIGIN}/api/v1/health`, { headers: { [header]: "x" } }), peer);
      expect(response.status).toBe(403);
    }
  });
});

describe("Cloudflare Access event streams", () => {
  async function endsWithin(reader: ReadableStreamDefaultReader<Uint8Array>, reads = 200): Promise<boolean> {
    for (let read = 0; read < reads; read += 1) {
      if ((await reader.read()).done) return true;
    }
    return false;
  }

  test("an admitted stream ends once the admitting token expires", async () => {
    const { state, verifier } = fixture([keyA]);
    const handler = handlerFor(verifier, { sseKeepaliveMs: 1 });
    const stream = await handler(request("/api/v1/events", await token(keyA, state.nowMs)), peer);
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: snapshot");
    // Still valid: keepalives flow.
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: keepalive");

    state.nowMs += 61_000;
    expect(await endsWithin(reader)).toBe(true);
  });

  test("an admitted stream survives a key-set outage and ends once the admitting token expires", async () => {
    const state = { nowMs: Date.UTC(2026, 9, 1, 12), fail: false };
    const verifier = createCloudflareAccessVerifier({
      teamDomain: TEAM,
      audience: AUDIENCE,
      now: () => state.nowMs,
      cacheMaxAgeMs: 0,
      cooldownMs: 0,
      fetch: async () => {
        if (state.fail) throw new TypeError("network down");
        return Response.json({ keys: [keyA.jwk] });
      },
    });
    const handler = handlerFor(verifier, { sseKeepaliveMs: 1 });
    const stream = await handler(request("/api/v1/events", await token(keyA, state.nowMs)), peer);
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: snapshot");
    state.fail = true;
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: keepalive");
    state.nowMs += 61_000;
    expect(await endsWithin(reader)).toBe(true);
  });
});
