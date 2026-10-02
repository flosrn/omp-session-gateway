export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_CAPABILITY_BYTES = 8 * 1024;
export const MAX_LABEL_CODEPOINTS = 256;
export const MAX_SESSIONS = 1_000;
/**
 * OMP mints every instance identity now, so its own `COLLAB_INSTANCE_ID_PATTERN` is the contract:
 * 8-64 characters of `[a-z0-9-]`. A host is free to use the 8-character minimum, and a gateway that
 * required more would admit that host from discovery and then fail the whole directory response in
 * the browser, so every layer validates against this one value.
 */
export const INSTANCE_ID_PATTERN = /^[a-z0-9-]{8,64}$/u;
export const MAX_OMP_REGISTRY_REQUEST_BYTES = 4 * 1024;
export const MAX_OMP_REGISTRY_RESPONSE_BYTES = 64 * 1024;
export const PUSH_API_VERSION = 2 as const;
export const MAX_PUSH_ENDPOINT_BYTES = 4 * 1024;
export const MAX_PUSH_SUBSCRIPTION_BYTES = 8 * 1024;
export const MAX_REQUEST_ID_BYTES = 128;
export const MAX_PUSH_PENDING_COUNT = 1_000;

/** Machine name as HarnessOS `hosts.toml` spells it; also the first half of a fleet identity. */
export const FLEET_HOST_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
/** OMP's native instance id as HarnessOS validates it before it reaches the gateway. */
export const FLEET_NATIVE_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
export const MAX_FLEET_HOSTS = 64;
export const MAX_FLEET_HOST_ERROR_CODEPOINTS = 512;

/** Activity and workspace text bounds, in UTF-16 code units as the HarnessOS hub schema counts them. */
export const MAX_ACTIVITY_TOOL_LENGTH = 64;
export const MAX_ACTIVITY_INTENT_LENGTH = 160;
export const MAX_ACTIVITY_PREVIEW_LENGTH = 240;
export const MAX_WORKSPACE_ID_LENGTH = 1_024;
export const MAX_WORKSPACE_PATH_LENGTH = 512;
export const MAX_WORKSPACE_PROJECT_LENGTH = 128;
export const MAX_WORKSPACE_BRANCH_LENGTH = 256;
export const MAX_WORKSPACE_COMMENT_LENGTH = 512;
export const MAX_WORKSPACE_STATUS_LENGTH = 64;
export const MAX_WORKSPACE_PR_LENGTH = 1_024;
/** ECMAScript TimeClip: every accepted epoch-millisecond instant survives `new Date()`. */
export const MAX_EPOCH_MS = 8_640_000_000_000_000;

/**
 * What one session last did, as the host observed it. Every field is `null` when not observed:
 * a missing count is never reported as zero. `contextTokens` is input plus cache read and write of
 * the latest assistant request; `cost` is the persisted usage total for the whole session, not a
 * repricing; `contextWindow` and `subagents` are present only where the host can observe them.
 */
export interface SessionActivity {
  /** Last entry written, epoch milliseconds. */
  readonly at: number | null;
  readonly tool: string | null;
  readonly intent: string | null;
  readonly preview: string | null;
  readonly contextTokens: number | null;
  readonly contextWindow: number | null;
  readonly cost: number | null;
  readonly subagents: number | null;
}

/**
 * The Orca workspace a session runs in, attached only on an exact cwd or terminal identity match.
 * Orca state never stands in for OMP activity: `busy`/`inputRequired` remain authoritative.
 * `id` and `path` identify the workspace for actions and are never rendered.
 */
export interface SessionWorkspace {
  readonly id: string;
  readonly path: string;
  readonly project: string;
  readonly branch: string | null;
  readonly comment: string | null;
  readonly status: string | null;
  readonly unread: boolean;
  readonly pr: string | null;
}

/**
 * Freshness of one fleet machine's reading, on the HarnessOS hub's clock: `live` is current,
 * `stale` is the last good reading kept for display, `never` has had no reading since the hub
 * started. Only a `live` machine's sessions can be launched.
 */
export type FleetHostStatus = "live" | "stale" | "never";
/**
 * Reachability of the fleet directory itself, not of one machine. `ok` means the latest bridge
 * listing succeeded, even when that listing is empty. `unreachable` means no listing has succeeded
 * since boot, or the latest poll failed. Absent on a standalone gateway. Not a capability.
 */
export type FleetDirectoryStatus = "ok" | "unreachable";


/** One machine in a federated directory; present even when the machine holds no session. */
export interface FleetHostSummary {
  readonly host: string;
  readonly status: FleetHostStatus;
  readonly ageSeconds: number | null;
  readonly error?: string;
}

/** HarnessOS session state, collapsed by the hub; `needs-input` wins over `working`. */
export type FleetSessionState = "needs-input" | "working" | "idle" | "unknown";

/**
 * One OMP session as the HarnessOS bridge reports it, after strict validation. Metadata only:
 * the bridge never sends a link in a listing. `generation === null` comes from an OMP that does
 * not report one; such a session has no launchable identity and never reaches the directory.
 */
export interface FleetBridgeSession {
  readonly instanceId: string;
  readonly generation: number | null;
  readonly sessionId: string | null;
  readonly title: string | null;
  readonly pid: number;
  readonly cwd: string | null;
  readonly model: { readonly provider: string | null; readonly id: string | null } | null;
  readonly roomSince: number | null;
  readonly state: FleetSessionState;
  readonly guests: number;
  readonly relayConnected: boolean;
  readonly tmuxSession: string | null;
  /** Omitted by a hub that predates access reporting: unknown, so never controllable. */
  readonly canControl?: boolean;
  /** Omitted by a hub that predates activity reporting: unknown, never idle or zero. */
  readonly activity?: SessionActivity;
  /** Omitted when no Orca workspace matches this session exactly. */
  readonly workspace?: SessionWorkspace;
}

export interface FleetBridgeHost {
  readonly host: string;
  readonly source: "hub" | "mac";
  readonly status: FleetHostStatus;
  readonly ageSeconds: number | null;
  readonly error: string | null;
  readonly sessions: readonly FleetBridgeSession[];
}

/** `GET /gateway/sessions` on the HarnessOS bridge: the hub's live document, unchanged. */
export interface FleetBridgeSnapshot {
  readonly hosts: readonly FleetBridgeHost[];
}

export const FLEET_LINK_ERRORS = [
  "not-found",
  "stale-generation",
  "unavailable",
  "invalid-link",
  "timeout",
  "token-refused",
  "bad-target",
  "too-large",
] as const;
export type FleetLinkError = (typeof FLEET_LINK_ERRORS)[number];

export type LaunchMode = "view" | "control";
/**
 * Wire version of OMP's own local collaboration host registry. Mainline OMP publishes one
 * discovery file and one owner-only socket per live host; the gateway reads them. Upstream calls
 * this `COLLAB_REGISTRY_VERSION` and rejects any other value with `unsupported_protocol`.
 */
export const OMP_REGISTRY_VERSION = 1 as const;

/** Parsed `<entryId>.json` from OMP's discovery directory. Never carries a capability. */
export interface OmpDiscoveryEntry {
  /** Basename without `.json`. Fresh per publication, so a rotated room never reuses it. */
  readonly entryId: string;
  readonly version: number;
  readonly instanceId: string;
  readonly pid: number;
  /** Absolute socket or named-pipe path. OMP relocates long paths, so never derive it. */
  readonly endpoint: string;
  readonly createdAt: number;
  /** Bearer for querying this host only. Authorizes a question, never an answer. */
  readonly token: string;
}

export interface OmpHostModel {
  readonly provider: string;
  readonly id: string;
}

/** One `snapshot` answer from a live OMP host. Metadata only, by upstream's contract. */
export interface OmpHostSnapshot {
  readonly instanceId: string;
  readonly generation: number;
  readonly pid: number;
  readonly sessionId: string;
  readonly sessionName?: string;
  readonly cwd?: string;
  readonly model?: OmpHostModel;
  readonly startedAt: number;
  readonly participants: number;
  readonly relayConnected: boolean;
  readonly inputRequired: boolean;
  /** Omitted means the host does not report activity; never infer idle from omission. */
  readonly busy?: boolean;
  readonly access: LaunchMode;
}

/** Every wire error string upstream's registry server can return. */
export type OmpRegistryErrorCode =
  | "malformed_request"
  | "unsupported_protocol"
  | "authentication_failed"
  | "snapshot_unavailable"
  | "invalid_operation"
  | "invalid_access"
  | "stale_generation"
  | "access_unavailable";

/**
 * A host the gateway observed this poll, reduced to what the directory needs. Capability-free by
 * construction: the gateway asks a host for a link only when an operator presses View or Control.
 */
export interface ObservedSessionInput {
  readonly instanceId: string;
  readonly generation: number;
  readonly pid: number;
  readonly sessionId: string;
  readonly title?: string;
  readonly cwdLabel?: string;
  readonly model?: string;
  readonly startedAt: string;
  readonly canControl: boolean;
  readonly inputRequired: boolean;
  /** Omitted means activity is unknown, not idle. */
  readonly busy?: boolean;
  /**
   * Fleet-only, all four together or none. `instanceId` is then
   * SHA-256(host + "\0" + originalInstanceId) in lowercase hex: a directory identity, never a
   * capability. `available: false` means the row is shown but cannot be launched or notified.
   */
  readonly host?: string;
  readonly originalInstanceId?: string;
  readonly hostStatus?: FleetHostStatus;
  readonly available?: boolean;
  /** Last known even while the machine is stale; `busy` alone says whether it is current. */
  readonly activity?: SessionActivity;
  readonly workspace?: SessionWorkspace;
}

export interface SessionAskMetadata {
  readonly requestId: string;
  readonly since: string;
  readonly preview?: string;
  readonly optionCount?: number;
}

/** Browser-safe metadata. This type can never contain a collaboration capability. */
export interface SessionMetadata {
  readonly instanceId: string;
  readonly generation: number;
  readonly title?: string;
  readonly cwdLabel?: string;
  readonly model?: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly canView: boolean;
  readonly canControl: boolean;
  readonly inputRequired: boolean;
  readonly busy?: boolean;
  readonly ask?: SessionAskMetadata;
  /** Fleet-only, all four together or none; see `ObservedSessionInput`. */
  readonly host?: string;
  readonly originalInstanceId?: string;
  readonly hostStatus?: FleetHostStatus;
  readonly available?: boolean;
  readonly activity?: SessionActivity;
  readonly workspace?: SessionWorkspace;
}

export interface SessionListResponse {
  readonly revision: number;
  readonly sessions: readonly SessionMetadata[];
  /** Fleet machines, including empty and unreachable ones; absent from a standalone gateway. */
  readonly hosts?: readonly FleetHostSummary[];
  /** Bridge reachability; absent on a standalone gateway, independent of each machine's status. */
  readonly fleetStatus?: FleetDirectoryStatus;
}

export type SessionEvent =
  | {
      readonly type: "snapshot";
      readonly revision: number;
      readonly sessions: readonly SessionMetadata[];
      readonly hosts?: readonly FleetHostSummary[];
      readonly fleetStatus?: FleetDirectoryStatus;
    }
  | { readonly type: "session_upsert"; readonly revision: number; readonly session: SessionMetadata }
  | {
      readonly type: "session_remove";
      readonly revision: number;
      readonly instanceId: string;
      readonly generation: number;
    };
export interface PushSubscriptionKeys {
  readonly p256dh: string;
  readonly auth: string;
}

export interface BrowserPushSubscription {
  readonly endpoint: string;
  readonly expirationTime: number | null;
  readonly keys: PushSubscriptionKeys;
}

export type PushDetailLevel = "private" | "session" | "preview";

export interface PushSubscriptionRequest {
  readonly version: typeof PUSH_API_VERSION;
  readonly detailLevel?: PushDetailLevel;
  readonly subscription: BrowserPushSubscription;
}

export interface PushSubscriptionResponse {
  readonly version: typeof PUSH_API_VERSION;
  readonly detailLevel: PushDetailLevel;
}

export interface PushUnsubscribeRequest {
  readonly version: typeof PUSH_API_VERSION;
  readonly endpoint: string;
}

export interface PushConfigResponse {
  readonly version: typeof PUSH_API_VERSION;
  readonly applicationServerKey: string;
}

/** Capability-free message encrypted for one browser push subscription. */
export type AttentionPushMessage =
  | {
      readonly version: typeof PUSH_API_VERSION;
      readonly type: "attention";
      readonly instanceId: string;
      readonly generation: number;
      readonly requestId: string;
      readonly pendingAskCount: number;
      readonly title: "OMP session needs attention";
      readonly body?: string;
    }
  | {
      readonly version: typeof PUSH_API_VERSION;
      readonly type: "activity_stop";
      readonly instanceId: string;
      readonly generation: number;
      readonly pendingAskCount: number;
      readonly title: "OMP session activity stopped";
      readonly body?: string;
    }
  | {
      readonly version: typeof PUSH_API_VERSION;
      readonly type: "clear";
      readonly instanceId: string;
      readonly requestId: string;
      readonly pendingAskCount: number;
    };


/** Capability-free launch intent, revalidated against the current directory before launch. */
export type NotificationLaunchIntent =
  | { readonly kind: "attention"; readonly instanceId: string; readonly requestId: string }
  | { readonly kind: "activity_stop"; readonly instanceId: string; readonly generation: number };

export interface LaunchRequest {
  readonly mode: LaunchMode;
  readonly generation: number;
  readonly requestId?: string;
}

export interface LaunchResponse {
  readonly mode: LaunchMode;
  readonly generation: number;
  readonly capability: string;
}

export interface ProblemResponse {
  readonly code: string;
  readonly message: string;
}
