import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

/** The only place Access delivers the application token to an origin that it always populates. */
export const CLOUDFLARE_ACCESS_ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";

/** Access tokens are a few kilobytes at most; custom claims are trimmed near 1 KB. */
const MAX_ASSERTION_LENGTH = 16 * 1_024;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
/** Tolerated skew for `nbf` and `iat` only; expiry is enforced without any tolerance. */
const CLOCK_SKEW_SECONDS = 30;
const MAX_SUBJECT_LENGTH = 256;
const MAX_EMAIL_LENGTH = 320;

/** `https://<team>.cloudflareaccess.com`, exactly: no port, path, query, fragment or credentials. */
const TEAM_DOMAIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u;
/** The Application Audience tag Cloudflare assigns to one Access application. */
const AUDIENCE_TAG = /^[0-9a-f]{64}$/u;

export interface CloudflareAccessSettings {
  /** Exact issuer origin, e.g. `https://team.cloudflareaccess.com`; also the pinned JWKS origin. */
  readonly teamDomain: string;
  /** Application Audience (AUD) tag of the one Access application fronting this gateway. */
  readonly audience: string;
}

export function isCloudflareAccessTeamDomain(value: unknown): value is string {
  if (typeof value !== "string" || !TEAM_DOMAIN.test(value)) return false;
  try {
    const url = new URL(value);
    return url.origin === value && url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function isCloudflareAccessAudience(value: unknown): value is string {
  return typeof value === "string" && AUDIENCE_TAG.test(value);
}

export function cloudflareAccessCertsUrl(teamDomain: string): URL {
  if (!isCloudflareAccessTeamDomain(teamDomain)) throw new Error("invalid Cloudflare Access team domain");
  return new URL("/cdn-cgi/access/certs", teamDomain);
}

/** A human identity Access asserted for this application, before any allowlist decision. */
export interface CloudflareAccessIdentity {
  /** The `email` claim exactly as signed; callers normalize before comparing. */
  readonly email: string;
  readonly subject: string;
  /** `exp` in epoch milliseconds: nothing derived from this token may outlive it. */
  readonly expiresAtMs: number;
}

export class AccessKeysUnavailable extends Error {
  constructor() {
    super("Cloudflare Access key set is unavailable");
    this.name = "AccessKeysUnavailable";
  }
}

export interface CloudflareAccessVerifier {
  /**
   * Resolves the verified identity, or `undefined` when the assertion itself is rejected. Token
   * failures are indistinguishable and are not thrown, so no caller can log a JOSE error or the
   * token by accident. A fetch or timeout while retrieving the pinned key set throws
   * {@link AccessKeysUnavailable} and nothing else: that is not a rejected signature.
   */
  verify(token: string): Promise<CloudflareAccessIdentity | undefined>;
  /** The clock `verify` used. Revalidation must read this, not a second clock. */
  now(): number;
}

export interface CloudflareAccessVerifierOptions extends CloudflareAccessSettings {
  /** Wall clock in epoch milliseconds. */
  readonly now?: () => number;
  /**
   * Transport for the pinned certs URL. The URL itself is never injectable: only how it is fetched,
   * so tests serve a local JWKS through the same remote key-set cache and rotation logic.
   */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Minimum interval between JWKS refetches triggered by an unknown `kid` (jose default 30 s). */
  readonly cooldownMs?: number;
  /** Maximum age of a fetched JWKS before it is refetched (jose default 10 min). */
  readonly cacheMaxAgeMs?: number;
}

export function createCloudflareAccessVerifier(options: CloudflareAccessVerifierOptions): CloudflareAccessVerifier {
  if (!isCloudflareAccessTeamDomain(options.teamDomain)) throw new Error("invalid Cloudflare Access team domain");
  if (!isCloudflareAccessAudience(options.audience)) throw new Error("invalid Cloudflare Access audience");
  const issuer = options.teamDomain;
  const audience = options.audience;
  const now = options.now ?? Date.now;
  // jose caches the set, refetches it when it ages out, and refetches early when a token names a
  // `kid` it does not hold, which is how Cloudflare's six-weekly (or manual) rotation arrives.
  // Redirects are not followed, so the keys can only come from the pinned team origin.
  const keys: JWTVerifyGetKey = createRemoteJWKSet(cloudflareAccessCertsUrl(issuer), {
    timeoutDuration: 5_000,
    ...(options.cooldownMs === undefined ? {} : { cooldownDuration: options.cooldownMs }),
    ...(options.cacheMaxAgeMs === undefined ? {} : { cacheMaxAge: options.cacheMaxAgeMs }),
    [customFetch]: async (url, init) => {
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(url, init);
      } catch {
        // Classify at the fetch boundary, not by error shape from signature/key processing.
        throw new AccessKeysUnavailable();
      }
      if (response.status !== 200) throw new AccessKeysUnavailable();
      return response;
    },
  });
  return {
    now,
    async verify(token) {
      if (token.length === 0 || token.length > MAX_ASSERTION_LENGTH || !COMPACT_JWS.test(token)) return undefined;
      try {
        const { payload, protectedHeader } = await jwtVerify(token, keys, {
          issuer,
          audience,
          algorithms: ["RS256"],
          requiredClaims: ["exp", "iat", "sub", "email"],
          clockTolerance: CLOCK_SKEW_SECONDS,
          currentDate: new Date(now()),
        });
        // A cold key fetch can outlast `exp`. jose judged the pre-await clock; this one is current.
        const verifiedAtMs = now();
        if (protectedHeader.typ !== undefined && protectedHeader.typ !== "JWT") return undefined;
        // `app` is the per-application token Access forwards; `org` is the global session token.
        if (payload.type !== "app") return undefined;
        // Service tokens carry `common_name` and an empty `sub`; they are machines, never a person.
        if ("common_name" in payload) return undefined;
        const { sub, email, exp, iat } = payload;
        if (typeof sub !== "string" || sub.length === 0 || sub.length > MAX_SUBJECT_LENGTH) return undefined;
        if (typeof email !== "string" || email.length === 0 || email.length > MAX_EMAIL_LENGTH) return undefined;
        if (typeof exp !== "number" || typeof iat !== "number" || !Number.isFinite(exp) || !Number.isFinite(iat)) {
          return undefined;
        }
        const expiresAtMs = exp * 1_000;
        // jose extends expiry by the skew tolerance; access must not.
        if (expiresAtMs <= verifiedAtMs) return undefined;
        if (iat * 1_000 > verifiedAtMs + CLOCK_SKEW_SECONDS * 1_000 || iat > exp) return undefined;
        return { email, subject: sub, expiresAtMs };
      } catch (error) {
        if (error instanceof AccessKeysUnavailable || error instanceof errors.JWKSTimeout) {
          throw new AccessKeysUnavailable();
        }
        return undefined;
      }
    },
  };
}

