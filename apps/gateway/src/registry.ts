import { randomUUID } from "node:crypto";
import {
  sessionMetadataFromObserved,
  type FleetDirectoryStatus,
  type FleetHostSummary,
  type LaunchMode,
  type ObservedSessionInput,
  type SessionEvent,
  type SessionListResponse,
  type SessionMetadata,
} from "@omp-session-gateway/protocol";

export interface RegistryClock {
  monotonicNowMs(): number;
  wallNowIso(): string;
}

export interface RegistryOptions {
  readonly ttlSeconds: number;
  readonly maxSessions: number;
  readonly clock?: RegistryClock;
  readonly requestIdFactory?: () => string;
  readonly onListenerError?: (error: unknown) => void;
}

interface InternalMetadataRecord {
  metadata: SessionMetadata;
  immutableIdentity: string;
  receivedAtMs: number;
  activityStopRevision: number | undefined;
}

/** Gateway-private edge notification; never part of the browser SessionEvent stream. */
export interface SessionActivityStopEvent {
  readonly type: "activity_stop";
  readonly revision: number;
  readonly session: SessionMetadata;
}

export type UpsertResult = "inserted" | "updated" | "ignored_older";

/**
 * One poll of OMP's discovery directory. `observed` hosts answered a snapshot; `retained` hosts are
 * published but were unreadable this round, so their records survive until the TTL expires them —
 * a retained fleet record also turns unavailable, since nothing vouches for it any more.
 * Anything in neither set is finished and is dropped immediately.
 */
export interface ObservedDirectory {
  readonly observed: readonly ObservedSessionInput[];
  readonly retained: ReadonlySet<string>;
}

export interface ReconcileResult {
  readonly inserted: number;
  readonly updated: number;
  readonly removed: number;
}

const systemClock: RegistryClock = {
  monotonicNowMs: () => performance.now(),
  wallNowIso: () => new Date().toISOString(),
};
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

function cloneMetadata(metadata: SessionMetadata): SessionMetadata {
  return { ...metadata, ...(metadata.ask === undefined ? {} : { ask: { ...metadata.ask } }) };
}

function cloneHosts(hosts: readonly FleetHostSummary[]): FleetHostSummary[] {
  return hosts.map(host => ({ ...host }));
}
function directoryFields(
  hosts: readonly FleetHostSummary[] | undefined,
  fleetStatus: FleetDirectoryStatus | undefined,
): Pick<SessionListResponse, "hosts" | "fleetStatus"> {
  return {
    ...(hosts === undefined ? {} : { hosts: cloneHosts(hosts) }),
    ...(fleetStatus === undefined ? {} : { fleetStatus }),
  };
}


/**
 * A reading's age ticks on every poll. Live ages are not worth a revision, and a stale age is
 * worth one per minute, so a quiet fleet does not rebroadcast its whole directory every poll.
 */
function sameHostsForBroadcast(left: readonly FleetHostSummary[] | undefined, right: readonly FleetHostSummary[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((host, index) => {
      const other = right[index];
      return other !== undefined && host.host === other.host && host.status === other.status &&
        host.error === other.error &&
        (host.status === "live" || Math.floor((host.ageSeconds ?? -60) / 60) === Math.floor((other.ageSeconds ?? -60) / 60));
    })
  );
}

export type LaunchAuthorization =
  | { readonly status: "ok"; readonly session: SessionMetadata }
  | { readonly status: "missing" }
  | { readonly status: "generation_mismatch" }
  | { readonly status: "mode_unavailable" }
  | { readonly status: "request_mismatch" };

export class SessionRegistry {
  readonly #metadata = new Map<string, InternalMetadataRecord>();
  readonly #listeners = new Set<(event: SessionEvent) => void>();
  readonly #activityStopListeners = new Set<(event: SessionActivityStopEvent) => void>();
  readonly #pending: (SessionEvent | SessionActivityStopEvent)[] = [];
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #clock: RegistryClock;
  readonly #requestIdFactory: () => string;
  readonly #onListenerError: (error: unknown) => void;
  #pendingHead = 0;
  #dispatching = false;
  #revision = 0;
  /** Fleet machine summaries; undefined for a standalone gateway, which never publishes `hosts`. */
  #hosts: readonly FleetHostSummary[] | undefined;
  /** Bridge reachability; undefined for a standalone gateway, which never publishes `fleetStatus`. */
  #fleetStatus: FleetDirectoryStatus | undefined;

  constructor(options: RegistryOptions) {
    if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1) throw new Error("invalid registry TTL");
    if (!Number.isSafeInteger(options.maxSessions) || options.maxSessions < 1) throw new Error("invalid registry capacity");
    this.#ttlMs = options.ttlSeconds * 1_000;
    this.#maxSessions = options.maxSessions;
    this.#clock = options.clock ?? systemClock;
    this.#requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.#onListenerError = options.onListenerError ?? (() => undefined);
  }

  get revision(): number {
    return this.#revision;
  }

  get size(): number {
    return this.#metadata.size;
  }

  snapshot(): SessionListResponse {
    this.sweepExpired();
    return {
      revision: this.#revision,
      sessions: [...this.#metadata.values()]
        .map(record => cloneMetadata(record.metadata))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
      ...directoryFields(this.#hosts, this.#fleetStatus),
    };
  }

  /**
   * Replaces the fleet machine summaries. They are directory state, not session state, so a
   * material change spends one revision and is published as a fresh snapshot. An age-only change
   * is stored for the next reader without a revision; see `sameHostsForBroadcast`.
   */
  setHosts(hosts: readonly FleetHostSummary[], fleetStatus?: FleetDirectoryStatus): void {
    const nextStatus = fleetStatus ?? this.#fleetStatus;
    const material = !sameHostsForBroadcast(this.#hosts, hosts) || nextStatus !== this.#fleetStatus;
    this.#hosts = cloneHosts(hosts);
    if (nextStatus !== undefined) this.#fleetStatus = nextStatus;
    if (!material) return;
    const { sessions } = this.snapshot();
    this.#revision += 1;
    this.#emit({
      type: "snapshot",
      revision: this.#revision,
      sessions,
      ...directoryFields(this.#hosts, this.#fleetStatus),
    });
  }

  /**
   * Publishes bridge reachability. A repeated status is stored as the same value and spends no
   * revision; only a change is a new snapshot. Standalone registries never call this.
   */
  setFleetStatus(status: FleetDirectoryStatus): void {
    if (this.#fleetStatus === status) return;
    this.#fleetStatus = status;
    const { sessions } = this.snapshot();
    this.#revision += 1;
    this.#emit({
      type: "snapshot",
      revision: this.#revision,
      sessions,
      ...directoryFields(this.#hosts, this.#fleetStatus),
    });
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  subscribeActivityStops(listener: (event: SessionActivityStopEvent) => void): () => void {
    const admittedRevision = this.#revision;
    const gate = (event: SessionActivityStopEvent): void => {
      if (event.revision > admittedRevision) listener(event);
    };
    this.#activityStopListeners.add(gate);
    return () => {
      this.#activityStopListeners.delete(gate);
    };
  }

  /** An intervening activity gap, restart, replacement, or ask invalidates delayed delivery. */
  isCurrentActivityStop(event: SessionActivityStopEvent): boolean {
    this.sweepExpired();
    const record = this.#metadata.get(event.session.instanceId);
    return record?.activityStopRevision === event.revision && record.metadata.generation === event.session.generation;
  }

  /**
   * Atomic admission: the listener is registered before the snapshot is observed, so a mutation that
   * races the handshake — including one the listener itself causes while reading the snapshot — is
   * buffered instead of falling into the gap between reading the directory and subscribing to it.
   * Buffered revisions at or below the snapshot revision are already represented by the snapshot and
   * are dropped; every newer one is replayed in order before the subscription goes live, so the
   * listener observes exactly one snapshot followed by strictly increasing revisions.
   */
  subscribeWithSnapshot(listener: (event: SessionEvent) => void): () => void {
    const buffered: SessionEvent[] = [];
    let snapshotRevision = -1;
    let live = false;
    const gate = (event: SessionEvent): void => {
      if (!live) {
        buffered.push(event);
        return;
      }
      // Still filtered once live: admission can complete inside an in-flight dispatch that has yet to
      // reach this listener, and that event is already folded into the snapshot.
      if (event.revision > snapshotRevision) listener(event);
    };
    this.#listeners.add(gate);
    const unsubscribe = (): void => {
      this.#listeners.delete(gate);
    };
    try {
      const snapshot = this.snapshot();
      snapshotRevision = snapshot.revision;
      listener({
        type: "snapshot",
        revision: snapshot.revision,
        sessions: snapshot.sessions,
        ...directoryFields(snapshot.hosts, snapshot.fleetStatus),
      });
      // Indexed rather than shifted: the gate keeps appending while this drains, and those late
      // arrivals belong at the tail of the same ordered replay.
      for (let index = 0; index < buffered.length; index += 1) {
        const event = buffered[index] as SessionEvent;
        if (event.revision > snapshotRevision) listener(event);
      }
      live = true;
      buffered.length = 0;
    } catch (error) {
      // A throwing listener must not leave its admission wrapper registered on the registry.
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  }

  /**
   * Folds one directory poll into the live model. A session that OMP stopped publishing is removed
   * on the very next poll — the host's own artifacts are the liveness signal — while a session that
   * merely failed to answer keeps its card until the TTL runs out, so a momentarily busy machine
   * does not clear the operator's directory.
   */
  reconcile(directory: ObservedDirectory): ReconcileResult {
    let inserted = 0;
    let updated = 0;
    for (const input of directory.observed) {
      const result = this.#observe(input);
      if (result === "inserted") inserted += 1;
      else if (result === "updated") updated += 1;
    }
    const live = new Set(directory.observed.map(input => input.instanceId));
    let removed = 0;
    for (const [instanceId, record] of [...this.#metadata.entries()]) {
      if (live.has(instanceId)) continue;
      if (directory.retained.has(instanceId)) {
        if (record.metadata.host === undefined) this.#forgetActivity(record);
        else this.#markUnavailable(record);
        continue;
      }
      this.#removeRecord(instanceId, record.metadata.generation);
      removed += 1;
    }
    return { inserted, updated, removed };
  }

  #observe(input: ObservedSessionInput): UpsertResult {
    const existing = this.#metadata.get(input.instanceId);
    // A directory identity names one machine's one OMP instance for good. A different claimant
    // (a hash collision, or a standalone record meeting a fleet one) never inherits the card.
    if (
      existing !== undefined &&
      (existing.metadata.host !== input.host || existing.metadata.originalInstanceId !== input.originalInstanceId)
    ) {
      return "ignored_older";
    }
    if (existing !== undefined && input.generation < existing.metadata.generation) {
      this.#forgetActivity(existing);
      return "ignored_older";
    }
    if (existing === undefined && this.#metadata.size >= this.#maxSessions) return "ignored_older";
    const receivedAtMs = this.#clock.monotonicNowMs();
    const receivedAt = this.#clock.wallNowIso();
    const projected = sessionMetadataFromObserved(input, receivedAt);
    // A same-generation identity change means the host replaced the room without advancing its
    // generation. Trust the host's current answer and treat it as a fresh record.
    const continues =
      existing !== undefined &&
      receivedAtMs - existing.receivedAtMs < this.#ttlMs &&
      existing.metadata.generation === input.generation &&
      existing.immutableIdentity === projected.immutableIdentity;
    let metadata = projected.metadata;
    if (metadata.inputRequired) {
      // One attention request keeps one identity for as long as the host keeps asking, so a
      // notification the operator already dismissed is not re-raised by the next poll.
      const preservedAsk = continues && existing.metadata.inputRequired ? existing.metadata.ask : undefined;
      const requestId = preservedAsk?.requestId ?? this.#requestIdFactory();
      if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("invalid attention request ID");
      metadata = { ...metadata, ask: preservedAsk ?? { requestId, since: receivedAt } };
    }
    if (continues && this.#unchanged(existing.metadata, metadata)) {
      // Nothing observable moved: refresh liveness without spending a revision on every poll.
      existing.receivedAtMs = receivedAtMs;
      existing.metadata = metadata;
      return "updated";
    }
    const stopped = continues && existing.metadata.busy === true && metadata.busy === false &&
      !existing.metadata.inputRequired && !metadata.inputRequired;
    this.#revision += 1;
    this.#metadata.set(input.instanceId, {
      metadata,
      immutableIdentity: projected.immutableIdentity,
      receivedAtMs,
      activityStopRevision: stopped ? this.#revision :
        continues && metadata.busy === false && !metadata.inputRequired ? existing.activityStopRevision : undefined,
    });
    this.#emit(
      { type: "session_upsert", revision: this.#revision, session: cloneMetadata(metadata) },
      stopped ? { type: "activity_stop", revision: this.#revision, session: cloneMetadata(metadata) } : undefined,
    );
    return existing === undefined ? "inserted" : "updated";
  }

  #forgetActivity(record: InternalMetadataRecord): void {
    if (record.metadata.busy === undefined) return;
    const { busy: _busy, ...metadata } = record.metadata;
    record.metadata = metadata;
    record.activityStopRevision = undefined;
    this.#revision += 1;
    this.#emit({ type: "session_upsert", revision: this.#revision, session: cloneMetadata(metadata) });
  }

  /**
   * A fleet record nothing vouched for this round keeps its card but loses everything that would
   * let it be launched or notified: it can no longer be Controlled, its activity is unknown, and a
   * `live` machine reads `stale`. Liveness is not refreshed, so the TTL still retires it.
   */
  #markUnavailable(record: InternalMetadataRecord): void {
    const { busy: _busy, ...rest } = record.metadata;
    const metadata: SessionMetadata = {
      ...rest,
      canControl: false,
      hostStatus: rest.hostStatus === "live" ? "stale" : rest.hostStatus ?? "stale",
      available: false,
    };
    record.activityStopRevision = undefined;
    if (this.#unchanged(record.metadata, metadata)) return;
    record.metadata = metadata;
    this.#revision += 1;
    this.#emit({ type: "session_upsert", revision: this.#revision, session: cloneMetadata(metadata) });
  }

  /** Compares everything a browser renders, ignoring the liveness stamp that moves every poll. */
  #unchanged(left: SessionMetadata, right: SessionMetadata): boolean {
    return (
      left.generation === right.generation &&
      left.title === right.title &&
      left.cwdLabel === right.cwdLabel &&
      left.model === right.model &&
      left.startedAt === right.startedAt &&
      left.canView === right.canView &&
      left.canControl === right.canControl &&
      left.inputRequired === right.inputRequired &&
      left.busy === right.busy &&
      left.ask?.requestId === right.ask?.requestId &&
      left.host === right.host &&
      left.originalInstanceId === right.originalInstanceId &&
      left.hostStatus === right.hostStatus &&
      left.available === right.available
    );
  }

  /**
   * Confirms the directory still shows this exact session before the gateway asks its host for a
   * capability. Metadata is the whole basis for the check: the capability itself lives in OMP.
   * An unavailable fleet row is shown but is not a launchable session, so it reads as missing.
   */
  authorizeLaunch(instanceId: string, generation: number, mode: LaunchMode, requestId?: string): LaunchAuthorization {
    this.sweepExpired();
    const record = this.#metadata.get(instanceId);
    if (record === undefined) return { status: "missing" };
    if (record.metadata.generation !== generation) return { status: "generation_mismatch" };
    if (record.metadata.available === false) return { status: "missing" };
    if (mode === "control" && !record.metadata.canControl) return { status: "mode_unavailable" };
    if (mode === "view" && !record.metadata.canView) return { status: "mode_unavailable" };
    if (
      requestId !== undefined &&
      (mode !== "control" || !record.metadata.inputRequired || record.metadata.ask?.requestId !== requestId)
    ) {
      return { status: "request_mismatch" };
    }
    return { status: "ok", session: cloneMetadata(record.metadata) };
  }

  sweepExpired(): number {
    const now = this.#clock.monotonicNowMs();
    const expired = [...this.#metadata.entries()].filter(([, record]) => now - record.receivedAtMs >= this.#ttlMs);
    for (const [instanceId, record] of expired) this.#removeRecord(instanceId, record.metadata.generation);
    return expired.length;
  }

  clear(): void {
    for (const [instanceId, record] of [...this.#metadata.entries()]) {
      this.#removeRecord(instanceId, record.metadata.generation);
    }
  }

  #removeRecord(instanceId: string, generation: number): void {
    this.#metadata.delete(instanceId);
    this.#revision += 1;
    this.#emit({ type: "session_remove", revision: this.#revision, instanceId, generation });
  }

  /**
   * Dispatch is serialized. A listener is free to mutate the registry — `PushService` does so
   * indirectly by sweeping through `snapshot()` — and delivering that nested revision inline would
   * hand it to every listener the outer loop has not reached yet, ahead of the older revision they
   * are still owed. Queueing keeps delivery in strictly increasing revision order for all listeners.
   */
  #notify<T extends SessionEvent | SessionActivityStopEvent>(event: T, listeners: ReadonlySet<(event: T) => void>): void {
    for (const listener of listeners) {
      try {
        const copy = "session" in event ? { ...event, session: cloneMetadata(event.session) }
          : event.type === "snapshot"
            ? {
                ...event,
                sessions: event.sessions.map(cloneMetadata),
                ...(event.hosts === undefined ? {} : { hosts: cloneHosts(event.hosts) }),
              }
            : { ...event };
        listener(copy);
      } catch (error) {
        // Observers cannot interrupt revocation or starve other observers, even if reporting fails.
        try {
          this.#onListenerError(error);
        } catch {
          // Error reporting is an observer too.
        }
      }
    }
  }

  #emit(event: SessionEvent, stop?: SessionActivityStopEvent): void {
    this.#pending.push(event);
    // Both edges belong ahead of any mutation an ordinary observer triggers while receiving upsert.
    if (stop !== undefined) this.#pending.push(stop);
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      while (this.#pendingHead < this.#pending.length) {
        const next = this.#pending[this.#pendingHead] as SessionEvent | SessionActivityStopEvent;
        this.#pendingHead += 1;
        if (next.type === "activity_stop") this.#notify(next, this.#activityStopListeners);
        else this.#notify(next, this.#listeners);
      }
    } finally {
      this.#pending.splice(0, this.#pendingHead);
      this.#pendingHead = 0;
      this.#dispatching = false;
    }
  }
}
