import { afterAll, describe, expect, test } from "bun:test";
import { MAX_SESSIONS, type FleetHostSummary, type SessionMetadata } from "@omp-session-gateway/protocol";
import fc, { type AsyncCommand } from "fast-check";
import type { CollabEmbedOptions, CollabEmbedState } from "../../../packages/collab-client/upstream/src/embed-contract";

let embedStateSink: ((state: CollabEmbedState) => void) | undefined;
let lastEmbedOptions: CollabEmbedOptions | undefined;
/** How many embedded clients the app has torn down; a stopped client has closed its transport. */
let embedDisposals = 0;
/** How many embedded clients the app has started, i.e. handed a capability to. */
let embedStarts = 0;
/** Test seam imported by app.ts only when a launch fixture sets the collab module URL. */
export function startCollabWithCapability(
  _container: HTMLElement,
  _capability: string,
  _onDispose: () => void,
  options?: CollabEmbedOptions,
): () => void {
  embedStateSink = options?.onStateChange;
  lastEmbedOptions = options;
  embedStarts += 1;
  return () => {
    embedStateSink = undefined;
    embedDisposals += 1;
  };
}

const GLOBAL_NAMES = [
  "window",
  "document",
  "location",
  "navigator",
  "Notification",
  "MessageChannel",
  "PushManager",
  "history",
  "EventSource",
  "fetch",
  "localStorage",
  "HTMLElement",
  "__COLLAB_CLIENT_MODULE__",
  "__COLLAB_CLIENT_STYLESHEET__",
] as const;
const nativeGlobals = Object.fromEntries(
  GLOBAL_NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
) as Record<(typeof GLOBAL_NAMES)[number], PropertyDescriptor | undefined>;

// A frozen renderer runs no timers while wall-clock time keeps moving, so the test clock has to
// advance independently of the fake timers.
const nativeNow = Date.now;
let clockOffset = 0;

Date.now = (): number => nativeNow() + clockOffset;
class FakeStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FakeElement extends EventTarget {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  checked = false;
  className = "";
  disabled = false;
  hidden = false;
  id = "";
  open = false;
  textContent: string | null = "";
  type = "";
  value = "";

  constructor(readonly tagName: string) {
    super();
  }

  get childElementCount(): number {
    return this.children.length;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) this.#adopt(child);
    this.children.push(...children);
  }

  insertBefore(child: FakeElement, reference: FakeElement | null): FakeElement {
    if (reference === null) {
      this.append(child);
      return child;
    }
    if (reference.parentElement !== this) throw new DOMException("reference is not a child", "NotFoundError");
    this.#adopt(child);
    this.children.splice(this.children.indexOf(reference), 0, child);
    return child;
  }

  after(...siblings: FakeElement[]): void {
    const parent = this.parentElement;
    if (parent === null) return;
    for (const sibling of siblings) parent.#adopt(sibling);
    parent.children.splice(parent.children.indexOf(this) + 1, 0, ...siblings);
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children.splice(0)) child.parentElement = null;
    this.append(...children);
  }

  remove(): void {
    const parent = this.parentElement;
    if (parent === null) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }

  /** Moves `child` here, detaching it from any previous parent as the DOM does. */
  #adopt(child: FakeElement): void {
    child.remove();
    child.parentElement = this;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  toggleAttribute(name: string, force?: boolean): void {
    const present = force ?? !this.attributes.has(name);
    if (present) this.attributes.set(name, "");
    else this.attributes.delete(name);
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }

  matches(selector: string): boolean {
    return selector.split(",").some(part => {
      const single = part.trim();
      if (single === "link[data-omp-collab-styles]") return this.dataset.ompCollabStyles === "true";
      if (single.startsWith(".")) return this.className.split(/\s+/u).includes(single.slice(1));
      if (single.startsWith("#")) return this.id === single.slice(1);
      return this.tagName.toLowerCase() === single.toLowerCase();
    });
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      if (element.matches(selector)) found.push(element);
      for (const child of element.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return found;
  }
}

class FakeMessagePort {
  peer: FakeMessagePort | undefined;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  close(): void {}

  start(): void {}

  postMessage(data: unknown): void {
    queueMicrotask(() => this.peer?.onmessage?.({ data }));
  }
}

class FakeMessageChannel {
  readonly port1 = new FakeMessagePort();
  readonly port2 = new FakeMessagePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

class FakeWindow extends EventTarget {
  readonly opened: string[] = [];
  readonly timers = new Map<number, { readonly callback: () => void; readonly delay: number }>();
  scrollY = 0;
  #nextTimer = 1;

  matchMedia(): { matches: boolean; addEventListener(): void } {
    return { matches: false, addEventListener(): void {} };
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  setTimeout(callback: () => void, delay = 0): number {
    const handle = this.#nextTimer;
    this.#nextTimer += 1;
    this.timers.set(handle, { callback, delay });
    return handle;
  }

  runTimers(): void {
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const timer of pending) timer.callback();
  }

  runTimersWithDelay(delay: number): void {
    for (const [handle, timer] of [...this.timers]) {
      if (timer.delay !== delay) continue;
      this.timers.delete(handle);
      timer.callback();
    }
  }

  pendingDelays(): number[] {
    return [...this.timers.values()].map(timer => timer.delay);
  }

  scrollTo(_x: number, y: number): void {
    this.scrollY = y;
  }

  open(url?: string | URL): null {
    this.opened.push(String(url));
    return null;
  }
}

class FakeDocument extends EventTarget {
  readonly body = new FakeElement("body");
  readonly head = new FakeElement("head");
  title = "OMP Sessions";
  readonly documentElement = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
  };
  visibilityState: "visible" | "hidden" = "visible";

  constructor(
    readonly bySelector: Record<string, FakeElement>,
    readonly detailInputs: readonly FakeElement[],
    readonly defaultView: FakeWindow,
  ) {
    super();
    // Elements already nested in the shell (the settings button inside `.brand-row`) stay put.
    this.body.append(...Object.values(bySelector).filter(element => element.parentElement === null));
  }

  querySelector(selector: string): FakeElement | null {
    return this.bySelector[selector] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === 'input[name="notification-detail"]' ? [...this.detailInputs] : [];
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  /** Chrome on Android hides a backgrounded page at once and freezes it about a minute later. */
  setVisibility(state: "visible" | "hidden"): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }

  freeze(): void {
    this.dispatchEvent(new Event("freeze"));
  }
}

class FakeEventSource extends EventTarget {
  static readonly instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  close(): void {
    this.closed = true;
  }

  emit(type: "snapshot" | "session_upsert" | "session_remove" | "keepalive", payload: unknown): void {
    const event = new Event(type);
    Object.defineProperty(event, "data", { value: JSON.stringify(payload) });
    this.dispatchEvent(event);
  }
}

class FakeBrowserNotification {
  closed = false;

  constructor(
    readonly tag: string,
    readonly data: unknown,
  ) {}

  close(): void {
    this.closed = true;
  }
}

interface BrowserHarness {
  readonly body: FakeElement;
  setEmbedState(state: CollabEmbedState): void;
  readonly elements: {
    readonly sessionList: FakeElement;
    readonly notificationButton: FakeElement;
    readonly notificationDisclosure: FakeElement;
    readonly notificationSettings: FakeElement;
    readonly networkRecoveryHelp: FakeElement;
    readonly settingsButton: FakeElement;
    readonly notificationDetailOptions: FakeElement;
    readonly emptyState: FakeElement;
    readonly notificationDetailInputs: readonly FakeElement[];
    readonly statusBanner: FakeElement;
    readonly directoryTitle: FakeElement;
    readonly directoryCount: FakeElement;
    readonly localActionToast: FakeElement;
    readonly localActionToastCopy: FakeElement;
    readonly localActionToastUndo: FakeElement;
    readonly quickRepliesInput: FakeElement;
    readonly quickRepliesReset: FakeElement;
  };
  disconnectEvents(): void;
  expireEventLiveness(): void;
  runTimers(): void;
  runUndoTimer(): void;
  pendingDelays(): number[];
  setVisibility(state: "visible" | "hidden"): void;
  freeze(): void;
  advanceClock(milliseconds: number): void;
  hangNextListRequest(): void;
  failNextListRequest(): void;
  setOnline(online: boolean): void;
  activateWorker(): void;
  readonly reloads: { count: number };
  readonly fetchPaths: string[];
  readonly fetchLocations: string[];
  readonly fetchInits: readonly { readonly path: string; readonly init: RequestInit }[];
  readonly permissionRequests: { count: number };
  readonly subscriptionRequests: unknown[];
  readonly unsubscribeRequests: unknown[];
  readonly subscriptionCalls: { subscribe: number; unsubscribe: number };
  readonly workerMessages: unknown[];
  readonly replacedPaths: readonly string[];
  readonly window: FakeWindow;
  readonly localStorage: FakeStorage;
  readonly notifications: readonly FakeBrowserNotification[];
  addNotification(tag: string, data: unknown): FakeBrowserNotification;
  emit(type: "snapshot" | "session_upsert" | "session_remove" | "keepalive", payload: unknown): void;
  setList(
    revision: number,
    sessions: readonly SessionMetadata[],
    status?: number,
    hosts?: readonly FleetHostSummary[],
    fleetStatus?: "ok" | "unreachable",
  ): void;
  holdNextLaunch(): Promise<void>;
  /** Holds every launch response until the returned release is called. */
  holdLaunches(): () => void;
}

function session(
  instanceId: string,
  overrides: Partial<SessionMetadata> = {},
): SessionMetadata {
  const merged = {
    instanceId,
    generation: 1,
    title: instanceId,
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-07-21T10:00:00.000Z",
    lastSeenAt: "2026-07-21T10:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: false,
    ...overrides,
  };
  if (!merged.inputRequired || merged.ask !== undefined) return merged;
  return {
    ...merged,
    ask: {
      requestId: `request-${instanceId.replaceAll(/[^A-Za-z0-9_-]/gu, "-")}`,
      since: merged.lastSeenAt,
    },
  };
}

async function settleUntil(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("dashboard state did not settle");
}

async function bootApp(options: {
  readonly permission: NotificationPermission;
  readonly initialSessions: readonly SessionMetadata[];
  readonly workerResponse?: unknown;
  readonly permissionResult?: NotificationPermission;
  readonly existingSubscription?: boolean;
  /** WebKit's `toJSON()` omits `expirationTime` when it is null; Chromium includes it. */
  readonly webkitSubscriptionJson?: boolean;
  readonly pathname?: string;
  readonly search?: string;
  readonly storage?: FakeStorage;
  readonly initialHosts?: readonly FleetHostSummary[];
  readonly initialFleetStatus?: "ok" | "unreachable";
  readonly launchStatus?: number;
  /** Status `/api/v1/workspace` answers; only an Access refusal is modelled. */
  readonly workspaceStatus?: 401 | 403;
  readonly suffix: string;
}): Promise<BrowserHarness> {
  FakeEventSource.instances.length = 0;
  clockOffset = 0;
  const sessionList = new FakeElement("section");
  const emptyState = new FakeElement("section");
  const statusBanner = new FakeElement("div");
  const notificationButton = new FakeElement("button");
  notificationButton.textContent = "Checking background alerts…";
  notificationButton.disabled = true;
  const notificationDisclosure = new FakeElement("p");
  const notificationSettings = new FakeElement("dialog");
  const networkRecoveryHelp = new FakeElement("dialog");
  const networkRecoveryHelpClose = new FakeElement("button");
  const notificationSettingsClose = new FakeElement("button");
  const settingsButton = new FakeElement("button");
  const notificationDetailOptions = new FakeElement("fieldset");
  notificationDetailOptions.hidden = true;
  const localActionToast = new FakeElement("aside");
  localActionToast.hidden = true;
  const localActionToastCopy = new FakeElement("span");
  const localActionToastUndo = new FakeElement("button");
  const notificationDetailInputs = (["private", "session", "preview"] as const).map(value => {
    const input = new FakeElement("input");
    input.type = "radio";
    input.value = value;
    input.checked = value === "session";
    return input;
  });
  const directoryTitle = new FakeElement("h1");
  directoryTitle.textContent = "Sessions";
  const directoryCount = new FakeElement("p");
  directoryCount.hidden = true;
  const quickRepliesInput = new FakeElement("textarea");
  const quickRepliesReset = new FakeElement("button");
  // The masthead row the Workspace launcher joins, right before Settings.
  const brandRow = new FakeElement("div");
  brandRow.className = "brand-row";
  brandRow.append(new FakeElement("p"), settingsButton);
  const bySelector: Record<string, FakeElement> = {
    "#session-list": sessionList,
    "#empty-state": emptyState,
    "#status-banner": statusBanner,
    "#notify": notificationButton,
    "#notify-note": notificationDisclosure,
    "#directory-title": directoryTitle,
    "#directory-count": directoryCount,
    "#local-action-toast": localActionToast,
    "#local-action-toast-copy": localActionToastCopy,
    "#local-action-toast-undo": localActionToastUndo,
    "#notification-settings": notificationSettings,
    "#notification-settings-close": notificationSettingsClose,
    "#settings": settingsButton,
    "#notification-detail-options": notificationDetailOptions,
    "#network-recovery-help": networkRecoveryHelp,
    "#network-recovery-help-close": networkRecoveryHelpClose,
    "#quick-replies-input": quickRepliesInput,
    "#quick-replies-reset": quickRepliesReset,
    "link[data-omp-collab-styles]": new FakeElement("link"),
    ".brand-row": brandRow,
  };
  const window = new FakeWindow();
  const document = new FakeDocument(bySelector, notificationDetailInputs, window);
  const localStorage = options.storage ?? new FakeStorage();
  const reloads = { count: 0 };
  const location = {
    origin: "https://sessions.example",
    pathname: options.pathname ?? "/",
    search: options.search ?? "",
    get href(): string { return `${this.origin}${this.pathname}${this.search}`; },
    reload(): void { reloads.count += 1; },
    replace(path: string): void {
      location.pathname = path;
      location.search = "";
    },
  };
  const history = {
    replaced: [] as string[],
    state: null as unknown,
    replaceState(data: unknown, _unused: string, path: string): void {
      this.replaced.push(path);
      this.state = data;
      location.pathname = path;
      location.search = "";
    },
    pushState(data: unknown, _unused: string, path: string): void {
      this.state = data;
      location.pathname = path;
      location.search = "";
    },
    back(): void {},
  };
  const fetchPaths: string[] = [];
  const fetchLocations: string[] = [];
  const fetchInits: { readonly path: string; readonly init: RequestInit }[] = [];
  let listRevision = 1;
  let listSessions = [...options.initialSessions];
  let listHosts = options.initialHosts;
  let listFleetStatus = options.initialFleetStatus;
  let launchStatus = options.launchStatus ?? 200;
  let heldLaunch: Promise<void> | undefined;
  let listStatus = 200;
  const workerMessages: unknown[] = [];
  let hangingListRequests = 0;
  let failedListRequests = 0;
  const permissionRequests = { count: 0 };
  const subscriptionRequests: unknown[] = [];
  const unsubscribeRequests: unknown[] = [];
  const subscriptionCalls = { subscribe: 0, unsubscribe: 0 };
  const notificationApi = {
    permission: options.permission,
    async requestPermission(): Promise<NotificationPermission> {
      permissionRequests.count += 1;
      this.permission = options.permissionResult ?? "granted";
      return this.permission;
    },
  };
  const pushSubscriptionJson = {
    endpoint: "https://push.example.test/send/browser-device",
    expirationTime: null,
    keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
  };
  let currentSubscription: PushSubscription | null = null;
  const createPushSubscription = (): PushSubscription => ({
    endpoint: pushSubscriptionJson.endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: null },
    getKey(): ArrayBuffer | null {
      return null;
    },
    toJSON(): PushSubscriptionJSON {
      if (options.webkitSubscriptionJson !== true) return pushSubscriptionJson;
      const { expirationTime: _omitted, ...webkit } = pushSubscriptionJson;
      return webkit;
    },
    async unsubscribe(): Promise<boolean> {
      subscriptionCalls.unsubscribe += 1;
      currentSubscription = null;
      return true;
    },
  });
  if (options.existingSubscription === true) currentSubscription = createPushSubscription();
  const pushManager = {
    async getSubscription(): Promise<PushSubscription | null> {
      return currentSubscription;
    },
    async subscribe(): Promise<PushSubscription> {
      subscriptionCalls.subscribe += 1;
      currentSubscription = createPushSubscription();
      return currentSubscription;
    },
  };
  const notifications: FakeBrowserNotification[] = [];
  const registration = {
    active: {
      postMessage(message: unknown, transfer: readonly MessagePort[]): void {
        workerMessages.push(message);
        const response = options.workerResponse ?? {
          type: "omp-notification-support-response",
          version: 2,
        };
        transfer[0]?.postMessage(response);
      },
    },
    pushManager,
    async getNotifications(options: { readonly tag?: string } = {}): Promise<FakeBrowserNotification[]> {
      return notifications.filter(notification =>
        !notification.closed && (options.tag === undefined || notification.tag === options.tag),
      );
    },
    async showNotification(): Promise<void> {},
  };
  const serviceWorker = new EventTarget() as EventTarget & {
    controller: object | null;
    readonly ready: Promise<typeof registration>;
    register(): Promise<typeof registration>;
    startMessages(): void;
  };
  serviceWorker.controller = {};
  Object.defineProperties(serviceWorker, {
    ready: { value: Promise.resolve(registration) },
    register: {
      async value(): Promise<typeof registration> {
        return registration;
      },
    },
    startMessages: { value(): void {} },
  });
  const navigator = { serviceWorker, onLine: true };
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    fetchPaths.push(path);
    fetchLocations.push(location.pathname + location.search);
    fetchInits.push({ path, init });
    if (path === "/api/v1/push/config") {
      return Response.json({ version: 2, applicationServerKey: "V".repeat(87) });
    }
    if (path === "/api/v1/push/subscription") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (init.method === "DELETE") {
        unsubscribeRequests.push(body);
        return new Response(null, { status: 204 });
      }
      subscriptionRequests.push(body);
      return Response.json({
        version: 2,
        detailLevel: body.detailLevel ?? "session",
      });
    }
    if (path.endsWith("/launch")) {
      if (heldLaunch !== undefined) await heldLaunch;
      if (launchStatus !== 200) return new Response("", { status: launchStatus });
      const request = typeof init.body === "string" ? JSON.parse(init.body) as { mode?: unknown; generation?: unknown } : {};
      return Response.json({
        mode: request.mode,
        generation: request.generation,
        capability: "capability-canary",
      });
    }
    if (path === "/api/v1/workspace" && options.workspaceStatus !== undefined) {
      return new Response("", { status: options.workspaceStatus });
    }
    if (path !== "/api/v1/sessions") throw new Error(`unexpected fetch: ${path}`);
    if (failedListRequests > 0) {
      failedListRequests -= 1;
      throw new TypeError("network request failed");
    }
    if (hangingListRequests > 0) {
      hangingListRequests -= 1;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        const abort = (): void => reject(new DOMException("snapshot timed out", "AbortError"));
        if (signal?.aborted === true) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (listStatus !== 200) return new Response("", { status: listStatus });
    return Response.json({
      revision: listRevision,
      sessions: listSessions,
      ...(listHosts === undefined ? {} : { hosts: listHosts }),
      ...(listFleetStatus === undefined ? {} : { fleetStatus: listFleetStatus }),
    });
  };

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: document },
    location: { configurable: true, value: location },
    history: { configurable: true, value: history },
    navigator: { configurable: true, value: navigator },
    localStorage: { configurable: true, value: localStorage },
    Notification: { configurable: true, value: notificationApi },
    PushManager: { configurable: true, value: class {} },
    MessageChannel: { configurable: true, value: FakeMessageChannel },
    EventSource: { configurable: true, value: FakeEventSource },
    fetch: { configurable: true, value: fetch },
    isSecureContext: { configurable: true, value: true },
    HTMLElement: { configurable: true, value: class extends EventTarget {} },
    ...(options.launchStatus === undefined
      ? {}
      : {
          __COLLAB_CLIENT_MODULE__: { configurable: true, value: import.meta.url },
          __COLLAB_CLIENT_STYLESHEET__: { configurable: true, value: "/client/collab.css" },
        }),
  });

  // app.ts bootstraps at import time, so a cache-busted test module is required for an isolated page.
  await import(`../src/app.ts?${options.suffix}`);
  await settleUntil(() => notificationButton.textContent !== "Checking background alerts…");
  await settleUntil(() => FakeEventSource.instances.length === 1);
  if (options.pathname?.startsWith("/collab/") === true) {
    await settleUntil(() => statusBanner.dataset.kind === "expired", 100);
  }

  return {
    body: document.body,
    setEmbedState(state): void {
      embedStateSink?.(state);
    },
    elements: {
      sessionList,
      statusBanner,
      notificationButton,
      notificationDisclosure,
      notificationSettings,
      networkRecoveryHelp,
      settingsButton,
      notificationDetailOptions,
      emptyState,
      notificationDetailInputs,
      directoryTitle,
      directoryCount,
      localActionToast,
      localActionToastCopy,
      localActionToastUndo,
      quickRepliesInput,
      quickRepliesReset,
    },
    fetchPaths,
    fetchLocations,
    fetchInits,
    permissionRequests,
    subscriptionRequests,
    unsubscribeRequests,
    subscriptionCalls,
    workerMessages,
    replacedPaths: history.replaced,
    reloads,
    window,
    localStorage,
    notifications,
    addNotification(tag, data): FakeBrowserNotification {
      const notification = new FakeBrowserNotification(tag, data);
      notifications.push(notification);
      return notification;
    },
    emit(type, payload): void {
      const source = FakeEventSource.instances.at(-1);
      if (source === undefined) throw new Error("missing event source");
      source.emit(type, payload);
    },
    disconnectEvents(): void {
      const source = FakeEventSource.instances.at(-1);
      if (source === undefined) throw new Error("missing event source");
      source.onerror?.();
    },
    expireEventLiveness(): void {
      window.runTimers();
    },
    runTimers(): void {
      window.runTimers();
    },
    runUndoTimer(): void {
      window.runTimersWithDelay(5_000);
    },
    pendingDelays(): number[] {
      return window.pendingDelays();
    },
    setVisibility(state): void {
      document.setVisibility(state);
    },
    freeze(): void {
      document.freeze();
    },
    advanceClock(milliseconds): void {
      clockOffset += milliseconds;
    },
    hangNextListRequest(): void {
      hangingListRequests += 1;
    },
    failNextListRequest(): void {
      failedListRequests += 1;
    },
    setOnline(online): void {
      navigator.onLine = online;
    },
    activateWorker(): void {
      serviceWorker.controller = {};
      serviceWorker.dispatchEvent(new Event("controllerchange"));
    },
    holdNextLaunch(): Promise<void> {
      let release: () => void = () => undefined;
      heldLaunch = new Promise<void>(resolve => {
        release = () => {
          heldLaunch = undefined;
          resolve();
        };
      });
      return Promise.resolve().then(release);
    },
    holdLaunches(): () => void {
      let release: () => void = () => undefined;
      heldLaunch = new Promise<void>(resolve => {
        release = () => {
          heldLaunch = undefined;
          resolve();
        };
      });
      return release;
    },
    setList(revision, sessions, status = 200, hosts = listHosts, fleetStatus = listFleetStatus): void {
      listRevision = revision;
      listSessions = [...sessions];
      listStatus = status;
      listHosts = hosts;
      listFleetStatus = fleetStatus;
    },
  };
}

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    const descriptor = nativeGlobals[name];
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  Date.now = nativeNow;
});

describe("dashboard attention and notifications", () => {
  test("renders the boolean-only triage queue without prompting or notifying on the initial list", async () => {
    const harness = await bootApp({
      permission: "default",
      suffix: "initial-attention",
      initialSessions: [
        session("ordinary-newest-0003", { startedAt: "2026-07-21T12:00:00.000Z" }),
        session("attention-viewonly-002", {
          startedAt: "2026-07-21T09:00:00.000Z",
          canControl: false,
          inputRequired: true,
        }),
        session("attention-control-0001", { inputRequired: true }),
      ],
    });

    expect(harness.elements.directoryTitle.textContent).toBe("Needs you");
    expect(harness.elements.directoryCount.textContent).toBe("2 waiting");
    expect(harness.elements.directoryCount.className).toContain("count-pill-waiting");
    const hero = harness.elements.sessionList.querySelector(".queue-hero");
    expect(hero?.querySelector("h2")?.textContent).toBe("attention-control-0001");
    expect(hero?.querySelector(".ask-preview")?.textContent).toBe("Waiting for your input");
    expect(hero?.querySelector(".action-request")?.textContent).toBe("Open request");
    expect(hero?.querySelectorAll(".hero-alt").map(action => action.textContent)).toEqual([
      "Hold for desk",
      "Transcript",
    ]);
    const waitingRows = harness.elements.sessionList.querySelectorAll(".queue-row");
    expect(waitingRows.map(row => row.querySelector(".row-title")?.textContent)).toEqual([
      "attention-viewonly-002",
    ]);
    expect(waitingRows[0]?.getAttribute("aria-label")).toBe("View attention-viewonly-002");
    expect(
      harness.elements.sessionList.querySelectorAll(".working-row").map(
        row => row.querySelector(".row-title")?.textContent,
      ),
    ).toEqual(["ordinary-newest-0003"]);
    expect(harness.elements.sessionList.querySelector(".attention")).toBeNull();
    expect(harness.permissionRequests.count).toBe(0);
    expect(harness.workerMessages).toEqual([{ type: "omp-notification-support-request", version: 2 }]);
    expect(harness.elements.notificationButton.textContent).toBe("Enable background alerts");
    expect(harness.elements.notificationButton.dataset.state).toBe("idle");
    expect(harness.elements.notificationDisclosure.hidden).toBeFalse();
  });

  test("renders the exact all-clear resting state", async () => {
    const harness = await bootApp({
      permission: "denied",
      suffix: "all-clear",
      initialSessions: [
        session("working-session-0001", { startedAt: "2026-07-21T10:00:00.000Z" }),
        session("working-session-0002", { startedAt: "2026-07-21T11:00:00.000Z" }),
      ],
    });

    expect(harness.elements.directoryTitle.textContent).toBe("Sessions");
    expect(harness.elements.directoryCount.textContent).toBe("Live · 2");
    expect(harness.elements.sessionList.querySelector(".all-clear-title")?.textContent).toBe("All clear");
    // Blocked alerts must not promise a ping; the hint chip routes to Settings instead.
    expect(harness.elements.sessionList.querySelector(".all-clear-copy")?.textContent).toBe(
      "Nothing needs you.",
    );
    expect(harness.elements.sessionList.querySelector(".alerts-hint")?.textContent).toBe(
      "Alerts blocked · Settings",
    );
    expect(
      harness.elements.sessionList
        .querySelectorAll(".working-row")
        .map(row => row.querySelector(".row-title")?.textContent),
    ).toEqual(["working-session-0002", "working-session-0001"]);
    const firstWorking = harness.elements.sessionList.querySelector(".working-row");
    expect(firstWorking?.querySelector(".row-time")).not.toBeNull();
    expect(firstWorking?.querySelector(".working-context")?.textContent).toBe("· project");
    expect(firstWorking?.querySelector(".working-model")?.textContent).toBe("· model");
    const hide = harness.elements.sessionList.querySelector(".dismiss-session");
    expect(hide?.textContent).toBe("Hide");
    expect(hide?.getAttribute("aria-label")).toBe("Hide working-session-0002 on this device");
  });

  test("shows the empty state instead of a zero-count all-clear when nothing is live", async () => {
    const harness = await bootApp({
      permission: "denied",
      suffix: "empty-directory",
      initialSessions: [],
    });

    expect(harness.elements.emptyState.hidden).toBeFalse();
    expect(harness.elements.directoryTitle.textContent).toBe("Sessions");
    expect(harness.elements.directoryCount.hidden).toBeTrue();
    expect(harness.elements.sessionList.querySelector(".all-clear-title")).toBeNull();

    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 2,
      session: session("empty-then-live-0001"),
    });
    expect(harness.elements.emptyState.hidden).toBeTrue();
    expect(harness.elements.directoryCount.hidden).toBeFalse();

    harness.emit("session_remove", {
      type: "session_remove",
      revision: 3,
      instanceId: "empty-then-live-0001",
      generation: 1,
    });
    expect(harness.elements.emptyState.hidden).toBeFalse();
    expect(harness.elements.directoryCount.hidden).toBeTrue();
  });

  test("activity samples distinguish working, idle, and unknown across metadata updates", async () => {
    const base = session("activity-samples-0001", { busy: true });
    const harness = await bootApp({
      permission: "denied", suffix: "activity-samples", initialSessions: [base],
    });
    const activity = (): string | null | undefined =>
      harness.elements.sessionList.querySelector(".session-activity")?.textContent;
    expect(activity()).toContain("Working");
    harness.emit("session_upsert", { type: "session_upsert", revision: 2, session: { ...base, busy: false } });
    expect(activity()).toContain("Idle");
    harness.emit("session_upsert", { type: "session_upsert", revision: 3, session: session(base.instanceId) });
    expect(activity()).toContain("Activity unknown");
    expect(harness.elements.directoryCount.textContent).toBe("Live · 1");
    expect(harness.fetchPaths.some(path => path.endsWith("/launch"))).toBeFalse();
  });

  test("scrubs malformed notification routes before any fetch without attempting a launch", async () => {
    const harness = await bootApp({
      permission: "denied",
      pathname: "/collab/activity-session-0001",
      search: "?activity=stopped&generation=01",
      suffix: "malformed-notification-route",
      initialSessions: [session("activity-session-0001")],
    });
    expect(harness.fetchLocations.every(path => path === "/")).toBeTrue();
    expect(harness.replacedPaths).toEqual(["/"]);
    expect(harness.fetchPaths.some(path => path.endsWith("/launch"))).toBeFalse();
    harness.emit("keepalive", { type: "keepalive", revision: 1 });
    expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
  });

  test("rejects changed, gone, and unavailable activity-stop sessions without launching", async () => {
    for (const [name, current] of [
      ["changed", session("activity-session-0001", { generation: 2 })],
      ["gone", undefined],
      ["unavailable", session("activity-session-0001", { canView: false, canControl: false })],
    ] as const) {
      const harness = await bootApp({
        permission: "denied",
        pathname: "/collab/activity-session-0001",
        search: "?activity=stopped&generation=1",
        suffix: `stale-activity-${name}`,
        initialSessions: current === undefined ? [] : [current],
      });
      expect(harness.fetchLocations.every(path => path === "/")).toBeTrue();
      expect(harness.fetchPaths.some(path => path.endsWith("/launch"))).toBeFalse();
      expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
      harness.emit("keepalive", { type: "keepalive", revision: 1 });
      expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
    }
  });

  test("scrubs stale notification routes and keeps their expired state visible", async () => {
    const harness = await bootApp({
      permission: "denied",
      pathname: "/collab/stale-attention-0001",
      search: "?request=stale-request-0001",
      suffix: "stale-attention-route",
      initialSessions: [],
    });

    expect(harness.replacedPaths).toEqual(["/"]);
    expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
    harness.emit("snapshot", { type: "snapshot", revision: 2, sessions: [] });
    expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
  });

  test("reloads an idle directory after an updated worker activates", async () => {
    const harness = await bootApp({
      permission: "denied",
      suffix: "worker-activation",
      initialSessions: [session("worker-update-0001")],
    });

    harness.activateWorker();
    expect(harness.reloads.count).toBe(0);
    harness.runTimers();
    expect(harness.reloads.count).toBe(1);
  });

  test("closes a silent SSE stream and resyncs, raising the outage only after the grace", async () => {
    const base = session("liveness-session-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "sse-liveness",
      initialSessions: [base],
    });

    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    harness.expireEventLiveness();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.closed).toBeTrue();
    // A reconnect usually lands within the grace, so nothing is shown yet.
    expect(harness.elements.statusBanner.dataset.kind).not.toBe("gateway");
    expect(harness.pendingDelays()).toContain(3_000);

    // Still down when the grace ends: now it is an outage worth showing.
    harness.advanceClock(3_000);
    harness.window.runTimersWithDelay(3_000);
    expect(harness.elements.statusBanner.dataset.kind).toBe("gateway");
    expect(harness.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "Gateway unavailable",
    );

    harness.setList(2, [base]);
    harness.runTimers();
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length === 2);
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 1);
    await settleUntil(() => FakeEventSource.instances.length === 2);
    expect(harness.elements.statusBanner.hidden).toBe(true);
  });

  test("a stream drop that reconnects within the grace, or happens while hidden, shows no outage", async () => {
    const base = session("brief-drop-session-01");
    const harness = await bootApp({ permission: "denied", suffix: "brief-drop", initialSessions: [base] });

    harness.disconnectEvents();
    harness.setList(2, [base]);
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => FakeEventSource.instances.length === 2);
    await drainMicrotasks();
    expect(harness.pendingDelays()).not.toContain(3_000);
    harness.runTimers();
    await drainMicrotasks();
    expect(harness.elements.statusBanner.dataset.kind).not.toBe("gateway");

    harness.setVisibility("hidden");
    harness.disconnectEvents();
    expect(harness.pendingDelays()).not.toContain(3_000);
    expect(harness.elements.statusBanner.dataset.kind).not.toBe("gateway");
  });
  test("recovers through the native event stream when browser timers are lost", async () => {
    const base = session("native-reconnect-0001");
    const recovered = session("native-reconnect-0001", { title: "Recovered natively" });
    const harness = await bootApp({
      permission: "denied",
      suffix: "native-eventsource-reconnect",
      initialSessions: [base],
    });
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing initial event stream");

    harness.disconnectEvents();
    expect(source.closed).toBeFalse();

    source.onopen?.();
    source.emit("snapshot", { type: "snapshot", revision: 2, sessions: [recovered] });
    await settleUntil(() => harness.elements.statusBanner.hidden);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(harness.elements.sessionList.querySelector(".row-title")?.textContent).toBe(
      "Recovered natively",
    );
  });



  test("keeps the last directory while distinguishing device and tailnet outages", async () => {
    const offlineBase = session("offline-session-0001");
    const offline = await bootApp({
      permission: "denied",
      suffix: "phone-offline",
      initialSessions: [offlineBase],
    });
    offline.setOnline(false);
    offline.window.dispatchEvent(new Event("offline"));
    expect(offline.elements.statusBanner.dataset.kind).toBe("offline");
    expect(offline.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "You're offline",
    );
    expect(offline.elements.statusBanner.querySelector(".status-detail")?.textContent).toContain(
      "Showing the list as of",
    );
    expect(offline.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);

    const tailnetBase = session("tailnet-session-0001");
    const tailnet = await bootApp({
      permission: "denied",
      suffix: "tailnet-offline",
      initialSessions: [tailnetBase],
    });
    tailnet.failNextListRequest();
    tailnet.disconnectEvents();
    tailnet.runTimers();
    await settleUntil(() => tailnet.elements.statusBanner.dataset.kind === "tailnet");
    expect(tailnet.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "Tailnet unreachable",
    );
    expect(tailnet.elements.statusBanner.querySelector(".status-detail")?.textContent).toBe(
      "This device is online, but your tailnet isn't answering — Tailscale is off or logged out here.",
    );
    expect(tailnet.elements.statusBanner.querySelector(".status-freshness")?.textContent).toContain(
      "Last seen",
    );
    expect(tailnet.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
  });

  test("releases the directory stream when the hidden page freezes and rebuilds it on return", async () => {
    const base = session("frozen-directory-0001");
    const harness = await bootApp({ permission: "denied", suffix: "frozen-directory", initialSessions: [base] });
    const source = FakeEventSource.instances.at(-1);
    if (source === undefined) throw new Error("missing event source");
    const listReads = (): number => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;
    const readsBeforeFreeze = listReads();

    // A short app switch keeps the stream.
    harness.setVisibility("hidden");
    expect(source.closed).toBeFalse();

    harness.freeze();
    expect(source.closed).toBeTrue();
    expect(harness.pendingDelays()).toEqual([]);
    expect(harness.elements.statusBanner.hidden).toBeTrue();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);

    harness.setVisibility("visible");
    await settleUntil(() => FakeEventSource.instances.at(-1) !== source);
    expect(listReads()).toBe(readsBeforeFreeze + 1);
    expect(FakeEventSource.instances.at(-1)?.closed).toBeFalse();
  });

  test("offers local browser recovery help only after a prolonged visible outage", async () => {
    const base = session("prolonged-outage-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "prolonged-outage",
      initialSessions: [base],
    });

    harness.failNextListRequest();
    harness.disconnectEvents();
    harness.runTimers();
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "tailnet");
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();

    harness.setVisibility("hidden");
    harness.advanceClock(45_000);
    harness.failNextListRequest();
    harness.setVisibility("visible");
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "tailnet");
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();

    harness.advanceClock(45_000);
    harness.failNextListRequest();
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.querySelector(".status-guidance") !== null);
    expect(harness.elements.statusBanner.querySelector(".status-guidance")?.textContent).toContain(
      "The browser may be stuck after sleep or a network change",
    );
    const troubleshooting = harness.elements.statusBanner
      .querySelectorAll(".status-action")
      .find(element => element.tagName === "button" && element.textContent === "Troubleshooting");
    troubleshooting?.dispatchEvent(new Event("click"));
    expect(harness.elements.networkRecoveryHelp.open).toBeTrue();

    harness.setList(2, [base]);
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.hidden);
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();
    expect(harness.elements.networkRecoveryHelp.open).toBeFalse();
  });
  test("times out a hung snapshot and keeps retrying automatically", async () => {
    const base = session("snapshot-timeout-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "snapshot-timeout",
      initialSessions: [base],
    });

    harness.hangNextListRequest();
    harness.disconnectEvents();
    harness.runTimers();
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length === 2);

    expect(harness.pendingDelays()).toContain(20_000);
    harness.runTimers();

    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "desktop");
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(harness.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "Desktop unreachable",
    );

    harness.setList(2, [base]);
    harness.runTimers();
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length === 3);
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 1);
    expect(harness.elements.statusBanner.hidden).toBe(true);
  });
  test("backs off repeated visible network failures instead of churning connections", async () => {
    const nativeRandom = Math.random;
    Math.random = () => 0.999;
    try {
      const base = session("network-backoff-0001");
      const harness = await bootApp({
        permission: "denied",
        suffix: "network-backoff",
        initialSessions: [base],
      });
      const snapshots = (): number => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;
      const retryDelays: number[] = [];

      harness.disconnectEvents();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await settleUntil(() => harness.pendingDelays().some(delay => delay < 45_000));
        retryDelays.push(Math.min(...harness.pendingDelays().filter(delay => delay < 45_000)));
        harness.failNextListRequest();
        harness.runTimers();
        await settleUntil(() => snapshots() === attempt + 2);
      }

      expect(retryDelays).toEqual([999, 1_999, 3_998, 7_996, 15_992]);
    } finally {
      Math.random = nativeRandom;
    }
  });

  test("creates and removes a persistent push subscription only after explicit user actions", async () => {
    const base = session("transition-session-001", { title: "PROMPT_CONTENT_CANARY" });
    const harness = await bootApp({
      permission: "default",
      permissionResult: "granted",
      suffix: "background-subscription",
      initialSessions: [base],
    });

    expect(harness.subscriptionRequests).toHaveLength(0);
    harness.elements.notificationButton.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.elements.notificationButton.textContent === "Disable background alerts");
    expect(harness.elements.notificationButton.dataset.state).toBe("enabled");
    expect(harness.elements.notificationButton.disabled).toBeFalse();
    expect(harness.permissionRequests.count).toBe(1);
    expect(harness.subscriptionCalls.subscribe).toBe(1);
    expect(harness.subscriptionRequests).toHaveLength(1);
    expect(JSON.stringify(harness.subscriptionRequests)).not.toContain("CONTENT_CANARY");

    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 2,
      session: session(base.instanceId, { ...base, inputRequired: true }),
    });
    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 3,
      session: { ...base, inputRequired: false },
    });
    await Promise.resolve();
    expect(harness.subscriptionRequests).toHaveLength(1);

    // The toggle lives in the Settings sheet and now disables in place.
    expect(harness.elements.notificationDetailOptions.hidden).toBeFalse();
    harness.elements.notificationButton.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.elements.notificationButton.textContent === "Enable background alerts");
    expect(harness.subscriptionCalls.unsubscribe).toBe(1);
    expect(harness.unsubscribeRequests).toEqual([
      { version: 2, endpoint: "https://push.example.test/send/browser-device" },
    ]);
  });

  // #274: no iPhone or iPad could enable background alerts. WebKit omits a null `expirationTime`
  // from `PushSubscription.toJSON()`, and the exact subscription check rejected that shape before
  // any request, so the new subscription was removed and the control read unavailable.
  test("enables background alerts when WebKit omits a null subscription expiration", async () => {
    const harness = await bootApp({
      permission: "default",
      permissionResult: "granted",
      webkitSubscriptionJson: true,
      suffix: "webkit-subscription",
      initialSessions: [session("webkit-session-001")],
    });

    harness.elements.notificationButton.dispatchEvent(new Event("click"));
    const settled = () => harness.elements.notificationButton.dataset.state;
    await settleUntil(() => settled() === "enabled" || settled() === "unavailable");
    expect(settled()).toBe("enabled");
    expect(harness.subscriptionCalls.unsubscribe).toBe(0);
    expect(harness.subscriptionRequests).toEqual([
      expect.objectContaining({ subscription: expect.objectContaining({ expirationTime: null }) }),
    ]);
  });

  test("restores an existing browser subscription without requesting permission again", async () => {
    const base = session("reconnect-session-001");
    const harness = await bootApp({
      permission: "granted",
      existingSubscription: true,
      suffix: "background-subscription-restore",
      initialSessions: [base],
    });

    expect(harness.elements.notificationButton.textContent).toBe("Disable background alerts");
    expect(harness.permissionRequests.count).toBe(0);
    expect(harness.subscriptionCalls.subscribe).toBe(0);
    expect(harness.subscriptionRequests).toHaveLength(1);

    harness.disconnectEvents();
    harness.setList(2, [session(base.instanceId, { ...base, inputRequired: true })]);
    harness.runTimers();
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length >= 2);
    expect(harness.subscriptionRequests).toHaveLength(1);
  });


  test("updates notification detail for the existing device subscription", async () => {
    const harness = await bootApp({
      permission: "granted",
      existingSubscription: true,
      suffix: "notification-detail",
      initialSessions: [session("notification-detail-0001")],
    });

    expect(harness.subscriptionRequests).toHaveLength(1);
    harness.elements.settingsButton.dispatchEvent(new Event("click"));
    expect(harness.elements.notificationSettings.open).toBeTrue();
    expect(harness.elements.notificationDetailOptions.hidden).toBeFalse();
    const preview = harness.elements.notificationDetailInputs.find(input => input.value === "preview");
    expect(preview).toBeDefined();
    if (preview === undefined) throw new Error("missing preview detail input");
    for (const input of harness.elements.notificationDetailInputs) input.checked = input === preview;
    preview.dispatchEvent(new Event("change"));
    await settleUntil(() => harness.subscriptionRequests.length === 2);
    expect(harness.subscriptionRequests[1]).toMatchObject({
      version: 2,
      detailLevel: "preview",
    });
  });
  test("uses only bounded metadata bodies and fails closed for denied or invalid worker support", async () => {
    const denied = await bootApp({
      permission: "denied",
      suffix: "notifications-denied",
      initialSessions: [session("denied-session-0001")],
    });
    expect(denied.elements.notificationButton.textContent).toBe("Notifications blocked");
    expect(denied.elements.notificationButton.dataset.state).toBe("blocked");
    expect(denied.elements.notificationButton.disabled).toBeTrue();
    expect(denied.elements.notificationDisclosure.textContent).toContain("browser settings");
    denied.elements.notificationButton.dispatchEvent(new Event("click"));
    expect(denied.permissionRequests.count).toBe(0);

    const unavailable = await bootApp({
      permission: "default",
      workerResponse: { type: "omp-notification-support-response", version: 2, extra: true },
      suffix: "notifications-invalid-worker",
      initialSessions: [session("unavailable-session-01")],
    });
    expect(unavailable.elements.notificationButton.textContent).toBe("Background alerts unavailable");
    expect(unavailable.elements.notificationButton.dataset.state).toBe("unavailable");
    expect(unavailable.elements.notificationButton.disabled).toBeTrue();
  });

  test("rebuilds a frozen directory connection on resume instead of trusting the old one", async () => {
    const base = session("resume-session-00001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "frozen-resume",
      initialSessions: [base],
    });
    const snapshots = (): number => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(snapshots()).toBe(1);
    const frozen = FakeEventSource.instances[0];

    // #65's reproduction recipe: display off freezes the renderer, so no timer runs and the liveness
    // watchdog never fires, while wall-clock time passes and the stream silently dies. The
    // EventSource still reports open because nothing in the page ran to notice otherwise.
    harness.setVisibility("hidden");
    harness.advanceClock(45_000);
    harness.setList(2, [base]);
    harness.setVisibility("visible");

    // No timer is flushed anywhere below: resume alone has to produce the fresh connection.
    expect(frozen?.closed).toBeTrue();
    await settleUntil(() => FakeEventSource.instances.length === 2);
    await settleUntil(() => snapshots() === 2);
    expect(FakeEventSource.instances[1]?.closed).toBeFalse();
    expect(harness.elements.statusBanner.hidden).toBeTrue();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
  });

  test("keeps a bounded retry pending when the phone reports offline and no online event follows", async () => {
    const base = session("offline-retry-000001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "offline-retry",
      initialSessions: [base],
    });
    const snapshots = (): number => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;

    expect(snapshots()).toBe(1);
    harness.setOnline(false);
    harness.window.dispatchEvent(new Event("offline"));
    expect(harness.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "You're offline",
    );

    // The offline state must carry its own way out: #65 measured `navigator.onLine` reporting true
    // through a total outage, so an `online` event is not a wake-up the page can count on. One
    // retry is pending, and it is scheduled inside the backoff ceiling.
    expect(harness.pendingDelays()).toHaveLength(1);
    expect(harness.pendingDelays()[0]).toBeLessThanOrEqual(4_000);

    harness.setOnline(true);
    harness.setList(2, [base]);
    harness.runTimers();
    await settleUntil(() => snapshots() === 2);
    await settleUntil(() => FakeEventSource.instances.length === 2);
    expect(harness.elements.statusBanner.hidden).toBeTrue();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
  });

  test("does not count offline time toward browser recovery guidance", async () => {
    const base = session("offline-guidance-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "offline-guidance",
      initialSessions: [base],
    });

    harness.setOnline(false);
    harness.window.dispatchEvent(new Event("offline"));
    harness.advanceClock(60_000);
    harness.setOnline(true);
    harness.failNextListRequest();
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "tailnet");
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();
  });

  test("holds an ask locally, closes only its notification, and preserves FIFO across reload", async () => {
    const storage = new FakeStorage();
    const first = session("hold-first-session-0001", {
      inputRequired: true,
      ask: {
        requestId: "hold-first-request-0001",
        since: "2026-07-21T10:00:00.000Z",
      },
    });
    const second = session("hold-second-session-002", {
      inputRequired: true,
      ask: {
        requestId: "hold-second-request-002",
        since: "2026-07-21T10:01:00.000Z",
      },
    });
    const harness = await bootApp({
      permission: "denied",
      suffix: "hold-local",
      storage,
      initialSessions: [second, first],
    });
    const tag = `omp-attention-${first.instanceId}`;
    const matching = harness.addNotification(tag, { requestId: first.ask?.requestId });
    const unrelatedRequest = harness.addNotification(tag, { requestId: second.ask?.requestId });
    const unrelatedTag = harness.addNotification("omp-attention-unrelated-session", {
      requestId: first.ask?.requestId,
    });

    harness.elements.sessionList.querySelector(".hero-hold")?.dispatchEvent(new Event("click"));
    await settleUntil(() => matching.closed);

    expect(unrelatedRequest.closed).toBeFalse();
    expect(unrelatedTag.closed).toBeFalse();
    expect(harness.elements.directoryCount.textContent).toBe("2 waiting · 1 held");
    expect(harness.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      second.instanceId,
    );
    expect(harness.elements.sessionList.querySelector(".held-row")?.dataset.instanceId).toBe(
      first.instanceId,
    );
    const stored = JSON.parse(storage.getItem("omp.sessions.held-asks.v1") ?? "null") as unknown;
    expect(stored).toEqual([
      {
        instanceId: first.instanceId,
        requestId: first.ask?.requestId,
        heldAt: expect.any(String),
      },
    ]);
    expect(Object.keys((stored as Record<string, unknown>[])[0] ?? {}).sort()).toEqual([
      "heldAt",
      "instanceId",
      "requestId",
    ]);

    const reloaded = await bootApp({
      permission: "denied",
      suffix: "hold-local-reload",
      storage,
      initialSessions: [first, second],
    });
    expect(reloaded.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      second.instanceId,
    );
    reloaded.elements.sessionList.querySelector(".held-requeue")?.dispatchEvent(new Event("click"));
    expect(reloaded.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      first.instanceId,
    );
    expect(storage.getItem("omp.sessions.held-asks.v1")).toBe("[]");
  });

  test("shows an all-held queue and forgets a hold when the exact ask changes", async () => {
    const first = session("all-held-session-0001", {
      inputRequired: true,
      ask: {
        requestId: "all-held-request-0001",
        since: "2026-07-21T10:00:00.000Z",
      },
    });
    const second = session("all-held-session-0002", {
      inputRequired: true,
      ask: {
        requestId: "all-held-request-0002",
        since: "2026-07-21T10:01:00.000Z",
      },
    });
    const harness = await bootApp({
      permission: "denied",
      suffix: "all-held-local",
      initialSessions: [first, second],
    });

    const staleFirstHold = harness.elements.sessionList.querySelector(".hero-hold");
    harness.elements.sessionList.querySelector(".hero-hold")?.dispatchEvent(new Event("click"));
    harness.elements.sessionList.querySelector(".hero-hold")?.dispatchEvent(new Event("click"));
    expect(harness.elements.directoryCount.textContent).toBe("2 waiting · 2 held");
    expect(harness.elements.sessionList.querySelector(".queue-hero")).toBeNull();
    expect(harness.elements.sessionList.querySelector(".all-held-summary")?.querySelector("strong")?.textContent).toBe(
      "Queue clear · 2 on hold — handle at desk",
    );
    expect(harness.elements.sessionList.querySelectorAll(".held-row")).toHaveLength(2);

    const replacement = session(first.instanceId, {
      generation: first.generation,
      inputRequired: true,
      ask: {
        requestId: "replacement-request-0001",
        since: "2026-07-21T10:00:30.000Z",
      },
    });
    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 2,
      session: replacement,
    });

    expect(harness.elements.directoryCount.textContent).toBe("2 waiting · 1 held");
    expect(harness.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      first.instanceId,
    );
    expect(JSON.parse(harness.localStorage.getItem("omp.sessions.held-asks.v1") ?? "null")).toEqual([
      expect.objectContaining({
        instanceId: second.instanceId,
        requestId: second.ask?.requestId,
      }),
    ]);
    expect(staleFirstHold).not.toBeNull();
    staleFirstHold?.dispatchEvent(new Event("click"));
    expect(harness.elements.directoryCount.textContent).toBe("2 waiting · 1 held");
    expect(harness.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      first.instanceId,
    );
  });

  test("dismisses only on this device with undo, expiry, and an explicit restore surface", async () => {
    const first = session("dismiss-session-00001", { title: "Dismiss One" });
    const second = session("dismiss-session-00002", { title: "Keep Two" });
    const harness = await bootApp({
      permission: "denied",
      suffix: "dismiss-local",
      initialSessions: [first, second],
    });
    const networkCalls = harness.fetchPaths.length;

    harness.elements.sessionList.querySelectorAll(".dismiss-session")[0]?.dispatchEvent(new Event("click"));
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(harness.elements.directoryCount.textContent).toBe("Live · 2");
    expect(harness.elements.sessionList.querySelector(".all-clear-copy")?.textContent).toBe("Nothing needs you.");
    expect(harness.elements.localActionToast.hidden).toBeFalse();
    expect(harness.elements.localActionToastCopy.textContent).toStartWith("Hidden “Dismiss One”");
    const stored = JSON.parse(
      harness.localStorage.getItem("omp.sessions.dismissed.v1") ?? "null",
    ) as Record<string, unknown>[];
    expect(stored).toEqual([
      {
        instanceId: first.instanceId,
        generation: first.generation,
        dismissedAt: expect.any(String),
      },
    ]);
    expect(Object.keys(stored[0] ?? {}).sort()).toEqual([
      "dismissedAt",
      "generation",
      "instanceId",
    ]);

    harness.elements.localActionToastUndo.dispatchEvent(new Event("click"));
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(2);
    expect(harness.localStorage.getItem("omp.sessions.dismissed.v1")).toBe("[]");

    harness.elements.sessionList.querySelectorAll(".dismiss-session")[0]?.dispatchEvent(new Event("click"));
    harness.runUndoTimer();
    expect(harness.elements.localActionToast.hidden).toBeTrue();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(harness.fetchPaths).toHaveLength(networkCalls);
    const restore = harness.elements.sessionList
      .querySelector(".dismissed-control")
      ?.querySelector("button");
    expect(
      harness.elements.sessionList.querySelector(".dismissed-control")?.querySelector("span")?.textContent,
    ).toBe("1 hidden on this device");
    expect(restore?.textContent).toBe("Show all");
    restore?.dispatchEvent(new Event("click"));
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(2);
    expect(harness.localStorage.getItem("omp.sessions.dismissed.v1")).toBe("[]");
  });

  test("scopes dismissals to one generation and never hides a later attention request", async () => {
    const storage = new FakeStorage();
    const initial = session("generation-dismiss-001", { title: "Generation one" });
    const firstPage = await bootApp({
      permission: "denied",
      suffix: "dismiss-generation-first",
      storage,
      initialSessions: [initial],
    });
    firstPage.elements.sessionList.querySelector(".dismiss-session")?.dispatchEvent(new Event("click"));
    firstPage.runUndoTimer();

    const reloaded = await bootApp({
      permission: "denied",
      suffix: "dismiss-generation-reload",
      storage,
      initialSessions: [initial],
    });
    expect(reloaded.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(0);
    expect(reloaded.elements.sessionList.querySelector(".dismissed-control")).not.toBeNull();

    const replacement = session(initial.instanceId, {
      generation: 2,
      title: "Generation two",
    });
    reloaded.emit("session_upsert", {
      type: "session_upsert",
      revision: 2,
      session: replacement,
    });
    expect(reloaded.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(storage.getItem("omp.sessions.dismissed.v1")).toBe("[]");

    reloaded.elements.sessionList.querySelector(".dismiss-session")?.dispatchEvent(new Event("click"));
    const attention = session(initial.instanceId, {
      generation: 2,
      inputRequired: true,
      ask: {
        requestId: "attention-after-dismiss-0001",
        since: "2026-07-21T11:00:00.000Z",
      },
    });
    reloaded.emit("session_upsert", {
      type: "session_upsert",
      revision: 3,
      session: attention,
    });
    expect(reloaded.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      initial.instanceId,
    );
    expect(reloaded.elements.localActionToast.hidden).toBeTrue();
    expect(storage.getItem("omp.sessions.dismissed.v1")).toBe("[]");
  });

  test("sanitizes malformed, oversized, and excess local routing records", async () => {
    const heldSession = session("sanitized-hold-session-001", {
      inputRequired: true,
      ask: {
        requestId: "sanitized-hold-request-001",
        since: "2026-07-21T10:00:00.000Z",
      },
    });
    const dismissedSession = session("sanitized-dismiss-session-01");
    const heldRecord = {
      instanceId: heldSession.instanceId,
      requestId: heldSession.ask?.requestId,
      heldAt: "2026-07-21T10:01:00.000Z",
    };
    const dismissedRecord = {
      instanceId: dismissedSession.instanceId,
      generation: dismissedSession.generation,
      dismissedAt: "2026-07-21T10:01:00.000Z",
    };
    const sanitizedStorage = new FakeStorage();
    sanitizedStorage.setItem(
      "omp.sessions.held-asks.v1",
      JSON.stringify([
        heldRecord,
        { ...heldRecord, title: "LOCAL_STORAGE_TITLE_CANARY" },
        { ...heldRecord, heldAt: "not-canonical" },
      ]),
    );
    sanitizedStorage.setItem(
      "omp.sessions.dismissed.v1",
      JSON.stringify([dismissedRecord, { ...dismissedRecord, generation: 0 }]),
    );

    const sanitized = await bootApp({
      permission: "denied",
      suffix: "sanitize-local-records",
      storage: sanitizedStorage,
      initialSessions: [heldSession, dismissedSession],
    });
    expect(sanitized.elements.sessionList.querySelectorAll(".held-row")).toHaveLength(1);
    expect(sanitized.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(0);
    expect(JSON.parse(sanitizedStorage.getItem("omp.sessions.held-asks.v1") ?? "null")).toEqual([
      heldRecord,
    ]);
    expect(JSON.parse(sanitizedStorage.getItem("omp.sessions.dismissed.v1") ?? "null")).toEqual([
      dismissedRecord,
    ]);

    const oversizedStorage = new FakeStorage();
    oversizedStorage.setItem("omp.sessions.held-asks.v1", "x".repeat(512_001));
    const oversized = await bootApp({
      permission: "denied",
      suffix: "oversized-local-records",
      storage: oversizedStorage,
      initialSessions: [heldSession],
    });
    expect(oversizedStorage.getItem("omp.sessions.held-asks.v1")).toBeNull();
    expect(oversized.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      heldSession.instanceId,
    );

    const excessStorage = new FakeStorage();
    excessStorage.setItem(
      "omp.sessions.dismissed.v1",
      JSON.stringify(Array.from({ length: MAX_SESSIONS + 1 }, () => dismissedRecord)),
    );
    const excess = await bootApp({
      permission: "denied",
      suffix: "excess-local-records",
      storage: excessStorage,
      initialSessions: [dismissedSession],
    });
    expect(excessStorage.getItem("omp.sessions.dismissed.v1")).toBeNull();
    expect(excess.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
  });

  test("retains local routing choices when an authoritative refresh is unavailable", async () => {
    const waiting = session("transport-hold-session-001", {
      inputRequired: true,
      ask: {
        requestId: "transport-hold-request-001",
        since: "2026-07-21T10:00:00.000Z",
      },
    });
    const working = session("transport-dismiss-session-01");
    const harness = await bootApp({
      permission: "denied",
      suffix: "transport-local-records",
      initialSessions: [waiting, working],
    });
    harness.elements.sessionList.querySelector(".hero-hold")?.dispatchEvent(new Event("click"));
    harness.elements.sessionList.querySelector(".dismiss-session")?.dispatchEvent(new Event("click"));
    const heldBefore = harness.localStorage.getItem("omp.sessions.held-asks.v1");
    const dismissedBefore = harness.localStorage.getItem("omp.sessions.dismissed.v1");

    harness.failNextListRequest();
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "tailnet");

    expect(harness.localStorage.getItem("omp.sessions.held-asks.v1")).toBe(heldBefore);
    expect(harness.localStorage.getItem("omp.sessions.dismissed.v1")).toBe(dismissedBefore);
    expect(harness.elements.sessionList.querySelectorAll(".held-row")).toHaveLength(1);
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(0);
  });
});

const ACTIVE_SELECTION_KEY = "omp.sessions.active.v1";

function fleetSession(
  fill: string,
  host: string,
  hostStatus: FleetHostSummary["status"],
  overrides: Partial<SessionMetadata> = {},
): SessionMetadata {
  const available = hostStatus === "live";
  return session(fill.repeat(64), {
    host,
    originalInstanceId: `native-${fill}`,
    hostStatus,
    available,
    canView: false,
    canControl: available,
    ...overrides,
  });
}

function rememberedSelection(instanceId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, instanceId, generation: 1, mode: "control", ...extra });
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

/** Every button on the page that opens the Workspaces panel: the masthead's and any shell's. */
function workspaceLaunchers(harness: BrowserHarness): FakeElement[] {
  return harness.body.querySelectorAll("button").filter(button => button.getAttribute("aria-label") === "Workspaces");
}

describe("fleet directory, sign-in, and remembered selection", () => {
  test("labels machines, keeps unreachable rows visible but inert, and lists empty and never-reached machines", async () => {
    const live = fleetSession("a", "mac-studio", "live", { title: "Live build" });
    const stale = fleetSession("b", "gapicore", "stale", { title: "Stale build" });
    const liveAsk = fleetSession("c", "mac-studio", "live", {
      title: "Live question",
      inputRequired: true,
      lastSeenAt: "2026-07-21T10:05:00.000Z",
    });
    // Older than the live question, so only availability can keep it out of the hero.
    const staleAsk = fleetSession("d", "gapicore", "stale", {
      title: "Stale question",
      inputRequired: true,
      lastSeenAt: "2026-07-21T10:00:00.000Z",
    });
    const hosts = [
      { host: "mac-studio", status: "live", ageSeconds: 2 },
      { host: "gapicore", status: "stale", ageSeconds: 600 },
      { host: "pi-lab", status: "never", ageSeconds: null },
      { host: "idle-box", status: "live", ageSeconds: 1 },
    ] as const satisfies readonly FleetHostSummary[];
    const harness = await bootApp({
      permission: "denied",
      suffix: "fleet-directory",
      initialSessions: [live, stale, liveAsk, staleAsk],
      initialHosts: hosts,
    });
    const list = harness.elements.sessionList;

    const hero = list.querySelector(".queue-hero");
    expect(hero?.querySelector("h2")?.textContent).toBe("Live question");
    expect(hero?.querySelector(".session-summary")?.textContent).toBe("mac-studio · project · provider/model");
    expect(hero?.querySelector(".action-request")?.textContent).toBe("Open request");
    expect(hero?.querySelector(".action-request")?.disabled).toBeFalse();
    // Fleet rows never offer View, so the hero has no transcript alternative.
    expect(hero?.querySelectorAll(".hero-alt").map(action => action.textContent)).toEqual(["Hold for desk"]);

    const [queued] = list.querySelectorAll(".queue-row");
    expect(queued?.disabled).toBeTrue();
    expect(queued?.getAttribute("aria-label")).toBe("Stale question on gapicore — Machine unreachable");
    expect(queued?.querySelector(".row-time")?.textContent).toBe("gapicore · Machine unreachable");

    const working = new Map(list.querySelectorAll(".working-row").map(row => [row.dataset.instanceId, row]));
    const liveRow = working.get(live.instanceId);
    expect(liveRow?.disabled).toBeFalse();
    expect(liveRow?.getAttribute("aria-label")).toBe("Control Live build on mac-studio");
    expect(liveRow?.querySelector(".row-host")?.textContent).toBe("· mac-studio");
    const staleRow = working.get(stale.instanceId);
    expect(staleRow?.disabled).toBeTrue();
    expect(staleRow?.getAttribute("aria-label")).toBe("Stale build on gapicore — Machine unreachable");
    expect(staleRow?.querySelector(".row-unavailable")?.textContent).toBe("· Machine unreachable");
    staleRow?.dispatchEvent(new Event("click"));
    queued?.dispatchEvent(new Event("click"));
    await drainMicrotasks();
    expect(harness.fetchPaths.some(path => path.endsWith("/launch"))).toBeFalse();

    const machines = (): string[][] =>
      list.querySelectorAll(".host-row").map(row => [
        row.querySelector(".host-name")?.textContent ?? "",
        row.querySelector(".host-state")?.textContent ?? "",
      ]);
    expect(list.querySelector(".host-summary")?.getAttribute("aria-label")).toBe("Machines");
    expect(machines()).toEqual([
      ["mac-studio", "Live · 2 sessions"],
      ["gapicore", "Unreachable · last seen 10m ago · 2 sessions unavailable"],
      ["pi-lab", "Never reached"],
      ["idle-box", "Live · 0 sessions"],
    ]);

    // The registry sends a fresh snapshot when only a machine's reachability changed.
    harness.emit("snapshot", {
      type: "snapshot",
      revision: 2,
      sessions: [live, stale, liveAsk, staleAsk],
      hosts: hosts.slice(0, 3),
    });
    expect(machines().map(([host]) => host)).toEqual(["mac-studio", "gapicore", "pi-lab"]);
  });

  test("lists every machine even when no session is live anywhere", async () => {
    const harness = await bootApp({
      permission: "denied",
      suffix: "fleet-empty",
      initialSessions: [],
      initialHosts: [{ host: "gapicore", status: "stale", ageSeconds: 30 }],
    });
    expect(harness.elements.emptyState.hidden).toBeFalse();
    expect(
      harness.elements.sessionList.querySelectorAll(".host-row").map(row => row.querySelector(".host-state")?.textContent),
    ).toEqual(["Unreachable · last seen <1m ago · no sessions"]);
  });

  test("asks for sign-in after an expired or denied identity instead of retrying blindly", async () => {
    for (const [status, copy] of [
      [401, "Your sign-in expired. Sign in again to continue."],
      [403, "This identity is not authorized. Sign in with an allowed account."],
    ] as const) {
      const harness = await bootApp({
        permission: "denied",
        suffix: `sign-in-${status}`,
        initialSessions: [session("sign-in-session-0001")],
      });
      const ajax = { "X-Requested-With": "XMLHttpRequest" };
      const listInit = harness.fetchInits.find(entry => entry.path === "/api/v1/sessions")?.init;
      expect(listInit?.headers).toEqual(ajax);
      expect(listInit?.redirect).toBe("manual");
      expect(harness.fetchInits.find(entry => entry.path === "/api/v1/push/config")?.init.headers).toEqual(ajax);

      // Access ends the stream when the token expires; a native EventSource cannot carry the AJAX
      // header, so the snapshot fetch is the probe that recognizes it.
      harness.setList(2, [], status);
      harness.disconnectEvents();
      harness.runTimers();
      await settleUntil(() => harness.elements.statusBanner.dataset.kind === "unauthorized", 100);
      expect(harness.elements.statusBanner.textContent).toBe(copy);
      expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(0);

      const listReads = (): number => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;
      const readsAtDenial = listReads();
      harness.runTimers();
      harness.setVisibility("hidden");
      harness.setVisibility("visible");
      await drainMicrotasks();
      expect(listReads()).toBe(readsAtDenial);
      expect(harness.reloads.count).toBe(0);

      const signIn = harness.elements.statusBanner.querySelector(".status-action");
      expect(signIn?.textContent).toBe("Sign in again");
      signIn?.dispatchEvent(new Event("click"));
      expect(harness.reloads.count).toBe(1);
    }
  });

  test("a refused workspace request revokes the directory and every Workspaces launcher", async () => {
    const harness = await bootApp({
      permission: "denied",
      suffix: "workspace-refused",
      initialSessions: [],
      initialHosts: [{ host: "mac-studio", status: "live", ageSeconds: 0 }],
      workspaceStatus: 401,
    });
    const [launcher] = workspaceLaunchers(harness);
    expect(launcher?.disabled).toBeFalse();
    launcher?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "unauthorized", 100);

    expect(harness.elements.statusBanner.querySelector(".status-action")?.textContent).toBe("Sign in again");
    expect(workspaceLaunchers(harness).every(button => button.disabled)).toBeTrue();
    const workspaceReads = (): number => harness.fetchPaths.filter(path => path === "/api/v1/workspace").length;
    const readsAtDenial = workspaceReads();
    launcher?.dispatchEvent(new Event("click"));
    harness.runTimers();
    await drainMicrotasks();
    expect(workspaceReads()).toBe(readsAtDenial);
  });

  test("a reload never reopens a remembered session that ended, restarted, became unreachable, or lost Control", async () => {
    const standaloneId = "resume-standalone-0001";
    const fleetId = "e".repeat(64);
    for (const [name, instanceId, current, copy, kept] of [
      ["ended", standaloneId, [], "Your last session has ended. Choose a current session.", false],
      [
        "restarted",
        standaloneId,
        [session(standaloneId, { generation: 2 })],
        "Your last session restarted, so it was not reopened. Choose a current session.",
        false,
      ],
      [
        "unreachable",
        fleetId,
        [fleetSession("e", "gapicore", "stale")],
        "gapicore is unreachable, so your last session was not reopened.",
        true,
      ],
      [
        "control-lost",
        standaloneId,
        [session(standaloneId, { canControl: false })],
        "Control is no longer available for your last session.",
        false,
      ],
    ] as const) {
      const storage = new FakeStorage();
      storage.setItem(ACTIVE_SELECTION_KEY, rememberedSelection(instanceId));
      const harness = await bootApp({
        permission: "denied",
        suffix: `resume-refused-${name}`,
        initialSessions: current,
        storage,
      });
      await settleUntil(() => harness.elements.statusBanner.dataset.kind === "expired", 100);
      expect(harness.elements.statusBanner.textContent).toBe(copy);
      expect(harness.fetchPaths.some(path => path.endsWith("/launch"))).toBeFalse();
      // Only an unreachable machine may come back with the same session; nothing else is retried.
      expect(storage.getItem(ACTIVE_SELECTION_KEY)).toBe(kept ? rememberedSelection(instanceId) : null);
      harness.emit("keepalive", { type: "keepalive", revision: 1 });
      expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
      harness.runTimers();
      await drainMicrotasks();
      expect(harness.fetchPaths.some(path => path.endsWith("/launch"))).toBeFalse();
    }
  });

  test("discards a remembered selection that is malformed, oversized, or carries anything beyond metadata", async () => {
    const instanceId = "resume-sanitized-0001";
    for (const [name, stored] of [
      ["capability", rememberedSelection(instanceId, { capability: "SYNTHETIC_CAPABILITY_CANARY" })],
      ["title", rememberedSelection(instanceId, { title: "PROMPT_CONTENT_CANARY" })],
      ["oversized", rememberedSelection(instanceId, { pad: "x".repeat(300) })],
      ["mode", JSON.stringify({ version: 1, instanceId, generation: 1, mode: "admin" })],
      ["generation", JSON.stringify({ version: 1, instanceId, generation: 0, mode: "control" })],
      ["version", JSON.stringify({ version: 2, instanceId, generation: 1, mode: "control" })],
      ["json", "{not json"],
    ] as const) {
      const storage = new FakeStorage();
      storage.setItem(ACTIVE_SELECTION_KEY, stored);
      const harness = await bootApp({
        permission: "denied",
        suffix: `resume-sanitized-${name}`,
        initialSessions: [session(instanceId)],
        storage,
      });
      await drainMicrotasks();
      expect(storage.getItem(ACTIVE_SELECTION_KEY)).toBeNull();
      // An accepted record would have started a launch, which this harness reports as a failed start.
      expect(harness.elements.statusBanner.dataset.kind).toBe("ready");
    }
  });

  test("an alert for a session on an unreachable machine opens nothing", async () => {
    const unreachable = fleetSession("f", "gapicore", "stale", { inputRequired: true });
    const harness = await bootApp({
      permission: "denied",
      pathname: `/collab/${unreachable.instanceId}`,
      search: `?request=${unreachable.ask!.requestId}`,
      suffix: "fleet-alert-unreachable",
      initialSessions: [unreachable],
    });
    expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
    expect(harness.fetchPaths.some(path => path.endsWith("/launch"))).toBeFalse();
  });

  const liveEmbedState = (phase: CollabEmbedState["phase"] = "live"): CollabEmbedState => ({
    phase,
    endedReason: null,
    requestPending: false,
    responsePending: false,
    gatewayHealth: { state: "healthy", rttMs: 12, lastSuccessAt: 1, failureSince: null, retryAt: null },
    relayHealth: { state: "healthy", rttMs: 12, lastSuccessAt: 1, failureSince: null, retryAt: null },
  });

  async function openControl(harness: BrowserHarness, current: SessionMetadata): Promise<FakeElement> {
    harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.body.querySelector(".triage-bar") !== null, 100);
    harness.setEmbedState(liveEmbedState());
    expect(harness.localStorage.getItem(ACTIVE_SELECTION_KEY)).toBe(rememberedSelection(current.instanceId));
    const triage = harness.body.querySelector(".triage-bar");
    if (triage === null) throw new Error("collaboration shell did not mount");
    return triage;
  }

  test("a superseded failed launch settles only itself and keeps the newer remembered selection", async () => {
    const current = session("selection-current-01");
    const harness = await bootApp({
      permission: "denied",
      suffix: "stale-failed-launch",
      initialSessions: [current],
      launchStatus: 409,
    });
    const storage = harness.localStorage;
    storage.setItem(ACTIVE_SELECTION_KEY, rememberedSelection("selection-newer-0001", { generation: 4 }));
    const remembered = storage.getItem(ACTIVE_SELECTION_KEY);
    const release = harness.holdNextLaunch();
    harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.fetchPaths.some(path => path.endsWith("/launch")), 100);
    harness.body.querySelector(".shell-back")?.dispatchEvent(new Event("click"));
    await release;
    await drainMicrotasks();

    expect(storage.getItem(ACTIVE_SELECTION_KEY)).toBe(remembered);
    expect(harness.body.querySelector(".triage-bar")?.dataset.kind).not.toBe("reconnecting");
    expect(harness.reloads.count).toBe(0);
  });

  test("the session title opens a switcher of the other live sessions in directory order", async () => {
    const current = fleetSession("c", "mac-studio", "live", { title: "Current build" });
    const older = fleetSession("e", "mac-studio", "live", { title: "Older build", startedAt: "2026-07-21T08:00:00.000Z" });
    const waiting = fleetSession("f", "mac-studio", "live", { title: "Waiting question", inputRequired: true });
    const unreachable = fleetSession("b", "gapicore", "stale", { title: "Stale build", startedAt: "2026-07-21T09:00:00.000Z" });
    const harness = await bootApp({
      permission: "denied",
      suffix: "session-switcher",
      initialSessions: [older, current, unreachable, waiting],
      initialHosts: [
        { host: "mac-studio", status: "live", ageSeconds: 2 },
        { host: "gapicore", status: "stale", ageSeconds: 600 },
      ],
      launchStatus: 200,
    });
    await openControl(harness, current);
    const heading = harness.body.querySelector(".shell-heading");
    expect(heading?.tagName).toBe("button");
    expect(heading?.getAttribute("aria-haspopup")).toBe("dialog");
    heading?.dispatchEvent(new Event("click"));

    const sheet = harness.body.querySelector(".switch-sheet");
    expect(sheet?.open).toBeTrue();
    const rows = sheet?.querySelectorAll(".switch-row") ?? [];
    expect(rows.map(row => row.dataset.instanceId)).toEqual([
      waiting.instanceId,
      unreachable.instanceId,
      older.instanceId,
    ]);
    expect(sheet?.querySelectorAll(".queue-kicker").map(kicker => kicker.textContent)).toEqual([
      "Needs you",
      "Live sessions",
    ]);
    expect(rows.map(row => row.disabled)).toEqual([false, true, false]);
    expect(rows[1]?.querySelector(".switch-detail")?.textContent).toBe("gapicore · project · Machine unreachable");
    expect(rows[2]?.querySelector(".switch-detail")?.textContent).toBe("mac-studio · project");
    expect(rows[2]?.getAttribute("aria-label")).toBe("Control Older build on mac-studio");

    rows[1]?.dispatchEvent(new Event("click"));
    expect(sheet?.open).toBeTrue();
    const launchesBefore = harness.fetchPaths.filter(path => path.endsWith("/launch")).length;
    rows[2]?.dispatchEvent(new Event("click"));
    expect(sheet?.open).toBeFalse();
    await settleUntil(() => harness.body.querySelector(".shell-title")?.textContent === "Older build", 100);
    const launches = harness.fetchInits.filter(entry => entry.path.endsWith("/launch"));
    expect(launches).toHaveLength(launchesBefore + 1);
    expect(launches.at(-1)?.path).toBe(`/api/v1/sessions/${older.instanceId}/launch`);
    expect(JSON.parse(String(launches.at(-1)?.init.body))).toEqual({ mode: "control", generation: 1 });
  });

  test("Settings edits the quick replies the next session receives", async () => {
    const current = session("quick-replies-000001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "quick-replies",
      initialSessions: [current],
      launchStatus: 200,
    });
    const input = harness.elements.quickRepliesInput;
    expect(input.value).toBe("continue\noui\ngo\nrésume");

    input.value = "vas-y\n\n stop \nvas-y";
    input.dispatchEvent(new Event("input"));
    expect(harness.localStorage.getItem("omp.sessions.quick-replies.v1")).toBe(JSON.stringify(["vas-y", "stop"]));
    // Closing the sheet shows the list as it was stored.
    harness.elements.notificationSettings.dispatchEvent(new Event("close"));
    expect(input.value).toBe("vas-y\nstop");

    harness.elements.quickRepliesReset.dispatchEvent(new Event("click"));
    expect(input.value).toBe("continue\noui\ngo\nrésume");
    expect(harness.localStorage.getItem("omp.sessions.quick-replies.v1")).toBeNull();

    input.value = "on y va";
    input.dispatchEvent(new Event("input"));
    await openControl(harness, current);
    expect(lastEmbedOptions?.quickReplies).toEqual(["on y va"]);
  });

  test("an expired identity while a session is open keeps sign-in in that shell", async () => {
    const current = session("open-auth-expiry-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "open-auth-expiry",
      initialSessions: [current],
      launchStatus: 200,
    });
    await openControl(harness, current);
    const disposalsBeforeDenial = embedDisposals;
    harness.setList(2, [], 401);
    harness.disconnectEvents();
    harness.runTimers();
    await settleUntil(() => harness.body.querySelector(".triage-bar")?.dataset.kind === "signin", 100);

    const triage = harness.body.querySelector(".triage-bar");
    expect(triage?.querySelector(".triage-copy")?.textContent).toBe(
      "Your sign-in expired. Sign in again to continue.",
    );
    expect(triage?.querySelector(".triage-action")?.textContent).toBe("Sign in again");
    expect(harness.elements.statusBanner.querySelector(".status-action")).toBeNull();
    expect(harness.body.className).toBe("collab-shell-active");
    // The refusal also stops the embedded client's transport, and Workspaces with it.
    expect(embedDisposals).toBe(disposalsBeforeDenial + 1);
    expect(workspaceLaunchers(harness).length).toBeGreaterThan(0);
    expect(workspaceLaunchers(harness).every(button => button.disabled)).toBeTrue();
  });

  test("a refusal reported by the embedded client stops its transport but keeps the shell", async () => {
    const current = session("embed-auth-refusal-01");
    const harness = await bootApp({
      permission: "denied",
      suffix: "embed-auth-refusal",
      initialSessions: [current],
      launchStatus: 200,
    });
    const triage = await openControl(harness, current);
    const disposalsBeforeDenial = embedDisposals;
    lastEmbedOptions?.onAuthorizationDenied?.();
    await settleUntil(() => triage.dataset.kind === "signin", 100);

    expect(embedDisposals).toBe(disposalsBeforeDenial + 1);
    expect(harness.body.className).toBe("collab-shell-active");
    expect(workspaceLaunchers(harness).every(button => button.disabled)).toBeTrue();
    const sessionReads = harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;
    harness.runTimers();
    await drainMicrotasks();
    expect(harness.fetchPaths.filter(path => path === "/api/v1/sessions").length).toBe(sessionReads);
    triage.querySelector(".triage-action")?.dispatchEvent(new Event("click"));
    expect(harness.reloads.count).toBe(1);
  });

  test("an authorization refusal abandons a launch still waiting for its capability", async () => {
    const current = session("pending-launch-deny-01");
    const harness = await bootApp({
      permission: "denied",
      suffix: "pending-launch-deny",
      initialSessions: [current],
      launchStatus: 200,
    });
    const startsBefore = embedStarts;
    const release = harness.holdLaunches();
    harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.fetchPaths.some(path => path.endsWith("/launch")), 100);

    harness.setList(2, [], 401);
    harness.disconnectEvents();
    harness.runTimers();
    await settleUntil(
      () =>
        harness.elements.statusBanner.dataset.kind === "unauthorized" ||
        harness.body.querySelector(".triage-bar")?.dataset.kind === "signin",
      100,
    );
    release();
    await drainMicrotasks();

    // The capability that arrives after the refusal is never handed to a client.
    expect(embedStarts).toBe(startsBefore);
    expect(harness.fetchPaths.filter(path => path.endsWith("/launch"))).toHaveLength(1);
  });

  test("a sign-in action survives a buffered keepalive and the next connection tick", async () => {
    const current = session("signin-keepalive-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "signin-survives-keepalive",
      initialSessions: [current],
      launchStatus: 200,
    });
    const triage = await openControl(harness, current);
    const degraded: CollabEmbedState = {
      ...liveEmbedState("reconnecting"),
      gatewayHealth: { state: "unreachable", rttMs: null, lastSuccessAt: null, failureSince: 1, retryAt: Date.now() + 1_000 },
    };
    harness.setEmbedState(degraded);
    harness.advanceClock(3_000);
    harness.runTimers();
    expect(triage.dataset.kind).toBe("reconnecting");

    harness.setList(2, [], 401);
    harness.disconnectEvents();
    harness.runTimers();
    await settleUntil(() => triage.dataset.kind === "signin", 100);
    const before = triage.querySelector(".triage-action");
    expect(before?.textContent).toBe("Sign in again");

    const readsAtDenial = harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;
    harness.emit("keepalive", { type: "keepalive", revision: 2 });
    harness.setEmbedState(liveEmbedState());
    harness.runTimers();
    await drainMicrotasks();

    expect(triage.dataset.kind).toBe("signin");
    expect(triage.hidden).toBeFalse();
    expect(triage.querySelector(".triage-action")).toBe(before);
    expect(harness.fetchPaths.filter(path => path === "/api/v1/sessions").length).toBe(readsAtDenial);
    before?.dispatchEvent(new Event("click"));
    expect(harness.reloads.count).toBe(1);
  });

  test("an unreachable fleet directory is not presented as a healthy empty list", async () => {
    const stale = fleetSession("a", "gapicore", "stale", { title: "Offline build" });
    const hosts = [{ host: "gapicore", status: "stale", ageSeconds: 90 }] as const satisfies readonly FleetHostSummary[];
    const harness = await bootApp({
      permission: "denied",
      suffix: "fleet-directory-unreachable",
      initialSessions: [],
      initialHosts: [],
      initialFleetStatus: "unreachable",
    });
    expect(harness.elements.emptyState.hidden).toBeFalse();
    expect(harness.elements.statusBanner.dataset.kind).toBe("gateway");
    expect(harness.elements.statusBanner.textContent).toBe(
      "Fleet directory unavailable. Machine status may be incomplete.",
    );
    expect(harness.elements.sessionList.querySelector(".host-summary")?.dataset.fleetStatus).toBe("unreachable");

    harness.setList(2, [stale], 200, hosts, "unreachable");
    harness.emit("snapshot", {
      type: "snapshot",
      revision: 2,
      sessions: [stale],
      hosts,
      fleetStatus: "unreachable",
    });
    expect(harness.elements.sessionList.querySelector(".working-row")?.dataset.instanceId).toBe(stale.instanceId);
    expect(harness.elements.sessionList.querySelector(".host-row")?.querySelector(".host-name")?.textContent).toBe("gapicore");
    expect(harness.elements.sessionList.querySelector(".host-row")?.dataset.status).toBe("stale");
    expect(harness.elements.statusBanner.dataset.kind).toBe("gateway");
  });
});

interface RecoveryModel {
  revision: number;
  title: string;
  interrupted: boolean;
  online: boolean;
}

interface RecoveryReal {
  readonly harness: BrowserHarness;
  readonly instanceId: string;
  readonly capabilityCanary: string;
}

type RecoveryCommand = AsyncCommand<RecoveryModel, RecoveryReal>;

function activeModelStreams(): FakeEventSource[] {
  return FakeEventSource.instances.filter(source => !source.closed);
}

async function assertRecoveryInvariants(model: RecoveryModel, real: RecoveryReal): Promise<void> {
  await Promise.resolve();
  expect(activeModelStreams()).toHaveLength(1);

  // The 3 s outage grace is a display deadline, not a retry: at most one of it, besides one retry.
  const delays = real.harness.pendingDelays().filter(delay => delay <= 30_000);
  const grace = delays.indexOf(3_000);
  expect(delays.filter(delay => delay === 3_000).length).toBeLessThanOrEqual(2);
  const retryDelays = grace === -1 ? delays : delays.filter((_, index) => index !== grace);
  expect(retryDelays.length).toBeLessThanOrEqual(1);
  expect(retryDelays.every(delay => delay >= 0 && delay <= 30_000)).toBeTrue();
  expect(real.harness.reloads.count).toBe(0);

  const observableSinks = JSON.stringify({
    fetchPaths: real.harness.fetchPaths,
    opened: real.harness.window.opened,
    replacedPaths: real.harness.replacedPaths,
    rowTitle: real.harness.elements.sessionList.querySelector(".row-title")?.textContent,
    status: real.harness.elements.statusBanner.textContent,
    workerMessages: real.harness.workerMessages,
  });
  expect(observableSinks).not.toContain(real.capabilityCanary);

  if (!model.interrupted) {
    expect(real.harness.elements.statusBanner.hidden).toBeTrue();
    expect(real.harness.elements.sessionList.querySelector(".row-title")?.textContent).toBe(
      model.title,
    );
  }
}

class InterruptStreamCommand implements RecoveryCommand {
  constructor(private readonly reportedOnline: boolean) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return !model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    real.harness.setOnline(this.reportedOnline);
    real.harness.disconnectEvents();
    model.interrupted = true;
    model.online = this.reportedOnline;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `SSE error (navigator.onLine=${String(this.reportedOnline)}, no online event)`;
  }
}

class RepeatStreamFailureCommand implements RecoveryCommand {
  constructor(private readonly repetitions: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const source = activeModelStreams()[0];
    if (source === undefined) throw new Error("missing interrupted native stream");
    for (let index = 0; index < this.repetitions; index += 1) source.onerror?.();
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `repeat SSE error x${String(this.repetitions)}`;
  }
}

class LoseTimersCommand implements RecoveryCommand {
  constructor(private readonly elapsedMs: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    real.harness.advanceClock(this.elapsedMs);
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `freeze timers for ${String(this.elapsedMs)}ms`;
  }
}

class SetReportedOnlineWithoutEventCommand implements RecoveryCommand {
  constructor(private readonly online: boolean) {}

  check(): boolean {
    return true;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    real.harness.setOnline(this.online);
    model.online = this.online;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `set navigator.onLine=${String(this.online)} without event`;
  }
}

class NativeReopenCommand implements RecoveryCommand {
  constructor(private readonly titleId: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const source = activeModelStreams()[0];
    if (source === undefined) throw new Error("missing native stream to reopen");
    const revision = model.revision + 1;
    const title = `native-reopen-${String(this.titleId)}-r${String(revision)}`;
    source.onopen?.();
    source.emit("snapshot", {
      type: "snapshot",
      revision,
      sessions: [session(real.instanceId, { title })],
    });
    await settleUntil(() => real.harness.elements.statusBanner.hidden);
    model.revision = revision;
    model.title = title;
    model.interrupted = false;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `native SSE reopen ${String(this.titleId)}`;
  }
}

class SnapshotFallbackCommand implements RecoveryCommand {
  constructor(private readonly titleId: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const revision = model.revision + 1;
    const title = `snapshot-fallback-${String(this.titleId)}-r${String(revision)}`;
    const fetchesBefore = real.harness.fetchPaths.length;
    real.harness.setList(revision, [session(real.instanceId, { title })]);
    real.harness.runTimers();
    await settleUntil(() => real.harness.fetchPaths.length > fetchesBefore);
    await settleUntil(() => activeModelStreams().length === 1);
    model.revision = revision;
    model.title = title;
    model.interrupted = false;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `snapshot retry ${String(this.titleId)}`;
  }
}

class HideResumeCommand implements RecoveryCommand {
  constructor(private readonly titleId: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const revision = model.revision + 1;
    const title = `resume-${String(this.titleId)}-r${String(revision)}`;
    const fetchesBefore = real.harness.fetchPaths.length;
    real.harness.setList(revision, [session(real.instanceId, { title })]);
    real.harness.setVisibility("hidden");
    real.harness.advanceClock(45_000);
    real.harness.setVisibility("visible");
    await settleUntil(() => real.harness.fetchPaths.length > fetchesBefore);
    await settleUntil(() => activeModelStreams().length === 1);
    model.revision = revision;
    model.title = title;
    model.interrupted = false;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `hide/resume ${String(this.titleId)}`;
  }
}

class FreshStreamSnapshotCommand implements RecoveryCommand {
  constructor(private readonly titleId: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return !model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const revision = model.revision + 1;
    const title = `fresh-stream-${String(this.titleId)}-r${String(revision)}`;
    const source = activeModelStreams()[0];
    if (source === undefined) throw new Error("missing live stream");
    source.emit("snapshot", {
      type: "snapshot",
      revision,
      sessions: [session(real.instanceId, { title })],
    });
    model.revision = revision;
    model.title = title;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `fresh stream snapshot ${String(this.titleId)}`;
  }
}

class StaleStreamSnapshotCommand implements RecoveryCommand {
  check(model: Readonly<RecoveryModel>): boolean {
    return !model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const source = activeModelStreams()[0];
    if (source === undefined) throw new Error("missing live stream");
    source.emit("snapshot", {
      type: "snapshot",
      revision: Math.max(0, model.revision - 1),
      sessions: [session(real.instanceId, { title: "stale-snapshot-must-not-win" })],
    });
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return "stale stream snapshot";
  }
}

describe("stateful directory recovery model", () => {
  test("preserves recovery invariants across generated browser lifecycle sequences", async () => {
    let modelRun = 0;
    const setup = async (): Promise<{ model: RecoveryModel; real: RecoveryReal }> => {
      modelRun += 1;
      const instanceId = `recovery-model-${String(modelRun).padStart(4, "0")}`;
      const title = "model-initial-r1";
      const harness = await bootApp({
        permission: "denied",
        suffix: `recovery-model-${String(modelRun)}`,
        initialSessions: [session(instanceId, { title })],
      });
      const model = { revision: 1, title, interrupted: false, online: true };
      const real = {
        harness,
        instanceId,
        capabilityCanary: "MODEL_CAPABILITY_CANARY_8f6b10c2",
      };
      await assertRecoveryInvariants(model, real);
      return { model, real };
    };

    await fc.asyncModelRun(setup, [
      new InterruptStreamCommand(false),
      new LoseTimersCommand(120_000),
      new SetReportedOnlineWithoutEventCommand(true),
      new NativeReopenCommand(1),
      new FreshStreamSnapshotCommand(2),
      new StaleStreamSnapshotCommand(),
    ]);

    await fc.asyncModelRun(setup, [
      new InterruptStreamCommand(true),
      new RepeatStreamFailureCommand(4),
      new HideResumeCommand(3),
      new InterruptStreamCommand(true),
      new RepeatStreamFailureCommand(2),
      new SnapshotFallbackCommand(4),
    ]);

    const commandArbitraries: fc.Arbitrary<RecoveryCommand>[] = [
      fc.boolean().map(online => new InterruptStreamCommand(online)),
      fc.integer({ min: 1, max: 5 }).map(count => new RepeatStreamFailureCommand(count)),
      fc.integer({ min: 1_000, max: 180_000 }).map(elapsed => new LoseTimersCommand(elapsed)),
      fc.boolean().map(online => new SetReportedOnlineWithoutEventCommand(online)),
      fc.integer({ min: 1, max: 1_000 }).map(id => new NativeReopenCommand(id)),
      fc.integer({ min: 1, max: 1_000 }).map(id => new SnapshotFallbackCommand(id)),
      fc.integer({ min: 1, max: 1_000 }).map(id => new HideResumeCommand(id)),
      fc.integer({ min: 1, max: 1_000 }).map(id => new FreshStreamSnapshotCommand(id)),
      fc.constant(new StaleStreamSnapshotCommand()),
    ];

    await fc.assert(
      fc.asyncProperty(fc.commands(commandArbitraries, { maxCommands: 30 }), async commands => {
        await fc.asyncModelRun(setup, commands);
      }),
      { numRuns: 50 },
    );
  });
});
