/**
 * The workspace panel: Orca workspaces and terminals on each authorized fleet machine, full-text
 * search and past-session history with a read-only transcript, and the few mutations the RPC allows
 * (send, create, resume, set, sleep, close). Every call goes through one POST `/api/v1/workspace`.
 *
 * Two layers: `createWorkspaceController` owns state, request lifecycles and outcome classification
 * and needs no DOM; `createWorkspacePanel` renders it. Rules the controller enforces:
 * - Reads are abortable and generation-checked, so a late reply for a previous host, tab or query
 *   never lands. A failed read keeps the last data visibly marked stale.
 * - Writes are never aborted and never resent automatically. A lost or unreadable reply is
 *   `uncertain`; only the user can resend, and the resend reuses the exact body and request id so
 *   the operator's dedupe keeps it at most once.
 * - Nothing but cosmetic preferences (selected host and tab) reaches storage.
 */
import {
  MAX_WORKSPACE_RESPONSE_BYTES,
  OUTCOME_UNKNOWN,
  parseWorkspaceRequest,
  parseWorkspaceResponse,
  type WorkspaceArgs,
  type WorkspaceData,
  type WorkspaceEntry,
  type WorkspaceHistorySession,
  type WorkspaceModelRef,
  type WorkspaceOperation,
  type WorkspaceRequest,
  type WorkspaceResponse,
  type WorkspaceSearchHit,
  type WorkspaceTerminal,
  type WorkspaceTranscriptEntry,
} from "../../gateway/src/workspace.ts";

export type { WorkspaceRequest } from "../../gateway/src/workspace.ts";

export const WORKSPACE_PREFS_STORAGE_KEY = "omp.sessions.workspace-prefs.v1";
export const WORKSPACE_TABS = ["workspaces", "search", "history", "create"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

/** POSTs the body as JSON to `/api/v1/workspace` and returns the raw response. */
export type WorkspaceRequestFunction = (body: WorkspaceRequest, signal?: AbortSignal) => Promise<Response>;

export interface WorkspaceControllerOptions {
  readonly request: WorkspaceRequestFunction;
  /** The machines the current fleet listing authorizes, read on every call. */
  readonly hosts: () => readonly string[];
  /** Asks the directory to refresh its sessions, e.g. to discover a just-created agent. */
  readonly onRefresh?: () => void;
  /** Called when the gateway answers 401: the directory's own revocation path takes over. */
  readonly onAuthorizationLost?: () => void;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly randomUUID?: () => string;
}

export type ReadStatus = "idle" | "loading" | "ready" | "error";

export interface ReadSlot<Data> {
  readonly status: ReadStatus;
  readonly data: Data | null;
  /** Set when the last attempt failed; `data` is then the previous, stale result. */
  readonly error: string | null;
  readonly loadedAt: number | null;
}

export interface SearchHostResult {
  readonly status: ReadStatus;
  readonly enabled: boolean | null;
  readonly hits: readonly WorkspaceSearchHit[];
  readonly cursor: string | null;
  readonly error: string | null;
}

export interface TranscriptView {
  readonly host: string;
  readonly sessionId: string;
  /** The row's indexed path, sent back only as the host's index filter. */
  readonly path: string;
  readonly agent: string;
  readonly title: string;
  readonly origin: "search" | "history";
  readonly status: ReadStatus;
  readonly entries: readonly WorkspaceTranscriptEntry[];
  readonly cursor: string | null;
  readonly error: string | null;
}

export type WriteSlot = "send" | "create" | "resume" | "workspace";
/**
 * pending: awaiting the receipt. accepted: the machine took it (not yet running or delivered).
 * started: an agent terminal is running. done: the state change is confirmed. not-done: the
 * machine answered and did nothing. failed: refused before running. uncertain: may or may not
 * have run.
 */
export type WriteState = "pending" | "accepted" | "started" | "done" | "not-done" | "failed" | "uncertain";

export interface WriteRecord {
  readonly slot: WriteSlot;
  readonly request: WorkspaceRequest;
  readonly state: WriteState;
  readonly message: string;
  readonly warnings: readonly string[];
}

export interface WorkspaceState {
  readonly hosts: readonly string[];
  readonly host: string | null;
  readonly tab: WorkspaceTab;
  readonly online: boolean;
  readonly authorized: boolean;
  readonly inventory: ReadSlot<WorkspaceData["inventory"]>;
  readonly searchQuery: string;
  readonly searchHosts: readonly string[];
  readonly search: Readonly<Record<string, SearchHostResult>>;
  readonly historyQuery: string;
  readonly history: ReadSlot<{ readonly sessions: readonly WorkspaceHistorySession[]; readonly cursor: string | null }>;
  readonly transcript: TranscriptView | null;
  readonly selectedTerminal: string | null;
  readonly selectedWorkspace: string | null;
  readonly confirmClose: string | null;
  readonly writes: Readonly<Partial<Record<WriteSlot, WriteRecord>>>;
}

/** Why a write was refused locally, before any request left the page. */
export type WriteRefusal =
  | "unauthorized"
  | "offline"
  | "unknown-host"
  | "busy"
  | "no-target"
  | "read-only"
  | "invalid-input"
  | "not-confirmed"
  /** The slot's last write may have run: only its identical retry, or an acknowledged clear, may follow. */
  | "uncertain";

export interface WorkspaceController {
  getState(): WorkspaceState;
  subscribe(listener: (state: WorkspaceState) => void): () => void;
  hostsChanged(): void;
  selectHost(host: string): void;
  selectTab(tab: WorkspaceTab): void;
  loadInventory(): Promise<void>;
  search(query: string, hosts?: readonly string[]): Promise<void>;
  searchMore(host: string): Promise<void>;
  loadHistory(query?: string): Promise<void>;
  historyMore(): Promise<void>;
  openTranscript(target: { host: string; sessionId: string; agent: string; path: string; title: string; origin: "search" | "history" }): Promise<void>;
  transcriptMore(): Promise<void>;
  closeTranscript(): void;
  selectTerminal(handle: string | null): void;
  selectWorkspace(id: string | null): void;
  send(text: string): Promise<WriteRefusal | null>;
  create(input: { projectId: string; name: string; agent: string; model?: WorkspaceModelRef; prompt: string }): Promise<WriteRefusal | null>;
  resume(): Promise<WriteRefusal | null>;
  setWorkspace(input: { status?: string; comment?: string }): Promise<WriteRefusal | null>;
  sleepWorkspace(): Promise<WriteRefusal | null>;
  requestClose(): void;
  cancelClose(): void;
  confirmClose(): Promise<WriteRefusal | null>;
  /** Resend an uncertain write with the identical body and request id. Only on user action. */
  retry(slot: WriteSlot): Promise<WriteRefusal | null>;
  /**
   * Clears a settled receipt. An uncertain one is cleared only with `acknowledged` (the user
   * checked the machine), since clearing it is what allows a fresh request id.
   */
  dismiss(slot: WriteSlot, acknowledged?: boolean): void;
  setOnline(online: boolean): void;
  setAuthorized(authorized: boolean): void;
  dispose(): void;
}

const EMPTY_SLOT = { status: "idle", data: null, error: null, loadedAt: null } as const;
/** Error statuses after which a write certainly did not run. 503/504 may hide a run, so they don't. */
const DEFINITIVE_WRITE_FAILURES: Readonly<Record<number, true>> = {
  400: true,
  401: true,
  403: true,
  404: true,
  409: true,
  413: true,
  429: true,
};

type CallResult<Operation extends WorkspaceOperation> =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly response: WorkspaceResponse<Operation>;
      /** The gateway refused before relaying (`X-OMP-Workspace-Outcome: not-run`). */
      readonly notRun: boolean;
    }
  | { readonly kind: "lost"; readonly error: string }
  | { readonly kind: "aborted" };

function readPrefs(storage: WorkspaceControllerOptions["storage"]): { host: string | null; tab: WorkspaceTab } {
  const fallback = { host: null, tab: "workspaces" as WorkspaceTab };
  try {
    const raw = storage?.getItem(WORKSPACE_PREFS_STORAGE_KEY);
    if (raw === null || raw === undefined || raw.length > 512) return fallback;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return fallback;
    const { host, tab } = value as { host?: unknown; tab?: unknown };
    return {
      host: typeof host === "string" && host.length <= 63 ? host : null,
      tab: (WORKSPACE_TABS as readonly unknown[]).includes(tab) ? (tab as WorkspaceTab) : "workspaces",
    };
  } catch {
    return fallback;
  }
}

/**
 * The registered identity of a saved session, as the host's index knows it. The row path narrows
 * the index lookup (Orca's window can miss older sessions without it); it is omitted when not
 * absolute, since the host only accepts absolute filters and never opens it.
 */
function sessionRef(view: { readonly sessionId: string; readonly agent: string; readonly path: string }): {
  sessionId: string;
  agent: string;
  path?: string;
} {
  return view.path.startsWith("/")
    ? { sessionId: view.sessionId, agent: view.agent, path: view.path }
    : { sessionId: view.sessionId, agent: view.agent };
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const type = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new Error("not json");
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > MAX_WORKSPACE_RESPONSE_BYTES) throw new Error("too large");
  const body = await response.text();
  if (body.length > MAX_WORKSPACE_RESPONSE_BYTES) throw new Error("too large");
  return JSON.parse(body);
}

export function createWorkspaceController(options: WorkspaceControllerOptions): WorkspaceController {
  const uuid = options.randomUUID ?? (() => crypto.randomUUID());
  const prefs = readPrefs(options.storage);
  const listeners = new Set<(state: WorkspaceState) => void>();
  const reads = new Map<string, AbortController>();
  let disposed = false;

  const initialHosts = [...options.hosts()];
  let state: WorkspaceState = {
    hosts: initialHosts,
    host: prefs.host !== null && initialHosts.includes(prefs.host) ? prefs.host : (initialHosts[0] ?? null),
    tab: prefs.tab,
    online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
    authorized: true,
    inventory: EMPTY_SLOT,
    searchQuery: "",
    searchHosts: initialHosts,
    search: {},
    historyQuery: "",
    history: EMPTY_SLOT,
    transcript: null,
    selectedTerminal: null,
    selectedWorkspace: null,
    confirmClose: null,
    writes: {},
  };

  function update(patch: Partial<WorkspaceState>): void {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function savePrefs(): void {
    try {
      options.storage?.setItem(WORKSPACE_PREFS_STORAGE_KEY, JSON.stringify({ host: state.host, tab: state.tab }));
    } catch {
      // Cosmetic only.
    }
  }

  function abortRead(key: string): void {
    reads.get(key)?.abort();
    reads.delete(key);
  }

  function abortReadsMatching(prefix: string): void {
    for (const key of [...reads.keys()]) if (key.startsWith(prefix)) abortRead(key);
  }

  /**
   * One HTTP round trip, classified. `operation` is the caller's static view of `body.operation`;
   * the reply is parsed against it, so a reply for another request id or host never parses.
   */
  async function call<Operation extends WorkspaceOperation>(
    body: WorkspaceRequest,
    operation: Operation,
    signal?: AbortSignal,
  ): Promise<CallResult<Operation>> {
    // A call, not a property read: TypeScript must not carry an earlier `false` across awaits.
    const aborted = (): boolean => signal?.aborted === true;
    let response: Response;
    try {
      response = await options.request(body, signal);
    } catch (error) {
      if (aborted() || (error instanceof DOMException && error.name === "AbortError")) return { kind: "aborted" };
      return { kind: "lost", error: "network" };
    }
    if (aborted()) return { kind: "aborted" };
    if (response.status === 401) options.onAuthorizationLost?.();
    try {
      const json = await readJsonBounded(response);
      if (aborted()) return { kind: "aborted" };
      const expected = { requestId: body.requestId, host: body.host, operation };
      const notRun = response.headers.get("X-OMP-Workspace-Outcome") === "not-run";
      return { kind: "response", status: response.status, response: parseWorkspaceResponse(response.status, json, expected), notRun };
    } catch {
      if (aborted()) return { kind: "aborted" };
      return { kind: "lost", error: response.ok ? "invalid-response" : `http-${response.status}` };
    }
  }

  /** A fresh request, validated by the same parser the gateway uses; `null` when the input is invalid. */
  function buildRequest<Operation extends WorkspaceOperation>(
    host: string,
    operation: Operation,
    args: WorkspaceArgs[Operation],
  ): WorkspaceRequest | null {
    try {
      return parseWorkspaceRequest({ requestId: uuid(), host, operation, args });
    } catch {
      return null;
    }
  }

  /**
   * Runs a read in `key`, aborting the previous one there. Resolves to the data, or to an error
   * string, or to `undefined` when superseded — the caller then changes nothing.
   */
  async function runRead<Operation extends WorkspaceOperation>(
    key: string,
    host: string,
    operation: Operation,
    args: WorkspaceArgs[Operation],
  ): Promise<{ data: WorkspaceData[Operation] } | { error: string } | undefined> {
    if (!options.hosts().includes(host)) return { error: "unknown-host" };
    if (!state.authorized) return { error: "unauthorized" };
    const body = buildRequest(host, operation, args);
    if (body === null) return { error: "invalid-input" };
    abortRead(key);
    const controller = new AbortController();
    reads.set(key, controller);
    const result = await call(body, operation, controller.signal);
    if (reads.get(key) !== controller) return undefined;
    reads.delete(key);
    if (result.kind === "aborted" || disposed) return undefined;
    if (result.kind === "lost") return { error: result.error };
    return result.response.ok ? { data: result.response.data } : { error: result.response.error };
  }

  function writeRefusal(slot: WriteSlot, request: WorkspaceRequest): WriteRefusal | null {
    if (!state.authorized) return "unauthorized";
    if (!state.online) return "offline";
    if (!options.hosts().includes(request.host) || !state.hosts.includes(request.host)) return "unknown-host";
    const record = state.writes[slot];
    if (record?.state === "pending") return "busy";
    // A fresh id after doubt could run the same action twice; only the identical body may go.
    if (record?.state === "uncertain" && record.request !== request) return "uncertain";
    return null;
  }

  function classify(request: WorkspaceRequest, result: CallResult<WorkspaceOperation>): Omit<WriteRecord, "slot" | "request"> {
    if (result.kind !== "response") {
      return {
        state: "uncertain",
        message: "No readable receipt — it may or may not have run. Check the machine before retrying.",
        warnings: [],
      };
    }
    const { response, status } = result;
    if (!response.ok) {
      // Only the gateway's pre-relay 503 is marked; any other 503 may still hide a run.
      const refusedBeforeRelay = status === 503 && response.error === "unavailable" && result.notRun;
      if ((!DEFINITIVE_WRITE_FAILURES[status] && !refusedBeforeRelay) || response.error === OUTCOME_UNKNOWN) {
        return { state: "uncertain", message: `Outcome unknown (${response.error}) — it may have run.`, warnings: [] };
      }
      return { state: "failed", message: `Refused: ${response.error}. Nothing ran.`, warnings: [] };
    }
    // The reply was parsed against `request.operation`; the key checks narrow the data union to it.
    const data = response.data;
    const operation = request.operation;
    if (operation === "send" && "stage" in data) {
      return data.accepted
        ? { state: "accepted", message: `Accepted by ${request.host} (${data.stage}); delivery is the agent's.`, warnings: data.warnings }
        : { state: "not-done", message: `Not accepted (${data.stage}). Nothing was typed.`, warnings: data.warnings };
    }
    if ((operation === "create" || operation === "resume") && "terminalHandle" in data) {
      if (!data.accepted) return { state: "not-done", message: "Not accepted. No workspace was started.", warnings: [] };
      const worktree = data.worktreeId === null ? "" : ` workspace ${data.worktreeId}`;
      return data.terminalHandle === null
        ? { state: "accepted", message: `Accepted:${worktree}. The agent has not been seen starting yet.`, warnings: [] }
        : { state: "started", message: `Started:${worktree}, terminal ${data.terminalHandle}.`, warnings: [] };
    }
    if (operation === "set" && "updated" in data) {
      return data.updated ? { state: "done", message: "Saved.", warnings: [] } : { state: "not-done", message: "Not saved.", warnings: [] };
    }
    if (operation === "sleep" && "sleeping" in data) {
      return data.sleeping
        ? { state: "done", message: "Workspace is asleep.", warnings: [] }
        : { state: "not-done", message: "Workspace did not sleep.", warnings: [] };
    }
    if (operation === "close" && "closed" in data) {
      return data.closed
        ? { state: "done", message: "Terminals closed. The worktree and its files are kept.", warnings: [] }
        : { state: "not-done", message: "Terminals were not closed.", warnings: [] };
    }
    return { state: "uncertain", message: "Unexpected receipt.", warnings: [] };
  }

  function afterWrite(record: WriteRecord): void {
    const succeeded = record.state === "accepted" || record.state === "started" || record.state === "done";
    if (!succeeded) return;
    const operation = record.request.operation;
    if (operation === "create" || operation === "resume") options.onRefresh?.();
    if (operation !== "send" && record.request.host === state.host) void controller.loadInventory();
  }

  /**
   * Sends one write and records its receipt. `request` comes from `buildRequest` (already
   * validated) or is a stored record's, so a retry is byte-identical.
   */
  async function runWrite(slot: WriteSlot, request: WorkspaceRequest | null): Promise<WriteRefusal | null> {
    if (request === null) return "invalid-input";
    const refusal = writeRefusal(slot, request);
    if (refusal !== null) return refusal;
    const wasUncertain = state.writes[slot]?.state === "uncertain";
    update({
      writes: {
        ...state.writes,
        [slot]: { slot, request, state: "pending", message: "Waiting for the machine's receipt…", warnings: [] },
      },
    });
    // Writes take no abort signal: abandoning one mid-flight would only turn a receipt into doubt.
    const result = await call(request, request.operation);
    let outcome = classify(request, result);
    const positive = outcome.state === "accepted" || outcome.state === "started" || outcome.state === "done";
    // A retry's refusal says nothing about the first attempt, which may still have run; only a
    // positive receipt for this request id, or the user's acknowledgement, ends the doubt.
    if (wasUncertain && !positive && outcome.state !== "uncertain") {
      outcome = {
        state: "uncertain",
        message: `Retry was refused (${outcome.message}) — the original request may still have run. Check the machine.`,
        warnings: outcome.warnings,
      };
    }
    const record: WriteRecord = { slot, request, ...outcome };
    update({ writes: { ...state.writes, [slot]: record } });
    afterWrite(record);
    return null;
  }

  function selectedWorkspaceEntry(): WorkspaceEntry | null {
    const id = state.selectedWorkspace;
    return state.inventory.data?.workspaces.find((entry) => entry.id === id) ?? null;
  }

  /**
   * State tied to the selected machine. A transcript opened from search names its own host and
   * survives a host switch while that host stays authorized; one opened from history does not.
   */
  function resetHostScoped(hosts: readonly string[]): Partial<WorkspaceState> {
    abortRead("inventory");
    abortRead("history");
    const view = state.transcript;
    const keep = view !== null && view.origin === "search" && hosts.includes(view.host);
    if (!keep) abortRead("transcript");
    return {
      inventory: EMPTY_SLOT,
      history: EMPTY_SLOT,
      transcript: keep ? view : null,
      selectedTerminal: null,
      selectedWorkspace: null,
      confirmClose: null,
    };
  }

  const controller: WorkspaceController = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    hostsChanged() {
      const hosts = [...options.hosts()];
      // The directory calls this on every listing; an unchanged fleet changes nothing and fetches nothing.
      if (hosts.length === state.hosts.length && hosts.every((name, index) => name === state.hosts[index])) return;
      const host = state.host !== null && hosts.includes(state.host) ? state.host : (hosts[0] ?? null);
      for (const key of [...reads.keys()]) {
        if (key.startsWith("search:") && !hosts.includes(key.slice("search:".length))) abortRead(key);
      }
      let patch: Partial<WorkspaceState>;
      if (host !== state.host) {
        patch = resetHostScoped(hosts);
      } else {
        const view = state.transcript;
        const keep = view === null || hosts.includes(view.host);
        if (!keep) abortRead("transcript");
        patch = { transcript: keep ? view : null };
      }
      update({
        ...patch,
        hosts,
        host,
        search: Object.fromEntries(Object.entries(state.search).filter(([name]) => hosts.includes(name))),
        searchHosts: state.searchHosts.filter((name) => hosts.includes(name)).concat(hosts.filter((name) => !state.hosts.includes(name))),
      });
    },

    selectHost(host) {
      if (host === state.host || !state.hosts.includes(host)) return;
      update({ ...resetHostScoped(state.hosts), host });
      savePrefs();
      if (state.tab === "workspaces" || state.tab === "create") void controller.loadInventory();
      if (state.tab === "history") void controller.loadHistory(state.historyQuery);
    },

    selectTab(tab) {
      if (tab === state.tab) return;
      const leaving = state.tab;
      if (leaving === "search") abortReadsMatching("search:");
      if (leaving === "history") abortRead("history");
      // Abort drops the in-flight reply. A slot with no loaded data cannot stay loading forever;
      // loaded pages stay ready so a later More can run again.
      if (leaving === "history" && state.history.status === "loading") {
        update({ history: state.history.data === null ? EMPTY_SLOT : { ...state.history, status: "ready", error: null } });
      }
      if (leaving === "search") {
        const search = { ...state.search };
        let changed = false;
        for (const [host, result] of Object.entries(search)) {
          if (result.status !== "loading") continue;
          changed = true;
          search[host] = result.hits.length === 0
            ? { status: "idle", enabled: null, hits: [], cursor: null, error: null }
            : { ...result, status: "ready", error: null };
        }
        if (changed) update({ search });
      }
      if (state.transcript !== null && state.transcript.origin === leaving) abortRead("transcript");
      update({ tab, confirmClose: null });
      savePrefs();
      if ((tab === "workspaces" || tab === "create") && state.inventory.status === "idle") void controller.loadInventory();
      if (tab === "history" && state.history.status === "idle") void controller.loadHistory(state.historyQuery);
    },

    async loadInventory() {
      const host = state.host;
      if (host === null) return;
      update({ inventory: { ...state.inventory, status: "loading", error: null } });
      const result = await runRead("inventory", host, "inventory", {});
      if (result === undefined || state.host !== host) return;
      if ("data" in result) {
        const data = result.data;
        const keepTerminal = data.terminals.some((terminal) => terminal.handle === state.selectedTerminal);
        const keepWorkspace = data.workspaces.some((entry) => entry.id === state.selectedWorkspace);
        update({
          inventory: { status: "ready", data, error: null, loadedAt: Date.now() },
          selectedTerminal: keepTerminal ? state.selectedTerminal : null,
          selectedWorkspace: keepWorkspace ? state.selectedWorkspace : null,
          confirmClose: keepWorkspace ? state.confirmClose : null,
        });
      } else {
        update({ inventory: { ...state.inventory, status: "error", error: result.error } });
      }
    },

    async search(query, hosts) {
      const trimmed = query.trim();
      const targets = (hosts ?? state.searchHosts).filter((host) => state.hosts.includes(host));
      abortReadsMatching("search:");
      if (trimmed.length === 0) {
        update({ searchQuery: "", searchHosts: targets, search: {} });
        return;
      }
      const loading: Record<string, SearchHostResult> = {};
      for (const host of targets) loading[host] = { status: "loading", enabled: null, hits: [], cursor: null, error: null };
      update({ searchQuery: trimmed, searchHosts: targets, search: loading });
      await Promise.all(
        targets.map(async (host) => {
          const result = await runRead(`search:${host}`, host, "search", { query: trimmed });
          if (result === undefined || state.searchQuery !== trimmed) return;
          const entry: SearchHostResult =
            "data" in result
              ? { status: "ready", enabled: result.data.enabled, hits: result.data.hits, cursor: result.data.cursor, error: null }
              : { status: "error", enabled: null, hits: [], cursor: null, error: result.error };
          update({ search: { ...state.search, [host]: entry } });
        }),
      );
    },

    async searchMore(host) {
      const current = state.search[host];
      const query = state.searchQuery;
      if (current === undefined || current.cursor === null || current.status === "loading") return;
      update({ search: { ...state.search, [host]: { ...current, status: "loading", error: null } } });
      const result = await runRead(`search:${host}`, host, "search", { query, cursor: current.cursor });
      if (result === undefined || state.searchQuery !== query) return;
      const latest = state.search[host] ?? current;
      update({
        search: {
          ...state.search,
          [host]:
            "data" in result
              ? { status: "ready", enabled: result.data.enabled, hits: [...latest.hits, ...result.data.hits], cursor: result.data.cursor, error: null }
              : { ...latest, status: "error", error: result.error },
        },
      });
    },

    async loadHistory(query = "") {
      const host = state.host;
      if (host === null) return;
      const trimmed = query.trim();
      update({ historyQuery: trimmed, history: { ...state.history, status: "loading", error: null } });
      const args: WorkspaceArgs["history"] = trimmed.length === 0 ? {} : { query: trimmed };
      const result = await runRead("history", host, "history", args);
      if (result === undefined || state.host !== host || state.historyQuery !== trimmed) return;
      update({
        history:
          "data" in result
            ? { status: "ready", data: result.data, error: null, loadedAt: Date.now() }
            : { ...state.history, status: "error", error: result.error },
      });
    },

    async historyMore() {
      const host = state.host;
      const current = state.history.data;
      if (host === null || current === null || current.cursor === null || state.history.status === "loading") return;
      const query = state.historyQuery;
      update({ history: { ...state.history, status: "loading", error: null } });
      const args: WorkspaceArgs["history"] = query.length === 0 ? { cursor: current.cursor } : { query, cursor: current.cursor };
      const result = await runRead("history", host, "history", args);
      if (result === undefined || state.host !== host || state.historyQuery !== query) return;
      update({
        history:
          "data" in result
            ? {
                status: "ready",
                data: { sessions: [...current.sessions, ...result.data.sessions], cursor: result.data.cursor },
                error: null,
                loadedAt: Date.now(),
              }
            : { ...state.history, status: "error", error: result.error },
      });
    },

    async openTranscript(target) {
      const view: TranscriptView = { ...target, status: "loading", entries: [], cursor: null, error: null };
      update({ transcript: view });
      const result = await runRead("transcript", target.host, "transcript", sessionRef(target));
      const current = state.transcript;
      if (result === undefined || current === null || current.sessionId !== target.sessionId || current.host !== target.host) return;
      update({
        transcript:
          "data" in result
            ? { ...current, status: "ready", title: result.data.title || current.title, entries: result.data.entries, cursor: result.data.cursor }
            : { ...current, status: "error", error: result.error },
      });
    },

    async transcriptMore() {
      const view = state.transcript;
      if (view === null || view.cursor === null || view.status === "loading") return;
      update({ transcript: { ...view, status: "loading", error: null } });
      const result = await runRead("transcript", view.host, "transcript", { ...sessionRef(view), cursor: view.cursor });
      const current = state.transcript;
      if (result === undefined || current === null || current.sessionId !== view.sessionId || current.host !== view.host) return;
      update({
        transcript:
          "data" in result
            ? { ...current, status: "ready", entries: [...current.entries, ...result.data.entries], cursor: result.data.cursor }
            : { ...current, status: "error", error: result.error },
      });
    },

    closeTranscript() {
      abortRead("transcript");
      update({ transcript: null });
    },

    selectTerminal(handle) {
      update({ selectedTerminal: handle });
    },

    selectWorkspace(id) {
      update({ selectedWorkspace: id, confirmClose: null });
    },

    async send(text) {
      const host = state.host;
      if (!state.authorized) return "unauthorized";
      if (host === null) return "unknown-host";
      const terminal: WorkspaceTerminal | undefined = state.inventory.data?.terminals.find(
        (candidate) => candidate.handle === state.selectedTerminal,
      );
      if (terminal === undefined) return "no-target";
      if (!terminal.connected || !terminal.writable) return "read-only";
      const previous = state.writes.send;
      // Resubmitting the same text to the same terminal after doubt keeps the id, so it dedupes.
      const reuse =
        previous?.state === "uncertain" &&
        previous.request.host === host &&
        previous.request.operation === "send" &&
        previous.request.args.handle === terminal.handle &&
        previous.request.args.text === text;
      return runWrite("send", reuse && previous !== undefined ? previous.request : buildRequest(host, "send", { handle: terminal.handle, text }));
    },

    async create(input) {
      const host = state.host;
      if (!state.authorized) return "unauthorized";
      if (host === null) return "unknown-host";
      if (!state.inventory.data?.projects.some((project) => project.id === input.projectId)) return "no-target";
      const args: WorkspaceArgs["create"] =
        input.model === undefined
          ? { projectId: input.projectId, name: input.name.trim(), agent: input.agent.trim(), prompt: input.prompt }
          : { projectId: input.projectId, name: input.name.trim(), agent: input.agent.trim(), model: input.model, prompt: input.prompt };
      return runWrite("create", buildRequest(host, "create", args));
    },

    async resume() {
      const view = state.transcript;
      if (!state.authorized) return "unauthorized";
      if (view === null) return "no-target";
      return runWrite("resume", buildRequest(view.host, "resume", sessionRef(view)));
    },

    async setWorkspace(input) {
      const host = state.host;
      const entry = selectedWorkspaceEntry();
      if (!state.authorized) return "unauthorized";
      if (host === null) return "unknown-host";
      if (entry === null) return "no-target";
      const args: { worktreeId: string; status?: string; comment?: string } = { worktreeId: entry.id };
      if (input.status !== undefined) args.status = input.status.trim();
      if (input.comment !== undefined) args.comment = input.comment;
      return runWrite("workspace", buildRequest(host, "set", args));
    },

    async sleepWorkspace() {
      const host = state.host;
      const entry = selectedWorkspaceEntry();
      if (!state.authorized) return "unauthorized";
      if (host === null) return "unknown-host";
      if (entry === null) return "no-target";
      return runWrite("workspace", buildRequest(host, "sleep", { worktreeId: entry.id }));
    },

    requestClose() {
      const entry = selectedWorkspaceEntry();
      if (entry !== null) update({ confirmClose: entry.id });
    },

    cancelClose() {
      update({ confirmClose: null });
    },

    async confirmClose() {
      const host = state.host;
      const entry = selectedWorkspaceEntry();
      if (!state.authorized) return "unauthorized";
      if (host === null) return "unknown-host";
      if (entry === null) return "no-target";
      if (state.confirmClose !== entry.id) return "not-confirmed";
      update({ confirmClose: null });
      return runWrite("workspace", buildRequest(host, "close", { worktreeId: entry.id }));
    },

    async retry(slot) {
      const record = state.writes[slot];
      if (record === undefined || record.state !== "uncertain") return "no-target";
      return runWrite(slot, record.request);
    },

    dismiss(slot, acknowledged = false) {
      const record = state.writes[slot];
      if (record === undefined || record.state === "pending" || (record.state === "uncertain" && !acknowledged)) return;
      const writes = { ...state.writes };
      delete writes[slot];
      update({ writes });
    },

    setOnline(online) {
      if (online !== state.online) update({ online });
    },

    setAuthorized(authorized) {
      if (authorized === state.authorized) return;
      if (!authorized) {
        for (const key of [...reads.keys()]) abortRead(key);
        // Revocation drops everything fetched under the old grant; pending write receipts stay visible.
        update({
          authorized,
          inventory: EMPTY_SLOT,
          search: {},
          history: EMPTY_SLOT,
          transcript: null,
          selectedTerminal: null,
          selectedWorkspace: null,
          confirmClose: null,
        });
        return;
      }
      update({ authorized });
    },

    dispose() {
      for (const key of [...reads.keys()]) abortRead(key);
      listeners.clear();
      disposed = true;
    },
  };
  return controller;
}

// ---------------------------------------------------------------------------------------------
// DOM

export interface WorkspacePanelOptions extends WorkspaceControllerOptions {
  readonly document?: Document;
  /**
   * Renders one transcript entry's text. Pass the collab client's sanitizing Markdown helper; it
   * must never inject raw HTML. Without it, text is rendered as plain text.
   */
  readonly renderMarkdown?: (text: string) => Node;
}

export interface WorkspacePanel {
  /** Header button that opens the panel; append it to the directory masthead. */
  readonly launcher: HTMLButtonElement;
  /** Append to `document.body`. */
  readonly dialog: HTMLDialogElement;
  readonly controller: WorkspaceController;
  /**
   * Another button that opens the same panel, e.g. for the collab session header. It is disabled
   * with the main launcher on revocation and released by `dispose`.
   */
  createLauncher(className?: string): HTMLButtonElement;
  /** Detaches and forgets a button from `createLauncher`; the main `launcher` is kept. */
  releaseLauncher(element: HTMLButtonElement): void;
  open(): void;
  close(): void;
  /** Call whenever the directory's fleet host list changes; unchanged lists are free. */
  hostsChanged(): void;
  /** `false` the moment authorization is lost (launchers disabled, data dropped), `true` once back. */
  setAuthorized(authorized: boolean): void;
  /** True while any write awaits its receipt or may have run; a page reload would lose that receipt. */
  hasUnsettledWrites(): boolean;
  dispose(): void;
}

const TAB_LABELS: Readonly<Record<WorkspaceTab, string>> = {
  workspaces: "Workspaces",
  search: "Search",
  history: "History",
  create: "New",
};
const AGENT_SUGGESTIONS = ["omp", "claude", "codex"] as const;
const SVG_NS = "http://www.w3.org/2000/svg";
/** C0 controls other than tab/newline, DEL and bidi overrides never reach the page. */
const UNSAFE_DISPLAY = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;

function displayText(value: string): string {
  return value.replace(UNSAFE_DISPLAY, "");
}

function ago(at: number | null, now: number): string {
  if (at === null) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function createWorkspacePanel(options: WorkspacePanelOptions): WorkspacePanel {
  const doc = options.document ?? document;
  const controller = createWorkspaceController(options);

  function el<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className?: string, text?: string): HTMLElementTagNameMap[Tag] {
    const element = doc.createElement(tag);
    if (className !== undefined) element.className = className;
    if (text !== undefined) element.textContent = displayText(text);
    return element;
  }

  function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const element = el("button", `wsp-button ${className}`, label);
    element.type = "button";
    element.addEventListener("click", onClick);
    return element;
  }

  // Launchers -------------------------------------------------------------------------------
  const launchers = new Set<HTMLButtonElement>();
  const onLauncher = (): void => panel.open();
  function makeLauncher(className: string): HTMLButtonElement {
    const element = el("button", className);
    element.type = "button";
    element.setAttribute("aria-haspopup", "dialog");
    element.setAttribute("aria-label", "Workspaces");
    const icon = doc.createElementNS(SVG_NS, "svg");
    icon.setAttribute("width", "20");
    icon.setAttribute("height", "20");
    icon.setAttribute("viewBox", "0 0 20 20");
    icon.setAttribute("aria-hidden", "true");
    for (const [x, y] of [
      [3, 3],
      [11, 3],
      [3, 11],
      [11, 11],
    ] as const) {
      const rect = doc.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", "6");
      rect.setAttribute("height", "6");
      rect.setAttribute("rx", "1.5");
      rect.setAttribute("fill", "none");
      rect.setAttribute("stroke", "currentColor");
      rect.setAttribute("stroke-width", "1.6");
      icon.append(rect);
    }
    element.append(icon);
    element.addEventListener("click", onLauncher);
    launchers.add(element);
    syncLaunchers();
    return element;
  }
  /** No fleet, no launcher: the panel has nothing to act on. Authorization only disables. */
  function syncLaunchers(): void {
    const state = controller.getState();
    for (const element of launchers) {
      element.hidden = state.hosts.length === 0;
      element.disabled = !state.authorized;
    }
  }
  const launcher = makeLauncher("settings-button wsp-launcher");

  // Dialog skeleton --------------------------------------------------------------------------
  const dialog = el("dialog", "notification-sheet wsp-dialog");
  dialog.setAttribute("aria-labelledby", "wsp-title");
  const handle = el("div", "notification-sheet-handle");
  handle.setAttribute("aria-hidden", "true");
  const header = el("header", "wsp-header");
  const titleBox = el("div");
  titleBox.append(el("p", "sheet-kicker", "OMP Sessions"));
  const title = el("h2", undefined, "Workspaces");
  title.id = "wsp-title";
  titleBox.append(title);
  const closeButton = button("Close", "sheet-close", () => panel.close());
  closeButton.setAttribute("aria-label", "Close workspaces");
  header.append(titleBox, closeButton);

  const toolbar = el("div", "wsp-toolbar");
  const hostLabel = el("label", "wsp-field wsp-host");
  hostLabel.append(el("span", "wsp-label", "Machine"));
  const hostSelect = el("select", "wsp-input");
  hostSelect.addEventListener("change", () => controller.selectHost(hostSelect.value));
  hostLabel.append(hostSelect);
  const refreshButton = button("Refresh", "wsp-secondary", () => {
    const { tab } = controller.getState();
    if (tab === "history") void controller.loadHistory(controller.getState().historyQuery);
    else if (tab === "search") void controller.search(controller.getState().searchQuery);
    else void controller.loadInventory();
  });
  toolbar.append(hostLabel, refreshButton);

  const notice = el("p", "wsp-notice");
  notice.setAttribute("role", "status");
  notice.hidden = true;

  const tablist = el("div", "wsp-tabs");
  tablist.setAttribute("role", "tablist");
  const tabButtons = new Map<WorkspaceTab, HTMLButtonElement>();
  const tabPanels = new Map<WorkspaceTab, HTMLElement>();
  for (const tab of WORKSPACE_TABS) {
    const tabButton = button(TAB_LABELS[tab], "wsp-tab", () => controller.selectTab(tab));
    tabButton.setAttribute("role", "tab");
    tabButton.id = `wsp-tab-${tab}`;
    tabButton.setAttribute("aria-controls", `wsp-panel-${tab}`);
    tabButtons.set(tab, tabButton);
    tablist.append(tabButton);
    const section = el("section", "wsp-panel");
    section.id = `wsp-panel-${tab}`;
    section.setAttribute("role", "tabpanel");
    section.setAttribute("aria-labelledby", tabButton.id);
    tabPanels.set(tab, section);
  }
  const body = el("div", "wsp-body");
  body.append(...tabPanels.values());

  // Workspaces tab ----------------------------------------------------------------------------
  const inventoryStatus = el("p", "wsp-meta");
  const inventoryList = el("div", "wsp-list");
  const actions = el("div", "wsp-actions");

  const composer = el("form", "wsp-form wsp-composer");
  const composerTarget = el("p", "wsp-meta");
  const composerText = el("textarea", "wsp-input wsp-textarea");
  composerText.rows = 3;
  composerText.maxLength = 16_384;
  composerText.setAttribute("aria-label", "Text to send to the terminal");
  const composerSend = el("button", "wsp-button wsp-primary", "Send");
  composerSend.type = "submit";
  const composerOutcome = el("div", "wsp-outcome");
  composer.append(composerTarget, composerText, composerSend, composerOutcome);
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.send(composerText.value).then((refusal) => showRefusal(composerOutcome, refusal));
  });

  const editor = el("form", "wsp-form wsp-editor");
  const editorTarget = el("p", "wsp-meta");
  const statusLabel = el("label", "wsp-field");
  statusLabel.append(el("span", "wsp-label", "Status"));
  const statusInput = el("input", "wsp-input");
  statusInput.maxLength = 64;
  statusLabel.append(statusInput);
  const commentLabel = el("label", "wsp-field");
  commentLabel.append(el("span", "wsp-label", "Comment"));
  const commentInput = el("textarea", "wsp-input wsp-textarea");
  commentInput.rows = 2;
  commentInput.maxLength = 512;
  commentLabel.append(commentInput);
  const editorButtons = el("div", "wsp-row");
  const saveButton = el("button", "wsp-button wsp-primary", "Save");
  saveButton.type = "submit";
  const sleepButton = button("Sleep", "wsp-secondary", () => {
    void controller.sleepWorkspace().then((refusal) => showRefusal(editorOutcome, refusal));
  });
  const closeTerminalsButton = button("Close terminals…", "wsp-danger", () => controller.requestClose());
  editorButtons.append(saveButton, sleepButton, closeTerminalsButton);
  const confirmRow = el("div", "wsp-confirm");
  confirmRow.setAttribute("role", "alertdialog");
  confirmRow.setAttribute("aria-label", "Confirm closing terminals");
  const confirmText = el("p", undefined, "");
  const confirmYes = button("Close terminals", "wsp-danger", () => {
    void controller.confirmClose().then((refusal) => showRefusal(editorOutcome, refusal));
  });
  const confirmNo = button("Keep", "wsp-secondary", () => controller.cancelClose());
  confirmRow.append(confirmText, confirmYes, confirmNo);
  const editorOutcome = el("div", "wsp-outcome");
  editor.append(editorTarget, statusLabel, commentLabel, editorButtons, confirmRow, editorOutcome);
  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.setWorkspace({ status: statusInput.value, comment: commentInput.value }).then((refusal) => showRefusal(editorOutcome, refusal));
  });
  actions.append(composer, editor);
  tabPanels.get("workspaces")?.append(inventoryStatus, inventoryList, actions);

  // Search tab --------------------------------------------------------------------------------
  const searchForm = el("form", "wsp-form");
  const searchInput = el("input", "wsp-input");
  searchInput.type = "search";
  searchInput.maxLength = 256;
  searchInput.placeholder = "Search past sessions";
  searchInput.setAttribute("aria-label", "Search past sessions");
  const searchHostsBox = el("fieldset", "wsp-hosts");
  searchHostsBox.append(el("legend", "wsp-label", "Machines"));
  const searchHostsList = el("div", "wsp-chips");
  searchHostsBox.append(searchHostsList);
  const searchSubmit = el("button", "wsp-button wsp-primary", "Search");
  searchSubmit.type = "submit";
  searchForm.append(searchInput, searchHostsBox, searchSubmit);
  const searchResults = el("div", "wsp-list");
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const hosts = [...searchHostsList.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
      .filter((box) => box.checked)
      .map((box) => box.value);
    void controller.search(searchInput.value, hosts);
  });
  tabPanels.get("search")?.append(searchForm, searchResults);

  // History tab -------------------------------------------------------------------------------
  const historyForm = el("form", "wsp-form wsp-row");
  const historyInput = el("input", "wsp-input");
  historyInput.type = "search";
  historyInput.maxLength = 256;
  historyInput.placeholder = "Filter (optional)";
  historyInput.setAttribute("aria-label", "Filter past sessions");
  const historySubmit = el("button", "wsp-button wsp-secondary", "Load");
  historySubmit.type = "submit";
  historyForm.append(historyInput, historySubmit);
  historyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.loadHistory(historyInput.value);
  });
  const historyStatus = el("p", "wsp-meta");
  const historyList = el("div", "wsp-list");
  tabPanels.get("history")?.append(historyForm, historyStatus, historyList);

  // Create tab --------------------------------------------------------------------------------
  const createForm = el("form", "wsp-form");
  const field = (labelText: string, control: HTMLElement): HTMLLabelElement => {
    const wrapper = el("label", "wsp-field");
    wrapper.append(el("span", "wsp-label", labelText), control);
    return wrapper;
  };
  const projectSelect = el("select", "wsp-input");
  const nameInput = el("input", "wsp-input");
  nameInput.maxLength = 128;
  nameInput.autocapitalize = "off";
  nameInput.pattern = "[A-Za-z0-9][A-Za-z0-9._\\-]{0,127}";
  const agentInput = el("input", "wsp-input");
  agentInput.maxLength = 32;
  agentInput.value = "omp";
  agentInput.autocapitalize = "off";
  agentInput.setAttribute("list", "wsp-agents");
  const agentList = el("datalist");
  agentList.id = "wsp-agents";
  const modelSelect = el("select", "wsp-input");
  const promptInput = el("textarea", "wsp-input wsp-textarea");
  promptInput.rows = 5;
  promptInput.maxLength = 32_768;
  const createSubmit = el("button", "wsp-button wsp-primary", "Create workspace");
  createSubmit.type = "submit";
  const createOutcome = el("div", "wsp-outcome");
  createForm.append(
    field("Project", projectSelect),
    field("Workspace name", nameInput),
    field("Agent", agentInput),
    agentList,
    field("Model", modelSelect),
    field("Prompt", promptInput),
    createSubmit,
    createOutcome,
  );
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    // Option values are the model identity, so a reordered or refreshed catalog never shifts the choice.
    const models = controller.getState().inventory.data?.models ?? [];
    const model = models.find((candidate) => JSON.stringify([candidate.provider, candidate.id]) === modelSelect.value);
    const input = { projectId: projectSelect.value, name: nameInput.value, agent: agentInput.value, prompt: promptInput.value };
    void controller
      .create(model === undefined ? input : { ...input, model: { provider: model.provider, id: model.id } })
      .then((refusal) => showRefusal(createOutcome, refusal));
  });
  tabPanels.get("create")?.append(createForm);

  // Transcript overlay ------------------------------------------------------------------------
  const transcriptPane = el("section", "wsp-transcript");
  transcriptPane.setAttribute("aria-label", "Saved session transcript (read-only)");
  const transcriptHeader = el("div", "wsp-transcript-header");
  const transcriptBack = button("Back", "wsp-secondary", () => controller.closeTranscript());
  const transcriptTitle = el("h3", "wsp-transcript-title");
  const transcriptResume = button("Resume", "wsp-primary", () => {
    void controller.resume().then((refusal) => showRefusal(transcriptOutcome, refusal));
  });
  transcriptHeader.append(transcriptBack, transcriptTitle, transcriptResume);
  const transcriptMeta = el("p", "wsp-meta");
  const transcriptOutcome = el("div", "wsp-outcome");
  const transcriptEntries = el("ol", "wsp-entries");
  const transcriptMore = button("Load more", "wsp-secondary", () => void controller.transcriptMore());
  transcriptPane.append(transcriptHeader, transcriptMeta, transcriptOutcome, transcriptEntries, transcriptMore);
  transcriptPane.hidden = true;

  dialog.append(handle, header, toolbar, notice, tablist, body, transcriptPane);

  // Rendering --------------------------------------------------------------------------------
  const REFUSAL_TEXT: Readonly<Record<WriteRefusal, string>> = {
    unauthorized: "Access was revoked. Sign in again.",
    offline: "Offline — nothing was sent.",
    "unknown-host": "That machine is not in the authorized fleet.",
    busy: "Still waiting for the previous receipt.",
    "no-target": "Select a target first.",
    "read-only": "This terminal is read-only.",
    "invalid-input": "Check the fields: nothing was sent.",
    "not-confirmed": "Confirm closing first.",
    uncertain: "The last request may have run. Retry it, or check the machine and clear it first.",
  };

  function showRefusal(target: HTMLElement, refusal: WriteRefusal | null): void {
    if (refusal === null) return;
    const message = el("p", "wsp-outcome-line", REFUSAL_TEXT[refusal]);
    message.dataset.state = "failed";
    target.replaceChildren(message);
  }

  function renderWrite(target: HTMLElement, slot: WriteSlot, state: WorkspaceState): void {
    const record = state.writes[slot];
    if (record === undefined) {
      if (target.dataset.slot === slot) target.replaceChildren();
      target.dataset.slot = slot;
      return;
    }
    target.dataset.slot = slot;
    const line = el("div", "wsp-outcome-line");
    line.dataset.state = record.state;
    line.setAttribute("role", record.state === "pending" ? "status" : "alert");
    line.append(el("strong", undefined, `${record.request.operation} · ${record.state}`), el("span", undefined, record.message));
    for (const warning of record.warnings) line.append(el("span", "wsp-warning", warning));
    line.append(el("code", "wsp-request-id", record.request.requestId));
    if (record.state === "uncertain") {
      const retry = button("Retry same request", "wsp-secondary", () => void controller.retry(slot));
      retry.disabled = !state.online || !state.authorized;
      line.append(retry);
    }
    if (record.state === "uncertain") {
      line.append(button("Checked the machine — clear", "wsp-ghost", () => controller.dismiss(slot, true)));
    } else if (record.state !== "pending") {
      line.append(button("Dismiss", "wsp-ghost", () => controller.dismiss(slot)));
    }
    target.replaceChildren(line);
  }

  function readNotice<Data>(slot: ReadSlot<Data>, now: number): string {
    if (slot.status === "loading") return "Loading…";
    if (slot.status === "error") {
      return slot.data === null ? `Unavailable (${slot.error ?? "error"}).` : `Showing stale data from ${ago(slot.loadedAt, now)} — refresh failed (${slot.error ?? "error"}).`;
    }
    return slot.loadedAt === null ? "" : `Updated ${ago(slot.loadedAt, now)}.`;
  }

  function chip(text: string, kind?: string): HTMLSpanElement {
    const element = el("span", "wsp-chip", text);
    if (kind !== undefined) element.dataset.kind = kind;
    return element;
  }

  function terminalRow(terminal: WorkspaceTerminal, state: WorkspaceState, now: number): HTMLElement {
    const row = button("", "wsp-terminal", () => controller.selectTerminal(terminal.handle));
    row.setAttribute("aria-pressed", String(state.selectedTerminal === terminal.handle));
    const head = el("span", "wsp-row-head");
    head.append(el("span", "wsp-name", terminal.title || terminal.handle));
    if (terminal.agentType !== null) head.append(chip(terminal.agentType));
    head.append(chip(terminal.connected ? (terminal.writable ? "writable" : "read-only") : "disconnected", terminal.writable ? "ok" : "muted"));
    row.append(head);
    if (terminal.preview !== null) row.append(el("span", "wsp-preview", terminal.preview));
    if (terminal.lastOutputAt !== null) row.append(el("span", "wsp-meta", `Output ${ago(terminal.lastOutputAt, now)}`));
    return row;
  }

  function workspaceCard(entry: WorkspaceEntry, terminals: readonly WorkspaceTerminal[], state: WorkspaceState, now: number): HTMLElement {
    const card = el("article", "wsp-card");
    card.dataset.selected = String(state.selectedWorkspace === entry.id);
    const select = button("", "wsp-card-head", () => controller.selectWorkspace(state.selectedWorkspace === entry.id ? null : entry.id));
    select.setAttribute("aria-pressed", String(state.selectedWorkspace === entry.id));
    select.append(el("span", "wsp-name", entry.branch ?? entry.path));
    if (entry.unread) select.append(chip("unread", "accent"));
    if (entry.status !== null) select.append(chip(entry.status));
    card.append(select);
    if (entry.comment !== null && entry.comment.length > 0) card.append(el("p", "wsp-comment", entry.comment));
    if (entry.pr !== null) {
      if (/^https:\/\/[^\s]+$/u.test(entry.pr)) {
        const link = el("a", "wsp-link", entry.pr);
        link.href = entry.pr;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        card.append(link);
      } else card.append(el("p", "wsp-meta", `PR ${entry.pr}`));
    }
    card.append(el("p", "wsp-meta wsp-path", entry.path));
    for (const terminal of terminals) card.append(terminalRow(terminal, state, now));
    return card;
  }

  function renderInventory(state: WorkspaceState, now: number): void {
    inventoryStatus.textContent = state.host === null ? "No authorized machine." : readNotice(state.inventory, now);
    const data = state.inventory.data;
    if (data === null) {
      inventoryList.replaceChildren();
    } else {
      const groups = new Map<string, WorkspaceEntry[]>();
      for (const entry of data.workspaces) groups.set(entry.project, [...(groups.get(entry.project) ?? []), entry]);
      const placed = new Set<string>();
      const sections: HTMLElement[] = [];
      for (const [project, entries] of groups) {
        const group = el("details", "wsp-group");
        group.open = true;
        group.append(el("summary", "wsp-group-title", `${project} · ${entries.length}`));
        for (const entry of entries) {
          const terminals = data.terminals.filter((terminal) => terminal.worktreeId === entry.id);
          for (const terminal of terminals) placed.add(terminal.handle);
          group.append(workspaceCard(entry, terminals, state, now));
        }
        sections.push(group);
      }
      const loose = data.terminals.filter((terminal) => !placed.has(terminal.handle));
      if (loose.length > 0) {
        const group = el("details", "wsp-group");
        group.open = true;
        group.append(el("summary", "wsp-group-title", `Other terminals · ${loose.length}`));
        for (const terminal of loose) group.append(terminalRow(terminal, state, now));
        sections.push(group);
      }
      if (sections.length === 0) sections.push(el("p", "wsp-empty", "No workspaces or terminals on this machine."));
      inventoryList.replaceChildren(...sections);
    }

    const terminal = data?.terminals.find((candidate) => candidate.handle === state.selectedTerminal);
    composer.hidden = terminal === undefined && state.writes.send === undefined;
    composerTarget.textContent = terminal === undefined ? "No terminal selected." : displayText(`To ${terminal.title || terminal.handle} on ${state.host ?? ""}`);
    const writable = terminal !== undefined && terminal.connected && terminal.writable;
    composerText.disabled = !writable || !state.authorized;
    const sendBlocked = state.writes.send?.state === "pending" || state.writes.send?.state === "uncertain";
    composerSend.disabled = !writable || !state.authorized || !state.online || sendBlocked;
    renderWrite(composerOutcome, "send", state);
    const sent = state.writes.send;
    // Clear the draft once, when the receipt that consumed exactly this text arrives.
    if (sent?.state === "accepted" && composer.dataset.cleared !== sent.request.requestId) {
      composer.dataset.cleared = sent.request.requestId;
      if (sent.request.operation === "send" && sent.request.args.text === composerText.value) composerText.value = "";
    }

    const entry = data?.workspaces.find((candidate) => candidate.id === state.selectedWorkspace);
    editor.hidden = entry === undefined && state.writes.workspace === undefined;
    if (entry !== undefined && editor.dataset.target !== entry.id) {
      editor.dataset.target = entry.id;
      statusInput.value = entry.status ?? "";
      commentInput.value = entry.comment ?? "";
    }
    editorTarget.textContent = entry === undefined ? "No workspace selected." : displayText(`${entry.branch ?? entry.path} on ${state.host ?? ""}`);
    const workspaceBlocked = state.writes.workspace?.state === "pending" || state.writes.workspace?.state === "uncertain";
    const editable = entry !== undefined && state.authorized && state.online && !workspaceBlocked;
    for (const control of [saveButton, sleepButton, closeTerminalsButton]) control.disabled = !editable;
    statusInput.disabled = commentInput.disabled = entry === undefined || !state.authorized;
    confirmRow.hidden = entry === undefined || state.confirmClose !== entry.id;
    confirmText.textContent = displayText(`Close every terminal in ${entry?.branch ?? entry?.path ?? ""}? Files and the worktree are kept.`);
    confirmYes.disabled = !editable;
    renderWrite(editorOutcome, "workspace", state);
  }

  function hitRow(hit: WorkspaceSearchHit | WorkspaceHistorySession, origin: "search" | "history", now: number): HTMLElement {
    const row = button("", "wsp-hit", () => {
      void controller.openTranscript({ host: hit.host, sessionId: hit.sessionId, agent: hit.agent, path: hit.path, title: hit.title, origin });
    });
    const head = el("span", "wsp-row-head");
    head.append(el("span", "wsp-name", hit.title || hit.sessionId), chip(hit.agent), chip(hit.host, "muted"));
    row.append(head);
    const excerpt = "snippet" in hit ? hit.snippet : hit.preview;
    if (excerpt !== null && excerpt.length > 0) row.append(el("span", "wsp-preview", excerpt));
    row.append(el("span", "wsp-meta wsp-path", `${hit.path}${hit.lastActivityAt === null ? "" : ` · ${ago(hit.lastActivityAt, now)}`}`));
    return row;
  }

  function renderSearch(state: WorkspaceState, now: number): void {
    const checked = new Set(state.searchHosts);
    searchHostsList.replaceChildren(
      ...state.hosts.map((host) => {
        const label = el("label", "wsp-check");
        const box = el("input");
        box.type = "checkbox";
        box.value = host;
        box.checked = checked.has(host);
        label.append(box, el("span", undefined, host));
        return label;
      }),
    );
    searchSubmit.disabled = !state.authorized || state.hosts.length === 0;
    const sections: HTMLElement[] = [];
    for (const [host, result] of Object.entries(state.search)) {
      const section = el("section", "wsp-group");
      section.append(el("h3", "wsp-group-title", host));
      if (result.status === "loading" && result.hits.length === 0) section.append(el("p", "wsp-meta", "Searching…"));
      if (result.status === "error") {
        // The host's index moved under a cursor; only a fresh first page is meaningful.
        const message = result.error === "conflict" ? "Results changed on this machine — search again." : `Search failed (${result.error ?? "error"}).`;
        section.append(el("p", "wsp-meta", message));
      }
      if (result.enabled === false) section.append(el("p", "wsp-meta", "Session search index is disabled on this machine."));
      if (result.status === "ready" && result.enabled === true && result.hits.length === 0) section.append(el("p", "wsp-empty", "No matches."));
      for (const hit of result.hits) section.append(hitRow(hit, "search", now));
      if (result.cursor !== null) {
        const more = button(result.status === "loading" ? "Loading…" : "More", "wsp-secondary", () => void controller.searchMore(host));
        more.disabled = result.status === "loading";
        section.append(more);
      }
      sections.push(section);
    }
    searchResults.replaceChildren(...sections);
  }

  function renderHistory(state: WorkspaceState, now: number): void {
    historyStatus.textContent = state.host === null ? "No authorized machine." : readNotice(state.history, now);
    const data = state.history.data;
    const rows: HTMLElement[] = (data?.sessions ?? []).map((session) => hitRow(session, "history", now));
    if (data !== null && data.sessions.length === 0) rows.push(el("p", "wsp-empty", "No past sessions."));
    if (data?.cursor !== null && data !== null) {
      const more = button(state.history.status === "loading" ? "Loading…" : "Load more", "wsp-secondary", () => void controller.historyMore());
      more.disabled = state.history.status === "loading";
      rows.push(more);
    }
    historyList.replaceChildren(...rows);
  }

  function renderCreate(state: WorkspaceState): void {
    const data = state.inventory.data;
    const previousProject = projectSelect.value;
    projectSelect.replaceChildren(
      ...(data?.projects ?? []).map((project) => {
        const option = el("option", undefined, project.name);
        option.value = project.id;
        return option;
      }),
    );
    if (data?.projects.some((project) => project.id === previousProject) === true) projectSelect.value = previousProject;
    const previousModel = modelSelect.value;
    const defaultOption = el("option", undefined, "Agent default");
    defaultOption.value = "";
    modelSelect.replaceChildren(
      defaultOption,
      ...(data?.models ?? []).map((model) => {
        const option = el("option", undefined, `${model.name} · ${model.provider}`);
        option.value = JSON.stringify([model.provider, model.id]);
        return option;
      }),
    );
    // A model that left the catalog falls back to the agent default rather than to a neighbour.
    const kept = data?.models.some((model) => JSON.stringify([model.provider, model.id]) === previousModel) === true;
    modelSelect.value = kept ? previousModel : "";
    const agents = new Set<string>(AGENT_SUGGESTIONS);
    for (const terminal of data?.terminals ?? []) if (terminal.agentType !== null) agents.add(terminal.agentType);
    agentList.replaceChildren(
      ...[...agents].map((agent) => {
        const option = el("option");
        option.value = agent;
        return option;
      }),
    );
    const createBlocked = state.writes.create?.state === "pending" || state.writes.create?.state === "uncertain";
    createSubmit.disabled = data === null || data.projects.length === 0 || !state.authorized || !state.online || createBlocked;
    renderWrite(createOutcome, "create", state);
    const record = state.writes.create;
    if (record !== undefined && (record.state === "accepted" || record.state === "started")) {
      createOutcome.append(el("p", "wsp-meta", "The new agent appears in Sessions once it registers."));
    }
  }

  function renderTranscript(state: WorkspaceState, now: number): void {
    const view = state.transcript;
    transcriptPane.hidden = view === null;
    body.hidden = view !== null;
    tablist.hidden = view !== null;
    if (view === null) {
      if (transcriptEntries.childElementCount > 0) transcriptEntries.replaceChildren();
      transcriptPane.dataset.key = "";
      return;
    }
    transcriptTitle.textContent = displayText(view.title || view.sessionId);
    const status = view.status === "loading" ? "Loading…" : view.status === "error" ? `Unavailable (${view.error ?? "error"}).` : "Read-only saved session.";
    transcriptMeta.textContent = displayText(`${view.host} · ${view.agent} · ${status}`);
    const resumeBlocked = state.writes.resume?.state === "pending" || state.writes.resume?.state === "uncertain";
    transcriptResume.disabled = !state.authorized || !state.online || resumeBlocked || view.status === "loading";
    renderWrite(transcriptOutcome, "resume", state);
    // Entries only ever grow while one transcript is open, so render the new tail only.
    const key = `${view.host}\0${view.sessionId}`;
    if (transcriptPane.dataset.key !== key) {
      transcriptPane.dataset.key = key;
      transcriptEntries.replaceChildren();
    }
    for (const entry of view.entries.slice(transcriptEntries.childElementCount)) {
      const item = el("li", "wsp-entry");
      item.dataset.role = entry.role;
      const meta = el("p", "wsp-entry-meta", `${entry.role}${entry.tool === null ? "" : ` · ${entry.tool}`}${entry.at === null ? "" : ` · ${ago(entry.at, now)}`}`);
      const text = el("div", "wsp-entry-text");
      const safe = displayText(entry.text);
      if (options.renderMarkdown !== undefined && entry.role !== "tool") text.append(options.renderMarkdown(safe));
      else text.textContent = safe;
      item.append(meta, text);
      transcriptEntries.append(item);
    }
    transcriptMore.hidden = view.cursor === null;
    transcriptMore.disabled = view.status === "loading";
  }

  function render(state: WorkspaceState): void {
    const now = Date.now();
    const selected = hostSelect.value;
    hostSelect.replaceChildren(
      ...state.hosts.map((host) => {
        const option = el("option", undefined, host);
        option.value = host;
        return option;
      }),
    );
    hostSelect.value = state.host ?? selected;
    hostSelect.disabled = state.hosts.length <= 1;
    for (const tab of WORKSPACE_TABS) {
      const active = tab === state.tab;
      tabButtons.get(tab)?.setAttribute("aria-selected", String(active));
      tabButtons.get(tab)?.setAttribute("tabindex", active ? "0" : "-1");
      const section = tabPanels.get(tab);
      if (section !== undefined) section.hidden = !active;
    }
    const problems: string[] = [];
    if (!state.authorized) problems.push("Access revoked — sign in again. Actions are disabled.");
    else if (!state.online) problems.push("Offline — showing the last loaded state. Actions are disabled.");
    if (state.hosts.length === 0) problems.push("No authorized machine in the fleet.");
    notice.hidden = problems.length === 0;
    notice.textContent = problems.join(" ");
    dialog.dataset.state = !state.authorized ? "revoked" : state.online ? "online" : "offline";
    renderInventory(state, now);
    renderSearch(state, now);
    renderHistory(state, now);
    renderCreate(state);
    renderTranscript(state, now);
  }

  const unsubscribe = controller.subscribe((state) => {
    if (dialog.open) render(state);
  });

  /** Re-reads what the open tab shows. Reads only: a write is never resent from here. */
  function reloadVisible(): void {
    if (!dialog.open) return;
    const state = controller.getState();
    if (state.tab === "history") void controller.loadHistory(state.historyQuery);
    else if (state.tab === "search") {
      if (state.searchQuery.length > 0) void controller.search(state.searchQuery);
    } else void controller.loadInventory();
  }

  const view = doc.defaultView;
  const onOnline = (): void => {
    controller.setOnline(true);
    reloadVisible();
  };
  const onOffline = (): void => controller.setOnline(false);
  view?.addEventListener("online", onOnline);
  view?.addEventListener("offline", onOffline);

  const panel: WorkspacePanel = {
    launcher,
    dialog,
    controller,
    createLauncher(className = "wsp-launcher") {
      return makeLauncher(className);
    },
    releaseLauncher(element) {
      if (element === launcher || !launchers.delete(element)) return;
      element.removeEventListener("click", onLauncher);
      element.remove();
    },
    open() {
      if (dialog.open || !controller.getState().authorized) return;
      controller.hostsChanged();
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      render(controller.getState());
      reloadVisible();
    },
    close() {
      controller.cancelClose();
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    },
    hostsChanged() {
      const before = controller.getState().host;
      controller.hostsChanged();
      if (controller.getState().host !== before) reloadVisible();
      syncLaunchers();
    },
    hasUnsettledWrites() {
      return Object.values(controller.getState().writes).some((record) => record.state === "pending" || record.state === "uncertain");
    },
    setAuthorized(authorized) {
      const was = controller.getState().authorized;
      controller.setAuthorized(authorized);
      syncLaunchers();
      if (dialog.open) render(controller.getState());
      if (authorized && !was) reloadVisible();
    },
    dispose() {
      unsubscribe();
      controller.dispose();
      view?.removeEventListener("online", onOnline);
      view?.removeEventListener("offline", onOffline);
      for (const element of launchers) {
        element.removeEventListener("click", onLauncher);
        element.remove();
      }
      launchers.clear();
      panel.close();
      dialog.remove();
    },
  };
  return panel;
}
