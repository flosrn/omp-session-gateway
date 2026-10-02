/**
 * The workspace RPC: one POST body `{requestId, host, operation, args}` relayed to the HarnessOS
 * bridge, which runs it on the named machine through Orca. This module is pure — no Node I/O — so the
 * gateway route and the web panel share one strict reading of every request and every reply.
 *
 * The gateway route authenticates (Cloudflare Access), checks Origin/Sec-Fetch-Site and bounds the
 * body before `WorkspaceApi.handle` sees anything; this module never grants access by itself.
 */
import { FLEET_HOST_PATTERN } from "@omp-session-gateway/protocol";

export const MAX_WORKSPACE_BODY_BYTES = 64 * 1024;
export const MAX_WORKSPACE_RESPONSE_BYTES = 2 * 1024 * 1024;

export const WORKSPACE_READ_OPERATIONS = ["inventory", "search", "history", "transcript"] as const;
const WORKSPACE_WRITE_OPERATIONS = ["send", "create", "resume", "set", "sleep", "close"] as const;
export const WORKSPACE_OPERATIONS = [...WORKSPACE_READ_OPERATIONS, ...WORKSPACE_WRITE_OPERATIONS] as const;
type WorkspaceWriteOperation = (typeof WORKSPACE_WRITE_OPERATIONS)[number];
export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[number];

/** Statuses an error reply may carry; anything else from the peer is a fault. */
const WORKSPACE_ERROR_STATUSES = [400, 401, 403, 404, 409, 413, 429, 503, 504] as const;
type WorkspaceErrorStatus = (typeof WORKSPACE_ERROR_STATUSES)[number];

/** Fixed classification used when the peer gives no usable code of its own. */
const STATUS_ERRORS: Readonly<Record<WorkspaceErrorStatus, string>> = {
  400: "invalid-request",
  401: "unauthorized",
  403: "forbidden",
  404: "not-found",
  409: "conflict",
  413: "too-large",
  429: "rate-limited",
  503: "unavailable",
  504: "timeout",
};
/** A write whose fate the gateway cannot know: it may or may not have run on the machine. */
export const OUTCOME_UNKNOWN = "outcome-unknown";
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AGENT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_.:@/-]{1,256}$/u;
const CURSOR_PATTERN = /^[\x21-\x7e]{1,1024}$/u;
/** Identifiers and labels: no control or bidi-override characters at all. */
const IDENTIFIER_FORBIDDEN = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
/** Free text keeps newlines and tabs; other controls are refused. */
const TEXT_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export const WORKSPACE_LIMITS = {
  id: 1024,
  path: 512,
  name: 128,
  project: 128,
  branch: 256,
  comment: 512,
  status: 64,
  pr: 1024,
  title: 256,
  preview: 240,
  snippet: 512,
  stage: 64,
  warning: 256,
  query: 256,
  sendText: 16_384,
  prompt: 32_768,
  entryText: 65_536,
  projects: 256,
  workspaces: 512,
  terminals: 512,
  models: 512,
  hits: 100,
  sessions: 200,
  entries: 500,
  warnings: 16,
} as const;

export interface WorkspaceModelRef {
  readonly provider: string;
  readonly id: string;
}

export interface WorkspaceArgs {
  readonly inventory: Record<string, never>;
  readonly search: { readonly query: string; readonly cursor?: string };
  readonly history: { readonly query?: string; readonly cursor?: string };
  /** `path` is the history/search row's path: an index filter on the host, never opened as a file. */
  readonly transcript: { readonly sessionId: string; readonly agent?: string; readonly path?: string; readonly cursor?: string };
  readonly send: { readonly handle: string; readonly text: string };
  readonly create: {
    readonly projectId: string;
    readonly name: string;
    readonly agent: string;
    readonly model?: WorkspaceModelRef;
    readonly prompt: string;
  };
  readonly resume: { readonly sessionId: string; readonly agent: string; readonly path?: string; readonly projectId?: string };
  readonly set: { readonly worktreeId: string; readonly status?: string; readonly comment?: string };
  readonly sleep: { readonly worktreeId: string };
  readonly close: { readonly worktreeId: string };
}

export interface WorkspaceProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}
export interface WorkspaceEntry {
  readonly id: string;
  readonly path: string;
  readonly project: string;
  readonly branch: string | null;
  readonly comment: string | null;
  readonly status: string | null;
  readonly unread: boolean;
  readonly pr: string | null;
  readonly host: string;
}
export interface WorkspaceTerminal {
  readonly handle: string;
  readonly title: string;
  readonly worktreeId: string | null;
  readonly path: string | null;
  readonly connected: boolean;
  readonly writable: boolean;
  readonly lastOutputAt: number | null;
  readonly preview: string | null;
  readonly agentType: string | null;
}
export interface WorkspaceModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
}
export interface WorkspaceSearchHit {
  readonly sessionId: string;
  readonly agent: string;
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
  readonly resumeCommand: string | null;
  readonly lastActivityAt: number | null;
  readonly host: string;
}
export interface WorkspaceHistorySession {
  readonly sessionId: string;
  readonly agent: string;
  readonly path: string;
  readonly title: string;
  readonly lastActivityAt: number | null;
  readonly preview: string | null;
  readonly host: string;
}
type WorkspaceTranscriptRole = "user" | "assistant" | "tool" | "system";
export interface WorkspaceTranscriptEntry {
  readonly role: WorkspaceTranscriptRole;
  readonly text: string;
  readonly at: number | null;
  readonly tool: string | null;
}

export interface WorkspaceData {
  readonly inventory: {
    readonly projects: readonly WorkspaceProject[];
    readonly workspaces: readonly WorkspaceEntry[];
    readonly terminals: readonly WorkspaceTerminal[];
    readonly models: readonly WorkspaceModel[];
  };
  readonly search: { readonly enabled: boolean; readonly hits: readonly WorkspaceSearchHit[]; readonly cursor: string | null };
  readonly history: { readonly sessions: readonly WorkspaceHistorySession[]; readonly cursor: string | null };
  readonly transcript: { readonly entries: readonly WorkspaceTranscriptEntry[]; readonly cursor: string | null; readonly title: string };
  readonly send: { readonly accepted: boolean; readonly requestId: string; readonly stage: string; readonly warnings: readonly string[] };
  readonly create: { readonly worktreeId: string; readonly terminalHandle: string | null; readonly accepted: boolean };
  readonly resume: { readonly worktreeId: string | null; readonly terminalHandle: string | null; readonly accepted: boolean };
  readonly set: { readonly updated: boolean };
  readonly sleep: { readonly sleeping: boolean };
  readonly close: { readonly closed: boolean };
}

export type WorkspaceRequest = {
  [Operation in WorkspaceOperation]: {
    readonly requestId: string;
    readonly host: string;
    readonly operation: Operation;
    readonly args: WorkspaceArgs[Operation];
  };
}[WorkspaceOperation];

export interface WorkspaceSuccess<Operation extends WorkspaceOperation = WorkspaceOperation> {
  readonly requestId: string;
  readonly ok: true;
  readonly data: WorkspaceData[Operation];
}
export interface WorkspaceFailure {
  readonly requestId?: string;
  readonly ok: false;
  readonly error: string;
}
export type WorkspaceResponse<Operation extends WorkspaceOperation = WorkspaceOperation> =
  | WorkspaceSuccess<Operation>
  | WorkspaceFailure;

export class WorkspaceValidationError extends Error {
  constructor() {
    super("invalid workspace message");
    this.name = "WorkspaceValidationError";
  }
}

export function isWriteOperation(operation: WorkspaceOperation): operation is WorkspaceWriteOperation {
  return (WORKSPACE_WRITE_OPERATIONS as readonly string[]).includes(operation);
}

type JsonRecord = Record<string, unknown>;

function fail(): never {
  throw new WorkspaceValidationError();
}

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail();
  for (const key of required) if (!Object.hasOwn(value, key)) fail();
}

function identifier(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || IDENTIFIER_FORBIDDEN.test(value)) fail();
  return value;
}

/** Labels and paths may be empty only when the contract says so; free text keeps newlines. */
function text(value: unknown, maximum: number, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.trim().length === 0)) fail();
  if (TEXT_FORBIDDEN.test(value)) fail();
  return value;
}

function label(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || IDENTIFIER_FORBIDDEN.test(value)) fail();
  return value;
}

function patterned(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) fail();
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}

function nullable<Value>(value: unknown, read: (value: unknown) => Value): Value | null {
  return value === null || value === undefined ? null : read(value);
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail();
  return value;
}

function list<Value>(value: unknown, maximum: number, read: (item: unknown) => Value): Value[] {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value.map(read);
}

function optionalCursor(value: unknown): string | undefined {
  return value === undefined ? undefined : patterned(value, CURSOR_PATTERN);
}

/** An absolute session path used only to narrow the host's index lookup. */
function optionalIndexPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const path = label(value, WORKSPACE_LIMITS.path);
  if (!path.startsWith("/")) fail();
  return path;
}

function host(value: unknown): string {
  return patterned(value, FLEET_HOST_PATTERN);
}

function modelRef(value: unknown): WorkspaceModelRef {
  const item = record(value);
  exactKeys(item, ["provider", "id"]);
  return { provider: identifier(item.provider, 64), id: identifier(item.id, WORKSPACE_LIMITS.name) };
}

/**
 * Drop `undefined` optionals so the strict request never names a key the sender omitted; the
 * result takes the type the calling switch arm returns.
 */
function compact<Out>(value: JsonRecord): Out {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value as Out;
}

function parseArgs(operation: WorkspaceOperation, value: unknown): WorkspaceArgs[WorkspaceOperation] {
  const args = record(value);
  switch (operation) {
    case "inventory":
      exactKeys(args, []);
      return {};
    case "search": {
      exactKeys(args, ["query"], ["cursor"]);
      return compact({ query: text(args.query, WORKSPACE_LIMITS.query, false), cursor: optionalCursor(args.cursor) });
    }
    case "history": {
      exactKeys(args, [], ["query", "cursor"]);
      const query = args.query === undefined ? undefined : text(args.query, WORKSPACE_LIMITS.query, false);
      return compact({ query, cursor: optionalCursor(args.cursor) });
    }
    case "transcript": {
      exactKeys(args, ["sessionId"], ["agent", "path", "cursor"]);
      return compact({
        sessionId: patterned(args.sessionId, TOKEN_PATTERN),
        agent: args.agent === undefined ? undefined : patterned(args.agent, AGENT_PATTERN),
        path: optionalIndexPath(args.path),
        cursor: optionalCursor(args.cursor),
      });
    }
    case "send":
      exactKeys(args, ["handle", "text"]);
      return { handle: patterned(args.handle, TOKEN_PATTERN), text: text(args.text, WORKSPACE_LIMITS.sendText, false) };
    case "create":
      exactKeys(args, ["projectId", "name", "agent", "prompt"], ["model"]);
      return compact({
        projectId: identifier(args.projectId, WORKSPACE_LIMITS.id),
        name: patterned(args.name, WORKTREE_NAME_PATTERN),
        agent: patterned(args.agent, AGENT_PATTERN),
        model: args.model === undefined ? undefined : modelRef(args.model),
        prompt: text(args.prompt, WORKSPACE_LIMITS.prompt, false),
      });
    case "resume":
      exactKeys(args, ["sessionId", "agent"], ["path", "projectId"]);
      return compact({
        sessionId: patterned(args.sessionId, TOKEN_PATTERN),
        agent: patterned(args.agent, AGENT_PATTERN),
        path: optionalIndexPath(args.path),
        projectId: args.projectId === undefined ? undefined : identifier(args.projectId, WORKSPACE_LIMITS.id),
      });
    case "set": {
      exactKeys(args, ["worktreeId"], ["status", "comment"]);
      if (args.status === undefined && args.comment === undefined) fail();
      return compact({
        worktreeId: identifier(args.worktreeId, WORKSPACE_LIMITS.id),
        status: args.status === undefined ? undefined : label(args.status, WORKSPACE_LIMITS.status),
        comment: args.comment === undefined ? undefined : text(args.comment, WORKSPACE_LIMITS.comment),
      });
    }
    case "sleep":
    case "close":
      exactKeys(args, ["worktreeId"]);
      return { worktreeId: identifier(args.worktreeId, WORKSPACE_LIMITS.id) };
  }
}

/** Strict reading of a request body, on both sides of the wire. Throws `WorkspaceValidationError`. */
export function parseWorkspaceRequest(value: unknown): WorkspaceRequest {
  const body = record(value);
  exactKeys(body, ["requestId", "host", "operation", "args"]);
  const requestId = patterned(body.requestId, UUID_PATTERN);
  const operation = body.operation;
  if (typeof operation !== "string" || !(WORKSPACE_OPERATIONS as readonly string[]).includes(operation)) fail();
  const typed = operation as WorkspaceOperation;
  return { requestId, host: host(body.host), operation: typed, args: parseArgs(typed, body.args) } as WorkspaceRequest;
}

/** The request id, when a malformed body still names a well-formed one, so the error can echo it. */
function salvageRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const requestId = (value as JsonRecord).requestId;
  return typeof requestId === "string" && UUID_PATTERN.test(requestId) ? requestId : undefined;
}

function sameHost(value: unknown, expected: string): string {
  if (host(value) !== expected) fail();
  return expected;
}

function parseData(operation: WorkspaceOperation, value: unknown, requestHost: string): WorkspaceData[WorkspaceOperation] {
  const data = record(value);
  const L = WORKSPACE_LIMITS;
  switch (operation) {
    case "inventory":
      exactKeys(data, ["projects", "workspaces", "terminals", "models"]);
      return {
        projects: list(data.projects, L.projects, (item) => {
          const project = record(item);
          exactKeys(project, ["id", "name", "path"]);
          return { id: identifier(project.id, L.id), name: label(project.name, L.project), path: label(project.path, L.path) };
        }),
        workspaces: list(data.workspaces, L.workspaces, (item) => {
          const entry = record(item);
          exactKeys(entry, ["id", "path", "project", "branch", "comment", "status", "unread", "pr", "host"]);
          return {
            id: identifier(entry.id, L.id),
            path: label(entry.path, L.path),
            project: label(entry.project, L.project),
            branch: nullable(entry.branch, (branch) => label(branch, L.branch)),
            comment: nullable(entry.comment, (comment) => text(comment, L.comment)),
            status: nullable(entry.status, (status) => label(status, L.status)),
            unread: bool(entry.unread),
            pr: nullable(entry.pr, (pr) => label(pr, L.pr)),
            host: sameHost(entry.host, requestHost),
          };
        }),
        terminals: list(data.terminals, L.terminals, (item) => {
          const terminal = record(item);
          exactKeys(terminal, ["handle", "title", "worktreeId", "path", "connected", "writable", "lastOutputAt", "preview", "agentType"]);
          const connected = bool(terminal.connected);
          return {
            handle: patterned(terminal.handle, TOKEN_PATTERN),
            title: label(terminal.title, L.title),
            worktreeId: nullable(terminal.worktreeId, (id) => identifier(id, L.id)),
            path: nullable(terminal.path, (path) => label(path, L.path)),
            connected,
            // A disconnected terminal is never offered for input, whatever the peer claims.
            writable: bool(terminal.writable) && connected,
            lastOutputAt: nullable(terminal.lastOutputAt, timestamp),
            preview: nullable(terminal.preview, (preview) => text(preview, L.preview)),
            agentType: nullable(terminal.agentType, (agent) => label(agent, 64)),
          };
        }),
        models: list(data.models, L.models, (item) => {
          const model = record(item);
          exactKeys(model, ["provider", "id", "name"]);
          return { provider: identifier(model.provider, 64), id: identifier(model.id, L.name), name: label(model.name, L.name) };
        }),
      };
    case "search":
      exactKeys(data, ["enabled", "hits"], ["cursor"]);
      return {
        enabled: bool(data.enabled),
        hits: list(data.hits, L.hits, (item) => {
          const hit = record(item);
          exactKeys(hit, ["sessionId", "agent", "path", "title", "snippet", "host"], ["resumeCommand", "lastActivityAt"]);
          return {
            sessionId: patterned(hit.sessionId, TOKEN_PATTERN),
            agent: patterned(hit.agent, AGENT_PATTERN),
            path: label(hit.path, L.path),
            title: label(hit.title, L.title),
            snippet: text(hit.snippet, L.snippet),
            resumeCommand: nullable(hit.resumeCommand, (command) => label(command, L.path)),
            lastActivityAt: nullable(hit.lastActivityAt, timestamp),
            host: sameHost(hit.host, requestHost),
          };
        }),
        cursor: nullable(data.cursor, (cursor) => patterned(cursor, CURSOR_PATTERN)),
      };
    case "history":
      exactKeys(data, ["sessions"], ["cursor"]);
      return {
        sessions: list(data.sessions, L.sessions, (item) => {
          const session = record(item);
          exactKeys(session, ["sessionId", "agent", "path", "title", "lastActivityAt", "preview", "host"]);
          return {
            sessionId: patterned(session.sessionId, TOKEN_PATTERN),
            agent: patterned(session.agent, AGENT_PATTERN),
            path: label(session.path, L.path),
            title: label(session.title, L.title),
            lastActivityAt: nullable(session.lastActivityAt, timestamp),
            preview: nullable(session.preview, (preview) => text(preview, L.preview)),
            host: sameHost(session.host, requestHost),
          };
        }),
        cursor: nullable(data.cursor, (cursor) => patterned(cursor, CURSOR_PATTERN)),
      };
    case "transcript":
      exactKeys(data, ["entries", "title"], ["cursor"]);
      return {
        entries: list(data.entries, L.entries, (item) => {
          const entry = record(item);
          exactKeys(entry, ["role", "text"], ["at", "tool"]);
          const role = entry.role;
          if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") fail();
          return {
            role,
            text: text(entry.text, L.entryText),
            at: nullable(entry.at, timestamp),
            tool: nullable(entry.tool, (tool) => label(tool, 64)),
          };
        }),
        cursor: nullable(data.cursor, (cursor) => patterned(cursor, CURSOR_PATTERN)),
        title: label(data.title, L.title),
      };
    case "send":
      exactKeys(data, ["accepted", "requestId", "stage"], ["warnings"]);
      return {
        accepted: bool(data.accepted),
        requestId: patterned(data.requestId, TOKEN_PATTERN),
        stage: patterned(data.stage, ERROR_CODE_PATTERN),
        warnings: data.warnings === undefined ? [] : list(data.warnings, L.warnings, (warning) => label(warning, L.warning)),
      };
    case "create":
      exactKeys(data, ["worktreeId", "accepted"], ["terminalHandle"]);
      return {
        worktreeId: identifier(data.worktreeId, L.id),
        terminalHandle: nullable(data.terminalHandle, (handle) => patterned(handle, TOKEN_PATTERN)),
        accepted: bool(data.accepted),
      };
    case "resume":
      exactKeys(data, ["accepted"], ["worktreeId", "terminalHandle"]);
      return {
        worktreeId: nullable(data.worktreeId, (id) => identifier(id, L.id)),
        terminalHandle: nullable(data.terminalHandle, (handle) => patterned(handle, TOKEN_PATTERN)),
        accepted: bool(data.accepted),
      };
    case "set":
      exactKeys(data, ["updated"]);
      return { updated: bool(data.updated) };
    case "sleep":
      exactKeys(data, ["sleeping"]);
      return { sleeping: bool(data.sleeping) };
    case "close":
      exactKeys(data, ["closed"]);
      return { closed: bool(data.closed) };
  }
}

function errorCode(status: WorkspaceErrorStatus, value: unknown): string {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value) ? value : STATUS_ERRORS[status];
}

function isErrorStatus(status: number): status is WorkspaceErrorStatus {
  return (WORKSPACE_ERROR_STATUSES as readonly number[]).includes(status);
}

/**
 * Strict reading of a reply to `request`: 200 only with `{requestId, ok:true, data}` for this very
 * request and operation, an error status only with `{ok:false, error}`. Any other pairing throws.
 */
export function parseWorkspaceResponse<Operation extends WorkspaceOperation>(
  status: number,
  value: unknown,
  request: { readonly requestId: string; readonly host: string; readonly operation: Operation },
): WorkspaceResponse<Operation> {
  const body = record(value);
  if (status === 200) {
    exactKeys(body, ["requestId", "ok", "data"]);
    if (body.ok !== true || body.requestId !== request.requestId) fail();
    return {
      requestId: request.requestId,
      ok: true,
      data: parseData(request.operation, body.data, request.host) as WorkspaceData[Operation],
    };
  }
  if (!isErrorStatus(status)) fail();
  exactKeys(body, ["ok", "error"], ["requestId"]);
  if (body.ok !== false) fail();
  if (body.requestId !== undefined && body.requestId !== request.requestId) fail();
  return { requestId: request.requestId, ok: false, error: errorCode(status, body.error) };
}

/** The bridge half the API needs; `FleetBridgeClient.workspace` is the real one. */
export interface WorkspaceBridge {
  workspace(request: WorkspaceRequest): Promise<{ readonly status: number; readonly body: unknown }>;
}

export interface WorkspaceApiOptions {
  readonly bridge: WorkspaceBridge;
  /**
   * Hosts the directory currently knows from the fleet listing. A host outside it is refused before
   * any bridge call; HarnessOS still validates the host itself at the execution boundary.
   */
  readonly isAuthorizedHost?: (host: string) => boolean;
}

export interface WorkspaceApiReply {
  readonly status: 200 | WorkspaceErrorStatus;
  readonly body: WorkspaceResponse;
}

export interface WorkspaceApi {
  /** `body` is the already size-bounded, JSON-parsed POST body of an authenticated request. */
  handle(body: unknown): Promise<WorkspaceApiReply>;
}

function failure(status: WorkspaceErrorStatus, error: string, requestId?: string): WorkspaceApiReply {
  return { status, body: requestId === undefined ? { ok: false, error } : { requestId, ok: false, error } };
}

/**
 * Validates, relays once, and revalidates. A read that fails is `unavailable`; a write whose reply
 * is lost or unreadable is `outcome-unknown` (504), never success and never a silent retry — the
 * client may resend the identical body, and the request id lets the operator dedupe it.
 *
 * A parsed bridge 401 or 403 is a HarnessOS service refusal (`token-refused`, `forbidden`), not
 * Cloudflare Access. The page treats those two statuses as sign-in loss, so they leave this
 * boundary as 503 and 409. The peer's error code is unchanged. Access JWT revalidation stays a
 * gateway 401 and never reaches here.
 */
export function createWorkspaceApi(options: WorkspaceApiOptions): WorkspaceApi {
  return {
    async handle(body: unknown): Promise<WorkspaceApiReply> {
      let request: WorkspaceRequest;
      try {
        request = parseWorkspaceRequest(body);
      } catch {
        return failure(400, "invalid-request", salvageRequestId(body));
      }
      if (options.isAuthorizedHost !== undefined && !options.isAuthorizedHost(request.host)) {
        return failure(404, "unknown-host", request.requestId);
      }
      const write = isWriteOperation(request.operation);
      const lost = (): WorkspaceApiReply =>
        write ? failure(504, OUTCOME_UNKNOWN, request.requestId) : failure(503, "unavailable", request.requestId);
      let reply: { readonly status: number; readonly body: unknown };
      try {
        reply = await options.bridge.workspace(request);
      } catch {
        return lost();
      }
      let response: WorkspaceResponse;
      try {
        response = parseWorkspaceResponse(reply.status, reply.body, request);
      } catch {
        return lost();
      }
      if (response.ok) return { status: 200, body: response };
      // After strict parse only: a peer 401/403 must not be mistaken for Access revocation.
      const status = (reply.status === 401 ? 503 : reply.status === 403 ? 409 : reply.status) as WorkspaceErrorStatus;
      return { status, body: response };
    },
  };
}
