import { ProtocolValidationError, SecretCapability } from "./secret.ts";
import {
  FLEET_HOST_PATTERN,
  FLEET_LINK_ERRORS,
  FLEET_NATIVE_INSTANCE_ID_PATTERN,
  MAX_FRAME_BYTES,
  INSTANCE_ID_PATTERN,
  MAX_FLEET_HOST_ERROR_CODEPOINTS,
  MAX_FLEET_HOSTS,
  MAX_LABEL_CODEPOINTS,
  MAX_PUSH_PENDING_COUNT,
  MAX_REQUEST_ID_BYTES,
  MAX_PUSH_ENDPOINT_BYTES,
  MAX_SESSIONS,
  OMP_REGISTRY_VERSION,
  PUSH_API_VERSION,
  type FleetBridgeHost,
  type FleetBridgeSession,
  type FleetBridgeSnapshot,
  type FleetDirectoryStatus,
  type FleetHostSummary,
  type FleetHostStatus,
  type FleetLinkError,
  type AttentionPushMessage,
  type BrowserPushSubscription,
  type LaunchMode,
  type LaunchRequest,
  type LaunchResponse,
  type NotificationLaunchIntent,
  type ObservedSessionInput,
  type OmpDiscoveryEntry,
  type OmpHostSnapshot,
  type OmpRegistryErrorCode,
  type PushConfigResponse,
  type PushSubscriptionRequest,
  type PushSubscriptionResponse,
  type PushDetailLevel,
  type PushUnsubscribeRequest,
  type SessionEvent,
  type SessionListResponse,
  type SessionMetadata,
} from "./types.ts";

const SESSION_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;
const DISALLOWED_LABEL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;
const PUSH_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const PUSH_DETAIL_LEVELS: Readonly<Record<PushDetailLevel, true>> = {
  private: true,
  session: true,
  preview: true,
};

/** 32 random bytes, hex encoded, written into the discovery file by the host. */
const OMP_DISCOVERY_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const OMP_REGISTRY_ERROR_CODES: Readonly<Record<OmpRegistryErrorCode, true>> = {
  malformed_request: true,
  unsupported_protocol: true,
  authentication_failed: true,
  snapshot_unavailable: true,
  invalid_operation: true,
  invalid_access: true,
  stale_generation: true,
  access_unavailable: true,
};

/**
 * Keys that would carry ask content. Upstream's registry snapshot is metadata-only; a snapshot that
 * names one of these is a privacy regression to review, not an additive field, so it is refused.
 */
const FORBIDDEN_OMP_SNAPSHOT_KEYS = ["prompt", "question", "options", "prefill", "answer", "requestId", "count"] as const;

type JsonRecord = Record<string, unknown>;

function requireRecord(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError();
  }
  return value as JsonRecord;
}

function requireExactKeys(value: JsonRecord, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new ProtocolValidationError();
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ProtocolValidationError();
  }
}

/**
 * OMP evolves its registry v1 wire additively: it added `busy` without a version bump because a
 * bump would hide every host from differently versioned listers. OMP input therefore requires the
 * fields the gateway reads and ignores the rest; each parser builds its result from named fields
 * only, so an unknown key can never reach a projection. Gateway-owned protocols stay exact.
 */
function requireKeys(value: JsonRecord, required: readonly string[]): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new ProtocolValidationError();
  }
}

function requireInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ProtocolValidationError();
  }
  return value as number;
}

/** Every instance identity on every surface: the one OMP mints, validated the way OMP does. */
function requireInstanceId(value: unknown): string {
  if (typeof value !== "string" || !INSTANCE_ID_PATTERN.test(value)) throw new ProtocolValidationError();
  return value;
}

function requireRequestId(value: unknown): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > MAX_REQUEST_ID_BYTES ||
    !REQUEST_ID_PATTERN.test(value)
  ) {
    throw new ProtocolValidationError();
  }
  return value;
}

function requireDateTime(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new ProtocolValidationError();
  }
  return value;
}

function optionalLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ProtocolValidationError();
  const normalized = value.normalize("NFC").replace(DISALLOWED_LABEL_PATTERN, "").trim();
  if ([...normalized].length > MAX_LABEL_CODEPOINTS) throw new ProtocolValidationError();
  return normalized;
}

function assertNoDuplicateObjectKeys(text: string): void {
  let index = 0;
  const skipWhitespace = (): void => {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    index += 1;
    while (index < text.length) {
      const current = text[index];
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          throw new ProtocolValidationError();
        }
      }
      index += 1;
    }
    throw new ProtocolValidationError();
  };
  const parseValue = (): void => {
    skipWhitespace();
    const current = text[index];
    if (current === "{") {
      index += 1;
      const keys = new Set<string>();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        skipWhitespace();
        if (text[index] !== '"') throw new ProtocolValidationError();
        const key = parseString();
        if (keys.has(key)) throw new ProtocolValidationError();
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") throw new ProtocolValidationError();
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new ProtocolValidationError();
        index += 1;
      }
      throw new ProtocolValidationError();
    }
    if (current === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue();
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new ProtocolValidationError();
        index += 1;
      }
      throw new ProtocolValidationError();
    }
    if (current === '"') {
      parseString();
      return;
    }
    const start = index;
    while (index < text.length && !/[\s,}\]]/u.test(text[index] ?? "")) index += 1;
    if (start === index) throw new ProtocolValidationError();
  };

  parseValue();
  skipWhitespace();
  if (index !== text.length) throw new ProtocolValidationError();
}

export function parseJsonFrame(bytes: Uint8Array): unknown {
  return parseBoundedJson(bytes, MAX_FRAME_BYTES);
}

/** `parseJsonFrame` with a caller-chosen ceiling, for peer documents larger than one frame. */
export function parseBoundedJson(bytes: Uint8Array, maximumBytes: number): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) throw new ProtocolValidationError();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolValidationError();
  }
  if (text.includes("\0")) throw new ProtocolValidationError();
  assertNoDuplicateObjectKeys(text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolValidationError();
  }
}

/**
 * Parses one `<entryId>.json` discovery file. The file is written once per publication and never
 * rewritten, so an unparseable file or one missing a required field is a stale or alien artifact,
 * not a host. Fields a later upstream adds are ignored.
 */
export function parseOmpDiscoveryEntry(entryId: string, value: unknown): OmpDiscoveryEntry {
  const record = requireRecord(value);
  requireKeys(record, ["version", "instanceId", "pid", "endpoint", "createdAt", "token"]);
  if (typeof record.endpoint !== "string" || record.endpoint.length === 0 || record.endpoint.includes("\0")) {
    throw new ProtocolValidationError();
  }
  if (typeof record.token !== "string" || !OMP_DISCOVERY_TOKEN_PATTERN.test(record.token)) {
    throw new ProtocolValidationError();
  }
  return {
    entryId: requireInstanceId(entryId),
    version: requireInteger(record.version, 1),
    instanceId: requireInstanceId(record.instanceId),
    pid: requireInteger(record.pid, 1, 2_147_483_647),
    endpoint: record.endpoint,
    createdAt: requireInteger(record.createdAt, 0),
    token: record.token,
  };
}

function parseOmpHostModel(value: unknown): { provider: string; id: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireRecord(value);
  requireKeys(record, ["provider", "id"]);
  const provider = optionalLabel(record.provider);
  const id = optionalLabel(record.id);
  if (provider === undefined || id === undefined || provider === "" || id === "") return undefined;
  return { provider, id };
}

/** One host's `snapshot` payload. Upstream bounds every free-form string to 1024 characters. */
export function parseOmpHostSnapshot(value: unknown): OmpHostSnapshot {
  const record = requireRecord(value);
  requireKeys(record, [
    "instanceId",
    "generation",
    "pid",
    "sessionId",
    "startedAt",
    "participants",
    "relayConnected",
    "inputRequired",
    "access",
  ]);
  if (FORBIDDEN_OMP_SNAPSHOT_KEYS.some(key => Object.hasOwn(record, key))) throw new ProtocolValidationError();
  if (typeof record.sessionId !== "string" || !SESSION_ID_PATTERN.test(record.sessionId)) {
    throw new ProtocolValidationError();
  }
  if (typeof record.relayConnected !== "boolean" || typeof record.inputRequired !== "boolean") {
    throw new ProtocolValidationError();
  }
  if (record.access !== "view" && record.access !== "control") throw new ProtocolValidationError();
  if (record.busy !== undefined && record.busy !== null && typeof record.busy !== "boolean") {
    throw new ProtocolValidationError();
  }
  const sessionName = record.sessionName === null ? undefined : optionalLabel(record.sessionName);
  const cwd = record.cwd === null ? undefined : optionalLabel(record.cwd);
  const model = parseOmpHostModel(record.model);
  return {
    instanceId: requireInstanceId(record.instanceId),
    generation: requireInteger(record.generation, 1),
    pid: requireInteger(record.pid, 1, 2_147_483_647),
    sessionId: record.sessionId,
    // ECMAScript TimeClip limit: every accepted timestamp must survive ISO projection.
    startedAt: requireInteger(record.startedAt, 0, 8_640_000_000_000_000),
    participants: requireInteger(record.participants, 0),
    relayConnected: record.relayConnected,
    inputRequired: record.inputRequired,
    access: record.access,
    ...(typeof record.busy === "boolean" ? { busy: record.busy } : {}),
    ...(sessionName === undefined || sessionName === "" ? {} : { sessionName }),
    ...(cwd === undefined || cwd === "" ? {} : { cwd }),
    ...(model === undefined ? {} : { model }),
  };
}

export type OmpRegistryReply<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OmpRegistryErrorCode };

function parseOmpEnvelope(value: unknown): { record: JsonRecord; ok: boolean } {
  const record = requireRecord(value);
  if (record.v !== OMP_REGISTRY_VERSION || typeof record.ok !== "boolean") throw new ProtocolValidationError();
  if (!record.ok && (typeof record.error !== "string" || !Object.hasOwn(OMP_REGISTRY_ERROR_CODES, record.error))) {
    throw new ProtocolValidationError();
  }
  return { record, ok: record.ok };
}

export function parseOmpSnapshotReply(value: unknown): OmpRegistryReply<OmpHostSnapshot> {
  const { record, ok } = parseOmpEnvelope(value);
  if (!ok) return { ok: false, error: record.error as OmpRegistryErrorCode };
  requireKeys(record, ["snapshot"]);
  return { ok: true, value: parseOmpHostSnapshot(record.snapshot) };
}

/**
 * A successful `link` reply carries the one capability this whole system exists to broker, so it is
 * wrapped before it can be logged, serialized, or copied into a plain field.
 */
export function parseOmpLinkReply(value: unknown): OmpRegistryReply<SecretCapability> {
  const { record, ok } = parseOmpEnvelope(value);
  if (!ok) return { ok: false, error: record.error as OmpRegistryErrorCode };
  requireKeys(record, ["url"]);
  return { ok: true, value: SecretCapability.from(record.url) };
}

/**
 * Reduces one host snapshot to the browser-safe directory entry. `cwd` becomes a basename label:
 * the directory listing shows which project a session belongs to, and the full path is neither
 * needed for that nor worth broadcasting to every authenticated viewer.
 */
export function observedSessionFromSnapshot(snapshot: OmpHostSnapshot): ObservedSessionInput {
  const title = optionalLabel(snapshot.sessionName);
  const cwdLabel = optionalLabel(
    snapshot.cwd === undefined ? undefined : (snapshot.cwd.replace(/[/\\]+$/u, "").split(/[/\\]/u).pop() ?? undefined),
  );
  const model = snapshot.model === undefined ? undefined : optionalLabel(`${snapshot.model.provider}/${snapshot.model.id}`);
  return {
    instanceId: snapshot.instanceId,
    generation: snapshot.generation,
    pid: snapshot.pid,
    sessionId: snapshot.sessionId,
    startedAt: new Date(snapshot.startedAt).toISOString(),
    canControl: snapshot.access === "control",
    inputRequired: snapshot.inputRequired,
    ...(snapshot.busy === undefined ? {} : { busy: snapshot.busy }),
    ...(title === undefined || title === "" ? {} : { title }),
    ...(cwdLabel === undefined || cwdLabel === "" ? {} : { cwdLabel }),
    ...(model === undefined || model === "" ? {} : { model }),
  };
}

export function parseLaunchRequest(value: unknown): LaunchRequest {
  const record = requireRecord(value);
  requireExactKeys(record, ["mode", "generation"], ["requestId"]);
  if (record.mode !== "view" && record.mode !== "control") throw new ProtocolValidationError();
  if (record.requestId !== undefined && record.mode !== "control") throw new ProtocolValidationError();
  return {
    mode: record.mode,
    generation: requireInteger(record.generation, 1),
    ...(record.requestId === undefined ? {} : { requestId: requireRequestId(record.requestId) }),
  };
}
function requirePushEndpoint(value: unknown): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_PUSH_ENDPOINT_BYTES) {
    throw new ProtocolValidationError();
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ProtocolValidationError();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== "" ||
    endpoint.href !== value
  ) {
    throw new ProtocolValidationError();
  }
  return value;
}

function requirePushKey(value: unknown, minimumLength: number, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    !PUSH_KEY_PATTERN.test(value)
  ) {
    throw new ProtocolValidationError();
  }
  return value;
}

function parseBrowserPushSubscription(value: unknown): BrowserPushSubscription {
  const record = requireRecord(value);
  // WebKit's PushSubscription.toJSON() omits a null expirationTime; Chromium serializes it.
  requireExactKeys(record, ["endpoint", "keys"], ["expirationTime"]);
  const expirationTime = record.expirationTime ?? null;
  const keys = requireRecord(record.keys);
  requireExactKeys(keys, ["p256dh", "auth"]);
  if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || (expirationTime as number) < 0)) {
    throw new ProtocolValidationError();
  }
  return {
    endpoint: requirePushEndpoint(record.endpoint),
    expirationTime: expirationTime as number | null,
    keys: {
      p256dh: requirePushKey(keys.p256dh, 80, 128),
      auth: requirePushKey(keys.auth, 20, 64),
    },
  };
}

export function parsePushSubscriptionRequest(value: unknown): PushSubscriptionRequest {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "subscription"], ["detailLevel"]);
  if (record.version !== PUSH_API_VERSION) throw new ProtocolValidationError();
  let detailLevel: PushDetailLevel | undefined;
  if (record.detailLevel !== undefined) {
    if (
      typeof record.detailLevel !== "string" ||
      !Object.hasOwn(PUSH_DETAIL_LEVELS, record.detailLevel)
    ) {
      throw new ProtocolValidationError();
    }
    detailLevel = record.detailLevel as PushDetailLevel;
  }
  return {
    version: PUSH_API_VERSION,
    ...(detailLevel === undefined ? {} : { detailLevel }),
    subscription: parseBrowserPushSubscription(record.subscription),
  };
}

export function parsePushSubscriptionResponse(value: unknown): PushSubscriptionResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "detailLevel"]);
  if (
    record.version !== PUSH_API_VERSION ||
    typeof record.detailLevel !== "string" ||
    !Object.hasOwn(PUSH_DETAIL_LEVELS, record.detailLevel)
  ) {
    throw new ProtocolValidationError();
  }
  return {
    version: PUSH_API_VERSION,
    detailLevel: record.detailLevel as PushDetailLevel,
  };
}

export function parsePushUnsubscribeRequest(value: unknown): PushUnsubscribeRequest {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "endpoint"]);
  if (record.version !== PUSH_API_VERSION) throw new ProtocolValidationError();
  return { version: PUSH_API_VERSION, endpoint: requirePushEndpoint(record.endpoint) };
}

export function parsePushConfigResponse(value: unknown): PushConfigResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "applicationServerKey"]);
  if (record.version !== PUSH_API_VERSION) throw new ProtocolValidationError();
  return {
    version: PUSH_API_VERSION,
    applicationServerKey: requirePushKey(record.applicationServerKey, 80, 128),
  };
}

export function parseAttentionPushMessage(value: unknown): AttentionPushMessage {
  const record = requireRecord(value);
  if (record.version !== PUSH_API_VERSION) throw new ProtocolValidationError();
  if (record.type === "attention") {
    requireExactKeys(
      record,
      ["version", "type", "instanceId", "generation", "requestId", "pendingAskCount", "title"],
      ["body"],
    );
    if (record.title !== "OMP session needs attention") throw new ProtocolValidationError();
    const body = optionalLabel(record.body);
    return {
      version: PUSH_API_VERSION,
      type: "attention",
      instanceId: requireInstanceId(record.instanceId),
      generation: requireInteger(record.generation, 1),
      requestId: requireRequestId(record.requestId),
      pendingAskCount: requireInteger(record.pendingAskCount, 0, MAX_PUSH_PENDING_COUNT),
      title: record.title,
      ...(body === undefined ? {} : { body }),
    };
  }
  if (record.type === "activity_stop") {
    requireExactKeys(record, ["version", "type", "instanceId", "generation", "pendingAskCount", "title"], ["body"]);
    if (record.title !== "OMP session activity stopped") throw new ProtocolValidationError();
    const body = optionalLabel(record.body);
    return {
      version: PUSH_API_VERSION,
      type: "activity_stop",
      instanceId: requireInstanceId(record.instanceId),
      generation: requireInteger(record.generation, 1),
      pendingAskCount: requireInteger(record.pendingAskCount, 0, MAX_PUSH_PENDING_COUNT),
      title: record.title,
      ...(body === undefined ? {} : { body }),
    };
  }
  if (record.type === "clear") {
    requireExactKeys(record, ["version", "type", "instanceId", "requestId", "pendingAskCount"]);
    return {
      version: PUSH_API_VERSION,
      type: "clear",
      instanceId: requireInstanceId(record.instanceId),
      requestId: requireRequestId(record.requestId),
      pendingAskCount: requireInteger(record.pendingAskCount, 0, MAX_PUSH_PENDING_COUNT),
    };
  }
  throw new ProtocolValidationError();
}


/** Notification data is deliberately smaller than a push payload and admits no extra fields. */
export function parseNotificationData(value: unknown): NotificationLaunchIntent | undefined {
  try {
    const record = requireRecord(value);
    if (record.version !== PUSH_API_VERSION) return undefined;
    if (record.type === "attention") {
      requireExactKeys(record, ["version", "type", "instanceId", "requestId"]);
      return { kind: "attention", instanceId: requireInstanceId(record.instanceId), requestId: requireRequestId(record.requestId) };
    }
    if (record.type === "activity_stop") {
      requireExactKeys(record, ["version", "type", "instanceId", "generation"]);
      return { kind: "activity_stop", instanceId: requireInstanceId(record.instanceId), generation: requireInteger(record.generation, 1) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Shared by the HTTP shell guard and the browser; query keys are exact and non-repeating. */
export function parseNotificationRoute(url: URL): NotificationLaunchIntent | undefined {
  const match = /^\/collab\/([^/]{1,384})$/u.exec(url.pathname);
  if (match?.[1] === undefined || url.hash !== "") return undefined;
  try {
    const instanceId = requireInstanceId(decodeURIComponent(match[1]));
    const entries = [...url.searchParams];
    if (entries.length === 1 && entries[0]?.[0] === "request") {
      return { kind: "attention", instanceId, requestId: requireRequestId(entries[0][1]) };
    }
    if (entries.length !== 2 || url.searchParams.getAll("activity").length !== 1 || url.searchParams.getAll("generation").length !== 1) return undefined;
    const generation = url.searchParams.get("generation");
    if (url.searchParams.get("activity") !== "stopped" || generation === null || !/^[1-9][0-9]*$/u.test(generation)) return undefined;
    return { kind: "activity_stop", instanceId, generation: requireInteger(Number(generation), 1) };
  } catch {
    return undefined;
  }
}

export function notificationRoutePath(intent: NotificationLaunchIntent): string {
  const path = "/collab/" + requireInstanceId(intent.instanceId);
  return intent.kind === "attention"
    ? path + "?request=" + requireRequestId(intent.requestId)
    : path + "?activity=stopped&generation=" + requireInteger(intent.generation, 1);
}

const FLEET_METADATA_KEYS = ["host", "originalInstanceId", "hostStatus", "available"] as const;
const FLEET_INSTANCE_ID_PATTERN = /^[0-9a-f]{64}$/u;
const FLEET_HOST_STATUSES: Readonly<Record<FleetHostStatus, true>> = { live: true, stale: true, never: true };

function requireFleetHostStatus(value: unknown): FleetHostStatus {
  if (typeof value !== "string" || !Object.hasOwn(FLEET_HOST_STATUSES, value)) throw new ProtocolValidationError();
  return value as FleetHostStatus;
}

function requirePatterned(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new ProtocolValidationError();
  return value;
}

/**
 * Fleet metadata is all-or-nothing, and its invariants are what make an unavailable row safe to
 * show: it can never claim Control, never report activity, and only a `live` machine is available.
 */
function parseFleetMetadata(record: JsonRecord): Pick<SessionMetadata, (typeof FLEET_METADATA_KEYS)[number]> {
  const present = FLEET_METADATA_KEYS.filter(key => Object.hasOwn(record, key));
  if (present.length === 0) return {};
  if (present.length !== FLEET_METADATA_KEYS.length) throw new ProtocolValidationError();
  const hostStatus = requireFleetHostStatus(record.hostStatus);
  if (typeof record.available !== "boolean") throw new ProtocolValidationError();
  if (record.available !== (hostStatus === "live")) throw new ProtocolValidationError();
  if (!record.available && (record.canControl !== false || Object.hasOwn(record, "busy"))) {
    throw new ProtocolValidationError();
  }
  // The bridge brokers Control only, so a fleet row never advertises View.
  if (record.canView !== false) throw new ProtocolValidationError();
  if (typeof record.instanceId !== "string" || !FLEET_INSTANCE_ID_PATTERN.test(record.instanceId)) {
    throw new ProtocolValidationError();
  }
  return {
    host: requirePatterned(record.host, FLEET_HOST_PATTERN),
    originalInstanceId: requirePatterned(record.originalInstanceId, FLEET_NATIVE_INSTANCE_ID_PATTERN),
    hostStatus,
    available: record.available,
  };
}

function parseSessionMetadata(value: unknown): SessionMetadata {
  const record = requireRecord(value);
  requireExactKeys(
    record,
    ["instanceId", "generation", "startedAt", "lastSeenAt", "canView", "canControl"],
    ["title", "cwdLabel", "model", "inputRequired", "ask", "busy", ...FLEET_METADATA_KEYS],
  );
  if (
    typeof record.canView !== "boolean" ||
    typeof record.canControl !== "boolean" ||
    (record.inputRequired !== undefined && typeof record.inputRequired !== "boolean") ||
    (Object.hasOwn(record, "busy") && typeof record.busy !== "boolean")
  ) {
    throw new ProtocolValidationError();
  }
  const title = optionalLabel(record.title);
  const cwdLabel = optionalLabel(record.cwdLabel);
  const model = optionalLabel(record.model);
  let ask: SessionMetadata["ask"];
  if (record.ask !== undefined) {
    const askRecord = requireRecord(record.ask);
    requireExactKeys(askRecord, ["requestId", "since"], ["preview", "optionCount"]);
    const preview = optionalLabel(askRecord.preview);
    const optionCount =
      askRecord.optionCount === undefined ? undefined : requireInteger(askRecord.optionCount, 1, 128);
    ask = {
      requestId: requireRequestId(askRecord.requestId),
      since: requireDateTime(askRecord.since),
      ...(preview === undefined ? {} : { preview }),
      ...(optionCount === undefined ? {} : { optionCount }),
    };
  }
  const fleet = parseFleetMetadata(record);
  const inputRequired = record.inputRequired ?? false;
  if ((inputRequired && ask === undefined) || (!inputRequired && ask !== undefined)) {
    throw new ProtocolValidationError();
  }
  return {
    instanceId: requireInstanceId(record.instanceId),
    generation: requireInteger(record.generation, 1),
    ...(title === undefined ? {} : { title }),
    ...(cwdLabel === undefined ? {} : { cwdLabel }),
    ...(model === undefined ? {} : { model }),
    startedAt: requireDateTime(record.startedAt),
    lastSeenAt: requireDateTime(record.lastSeenAt),
    canView: record.canView,
    canControl: record.canControl,
    inputRequired,
    ...(record.busy === undefined ? {} : { busy: record.busy as boolean }),
    ...(ask === undefined ? {} : { ask }),
    ...fleet,
  };
}

function parseSessionArray(value: unknown): readonly SessionMetadata[] {
  if (!Array.isArray(value) || value.length > MAX_SESSIONS) throw new ProtocolValidationError();
  return value.map(parseSessionMetadata);
}

function parseFleetHostSummaries(value: unknown): readonly FleetHostSummary[] {
  if (!Array.isArray(value) || value.length > MAX_FLEET_HOSTS) throw new ProtocolValidationError();
  const seen = new Set<string>();
  return value.map(item => {
    const record = requireRecord(item);
    requireExactKeys(record, ["host", "status", "ageSeconds"], ["error"]);
    const host = requirePatterned(record.host, FLEET_HOST_PATTERN);
    if (seen.has(host)) throw new ProtocolValidationError();
    seen.add(host);
    const status = requireFleetHostStatus(record.status);
    const ageSeconds = record.ageSeconds === null ? null : requireInteger(record.ageSeconds, 0);
    if ((status === "never") !== (ageSeconds === null)) throw new ProtocolValidationError();
    const error = optionalFleetError(record.error);
    return { host, status, ageSeconds, ...(error === undefined ? {} : { error }) };
  });
}

function optionalFleetError(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ProtocolValidationError();
  const normalized = value.normalize("NFC").replace(DISALLOWED_LABEL_PATTERN, "").trim();
  if ([...normalized].length > MAX_FLEET_HOST_ERROR_CODEPOINTS) throw new ProtocolValidationError();
  return normalized === "" ? undefined : normalized;
}

const FLEET_DIRECTORY_STATUSES: Readonly<Record<FleetDirectoryStatus, true>> = { ok: true, unreachable: true };

function optionalFleetStatus(value: unknown): FleetDirectoryStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Object.hasOwn(FLEET_DIRECTORY_STATUSES, value)) throw new ProtocolValidationError();
  return value as FleetDirectoryStatus;
}

function fleetDirectoryFields(record: JsonRecord): Pick<SessionListResponse, "hosts" | "fleetStatus"> {
  const fleetStatus = optionalFleetStatus(record.fleetStatus);
  return {
    ...(record.hosts === undefined ? {} : { hosts: parseFleetHostSummaries(record.hosts) }),
    ...(fleetStatus === undefined ? {} : { fleetStatus }),
  };
}

export function parseSessionListResponse(value: unknown): SessionListResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["revision", "sessions"], ["hosts", "fleetStatus"]);
  return {
    revision: requireInteger(record.revision, 0),
    sessions: parseSessionArray(record.sessions),
    ...fleetDirectoryFields(record),
  };
}

export function parseSessionEvent(value: unknown): SessionEvent {
  const record = requireRecord(value);
  if (record.type === "snapshot") {
    requireExactKeys(record, ["type", "revision", "sessions"], ["hosts", "fleetStatus"]);
    return {
      type: "snapshot",
      revision: requireInteger(record.revision, 0),
      sessions: parseSessionArray(record.sessions),
      ...fleetDirectoryFields(record),
    };
  }
  if (record.type === "session_upsert") {
    requireExactKeys(record, ["type", "revision", "session"]);
    return {
      type: "session_upsert",
      revision: requireInteger(record.revision, 0),
      session: parseSessionMetadata(record.session),
    };
  }
  if (record.type === "session_remove") {
    requireExactKeys(record, ["type", "revision", "instanceId", "generation"]);
    return {
      type: "session_remove",
      revision: requireInteger(record.revision, 0),
      instanceId: requireInstanceId(record.instanceId),
      generation: requireInteger(record.generation, 1),
    };
  }
  throw new ProtocolValidationError();
}

export function parseLaunchResponse(value: unknown): LaunchResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["mode", "generation", "capability"]);
  if (record.mode !== "view" && record.mode !== "control") throw new ProtocolValidationError();
  return {
    mode: record.mode,
    generation: requireInteger(record.generation, 1),
    capability: SecretCapability.from(record.capability).reveal(),
  };
}

/**
 * Projects one observed host onto the browser-safe directory record. A standalone host always
 * answers a `view` link request, while `control` depends on how the session was shared. A fleet
 * record is Control-only (the bridge brokers nothing else), and an unavailable one claims neither
 * Control nor activity. No capability is involved — those are fetched per launch.
 */
export function sessionMetadataFromObserved(
  input: ObservedSessionInput,
  lastSeenAt: string,
): { metadata: SessionMetadata; immutableIdentity: string } {
  const { host, originalInstanceId, hostStatus, available } = input;
  let fleetFields: Pick<SessionMetadata, "host" | "originalInstanceId" | "hostStatus" | "available"> = {};
  if (host !== undefined || originalInstanceId !== undefined || hostStatus !== undefined || available !== undefined) {
    if (
      host === undefined || originalInstanceId === undefined || hostStatus === undefined || available === undefined ||
      available !== (hostStatus === "live")
    ) {
      throw new ProtocolValidationError();
    }
    fleetFields = { host, originalInstanceId, hostStatus, available };
  }
  const fleet = fleetFields.host !== undefined;
  const unavailable = available === false;
  const base = `${input.pid}\0${input.sessionId}\0${input.startedAt}`;
  return {
    metadata: {
      instanceId: input.instanceId,
      generation: input.generation,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.cwdLabel === undefined ? {} : { cwdLabel: input.cwdLabel }),
      ...(input.model === undefined ? {} : { model: input.model }),
      startedAt: input.startedAt,
      lastSeenAt,
      canView: !fleet,
      canControl: input.canControl && !unavailable,
      inputRequired: input.inputRequired,
      ...(input.busy === undefined || unavailable ? {} : { busy: input.busy }),
      ...fleetFields,
    },
    // Freshness is not identity: a machine going stale and back keeps the same room.
    immutableIdentity: fleet ? `${host}\0${originalInstanceId}\0${base}` : base,
  };
}

/**
 * Projects one bridge session onto a directory input under its machine-qualified identity, which
 * the caller derives (SHA-256 of host + "\0" + native id) because hashing is not portable here.
 * A session without a generation or a start time has no launchable identity, so it yields nothing
 * rather than an invented one. Control needs the hub's explicit `canControl`, a live machine and
 * a connected relay (the guest client reaches the room through it); none of these is inferred.
 * `available` is machine freshness only: a live machine's row stays visible and available.
 */
export function observedSessionFromFleet(
  host: FleetBridgeHost,
  session: FleetBridgeSession,
  directoryInstanceId: string,
): ObservedSessionInput | undefined {
  if (session.generation === null || session.roomSince === null) return undefined;
  if (!FLEET_INSTANCE_ID_PATTERN.test(directoryInstanceId)) throw new ProtocolValidationError();
  const title = optionalLabel(session.title ?? undefined);
  const cwdLabel = optionalLabel(
    session.cwd === null ? undefined : (session.cwd.replace(/[/\\]+$/u, "").split(/[/\\]/u).pop() ?? undefined),
  );
  const { provider, id } = session.model ?? { provider: null, id: null };
  const model = optionalLabel(id === null ? undefined : provider === null ? id : `${provider}/${id}`);
  const available = host.status === "live";
  return {
    instanceId: directoryInstanceId,
    generation: session.generation,
    pid: session.pid,
    sessionId: session.sessionId ?? "",
    startedAt: new Date(session.roomSince).toISOString(),
    canControl: available && session.relayConnected && session.canControl === true,
    inputRequired: session.state === "needs-input",
    ...(!available || session.state === "needs-input" || session.state === "unknown"
      ? {}
      : { busy: session.state === "working" }),
    ...(title === undefined || title === "" ? {} : { title }),
    ...(cwdLabel === undefined || cwdLabel === "" ? {} : { cwdLabel }),
    ...(model === undefined || model === "" ? {} : { model }),
    host: host.host,
    originalInstanceId: session.instanceId,
    hostStatus: host.status,
    available,
  };
}

/** One machine's browser-safe summary: freshness and why it failed, never its sessions. */
export function fleetHostSummary(host: FleetBridgeHost): FleetHostSummary {
  const error = optionalFleetError(host.error);
  return {
    host: host.host,
    status: host.status,
    ageSeconds: host.ageSeconds,
    ...(error === undefined ? {} : { error }),
  };
}

const FLEET_SESSION_STATES = { "needs-input": true, working: true, idle: true, unknown: true } as const;
const MAX_FLEET_SESSIONS_PER_HOST = 200;

function nullableBoundedString(value: unknown, maximumLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximumLength || value.includes("\0")) {
    throw new ProtocolValidationError();
  }
  return value;
}

function nullableInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return value === null ? null : requireInteger(value, minimum, maximum);
}

function parseFleetBridgeSession(value: unknown): FleetBridgeSession {
  const record = requireRecord(value);
  requireExactKeys(
    record,
    ["instanceId", "generation", "sessionId", "title", "pid", "cwd", "model", "roomSince", "state", "guests",
      "relayConnected", "tmuxSession"],
    ["canControl"],
  );
  if (typeof record.state !== "string" || !Object.hasOwn(FLEET_SESSION_STATES, record.state)) {
    throw new ProtocolValidationError();
  }
  if (typeof record.relayConnected !== "boolean") throw new ProtocolValidationError();
  if (record.canControl !== undefined && typeof record.canControl !== "boolean") throw new ProtocolValidationError();
  let model: FleetBridgeSession["model"] = null;
  if (record.model !== null) {
    const modelRecord = requireRecord(record.model);
    requireExactKeys(modelRecord, ["provider", "id"]);
    model = { provider: nullableBoundedString(modelRecord.provider, 64), id: nullableBoundedString(modelRecord.id, 128) };
  }
  return {
    instanceId: requirePatterned(record.instanceId, FLEET_NATIVE_INSTANCE_ID_PATTERN),
    // A generation is a positive room counter; zero or negative is malformed, null is unknown.
    generation: nullableInteger(record.generation, 1),
    sessionId: nullableBoundedString(record.sessionId, 128),
    title: nullableBoundedString(record.title, 256),
    pid: requireInteger(record.pid, 1, 2_147_483_647),
    cwd: nullableBoundedString(record.cwd, 512),
    model,
    // ECMAScript TimeClip limit: every accepted timestamp must survive ISO projection.
    roomSince: nullableInteger(record.roomSince, 0, 8_640_000_000_000_000),
    state: record.state as FleetBridgeSession["state"],
    guests: requireInteger(record.guests, 0),
    relayConnected: record.relayConnected,
    tmuxSession: nullableBoundedString(record.tmuxSession, 128),
    ...(record.canControl === undefined ? {} : { canControl: record.canControl }),
  };
}

function parseFleetBridgeHost(value: unknown): FleetBridgeHost {
  const record = requireRecord(value);
  requireExactKeys(record, ["host", "source", "status", "ageSeconds", "error", "sessions"]);
  if (record.source !== "hub" && record.source !== "mac") throw new ProtocolValidationError();
  if (!Array.isArray(record.sessions) || record.sessions.length > MAX_FLEET_SESSIONS_PER_HOST) {
    throw new ProtocolValidationError();
  }
  const sessions = record.sessions.map(parseFleetBridgeSession);
  // Two rows claiming one native identity on one machine make the directory identity ambiguous.
  if (new Set(sessions.map(session => session.instanceId)).size !== sessions.length) {
    throw new ProtocolValidationError();
  }
  const status = requireFleetHostStatus(record.status);
  const ageSeconds = nullableInteger(record.ageSeconds, 0);
  if ((status === "never") !== (ageSeconds === null)) throw new ProtocolValidationError();
  if (status === "never" && sessions.length > 0) throw new ProtocolValidationError();
  return {
    host: requirePatterned(record.host, FLEET_HOST_PATTERN),
    source: record.source,
    status,
    ageSeconds,
    error: nullableBoundedString(record.error, MAX_FLEET_HOST_ERROR_CODEPOINTS),
    sessions,
  };
}

/**
 * `GET /gateway/sessions` from the HarnessOS bridge. Exact keys throughout: the bridge is a peer we
 * own, so an unknown field is drift to review rather than an additive extension to ignore. A
 * machine named twice would make every identity on it ambiguous, so the whole document is refused.
 */
export function parseFleetBridgeSnapshot(value: unknown): FleetBridgeSnapshot {
  const record = requireRecord(value);
  requireExactKeys(record, ["hosts"]);
  if (!Array.isArray(record.hosts) || record.hosts.length > MAX_FLEET_HOSTS) throw new ProtocolValidationError();
  const hosts = record.hosts.map(parseFleetBridgeHost);
  if (new Set(hosts.map(host => host.host)).size !== hosts.length) throw new ProtocolValidationError();
  if (hosts.reduce((total, host) => total + host.sessions.length, 0) > MAX_SESSIONS) throw new ProtocolValidationError();
  return { hosts };
}

const FLEET_CONTROL_FRAGMENT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{64}$/u;
const MAX_FLEET_CONTROL_URL_LENGTH = 2_048;

export type FleetLinkOutcome =
  | { readonly ok: true; readonly capability: SecretCapability }
  | { readonly ok: false; readonly error: FleetLinkError };

/**
 * `POST /gateway/open` from the HarnessOS bridge. A success must be exactly a hosted-client
 * control link — `https://my.omp.sh/#<room>.<key>` with nothing else — so a redirect, a query, or
 * a View key fails closed. The link is wrapped before it can be logged or copied.
 */
export function parseFleetLinkOutcome(value: unknown): FleetLinkOutcome {
  const record = requireRecord(value);
  if (Object.hasOwn(record, "error")) {
    requireExactKeys(record, ["error"]);
    if (typeof record.error !== "string" || !(FLEET_LINK_ERRORS as readonly string[]).includes(record.error)) {
      throw new ProtocolValidationError();
    }
    return { ok: false, error: record.error as FleetLinkError };
  }
  requireExactKeys(record, ["url"]);
  const raw = record.url;
  if (typeof raw !== "string" || raw.length > MAX_FLEET_CONTROL_URL_LENGTH) throw new ProtocolValidationError();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProtocolValidationError();
  }
  if (
    url.href !== raw ||
    url.origin !== "https://my.omp.sh" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !FLEET_CONTROL_FRAGMENT_PATTERN.test(url.hash.slice(1))
  ) {
    throw new ProtocolValidationError();
  }
  return { ok: true, capability: SecretCapability.from(raw) };
}
