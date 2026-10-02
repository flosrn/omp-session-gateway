import {
  INSTANCE_ID_PATTERN,
  MAX_SESSIONS,
  PUSH_API_VERSION,
  parseLaunchResponse,
  parseNotificationData,
  parseNotificationRoute,
  parsePushConfigResponse,
  parsePushSubscriptionRequest,
  parsePushSubscriptionResponse,
  parseSessionEvent,
  parseSessionListResponse,
  type FleetHostSummary,
  type LaunchMode,
  type NotificationLaunchIntent,
  type SessionEvent,
  type SessionMetadata,
  type PushDetailLevel,
} from "@omp-session-gateway/protocol";
import type {
  CollabEmbedOptions,
  CollabEmbedState,
} from "../../../packages/collab-client/upstream/src/embed-contract";

type PathHealth = CollabEmbedState["gatewayHealth"];

type StartCollabWithCapability = (
  container: HTMLElement,
  capability: string,
  onDispose: () => void,
  options?: CollabEmbedOptions,
) => () => void;

interface CollabClientModule {
  startCollabWithCapability: StartCollabWithCapability;
}

declare const __COLLAB_CLIENT_MODULE__: string;
declare const __COLLAB_CLIENT_STYLESHEET__: string;

function importCollabClient(moduleUrl: string): Promise<CollabClientModule> {
  return import(moduleUrl) as Promise<CollabClientModule>;
}

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) throw new Error("application shell is incomplete");
  return element;
}

const sessionList = requiredElement<HTMLElement>("#session-list");
const emptyState = requiredElement<HTMLElement>("#empty-state");
const statusBanner = requiredElement<HTMLElement>("#status-banner");
const networkRecoveryHelp = requiredElement<HTMLDialogElement>("#network-recovery-help");
const networkRecoveryHelpClose = requiredElement<HTMLButtonElement>("#network-recovery-help-close");
const notificationButton = requiredElement<HTMLButtonElement>("#notify");
const notificationDisclosure = requiredElement<HTMLElement>("#notify-note");
const directoryTitle = requiredElement<HTMLElement>("#directory-title");
const directoryCount = requiredElement<HTMLElement>("#directory-count");
const notificationSettings = requiredElement<HTMLDialogElement>("#notification-settings");
const notificationSettingsClose = requiredElement<HTMLButtonElement>("#notification-settings-close");
const settingsButton = requiredElement<HTMLButtonElement>("#settings");
const notificationDetailOptions = requiredElement<HTMLFieldSetElement>("#notification-detail-options");
const localActionToast = requiredElement<HTMLElement>("#local-action-toast");
const localActionToastCopy = requiredElement<HTMLElement>("#local-action-toast-copy");
const localActionToastUndo = requiredElement<HTMLButtonElement>("#local-action-toast-undo");
const notificationDetailInputs = [
  ...document.querySelectorAll<HTMLInputElement>('input[name="notification-detail"]'),
];

/**
 * The theme preference the embedded OMP client already stores (`lib/theme.ts`), applied to the
 * directory too, so both surfaces switch together. "system" leaves `data-theme` to the system.
 */
const THEME_STORAGE_KEY = "omp-collab-theme";
type ThemePreference = "system" | "light" | "dark";
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyThemePreference(preference: ThemePreference): void {
  const resolved = preference === "system" ? (darkScheme.matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  for (const input of themeInputs) input.checked = input.value === preference;
}

const themeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="theme"]')];
applyThemePreference(readThemePreference());
darkScheme.addEventListener("change", () => applyThemePreference(readThemePreference()));
for (const input of themeInputs) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    const preference: ThemePreference = input.value === "light" || input.value === "dark" ? input.value : "system";
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Persistence is best-effort; the choice still applies to this page.
    }
    applyThemePreference(preference);
  });
}

const EVENT_LIVENESS_TIMEOUT_MS = 12_000;
const SNAPSHOT_TIMEOUT_MS = 4_000;
const RECOVERY_SNAPSHOT_TIMEOUT_MS = 20_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const CONNECTION_EXTENDED_MS = 3_000;
const CONNECTION_RECOVERED_MS = 1_800;
const TRANSPORT_GUIDANCE_DELAY_MS = 45_000;
const LOCAL_ACTION_UNDO_MS = 5_000;
const HELD_ASKS_STORAGE_KEY = "omp.sessions.held-asks.v1";
const DISMISSED_SESSIONS_STORAGE_KEY = "omp.sessions.dismissed.v1";
const MAX_LOCAL_STORAGE_BYTES = 512_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
/**
 * The one session this device last opened, so a full reload can offer it again. Metadata only —
 * `{version, instanceId, generation, mode}` — never a capability, URL, title, question, or transcript.
 */
const ACTIVE_SELECTION_STORAGE_KEY = "omp.sessions.active.v1";
const ACTIVE_SELECTION_VERSION = 1;
const MAX_ACTIVE_SELECTION_BYTES = 256;
/**
 * Cloudflare Access answers an expired session with 401 instead of a cross-origin login redirect
 * when a request carries this header, so the page can offer sign-in rather than retry blindly.
 */
const API_REQUEST_HEADERS: Readonly<Record<string, string>> = { "X-Requested-With": "XMLHttpRequest" };
type TransportFailureKind = "offline" | "tailnet" | "desktop" | "gateway";

interface HeldAsk {
  readonly instanceId: string;
  readonly requestId: string;
  readonly heldAt: string;
}

interface DismissedSession {
  readonly instanceId: string;
  readonly generation: number;
  readonly dismissedAt: string;
}

interface PendingDismissToast {
  readonly instanceId: string;
  readonly generation: number;
  readonly timeout: number;
}

const sessions = new Map<string, SessionMetadata>();
const heldAsks = readHeldAsks();
const dismissedSessions = readDismissedSessions();
let events: EventSource | undefined;
let directoryLoaded = false;
let authorizationDenied = false;
let notificationState: NotificationControlState = "checking";
let directoryEpoch = 0;
let directoryRevision = -1;
let snapshotController: AbortController | undefined;
let eventLivenessTimeout: number | undefined;
let eventStreamStale = false;
let reconnectTimeout: number | undefined;
let lastFreshAt: number | undefined;
let reconnectAttempt = 0;
let transportFailureSince: number | undefined;
let transportFailureKind: TransportFailureKind | undefined;
let transportGuidanceTimeout: number | undefined;
let notificationRegistration: ServiceWorkerRegistration | undefined;
let applicationServerKey: string | undefined;
let pendingLaunches = 0;
let workerUpdatePending = false;
let updateReloadTimeout: number | undefined;
let pendingDismissToast: PendingDismissToast | undefined;
/** Fleet machines from the latest snapshot; `undefined` on a standalone gateway. */
let hosts: readonly FleetHostSummary[] | undefined;
/**
 * Directory-level fleet reachability. Absent means a standalone gateway or a fleet listing that
 * has not said; `"unreachable"` is a bridge that has never produced a directory, not an empty one.
 */
let fleetStatus: "ok" | "unreachable" | undefined;
/**
 * Bumped by every explicit selection — a launch, a resume, or leaving a session — so an earlier
 * launch that resolves late can never mount over what the user chose since.
 */
let selectionSequence = 0;

type NotificationControlState =
  | "checking"
  | "idle"
  | "enabling"
  | "disabling"
  | "enabled"
  | "blocked"
  | "unavailable";

interface DirectoryHistoryState {
  readonly order: readonly string[];
  readonly scrollY: number;
}

interface DashboardSnapshot {
  readonly children: readonly HTMLElement[];
  readonly scrollY: number;
  readonly title: string;
  readonly bodyClass: string;
  readonly historyState: DirectoryHistoryState;
}

interface ActiveCollabShell {
  readonly instanceId: string;
  readonly generation: number;
  readonly openedRequestId?: string;
  readonly mode: LaunchMode;
  readonly connectionChip: HTMLElement;
  readonly triageBar: HTMLElement;
  readonly shell: HTMLElement;
  answerShown: boolean;
  answerTriageVisible: boolean;
  triageTimeout?: number;
  hasBeenLive: boolean;
  latestEmbedState?: CollabEmbedState;
  outagePath?: "gateway" | "relay";
  interruptionStartedAt?: number;
  connectionDelayTimeout?: number;
  connectionTickTimeout?: number;
  recoveredTimeout?: number;
}

interface DisposedShellResume {
  readonly instanceId: string;
  readonly generation: number;
  readonly mode: LaunchMode;
  readonly requestId?: string;
}

interface ActiveSelection {
  readonly instanceId: string;
  readonly generation: number;
  readonly mode: LaunchMode;
}

let dashboardSnapshot: DashboardSnapshot | undefined;
let activeCollabShell: ActiveCollabShell | undefined;
let disposeActiveCollab: (() => void) | undefined;
/**
 * `pagehide` disposes the collab client and drops its capability with it, but the shell DOM, the
 * `/client/` URL, and the document itself all survive into the bfcache. A restore of that entry is
 * an inert shell, so it can never be reconnected behind dead DOM, and never by restarting a client
 * whose capability is gone: the restore rebuilds the directory first and then relaunches from it.
 */
let collabShellDisposedOnPageHide = false;
/**
 * Which session the disposed shell was showing, so a restore can reopen it rather than stranding the
 * user in the directory (issue #198). Only a page that entered the bfcache gets here: backgrounding
 * an iPhone Home Screen app fires no `pagehide` (iOS 26.5 and 26.6 on real devices), so that page
 * and its client simply stay alive, and nothing may tear the client down on `visibilitychange`.
 *
 * This is a launch intent, never a capability. It holds only what the directory already publishes,
 * and the resume re-runs the ordinary launch fetch, so the capability is acquired fresh from OMP at
 * resume time exactly as at first launch. The bfcache preserves this heap; storage is not involved.
 */
let disposedShellResume: DisposedShellResume | undefined;
let currentNotificationDetail: PushDetailLevel = "session";

const notificationLabels: Readonly<Record<NotificationControlState, string>> = {
  checking: "Checking background alerts…",
  idle: "Enable background alerts",
  enabling: "Enabling…",
  disabling: "Disabling…",
  enabled: "Disable background alerts",
  blocked: "Notifications blocked",
  unavailable: "Background alerts unavailable",
};

function setNotificationControl(state: NotificationControlState): void {
  const changed = notificationState !== state;
  notificationState = state;
  notificationButton.dataset.state = state;
  notificationButton.textContent = notificationLabels[state];
  notificationButton.disabled =
    state === "checking" ||
    state === "enabling" ||
    state === "disabling" ||
    state === "blocked" ||
    state === "unavailable";
  notificationDetailOptions.hidden = state !== "enabled";
  notificationDisclosure.textContent =
    state === "blocked"
      ? "Notifications are blocked. Enable them in this site's browser settings."
      : state === "unavailable"
        ? "Background push is not available in this browser profile. On iPhone and iPad it needs OMP Sessions added to the Home Screen."
        : "Alerts work with the app closed for input requests or activity stops. After revalidation, requests open Control; activity stops open View.";
  notificationDisclosure.hidden = state === "enabled";
  // The all-clear surface repeats the alert promise, so it re-renders with the control state.
  if (changed) render();
}

function isNotificationSupportResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    keys.includes("type") &&
    keys.includes("version") &&
    record.type === "omp-notification-support-response" &&
    record.version === PUSH_API_VERSION
  );
}

async function checkNotificationWorker(registration: ServiceWorkerRegistration): Promise<boolean> {
  const active = registration.active;
  if (active === null) return false;
  const channel = new MessageChannel();
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  const finish = (supported: boolean): void => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
    channel.port1.close();
    try {
      channel.port2.close();
    } catch {
      // The worker may already own the transferred port.
    }
    resolve(supported);
  };
  const timeout = window.setTimeout(() => finish(false), 2_000);
  channel.port1.onmessage = event => finish(isNotificationSupportResponse(event.data));
  channel.port1.start();
  try {
    active.postMessage({ type: "omp-notification-support-request", version: PUSH_API_VERSION }, [channel.port2]);
  } catch {
    finish(false);
  }
  return promise;
}

async function savePushSubscription(
  subscription: PushSubscription,
  detailLevel?: PushDetailLevel,
): Promise<PushDetailLevel> {
  const request = parsePushSubscriptionRequest({
    version: PUSH_API_VERSION,
    ...(detailLevel === undefined ? {} : { detailLevel }),
    subscription: subscription.toJSON(),
  });
  const response = await fetch("/api/v1/push/subscription", {
    method: "POST",
    headers: { ...API_REQUEST_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("push subscription was rejected");
  return parsePushSubscriptionResponse(await response.json()).detailLevel;
}

function selectNotificationDetail(detailLevel: PushDetailLevel): void {
  currentNotificationDetail = detailLevel;
  for (const input of notificationDetailInputs) input.checked = input.value === detailLevel;
}

function clearUpdateReloadTimeout(): void {
  if (updateReloadTimeout === undefined) return;
  window.clearTimeout(updateReloadTimeout);
  updateReloadTimeout = undefined;
}

/** ADR-018's bounded fallback: reload only an idle directory, never a pending or mounted launch. */
function applyActivatedWorkerUpdate(): void {
  clearUpdateReloadTimeout();
  if (
    !workerUpdatePending ||
    pendingLaunches > 0 ||
    pendingNotificationRoute ||
    activeCollabShell !== undefined ||
    location.pathname === "/client/"
  ) {
    return;
  }
  workerUpdatePending = false;
  location.reload();
}

function isNotificationRouteRequest(value: unknown): value is { readonly data: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 3 &&
    keys.includes("type") &&
    keys.includes("version") &&
    keys.includes("data") &&
    record.type === "omp-notification-route" &&
    record.version === PUSH_API_VERSION
  );
}

/**
 * The worker hands a tapped notification to this page instead of navigating it, so a live
 * collaboration is never reloaded. The intent takes the same path as a routed load: fresh directory
 * metadata, exact generation or request, then an in-place launch.
 */
function acceptNotificationRoute(event: MessageEvent): void {
  if (!isNotificationRouteRequest(event.data)) return;
  const intent = parseNotificationData(event.data.data);
  if (intent === undefined) return;
  event.ports[0]?.postMessage({ type: "omp-notification-route-accepted", version: PUSH_API_VERSION });
  pendingNotificationLaunch = intent;
  pendingNotificationRoute = true;
  intentStatusLocked = true;
  // A tapped alert is a newer explicit intent than the session remembered across a reload.
  pendingResume = undefined;
  void refreshAndConnect();
}

async function initializeApplicationWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!isSecureContext || !("serviceWorker" in navigator)) return undefined;
  const serviceWorker = navigator.serviceWorker;
  serviceWorker.addEventListener("message", acceptNotificationRoute);
  serviceWorker.startMessages();
  let currentController = serviceWorker.controller;
  serviceWorker.addEventListener("controllerchange", () => {
    const nextController = serviceWorker.controller;
    if (currentController === null) {
      currentController = nextController;
      return;
    }
    if (nextController === currentController) return;
    currentController = nextController;
    workerUpdatePending = true;
    clearUpdateReloadTimeout();
    updateReloadTimeout = window.setTimeout(applyActivatedWorkerUpdate, 1_000);
  });
  try {
    return await serviceWorker.register("/service-worker.js", { scope: "/" });
  } catch {
    return undefined;
  }
}

async function initializeNotifications(
  workerRegistration: Promise<ServiceWorkerRegistration | undefined>,
): Promise<void> {
  setNotificationControl("checking");
  if (
    !isSecureContext ||
    typeof Notification === "undefined" ||
    typeof PushManager === "undefined"
  ) {
    setNotificationControl("unavailable");
    return;
  }
  try {
    const [registered, configResponse] = await Promise.all([
      workerRegistration,
      fetch("/api/v1/push/config", { headers: API_REQUEST_HEADERS, cache: "no-store", credentials: "same-origin" }),
    ]);
    if (registered === undefined) {
      setNotificationControl("unavailable");
      return;
    }
    const registration = registered.active === null ? await navigator.serviceWorker.ready : registered;
    if (
      !configResponse.ok ||
      typeof registration.showNotification !== "function" ||
      !(await checkNotificationWorker(registration))
    ) {
      setNotificationControl("unavailable");
      return;
    }
    const config = parsePushConfigResponse(await configResponse.json());
    notificationRegistration = registration;
    applicationServerKey = config.applicationServerKey;
    if (Notification.permission === "denied") {
      setNotificationControl("blocked");
      return;
    }
    const existing = await registration.pushManager.getSubscription();
    if (existing === null) {
      setNotificationControl("idle");
      return;
    }
    selectNotificationDetail(await savePushSubscription(existing));
    setNotificationControl("enabled");
  } catch {
    setNotificationControl("unavailable");
  }
}

async function disableBackgroundNotifications(): Promise<void> {
  const registration = notificationRegistration;
  if (registration === undefined) return;
  const existing = await registration.pushManager.getSubscription();
  if (existing === null) {
    setNotificationControl("idle");
    return;
  }
  setNotificationControl("disabling");
  const endpoint = existing.endpoint;
  try {
    await existing.unsubscribe();
    await fetch("/api/v1/push/subscription", {
      method: "DELETE",
      headers: { ...API_REQUEST_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ version: PUSH_API_VERSION, endpoint }),
      cache: "no-store",
      credentials: "same-origin",
    });
    setNotificationControl("idle");
  } catch {
    setNotificationControl("unavailable");
  }
}

/** The toggle lives inside the Settings sheet: idle enables, enabled disables in place. */
async function toggleBackgroundNotifications(): Promise<void> {
  if (notificationState === "enabled") {
    await disableBackgroundNotifications();
    return;
  }
  const registration = notificationRegistration;
  const publicKey = applicationServerKey;
  if (registration === undefined || publicKey === undefined) return;

  setNotificationControl("enabling");
  try {
    const permission =
      Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") {
      setNotificationControl(permission === "denied" ? "blocked" : "idle");
      return;
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKey,
    });
    try {
      selectNotificationDetail(await savePushSubscription(subscription, "session"));
    } catch (error) {
      await subscription.unsubscribe().catch(() => false);
      throw error;
    }
    setNotificationControl("enabled");
  } catch {
    setNotificationControl(Notification.permission === "denied" ? "blocked" : "unavailable");
  }
}

function readPendingNotificationLaunch(): NotificationLaunchIntent | undefined {
  const intent = parseNotificationRoute(new URL(location.href));
  if (location.pathname === "/collab" || location.pathname.startsWith("/collab/")) {
    history.replaceState(null, "", "/");
  }
  return intent;
}

let pendingNotificationRoute = location.pathname === "/collab" || location.pathname.startsWith("/collab/");
/** A routed intent's outcome stays on screen; directory events must not reset it to ready. */
let intentStatusLocked = pendingNotificationRoute;
let pendingNotificationLaunch = readPendingNotificationLaunch();
/** A notification route is the newer intent; otherwise offer the session open before the reload. */
let pendingResume = pendingNotificationRoute ? undefined : readActiveSelection();

if (location.pathname === "/update/" || location.pathname === "/client/") {
  history.replaceState(null, "", "/");
}

type StatusKind = "ready" | "offline" | "tailnet" | "desktop" | "gateway" | "unauthorized" | "expired" | "loading";

function setStatus(kind: StatusKind, message: string): void {
  if (kind === "ready" || kind === "unauthorized" || kind === "expired") clearTransportFailureTracking();
  statusBanner.dataset.kind = kind;
  statusBanner.replaceChildren();
  statusBanner.textContent = message;
  statusBanner.hidden = kind === "ready";
}

function isSignInRequired(response: Response): boolean {
  // `redirect: "manual"` turns a login redirect that slipped past the AJAX header into
  // `opaqueredirect` rather than a cross-origin failure indistinguishable from an outage.
  return response.status === 401 || response.status === 403 || response.type === "opaqueredirect";
}

function signInCopy(response: Response): string {
  return response.status === 403
    ? "This identity is not authorized. Sign in with an allowed account."
    : "Your sign-in expired. Sign in again to continue.";
}

/** Only ever called from an explicit tap: the navigation lets the access proxy renew the session. */
function reloadToSignIn(): void {
  location.reload();
}

/**
 * One entry for an expired or rejected identity, whether the denial arrived on a directory snapshot
 * or a launch from the open shell. Closes the browser-owned event stream, drops its liveness and
 * reconnect timers, and aborts any snapshot still in flight so a buffered keepalive or a later
 * error cannot replace the sign-in prompt. Transport failures stay on the ordinary recovery path.
 */
function enterAuthorizationDenied(message: string): void {
  authorizationDenied = true;
  directoryEpoch += 1;
  snapshotController?.abort();
  snapshotController = undefined;
  events?.close();
  events = undefined;
  clearEventLiveness();
  eventStreamStale = false;
  clearReconnectTimeout();
  if (activeCollabShell !== undefined) showSignInInShell(activeCollabShell, message);
  else showSignInRequired(message);
}

/** Stops automatic retries: only a user-initiated navigation can renew access. */
function showSignInRequired(message: string): void {
  authorizationDenied = true;
  clearReconnectTimeout();
  setStatus("unauthorized", message);
  const actions = document.createElement("span");
  actions.className = "status-actions";
  const signIn = document.createElement("button");
  signIn.type = "button";
  signIn.className = "status-action";
  signIn.textContent = "Sign in again";
  signIn.addEventListener("click", reloadToSignIn);
  actions.append(signIn);
  statusBanner.append(actions);
}

function parseDirectoryHistoryState(value: unknown): DirectoryHistoryState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const directory = (value as Record<string, unknown>).ompDirectory;
  if (typeof directory !== "object" || directory === null || Array.isArray(directory)) return undefined;
  const record = directory as Record<string, unknown>;
  if (
    !Array.isArray(record.order) ||
    !record.order.every(
      item => typeof item === "string" && INSTANCE_ID_PATTERN.test(item),
    ) ||
    new Set(record.order).size !== record.order.length ||
    typeof record.scrollY !== "number" ||
    !Number.isFinite(record.scrollY) ||
    record.scrollY < 0
  ) {
    return undefined;
  }
  return { order: [...record.order], scrollY: record.scrollY };
}

function clearTransportFailureTracking(): void {
  if (transportGuidanceTimeout !== undefined) {
    window.clearTimeout(transportGuidanceTimeout);
    transportGuidanceTimeout = undefined;
  }
  transportFailureSince = undefined;
  if (networkRecoveryHelp.open) networkRecoveryHelp.close();
  transportFailureKind = undefined;
}

function transportGuidanceVisible(kind: TransportFailureKind): boolean {
  return (
    kind !== "offline" &&
    transportFailureSince !== undefined &&
    Date.now() - transportFailureSince >= TRANSPORT_GUIDANCE_DELAY_MS &&
    document.visibilityState === "visible"
  );
}

function scheduleTransportGuidance(): void {
  if (transportFailureSince === undefined || transportGuidanceTimeout !== undefined) return;
  const remaining = TRANSPORT_GUIDANCE_DELAY_MS - (Date.now() - transportFailureSince);
  if (remaining <= 0) return;
  transportGuidanceTimeout = window.setTimeout(() => {
    transportGuidanceTimeout = undefined;
    const kind = transportFailureKind;
    if (kind !== undefined && document.visibilityState === "visible") showTransportFailure(kind);
  }, remaining);
}
function showTransportFailure(kind: TransportFailureKind): void {
  const tracksVisibleFailure = kind !== "offline" && document.visibilityState === "visible";
  if (tracksVisibleFailure) {
    if (transportFailureSince === undefined) transportFailureSince = Date.now();
    transportFailureKind = kind;
  } else {
    clearTransportFailureTracking();
  }
  directoryRevision = -1;
  render();
  const asOf =
    lastFreshAt === undefined
      ? "before the last successful connection"
      : new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(lastFreshAt);
  const copy: Record<TransportFailureKind, readonly [string, string]> = {
    offline: [
      "You're offline",
      "This device has no connection. Showing the list as of " + asOf + " — retries automatically.",
    ],
    tailnet: [
      "Tailnet unreachable",
      "This device is online, but your tailnet isn't answering — Tailscale is off or logged out here.",
    ],
    desktop: [
      "Desktop unreachable",
      "Tailnet looks fine, but the desktop isn't answering — asleep, or the gateway stopped. Last seen " + asOf + ".",
    ],
    gateway: [
      "Gateway unavailable",
      "Live updates paused; showing the list as of " + asOf + ". Reconnects automatically.",
    ],
  };
  const [title, body] = copy[kind];
  const text = document.createElement("span");
  text.className = "status-copy";
  text.append(
    createTextElement("strong", "status-title", title),
    createTextElement("span", "status-detail", body),
  );
  if (kind === "tailnet") {
    text.append(createTextElement("span", "status-freshness", "Last seen " + asOf + "."));
  }

  const extended = transportGuidanceVisible(kind);
  if (extended) {
    text.append(
      createTextElement(
        "span",
        "status-guidance",
        "Still unreachable? The browser may be stuck after sleep or a network change. Fully close the browser hosting OMP Sessions, then reopen OMP Sessions.",
      ),
    );
  }

  statusBanner.dataset.kind = kind;
  statusBanner.replaceChildren(text);
  if (kind === "desktop" || extended) {
    const actions = document.createElement("span");
    actions.className = "status-actions";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "status-action";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => void refreshAndConnect());
    actions.append(retry);
    if (extended) {
      const troubleshooting = document.createElement("button");
      troubleshooting.type = "button";
      troubleshooting.className = "status-action";
      troubleshooting.textContent = "Troubleshooting";
      troubleshooting.addEventListener("click", () => networkRecoveryHelp.showModal());
      actions.append(troubleshooting);
    }
    statusBanner.append(actions);
  }
  statusBanner.hidden = false;
  if (tracksVisibleFailure) scheduleTransportGuidance();
}

function clearEventLiveness(): void {
  if (eventLivenessTimeout === undefined) return;
  window.clearTimeout(eventLivenessTimeout);
  eventLivenessTimeout = undefined;
}

function clearReconnectTimeout(): void {
  if (reconnectTimeout === undefined) return;
  window.clearTimeout(reconnectTimeout);
  reconnectTimeout = undefined;
}

/**
 * True only when the event stream has demonstrably been heard from inside the liveness window.
 *
 * Neither `events !== undefined` nor `eventStreamStale` survives a freeze. Chrome freezes the
 * renderer while the display is off, so a page that resumes still holds an `EventSource` that
 * reports open and a liveness timeout that never ran, however long the stream has been dead.
 * Wall-clock freshness is the one signal a frozen page cannot have faked.
 */
function directoryStreamIsLive(): boolean {
  if (events === undefined || eventStreamStale || lastFreshAt === undefined) return false;
  return Date.now() - lastFreshAt < EVENT_LIVENESS_TIMEOUT_MS;
}

function scheduleReconnect(): void {
  if (authorizationDenied || reconnectTimeout !== undefined) return;
  const exponent = Math.min(reconnectAttempt, 5);
  const cap = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** exponent, RECONNECT_MAX_DELAY_MS);
  const floor = Math.floor(cap / 2);
  const delay = floor + Math.floor(Math.random() * (cap - floor));
  reconnectAttempt = Math.min(reconnectAttempt + 1, 5);
  reconnectTimeout = window.setTimeout(() => {
    reconnectTimeout = undefined;
    void refreshAndConnect(false);
  }, delay);
}
/**
 * When the directory stream broke, while the page was visible; cleared once a stream opens or
 * speaks. A phone drops the stream on every lock, app switch or radio handoff and the reconnect
 * usually lands within a second or two, so "Gateway unavailable" waits out CONNECTION_EXTENDED_MS
 * first and is never raised for a page nobody is looking at.
 */
let streamInterruptedSince: number | undefined;
let streamGraceTimeout: number | undefined;

function clearStreamInterruption(): void {
  streamInterruptedSince = undefined;
  if (streamGraceTimeout === undefined) return;
  window.clearTimeout(streamGraceTimeout);
  streamGraceTimeout = undefined;
}

function reportStreamInterruption(): void {
  if (navigator.onLine === false) {
    showTransportFailure("offline");
    return;
  }
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  streamInterruptedSince ??= now;
  const remaining = CONNECTION_EXTENDED_MS - (now - streamInterruptedSince);
  if (remaining <= 0) {
    showTransportFailure("gateway");
    return;
  }
  if (streamGraceTimeout !== undefined) return;
  streamGraceTimeout = window.setTimeout(() => {
    streamGraceTimeout = undefined;
    if (streamInterruptedSince === undefined || authorizationDenied || document.visibilityState !== "visible") return;
    showTransportFailure(navigator.onLine === false ? "offline" : "gateway");
  }, remaining);
}

function markEventStreamInterrupted(source: EventSource, epoch: number): boolean {
  if (events !== source || epoch !== directoryEpoch) return false;
  clearEventLiveness();
  eventStreamStale = true;
  // The next snapshot must be accepted whatever its revision: the gateway may have restarted.
  directoryRevision = -1;
  reportStreamInterruption();
  scheduleReconnect();
  return true;
}

function failEventStream(source: EventSource, epoch: number): void {
  if (!markEventStreamInterrupted(source, epoch)) return;
  source.close();
  events = undefined;
}

function armEventLiveness(source: EventSource, epoch: number): void {
  clearEventLiveness();
  eventLivenessTimeout = window.setTimeout(() => {
    eventLivenessTimeout = undefined;
    failEventStream(source, epoch);
  }, EVENT_LIVENESS_TIMEOUT_MS);
}


function sessionTitle(session: SessionMetadata): string {
  return session.title || session.cwdLabel || "OMP session";
}

function localRecordKey(instanceId: string, suffix: string | number): string {
  return `${instanceId}\0${suffix}`;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function exactLocalRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) return undefined;
  return record;
}

function readLocalRecordArray(key: string): readonly unknown[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const serialized = localStorage.getItem(key);
    if (serialized === null) return [];
    if (serialized.length > MAX_LOCAL_STORAGE_BYTES) throw new Error("local records exceed bound");
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value) || value.length > MAX_SESSIONS) throw new Error("invalid local records");
    return value;
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      // Local routing state is optional; storage denial must not break the directory.
    }
    return [];
  }
}

function writeLocalRecords(key: string, records: Iterable<HeldAsk | DismissedSession>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify([...records]));
  } catch {
    // Local routing state is optional; keep the live in-memory decision for this page.
  }
}

function readHeldAsks(): Map<string, HeldAsk> {
  const records = new Map<string, HeldAsk>();
  let sanitized = false;
  for (const value of readLocalRecordArray(HELD_ASKS_STORAGE_KEY)) {
    const record = exactLocalRecord(value, ["instanceId", "requestId", "heldAt"]);
    if (
      record === undefined ||
      typeof record.instanceId !== "string" ||
      !INSTANCE_ID_PATTERN.test(record.instanceId) ||
      typeof record.requestId !== "string" ||
      !REQUEST_ID_PATTERN.test(record.requestId) ||
      !isCanonicalTimestamp(record.heldAt)
    ) {
      sanitized = true;
      continue;
    }
    const held: HeldAsk = {
      instanceId: record.instanceId,
      requestId: record.requestId,
      heldAt: record.heldAt,
    };
    records.set(localRecordKey(held.instanceId, held.requestId), held);
  }
  if (sanitized) writeLocalRecords(HELD_ASKS_STORAGE_KEY, records.values());
  return records;
}

function readDismissedSessions(): Map<string, DismissedSession> {
  const records = new Map<string, DismissedSession>();
  let sanitized = false;
  for (const value of readLocalRecordArray(DISMISSED_SESSIONS_STORAGE_KEY)) {
    const record = exactLocalRecord(value, ["instanceId", "generation", "dismissedAt"]);
    if (
      record === undefined ||
      typeof record.instanceId !== "string" ||
      !INSTANCE_ID_PATTERN.test(record.instanceId) ||
      !Number.isSafeInteger(record.generation) ||
      (record.generation as number) < 1 ||
      !isCanonicalTimestamp(record.dismissedAt)
    ) {
      sanitized = true;
      continue;
    }
    const dismissed: DismissedSession = {
      instanceId: record.instanceId,
      generation: record.generation as number,
      dismissedAt: record.dismissedAt,
    };
    records.set(localRecordKey(dismissed.instanceId, dismissed.generation), dismissed);
  }
  if (sanitized) writeLocalRecords(DISMISSED_SESSIONS_STORAGE_KEY, records.values());
  return records;
}

function readActiveSelection(): ActiveSelection | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const serialized = localStorage.getItem(ACTIVE_SELECTION_STORAGE_KEY);
    if (serialized === null) return undefined;
    if (serialized.length > MAX_ACTIVE_SELECTION_BYTES) throw new Error("active selection exceeds bound");
    const record = exactLocalRecord(JSON.parse(serialized), ["version", "instanceId", "generation", "mode"]);
    if (
      record === undefined ||
      record.version !== ACTIVE_SELECTION_VERSION ||
      typeof record.instanceId !== "string" ||
      !INSTANCE_ID_PATTERN.test(record.instanceId) ||
      !Number.isSafeInteger(record.generation) ||
      (record.generation as number) < 1 ||
      (record.mode !== "view" && record.mode !== "control")
    ) {
      throw new Error("invalid active selection");
    }
    return { instanceId: record.instanceId, generation: record.generation as number, mode: record.mode };
  } catch {
    clearActiveSelection();
    return undefined;
  }
}

function writeActiveSelection(selection: ActiveSelection): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      ACTIVE_SELECTION_STORAGE_KEY,
      JSON.stringify({
        version: ACTIVE_SELECTION_VERSION,
        instanceId: selection.instanceId,
        generation: selection.generation,
        mode: selection.mode,
      }),
    );
  } catch {
    // Resume is optional; storage denial only means a reload lands in the directory.
  }
}

function clearActiveSelection(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(ACTIVE_SELECTION_STORAGE_KEY);
  } catch {
    // Nothing persisted that could be reused.
  }
}

/** Forgets the remembered session only when it is exactly this identity, never a newer choice. */
function forgetActiveSelection(instanceId: string, generation: number): void {
  const stored = readActiveSelection();
  if (stored?.instanceId === instanceId && stored.generation === generation) clearActiveSelection();
}

function setBoundedLocalRecord<RecordType>(map: Map<string, RecordType>, key: string, record: RecordType): void {
  map.delete(key);
  map.set(key, record);
  while (map.size > MAX_SESSIONS) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function isHeld(session: SessionMetadata): boolean {
  return (
    session.inputRequired &&
    session.ask !== undefined &&
    heldAsks.has(localRecordKey(session.instanceId, session.ask.requestId))
  );
}

function isDismissed(session: SessionMetadata): boolean {
  return (
    !session.inputRequired &&
    dismissedSessions.has(localRecordKey(session.instanceId, session.generation))
  );
}

function cancelPendingDismissToast(): void {
  if (pendingDismissToast !== undefined) window.clearTimeout(pendingDismissToast.timeout);
  pendingDismissToast = undefined;
  localActionToast.hidden = true;
}

function reconcileLocalRecords(): void {
  let heldChanged = false;
  for (const [key, held] of heldAsks) {
    const session = sessions.get(held.instanceId);
    if (!session?.inputRequired || session.ask?.requestId !== held.requestId) {
      heldAsks.delete(key);
      heldChanged = true;
    }
  }
  let dismissedChanged = false;
  for (const [key, dismissed] of dismissedSessions) {
    const session = sessions.get(dismissed.instanceId);
    if (
      session === undefined ||
      session.generation !== dismissed.generation ||
      session.inputRequired
    ) {
      dismissedSessions.delete(key);
      dismissedChanged = true;
    }
  }
  if (heldChanged) writeLocalRecords(HELD_ASKS_STORAGE_KEY, heldAsks.values());
  if (dismissedChanged) writeLocalRecords(DISMISSED_SESSIONS_STORAGE_KEY, dismissedSessions.values());

  if (pendingDismissToast !== undefined) {
    const session = sessions.get(pendingDismissToast.instanceId);
    if (
      session === undefined ||
      session.generation !== pendingDismissToast.generation ||
      session.inputRequired
    ) {
      cancelPendingDismissToast();
    }
  }
}

function replaceSessionSnapshot(nextSessions: readonly SessionMetadata[]): void {
  sessions.clear();
  for (const session of nextSessions) sessions.set(session.instanceId, session);
  reconcileLocalRecords();
}

function elapsedLabel(startedAt: number): string {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  if (elapsedMinutes < 1) return "<1m";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function waitingLabel(session: SessionMetadata): string {
  const since = Date.parse(session.ask?.since ?? session.lastSeenAt);
  return `waiting ${elapsedLabel(Number.isNaN(since) ? Date.now() : since)}`;
}

function uptimeLabel(session: SessionMetadata): string {
  const startedAt = Date.parse(session.startedAt);
  return `up ${elapsedLabel(Number.isNaN(startedAt) ? Date.now() : startedAt)}`;
}

function modelSlug(model: string): string {
  const separator = model.lastIndexOf("/");
  return separator >= 0 && separator + 1 < model.length ? model.slice(separator + 1) : model;
}

function isAvailable(session: SessionMetadata): boolean {
  return session.available !== false;
}

/**
 * One tap opens Control whenever the session offers it; View is the primary action only for a
 * standalone session that cannot be controlled. An unavailable fleet row has no action at all.
 */
function primaryMode(session: SessionMetadata): LaunchMode | undefined {
  if (!isAvailable(session)) return undefined;
  if (session.canControl) return "control";
  return session.canView ? "view" : undefined;
}

function onHost(session: SessionMetadata): string {
  return session.host === undefined ? "" : ` on ${session.host}`;
}

function unavailableCopy(session: SessionMetadata): string {
  if (session.hostStatus === "never") return "Machine never reached";
  return isAvailable(session) ? "Control unavailable" : "Machine unreachable";
}

function rowActionLabel(session: SessionMetadata, mode: LaunchMode | undefined, controlVerb: string): string {
  const title = sessionTitle(session);
  if (mode === "control") return `${controlVerb} ${title}${onHost(session)}`;
  if (mode === "view") return `View ${title}${onHost(session)}`;
  return `${title}${onHost(session)} — ${unavailableCopy(session)}`;
}

/** Machine first, then how long it has waited — or why nothing can be opened there. */
function queueRowDetail(session: SessionMetadata): string {
  const state = isAvailable(session) ? waitingLabel(session) : unavailableCopy(session);
  return session.host === undefined ? state : `${session.host} · ${state}`;
}

function compareWaiting(left: SessionMetadata, right: SessionMetadata): number {
  const leftSince = left.ask?.since ?? left.lastSeenAt;
  const rightSince = right.ask?.since ?? right.lastSeenAt;
  return leftSince === rightSince
    ? left.instanceId.localeCompare(right.instanceId)
    : leftSince.localeCompare(rightSince);
}

function orderedWaitingSessions(): SessionMetadata[] {
  // A question on an unreachable machine stays visible but never takes the hero over an actionable one.
  return [...sessions.values()]
    .filter(session => session.inputRequired && !isHeld(session))
    .sort((left, right) => Number(!isAvailable(left)) - Number(!isAvailable(right)) || compareWaiting(left, right));
}

function orderedHeldSessions(): SessionMetadata[] {
  return [...sessions.values()].filter(isHeld).sort(compareWaiting);
}

function orderedWorkingSessions(): SessionMetadata[] {
  return [...sessions.values()]
    .filter(session => !session.inputRequired && !isDismissed(session))
    .sort((left, right) => {
      const started = right.startedAt.localeCompare(left.startedAt);
      return started === 0 ? left.instanceId.localeCompare(right.instanceId) : started;
    });
}

function orderedDismissedSessions(): SessionMetadata[] {
  return [...sessions.values()].filter(isDismissed).sort((left, right) =>
    left.instanceId.localeCompare(right.instanceId),
  );
}
function createTextElement(tagName: string, className: string, text: string): HTMLElement {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

function createQueueKicker(label: string, detail?: string): HTMLElement {
  const kicker = createTextElement("p", "queue-kicker", label);
  if (detail !== undefined) {
    kicker.append(createTextElement("span", "queue-wait", detail));
  }
  return kicker;
}

function createSessionSummary(session: SessionMetadata): HTMLElement {
  const values = [session.host, session.cwdLabel, session.model].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  if (!isAvailable(session)) values.push(unavailableCopy(session));
  return createTextElement("p", "session-summary", values.join(" · ") || "Live OMP session");
}

async function closeHeldAskNotification(held: HeldAsk): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = notificationRegistration ?? (await navigator.serviceWorker.ready);
    const notifications = await registration.getNotifications({
      tag: `omp-attention-${held.instanceId}`,
    });
    for (const notification of notifications) {
      const data = notification.data as { requestId?: unknown } | undefined;
      if (data?.requestId === held.requestId) notification.close();
    }
  } catch {
    // Holding remains valid when the browser cannot enumerate notifications.
  }
}

function holdSession(session: SessionMetadata, rerender = true): boolean {
  const current = sessions.get(session.instanceId);
  const ask = current?.ask;
  if (
    current === undefined ||
    current.generation !== session.generation ||
    current.inputRequired === false ||
    ask === undefined ||
    session.ask?.requestId !== ask.requestId
  ) {
    return false;
  }
  const held: HeldAsk = {
    instanceId: current.instanceId,
    requestId: ask.requestId,
    heldAt: new Date().toISOString(),
  };
  setBoundedLocalRecord(heldAsks, localRecordKey(held.instanceId, held.requestId), held);
  writeLocalRecords(HELD_ASKS_STORAGE_KEY, heldAsks.values());
  void closeHeldAskNotification(held);
  if (rerender) render();
  return true;
}

function requeueHeldSession(session: SessionMetadata): void {
  if (session.ask === undefined) return;
  heldAsks.delete(localRecordKey(session.instanceId, session.ask.requestId));
  writeLocalRecords(HELD_ASKS_STORAGE_KEY, heldAsks.values());
  render();
}

function showDismissToast(session: SessionMetadata): void {
  cancelPendingDismissToast();
  localActionToastCopy.textContent = `Hidden “${sessionTitle(session)}” on this device · 5s`;
  localActionToast.hidden = false;
  const timeout = window.setTimeout(() => {
    if (
      pendingDismissToast?.instanceId === session.instanceId &&
      pendingDismissToast.generation === session.generation
    ) {
      pendingDismissToast = undefined;
      localActionToast.hidden = true;
    }
  }, LOCAL_ACTION_UNDO_MS);
  pendingDismissToast = {
    instanceId: session.instanceId,
    generation: session.generation,
    timeout,
  };
}

function dismissSession(session: SessionMetadata): void {
  const current = sessions.get(session.instanceId);
  if (
    current === undefined ||
    current.generation !== session.generation ||
    current.inputRequired
  ) {
    return;
  }
  const dismissed: DismissedSession = {
    instanceId: current.instanceId,
    generation: current.generation,
    dismissedAt: new Date().toISOString(),
  };
  setBoundedLocalRecord(
    dismissedSessions,
    localRecordKey(dismissed.instanceId, dismissed.generation),
    dismissed,
  );
  writeLocalRecords(DISMISSED_SESSIONS_STORAGE_KEY, dismissedSessions.values());
  render();
  showDismissToast(current);
}

function undoPendingDismissal(): void {
  const pending = pendingDismissToast;
  if (pending === undefined) return;
  window.clearTimeout(pending.timeout);
  pendingDismissToast = undefined;
  dismissedSessions.delete(localRecordKey(pending.instanceId, pending.generation));
  writeLocalRecords(DISMISSED_SESSIONS_STORAGE_KEY, dismissedSessions.values());
  localActionToast.hidden = true;
  render();
}

function restoreDismissedSessions(): void {
  dismissedSessions.clear();
  writeLocalRecords(DISMISSED_SESSIONS_STORAGE_KEY, dismissedSessions.values());
  cancelPendingDismissToast();
  render();
}

function createWorkingRow(session: SessionMetadata): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "working-row-frame";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "working-row";
  button.dataset.instanceId = session.instanceId;
  const mode = primaryMode(session);
  button.disabled = mode === undefined;
  button.setAttribute("aria-label", rowActionLabel(session, mode, "Control"));
  const copy = document.createElement("span");
  copy.className = "working-copy";
  const details = document.createElement("span");
  details.className = "working-details";
  details.append(createTextElement("span", "row-time", uptimeLabel(session)));
  if (session.host !== undefined) {
    details.append(createTextElement("span", "row-host", `· ${session.host}`));
  }
  details.append(
    isAvailable(session)
      ? createTextElement("span", "session-activity", session.busy === true ? "· Working" : session.busy === false ? "· Idle" : "· Activity unknown")
      : createTextElement("span", "session-activity row-unavailable", `· ${unavailableCopy(session)}`),
  );
  if (session.cwdLabel) {
    details.append(createTextElement("span", "working-context", `· ${session.cwdLabel}`));
  }
  if (session.model) {
    details.append(createTextElement("span", "working-model", `· ${modelSlug(session.model)}`));
  }
  copy.append(createTextElement("span", "row-title", sessionTitle(session)), details);
  button.append(createTextElement("span", isAvailable(session) ? "row-dot row-dot-live" : "row-dot row-dot-unavailable", ""), copy);
  button.addEventListener("click", () => {
    if (mode !== undefined) void launch(session, mode, button);
  });

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "dismiss-session";
  dismiss.textContent = "Hide";
  dismiss.title = "Hide on this device — the OMP process keeps running";
  dismiss.setAttribute("aria-label", `Hide ${sessionTitle(session)} on this device`);
  dismiss.addEventListener("click", () => dismissSession(session));
  frame.append(button, dismiss);
  return frame;
}

function createWaitingRow(session: SessionMetadata): HTMLButtonElement {
  const mode = primaryMode(session);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "queue-row";
  button.dataset.instanceId = session.instanceId;
  button.disabled = mode === undefined;
  button.setAttribute("aria-label", rowActionLabel(session, mode, "Open request in"));
  button.append(
    createTextElement("span", "row-dot row-dot-waiting", ""),
    createTextElement("span", "row-title", sessionTitle(session)),
    createTextElement("span", "row-time", queueRowDetail(session)),
    createTextElement("span", "row-chevron", "›"),
  );
  button.addEventListener("click", () => {
    if (mode !== undefined) void launch(session, mode, button, mode === "control" ? session.ask?.requestId : undefined);
  });
  return button;
}

function createHeldRow(session: SessionMetadata): HTMLElement {
  const mode = primaryMode(session);
  const row = document.createElement("div");
  row.className = "held-row";
  row.dataset.instanceId = session.instanceId;

  const open = document.createElement("button");
  open.type = "button";
  open.className = "held-open";
  open.disabled = mode === undefined;
  open.setAttribute("aria-label", rowActionLabel(session, mode, "Open held request in"));
  open.append(
    createTextElement("span", "row-dot row-dot-held", ""),
    createTextElement("span", "row-title", sessionTitle(session)),
    createTextElement("span", "row-time", queueRowDetail(session)),
  );
  open.addEventListener("click", () => {
    if (mode !== undefined) void launch(session, mode, open, mode === "control" ? session.ask?.requestId : undefined);
  });

  const requeue = document.createElement("button");
  requeue.type = "button";
  requeue.className = "held-requeue";
  requeue.textContent = "Requeue";
  requeue.setAttribute("aria-label", `Return ${sessionTitle(session)} to the queue`);
  requeue.addEventListener("click", () => requeueHeldSession(session));
  row.append(open, requeue);
  return row;
}

function appendDismissedControl(dismissed: readonly SessionMetadata[]): void {
  if (dismissed.length === 0) return;
  const control = document.createElement("aside");
  control.className = "dismissed-control";
  control.append(createTextElement("span", "", `${dismissed.length} hidden on this device`));
  const restore = document.createElement("button");
  restore.type = "button";
  restore.textContent = "Show all";
  restore.addEventListener("click", restoreDismissedSessions);
  control.append(restore);
  sessionList.append(control);
}

/**
 * Every federated machine, including one with no session and one never reached, so an empty or
 * stale machine reads as such instead of silently vanishing from the directory.
 */
const FLEET_DIRECTORY_UNAVAILABLE = "Fleet directory unavailable. Machine status may be incomplete.";

/** A bridge that has never answered is not a healthy empty fleet, even when no host row exists yet. */
function showFleetDirectoryUnavailable(): void {
  if (fleetStatus !== "unreachable" || statusBanner.dataset.kind === "unauthorized") return;
  setStatus("gateway", FLEET_DIRECTORY_UNAVAILABLE);
}

function appendHostSummary(): void {
  if (fleetStatus === "unreachable" && (hosts === undefined || hosts.length === 0)) {
    const section = document.createElement("section");
    section.className = "host-summary";
    section.dataset.fleetStatus = "unreachable";
    section.setAttribute("aria-label", "Machines");
    section.append(createTextElement("p", "host-unavailable", FLEET_DIRECTORY_UNAVAILABLE));
    sessionList.append(section);
  }
  if (hosts === undefined || hosts.length === 0) return;
  const section = document.createElement("section");
  section.className = "host-summary";
  section.setAttribute("aria-label", "Machines");
  section.append(createQueueKicker(`Machines · ${hosts.length}`));
  const list = document.createElement("ul");
  list.className = "host-list";
  for (const host of hosts) {
    const count = [...sessions.values()].filter(session => session.host === host.host).length;
    const sessionCount = `${count} ${count === 1 ? "session" : "sessions"}`;
    const lastSeen = host.ageSeconds === null ? "" : ` · last seen ${elapsedLabel(Date.now() - host.ageSeconds * 1_000)} ago`;
    const state =
      host.status === "live"
        ? `Live · ${sessionCount}`
        : host.status === "stale"
          ? `Unreachable${lastSeen} · ${count === 0 ? "no sessions" : `${sessionCount} unavailable`}`
          : "Never reached";
    const row = document.createElement("li");
    row.className = "host-row";
    row.dataset.status = host.status;
    row.append(
      createTextElement("span", `row-dot row-dot-host-${host.status}`, ""),
      createTextElement("span", "host-name", host.host),
      createTextElement("span", "host-state", state),
    );
    list.append(row);
  }
  section.append(list);
  sessionList.append(section);
}

function renderAllClear(
  working: readonly SessionMetadata[],
  dismissed: readonly SessionMetadata[],
): void {
  const summary = document.createElement("div");
  summary.className = "all-clear-summary";
  const alertsLive = notificationState === "enabled";
  const message = document.createElement("div");
  message.className = "all-clear-message";
  message.append(
    createTextElement("h2", "all-clear-title", "All clear"),
    createTextElement(
      "p",
      "all-clear-copy",
      `Nothing needs you.${alertsLive ? " Alerts are on for input requests and activity stops." : ""}`,
    ),
  );
  summary.append(createTextElement("span", "all-clear-dot", ""), message);
  // Keep the ping promise honest: without an active subscription, surface the path to one.
  if (notificationState === "idle" || notificationState === "blocked") {
    const hint = document.createElement("button");
    hint.type = "button";
    hint.className = "alerts-hint";
    hint.textContent = notificationState === "blocked" ? "Alerts blocked · Settings" : "Enable alerts to get pinged";
    hint.addEventListener("click", () => notificationSettings.showModal());
    summary.append(hint);
  }
  sessionList.append(summary);
  if (working.length > 0) {
    sessionList.append(createQueueKicker("Live sessions"));
    for (const session of working) sessionList.append(createWorkingRow(session));
  }
  appendDismissedControl(dismissed);
}

function renderWaitingQueue(
  waiting: readonly SessionMetadata[],
  held: readonly SessionMetadata[],
  working: readonly SessionMetadata[],
  dismissed: readonly SessionMetadata[],
): void {
  const [hero, ...remaining] = waiting;
  if (hero === undefined) {
    const summary = document.createElement("div");
    summary.className = "all-held-summary";
    summary.append(
      createTextElement("span", "row-dot row-dot-held", ""),
      createTextElement("strong", "", `Queue clear · ${held.length} on hold — handle at desk`),
    );
    sessionList.append(summary);
  } else {
    sessionList.append(createQueueKicker("Up next", isAvailable(hero) ? waitingLabel(hero) : unavailableCopy(hero)));
    const article = document.createElement("article");
    article.className = "queue-hero";
    article.dataset.instanceId = hero.instanceId;
    const askPreview = createTextElement(
      "p",
      "ask-preview",
      hero.ask?.preview === undefined
        ? primaryMode(hero) === "control"
          ? "Waiting for your input"
          : `Waiting for your input — ${unavailableCopy(hero)}`
        : hero.ask.preview,
    );
    if (hero.ask?.optionCount !== undefined) {
      askPreview.append(
        createTextElement(
          "span",
          "ask-options",
          `${hero.ask.optionCount} ${hero.ask.optionCount === 1 ? "option" : "options"} to pick from`,
        ),
      );
    }
    article.append(
      createTextElement("h2", "", sessionTitle(hero)),
      createSessionSummary(hero),
      askPreview,
    );

    const heroMode = primaryMode(hero);
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "action action-request";
    primary.textContent =
      heroMode === "control" ? "Open request" : heroMode === "view" ? "View transcript" : unavailableCopy(hero);
    primary.disabled = heroMode === undefined;
    primary.addEventListener("click", () => {
      if (heroMode !== undefined) {
        void launch(hero, heroMode, primary, heroMode === "control" ? hero.ask?.requestId : undefined);
      }
    });
    article.append(primary);

    const alternatives = document.createElement("div");
    alternatives.className = "hero-alternatives";
    const hold = document.createElement("button");
    hold.type = "button";
    hold.className = "hero-alt hero-hold";
    hold.textContent = "Hold for desk";
    hold.addEventListener("click", () => holdSession(hero));
    alternatives.append(hold);
    if (heroMode === "control" && hero.canView) {
      const transcript = document.createElement("button");
      transcript.type = "button";
      transcript.className = "hero-alt";
      transcript.textContent = "Transcript";
      transcript.addEventListener("click", () => void launch(hero, "view", transcript));
      alternatives.append(transcript);
    }
    article.append(alternatives);
    sessionList.append(article);
  }

  if (remaining.length > 0) {
    sessionList.append(createQueueKicker("Then"));
    for (const session of remaining) sessionList.append(createWaitingRow(session));
  }
  if (held.length > 0) {
    sessionList.append(createQueueKicker(`On hold · ${held.length}`));
    for (const session of held) sessionList.append(createHeldRow(session));
  }
  if (working.length > 0) {
    sessionList.append(createQueueKicker(`Live sessions · ${working.length}`));
    for (const session of working) sessionList.append(createWorkingRow(session));
  }
  appendDismissedControl(dismissed);
  appendHostSummary();
}

function render(): void {
  if (activeCollabShell !== undefined) return;
  sessionList.replaceChildren();
  if (!directoryLoaded) {
    emptyState.hidden = true;
    directoryTitle.textContent = "Sessions";
    directoryCount.hidden = true;
    return;
  }
  emptyState.hidden = sessions.size > 0;
  if (sessions.size === 0) {
    directoryTitle.textContent = "Sessions";
    directoryCount.hidden = true;
    sessionList.className = "session-list";
    sessionList.setAttribute("aria-label", "Live OMP sessions");
    appendHostSummary();
    return;
  }

  const waiting = orderedWaitingSessions();
  const held = orderedHeldSessions();
  const working = orderedWorkingSessions();
  const dismissed = orderedDismissedSessions();
  const attentionCount = waiting.length + held.length;
  directoryCount.hidden = false;
  if (attentionCount > 0) {
    directoryTitle.textContent = "Needs you";
    directoryCount.className = "count-pill count-pill-waiting";
    directoryCount.textContent =
      held.length === 0
        ? `${attentionCount} waiting`
        : `${attentionCount} waiting · ${held.length} held`;
    sessionList.className = "session-list queue";
    sessionList.setAttribute("aria-label", "Sessions waiting for input");
    renderWaitingQueue(waiting, held, working, dismissed);
    return;
  }

  directoryTitle.textContent = "Sessions";
  directoryCount.className = "count-pill count-pill-live";
  const liveWorkingCount = working.length + dismissed.length;
  directoryCount.textContent = `Live · ${liveWorkingCount}`;
  sessionList.className = "session-list all-clear";
  sessionList.setAttribute("aria-label", "Live OMP sessions");
  renderAllClear(working, dismissed);
  appendHostSummary();
}

function setConnectionState(
  chip: HTMLElement,
  state: "connected" | "reconnecting" | "offline",
  copy?: string,
): void {
  const label = copy ?? (state === "connected" ? "Connected" : state === "reconnecting" ? "Reconnecting…" : "Offline");
  chip.dataset.state = state;
  chip.dataset.compact = state === "connected" && copy === undefined ? "true" : "false";
  chip.textContent = label;
  chip.setAttribute("aria-label", label);
  chip.title = label;
}

function sessionEndedCopy(reason: string | null): string {
  const exitCode = reason?.match(/\bexit(?:ed)?(?:\s+with)?(?:\s+code)?\s+(-?\d+)\b/iu)?.[1];
  return exitCode === undefined ? "Mac/session ended" : `Mac/session ended · exit ${exitCode}`;
}

function hideTriageBar(shell: ActiveCollabShell, rerenderConnection = true): void {
  const hidAnswerTriage = shell.answerTriageVisible;
  if (shell.triageTimeout !== undefined) {
    window.clearTimeout(shell.triageTimeout);
    delete shell.triageTimeout;
  }
  shell.answerTriageVisible = false;
  shell.triageBar.hidden = true;
  delete shell.triageBar.dataset.dismissible;
  delete shell.shell.dataset.triageVisible;
  if (hidAnswerTriage && rerenderConnection) renderConnectionState(shell);
}

function showTriageBar(
  shell: ActiveCollabShell,
  kind: "next" | "clear" | "hold" | "sending" | "reconnecting" | "ended" | "signin",
  copy: string,
  actionLabel?: string,
  action?: () => void,
): void {
  hideTriageBar(shell, false);
  shell.triageBar.dataset.kind = kind;
  shell.answerTriageVisible = kind === "next" || kind === "clear";
  const message = createTextElement("span", "triage-copy", copy);
  if (actionLabel !== undefined && action !== undefined) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      kind === "next" || kind === "hold"
        ? "triage-action triage-action-next"
        : "triage-action";
    button.textContent = actionLabel;
    button.addEventListener("click", action);
    shell.triageBar.replaceChildren(message, button);
  } else {
    shell.triageBar.replaceChildren(message);
  }
  shell.triageBar.hidden = false;
  shell.shell.dataset.triageVisible = "true";
  if (kind === "next" || kind === "clear") {
    shell.triageBar.dataset.dismissible = "true";
    shell.triageTimeout = window.setTimeout(() => hideTriageBar(shell), 8_000);
  }
}

function clearConnectionTimers(shell: ActiveCollabShell): void {
  if (shell.connectionDelayTimeout !== undefined) {
    window.clearTimeout(shell.connectionDelayTimeout);
    delete shell.connectionDelayTimeout;
  }
  if (shell.connectionTickTimeout !== undefined) {
    window.clearTimeout(shell.connectionTickTimeout);
    delete shell.connectionTickTimeout;
  }
  if (shell.recoveredTimeout !== undefined) {
    window.clearTimeout(shell.recoveredTimeout);
    delete shell.recoveredTimeout;
  }
}

function pathInterrupted(health: PathHealth): boolean {
  return (
    health.state === "degraded" ||
    health.state === "unreachable" ||
    (health.state === "checking" && health.failureSince !== null)
  );
}

function retryingCopy(path: "gateway" | "relay", state: CollabEmbedState): string {
  const label = path === "gateway" ? "Gateway unavailable" : "Relay unavailable";
  const retryAt = path === "gateway" ? state.gatewayHealth.retryAt : state.relayHealth.retryAt;
  if (retryAt === null) return `${label} — retrying…`;
  const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
  return seconds > 0 ? `${label} — retrying in ${seconds}s` : `${label} — retrying…`;
}

function scheduleConnectionRender(shell: ActiveCollabShell, delay: number, kind: "delay" | "tick"): void {
  const existing = kind === "delay" ? shell.connectionDelayTimeout : shell.connectionTickTimeout;
  if (existing !== undefined) window.clearTimeout(existing);
  const timeout = window.setTimeout(() => {
    if (kind === "delay") delete shell.connectionDelayTimeout;
    else delete shell.connectionTickTimeout;
    renderConnectionState(shell);
  }, delay);
  if (kind === "delay") shell.connectionDelayTimeout = timeout;
  else shell.connectionTickTimeout = timeout;
}

/** A sign-in prompt cannot recover without a reload, so connection ticks must not replace it. */
function signInTriageVisible(shell: ActiveCollabShell): boolean {
  return shell.triageBar.dataset.kind === "signin" && !shell.triageBar.hidden;
}

function showSignInInShell(shell: ActiveCollabShell, message: string): void {
  shell.answerShown = true;
  clearConnectionTimers(shell);
  setConnectionState(shell.connectionChip, "offline", "Sign in required");
  showTriageBar(shell, "signin", message, "Sign in again", reloadToSignIn);
}

function renderConnectionState(shell: ActiveCollabShell): void {
  const state = shell.latestEmbedState;
  if (state === undefined || activeCollabShell !== shell || signInTriageVisible(shell) || authorizationDenied) return;

  if (state.phase === "ended") {
    clearConnectionTimers(shell);
    shell.answerShown = true;
    setConnectionState(shell.connectionChip, "offline", "Ended");
    // The room ended but OMP did not exit, and the directory still lists this very session: its
    // host can open a new room, so offer to rejoin rather than only to leave.
    const current = sessions.get(shell.instanceId);
    const exited = sessionEndedCopy(state.endedReason).includes("· exit");
    const rejoinMode =
      exited || current === undefined || current.generation !== shell.generation
        ? undefined
        : shell.mode === "control" && current.canControl
          ? "control"
          : primaryMode(current);
    if (current !== undefined && rejoinMode !== undefined) {
      showTriageBar(shell, "ended", "Session room closed", "Rejoin", () => void launch(current, rejoinMode));
    } else {
      showTriageBar(shell, "ended", sessionEndedCopy(state.endedReason), "Back to Sessions", returnToDirectory);
    }
    return;
  }

  const live = state.phase === "live";
  if (!shell.hasBeenLive) {
    if (!live) {
      setConnectionState(shell.connectionChip, "reconnecting", "Connecting…");
      return;
    }
    shell.hasBeenLive = true;
  }

  const gatewayInterrupted = pathInterrupted(state.gatewayHealth);
  const relayInterrupted = pathInterrupted(state.relayHealth);
  if (gatewayInterrupted || relayInterrupted) {
    if (shell.recoveredTimeout !== undefined) {
      window.clearTimeout(shell.recoveredTimeout);
      delete shell.recoveredTimeout;
    }
    shell.interruptionStartedAt ??= Date.now();
    shell.outagePath = gatewayInterrupted ? "gateway" : "relay";
    const elapsed = Date.now() - shell.interruptionStartedAt;
    if (elapsed < CONNECTION_EXTENDED_MS) {
      setConnectionState(shell.connectionChip, "reconnecting", "Reconnecting…");
      if (state.responsePending && !shell.answerTriageVisible) {
        showTriageBar(shell, "sending", "Sending…");
      } else if (!shell.answerTriageVisible && !shell.triageBar.hidden && !signInTriageVisible(shell)) {
        hideTriageBar(shell);
      }
      scheduleConnectionRender(shell, CONNECTION_EXTENDED_MS - elapsed, "delay");
      return;
    }
    const path = shell.outagePath ?? "relay";
    const copy = retryingCopy(path, state);
    setConnectionState(shell.connectionChip, "reconnecting", path === "gateway" ? "Gateway unavailable" : "Relay unavailable");
    if (state.responsePending && !shell.answerTriageVisible) showTriageBar(shell, "sending", "Sending…");
    else if (!shell.answerTriageVisible) showTriageBar(shell, "reconnecting", copy);
    scheduleConnectionRender(shell, 1_000, "tick");
    return;
  }

  const recovered = shell.interruptionStartedAt !== undefined;
  if (shell.connectionDelayTimeout !== undefined) {
    window.clearTimeout(shell.connectionDelayTimeout);
    delete shell.connectionDelayTimeout;
  }
  if (shell.connectionTickTimeout !== undefined) {
    window.clearTimeout(shell.connectionTickTimeout);
    delete shell.connectionTickTimeout;
  }
  delete shell.interruptionStartedAt;
  delete shell.outagePath;
  if (recovered) {
    window.clearTimeout(shell.recoveredTimeout);
    setConnectionState(shell.connectionChip, "connected", "Connected");
    shell.recoveredTimeout = window.setTimeout(() => {
      delete shell.recoveredTimeout;
      if (activeCollabShell === shell && shell.latestEmbedState?.phase === "live") {
        setConnectionState(shell.connectionChip, "connected");
      }
    }, CONNECTION_RECOVERED_MS);
  } else if (shell.recoveredTimeout === undefined) {
    setConnectionState(shell.connectionChip, "connected");
  }
  if (state.responsePending && !shell.answerTriageVisible) {
    showTriageBar(shell, "sending", "Sending…");
  } else {
    if (
      (shell.triageBar.dataset.kind === "reconnecting" || shell.triageBar.dataset.kind === "sending") &&
      !signInTriageVisible(shell)
    ) {
      hideTriageBar(shell);
    }
    reconcileActiveCollabShell();
  }
}
/**
 * Leaving a session is an explicit choice: it supersedes any launch still in flight and forgets the
 * session, so a later reload lands in the directory rather than reopening it.
 */
function returnToDirectory(historyValue?: unknown): void {
  selectionSequence += 1;
  clearActiveSelection();
  void restoreDirectory(historyValue);
}

/**
 * Why a remembered selection can no longer be reopened, judged only against fresh metadata: the
 * exact instance at the exact generation, still reachable, still offering the mode that was open.
 * A restarted host bumped its generation and ended that session, so its successor is never opened.
 */
function resumeRefusal(resume: ActiveSelection, session: SessionMetadata | undefined): string | undefined {
  if (session === undefined) return "Your last session has ended. Choose a current session.";
  if (session.generation !== resume.generation) {
    return "Your last session restarted, so it was not reopened. Choose a current session.";
  }
  if (!isAvailable(session)) {
    return `${session.host ?? "Its machine"} is unreachable, so your last session was not reopened.`;
  }
  if (resume.mode === "control" && !session.canControl) return "Control is no longer available for your last session.";
  if (resume.mode === "view" && !session.canView) return "Viewing is no longer available for your last session.";
  return undefined;
}

/** Stays in the directory and says why; never retries on its own. */
function refuseResume(resume: ActiveSelection, session: SessionMetadata | undefined, message: string): void {
  // An unreachable machine may return with the same session, so only that refusal keeps the record
  // for a later reload; every other one is final.
  const sameButUnreachable = session?.generation === resume.generation && !isAvailable(session);
  if (!sameButUnreachable) forgetActiveSelection(resume.instanceId, resume.generation);
  intentStatusLocked = true;
  setStatus("expired", message);
  applyActivatedWorkerUpdate();
}

/** After a full reload: reopen the remembered session only if fresh metadata matches it exactly. */
async function resolvePendingResume(): Promise<void> {
  const resume = pendingResume;
  pendingResume = undefined;
  if (resume === undefined || activeCollabShell !== undefined) return;
  const session = sessions.get(resume.instanceId);
  const refusal = resumeRefusal(resume, session);
  if (refusal !== undefined || session === undefined) {
    refuseResume(resume, session, refusal ?? "");
    return;
  }
  await launch(session, resume.mode);
}

/**
 * Restores the cached directory DOM synchronously — a caller that has already disposed a client
 * cannot be left waiting behind an inert shell — and resolves once the refreshed snapshot has
 * landed, so a resume can decide against current metadata rather than the pre-background copy.
 */
function restoreDirectory(historyValue?: unknown): Promise<boolean> {
  collabShellDisposedOnPageHide = false;
  disposedShellResume = undefined;
  const snapshot = dashboardSnapshot;
  if (snapshot === undefined) {
    location.replace("/");
    return Promise.resolve(false);
  }
  const historyState = parseDirectoryHistoryState(historyValue) ?? snapshot.historyState;
  disposeActiveCollab?.();
  disposeActiveCollab = undefined;
  activeCollabShell = undefined;
  document.body.className = snapshot.bodyClass;
  document.body.replaceChildren(...snapshot.children);
  document.title = snapshot.title;
  dashboardSnapshot = undefined;
  history.replaceState({ ompDirectory: historyState }, "", "/");
  window.scrollTo(0, historyState.scrollY);
  const refreshed = refreshAndConnect();
  applyActivatedWorkerUpdate();
  return refreshed;
}

/**
 * Reopens the session a backgrounded shell was showing, or leaves the user in the directory when the
 * card that shell was launched from no longer exists.
 *
 * Every condition the first launch checked is rechecked here against freshly polled metadata: the
 * same instance at the same generation, still offering the mode that was open. A host that restarted
 * bumped its generation and legitimately ended that session, so it falls back to the directory with
 * the ordinary stale-launch behaviour instead of silently opening its successor. The pending request
 * is carried back only while it is still the one waiting — the gateway rejects a stale `requestId`
 * outright, so an answered question must resume as a plain reopen rather than a failed launch.
 */
async function resumeDisposedCollabShell(): Promise<void> {
  const resume = disposedShellResume;
  const selection = selectionSequence;
  const restored = await restoreDirectory();
  // A tap made while the directory refreshed is newer than the backgrounded session.
  if (resume === undefined || !restored || selection !== selectionSequence) return;
  const session = sessions.get(resume.instanceId);
  const refusal = resumeRefusal(resume, session);
  if (refusal !== undefined || session === undefined) {
    refuseResume(resume, session, refusal ?? "");
    return;
  }
  const requestId = session.ask?.requestId === resume.requestId ? resume.requestId : undefined;
  await launch(session, resume.mode, undefined, requestId);
}

async function holdCurrentAskAndAdvance(shell: ActiveCollabShell, current: SessionMetadata): Promise<void> {
  const currentRequestId = current.ask?.requestId;
  const authoritativeCurrent = sessions.get(current.instanceId);
  if (
    currentRequestId === undefined ||
    authoritativeCurrent?.generation !== current.generation ||
    authoritativeCurrent.ask?.requestId !== currentRequestId
  ) {
    reconcileActiveCollabShell();
    return;
  }

  const next = orderedWaitingSessions().find(
    session =>
      primaryMode(session) !== undefined &&
      (session.instanceId !== current.instanceId || session.ask?.requestId !== currentRequestId),
  );
  const mode = next === undefined ? undefined : primaryMode(next);
  if (next !== undefined && mode !== undefined) {
    shell.answerShown = true;
    showTriageBar(shell, "sending", "Opening next request…");
    const opened = await launch(next, mode, undefined, next.ask?.requestId);
    if (opened) {
      holdSession(current, false);
      return;
    }
    if (activeCollabShell !== shell || signInTriageVisible(shell) || authorizationDenied) return;
    shell.answerShown = false;
    const latestCurrent = sessions.get(current.instanceId);
    if (
      latestCurrent?.generation !== current.generation ||
      latestCurrent.ask?.requestId !== currentRequestId
    ) {
      reconcileActiveCollabShell();
      return;
    }
    showTriageBar(
      shell,
      "hold",
      "Couldn't open the next request. This one is still queued.",
      "Try again",
      () => void holdCurrentAskAndAdvance(shell, current),
    );
    return;
  }
  if (!holdSession(current, false)) return;
  shell.answerShown = true;
  const held = orderedHeldSessions().length;
  showTriageBar(
    shell,
    "clear",
    `Queue clear · ${held} on hold — handle at desk`,
    "Sessions",
    returnToDirectory,
  );
}

function reconcileActiveCollabShell(): void {
  const shell = activeCollabShell;
  if (
    shell === undefined ||
    shell.answerShown ||
    !directoryLoaded ||
    shell.latestEmbedState?.responsePending === true
  ) {
    return;
  }
  const current = sessions.get(shell.instanceId);
  if (current === undefined || current.generation !== shell.generation) {
    shell.answerShown = true;
    clearConnectionTimers(shell);
    setConnectionState(shell.connectionChip, "offline", "Ended");
    showTriageBar(shell, "ended", "Mac/session ended", "Back to Sessions", returnToDirectory);
    return;
  }
  if (shell.openedRequestId !== undefined && current.ask?.requestId === shell.openedRequestId) {
    if (
      shell.latestEmbedState?.phase === "live" &&
      current.inputRequired &&
      isHeld(current) === false &&
      (shell.triageBar.hidden || shell.triageBar.dataset.kind !== "hold")
    ) {
      showTriageBar(shell, "hold", "Need the desk for this one?", "Hold → next", () =>
        void holdCurrentAskAndAdvance(shell, current),
      );
    }
    return;
  }
  if (shell.openedRequestId === undefined) return;

  shell.answerShown = true;
  const waiting = orderedWaitingSessions();
  const next = waiting.find(session => session.canControl);
  if (waiting.length > 0 && next !== undefined) {
    const copy =
      waiting.length === 1
        ? "✓ Answered — 1 more needs you"
        : `✓ Answered — ${waiting.length} more need you`;
    showTriageBar(shell, "next", copy, "Next ask →", () =>
      void launch(next, "control", undefined, next.ask?.requestId),
    );
    return;
  }
  const working = orderedWorkingSessions().length;
  showTriageBar(
    shell,
    "clear",
    `✓ Answered — all clear · ${working} live`,
    "Sessions",
    returnToDirectory,
  );
}

async function loadCollabStylesheet(): Promise<HTMLLinkElement> {
  const existing = document.querySelector<HTMLLinkElement>("link[data-omp-collab-styles]");
  if (existing !== null) return existing;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = __COLLAB_CLIENT_STYLESHEET__;
  link.dataset.ompCollabStyles = "true";
  const loaded = new Promise<HTMLLinkElement>((resolve, reject) => {
    link.addEventListener("load", () => resolve(link), { once: true });
    link.addEventListener("error", () => reject(new Error("collaboration client stylesheet failed to load")), {
      once: true,
    });
  });
  document.head.append(link);
  return await loaded;
}

let collabClientWarmed = false;

/**
 * Import the pinned collaboration client while the directory idles so a later View/Control tap
 * only pays for the launch POST and relay connect. Module only: applying the client stylesheet
 * here would let its own :root/body theme rules restyle the directory, so CSS bytes are warmed by
 * the build-emitted `<link rel="preload" as="style">` and applied first at launch. Any failure
 * falls back to the launch-time import; no capability is involved.
 */
function warmCollabClient(): void {
  if (collabClientWarmed) return;
  collabClientWarmed = true;
  const idle: (callback: () => void) => unknown =
    typeof requestIdleCallback === "function" ? requestIdleCallback : queueMicrotask;
  idle(() => {
    try {
      void importCollabClient(__COLLAB_CLIENT_MODULE__).catch(() => undefined);
    } catch {
      // Environments without the module define (unit harness) keep the launch-time import path.
    }
  });
}

function enterCollabClient(
  capability: string,
  startCollabWithCapability: StartCollabWithCapability,
  session: SessionMetadata,
  mode: LaunchMode,
  requestId?: string,
): void {
  setStatus("ready", "");
  if (dashboardSnapshot === undefined) {
    const historyState: DirectoryHistoryState = {
      scrollY: window.scrollY,
      order: [...sessionList.querySelectorAll<HTMLElement>("[data-instance-id]")]
        .map(element => element.dataset.instanceId)
        .filter((instanceId): instanceId is string => instanceId !== undefined),
    };
    dashboardSnapshot = {
      children: [...document.body.children] as HTMLElement[],
      scrollY: historyState.scrollY,
      title: document.title,
      bodyClass: document.body.className,
      historyState,
    };
  }
  disposeActiveCollab?.();

  const shell = document.createElement("div");
  shell.className = "gateway-shell";
  const bar = document.createElement("header");
  bar.className = "shell-bar";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "shell-back";
  back.textContent = "←";
  back.setAttribute("aria-label", "Back to Sessions");
  back.title = "Sessions";
  back.addEventListener("click", () => history.back());
  const heading = document.createElement("span");
  heading.className = "shell-heading";
  const title = createTextElement("span", "shell-title", sessionTitle(session));
  heading.append(title);
  if (session.cwdLabel) heading.append(createTextElement("span", "shell-cwd", session.cwdLabel));
  const control = document.createElement("button");
  control.type = "button";
  control.className = "shell-control";
  control.textContent = "Control";
  control.hidden = mode === "control" || !session.canControl;
  control.addEventListener("click", () => {
    const current = sessions.get(session.instanceId) ?? session;
    void launch(current, "control", control, current.ask?.requestId);
  });
  const connection = createTextElement("span", "conn-chip", "Connecting…");
  setConnectionState(connection, "reconnecting", "Connecting…");
  connection.setAttribute("role", "status");
  connection.setAttribute("aria-live", "polite");
  connection.setAttribute("aria-atomic", "true");
  // The embedded client renders its session tools (context fill, agents toggle) into this slot.
  const tools = document.createElement("span");
  tools.className = "shell-tools";
  const shellActions = document.createElement("span");
  shellActions.className = "shell-actions";
  shellActions.append(tools, control, connection);
  bar.append(back, heading, shellActions);

  const container = document.createElement("div");
  container.id = "root";
  container.setAttribute("role", "application");
  container.setAttribute("aria-label", "OMP collaboration session");
  const triageBar = document.createElement("aside");
  triageBar.className = "triage-bar";
  triageBar.hidden = true;
  shell.append(bar, container, triageBar);
  let triageSwipeStart: number | undefined;
  shell.addEventListener("pointerdown", event => {
    if (
      triageBar.dataset.dismissible === "true" &&
      event.target !== null &&
      !triageBar.contains(event.target as Node)
    ) {
      hideTriageBar(activeCollabShell ?? shellState);
    }
  });
  shell.addEventListener("keydown", event => {
    if (event.key === "Escape" && triageBar.dataset.dismissible === "true") {
      event.preventDefault();
      hideTriageBar(activeCollabShell ?? shellState);
    }
  });
  triageBar.addEventListener("pointerdown", event => {
    triageSwipeStart = triageBar.dataset.dismissible === "true" ? event.clientY : undefined;
  });
  triageBar.addEventListener("pointerup", event => {
    if (triageSwipeStart !== undefined && Math.abs(event.clientY - triageSwipeStart) >= 32) {
      hideTriageBar(activeCollabShell ?? shellState);
    }
    triageSwipeStart = undefined;
  });
  triageBar.addEventListener("pointercancel", () => {
    triageSwipeStart = undefined;
  });

  snapshotController?.abort();
  snapshotController = undefined;
  clearReconnectTimeout();
  reconnectAttempt = 0;
  if (location.pathname !== "/client/") {
    history.replaceState({ ompDirectory: dashboardSnapshot.historyState }, "", "/");
    history.pushState({ ompCollab: true }, "", "/client/");
  }
  document.body.className = "collab-shell-active";
  document.body.replaceChildren(shell);
  document.title = `${sessionTitle(session)} · OMP Sessions`;

  const shellState: ActiveCollabShell = {
    instanceId: session.instanceId,
    generation: session.generation,
    ...(requestId === undefined ? {} : { openedRequestId: requestId }),
    mode,
    connectionChip: connection,
    triageBar,
    shell,
    answerShown: false,
    answerTriageVisible: false,
    hasBeenLive: false,
  };
  activeCollabShell = shellState;
  // A live shell supersedes any disposed predecessor, so the bfcache restore path must not fire.
  collabShellDisposedOnPageHide = false;
  disposedShellResume = undefined;

  const updateConnection = (state: CollabEmbedState): void => {
    shellState.latestEmbedState = state;
    renderConnectionState(shellState);
    reconcileActiveCollabShell();
  };

  let disposeClient = (): void => undefined;
  const removeLifecycleListeners = (): void => {
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("popstate", handlePopState);
  };
  const dispose = (): void => {
    hideTriageBar(shellState, false);
    clearConnectionTimers(shellState);
    removeLifecycleListeners();
    disposeClient();
    disposeClient = (): void => undefined;
    if (activeCollabShell === shellState) activeCollabShell = undefined;
    if (disposeActiveCollab === dispose) disposeActiveCollab = undefined;
  };
  const handlePageHide = (): void => {
    collabShellDisposedOnPageHide = true;
    disposedShellResume = {
      instanceId: session.instanceId,
      generation: session.generation,
      mode,
      ...(requestId === undefined ? {} : { requestId }),
    };
    dispose();
  };
  const handlePopState = (event: PopStateEvent): void => {
    returnToDirectory(event.state);
  };
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("popstate", handlePopState);
  try {
    disposeClient = startCollabWithCapability(
      container,
      capability,
      () => {
        // The client has already unmounted itself. Restore the cached directory synchronously so a
        // failed location.replace() cannot strand an inert shell without lifecycle listeners.
        disposeClient = (): void => undefined;
        returnToDirectory();
      },
      {
        focusPendingRequest: requestId !== undefined,
        shellOwnsLifecycle: true,
        headerSlot: tools,
        onStateChange: updateConnection,
      },
    );
    disposeActiveCollab = dispose;
    // Metadata only, written after the user's explicit launch mounted: never the capability.
    writeActiveSelection({ instanceId: session.instanceId, generation: session.generation, mode });
  } catch (error) {
    dispose();
    returnToDirectory();
    throw error;
  }
}

async function launch(
  session: SessionMetadata,
  mode: LaunchMode,
  button?: HTMLButtonElement,
  requestId?: string,
): Promise<boolean> {
  const sourceShell = activeCollabShell;
  selectionSequence += 1;
  const selection = selectionSequence;
  // An explicit choice made after a reload replaces the session remembered from before it.
  pendingResume = undefined;
  const idleLabel = button?.textContent ?? (mode === "view" ? "View" : "Control");
  if (button !== undefined) {
    button.disabled = true;
    button.dataset.busy = "true";
    button.setAttribute("aria-busy", "true");
    button.textContent = mode === "view" ? "Opening view…" : "Opening control…";
  } else if (sourceShell === undefined) {
    setStatus("loading", mode === "view" ? "Opening view…" : "Opening control…");
  }
  pendingLaunches += 1;
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    pendingLaunches -= 1;
  };

  const resetButton = (): void => {
    if (button === undefined) return;
    button.disabled = mode === "view" && !session.canView;
    delete button.dataset.busy;
    button.removeAttribute("aria-busy");
    button.textContent = idleLabel;
  };
  let stylesheet: HTMLLinkElement | undefined;
  let startCollabWithCapability: StartCollabWithCapability;
  /** A newer selection owns shared UI, auth, history, and storage. This attempt may only settle itself. */
  const superseded = (): boolean => {
    if (selection === selectionSequence) return false;
    settle();
    resetButton();
    return true;
  };
  const fail = (kind: "offline" | "expired", message: string): boolean => {
    if (superseded()) return false;
    settle();
    resetButton();
    if (sourceShell !== undefined && activeCollabShell === sourceShell) {
      showTriageBar(sourceShell, "reconnecting", message, "Try again", () => {
        showTriageBar(
          sourceShell,
          "sending",
          mode === "view" ? "Opening view…" : "Opening control…",
        );
        void launch(session, mode, button, requestId);
      });
      return true;
    }
    // A concurrent launch may already have mounted a collaboration; its route and styles stay put.
    if (activeCollabShell === undefined) {
      if (location.pathname === "/client/") history.replaceState(null, "", "/");
      stylesheet?.remove();
    }
    setStatus(kind, message);
    applyActivatedWorkerUpdate();
    return false;
  };

  try {
    const [loadedStylesheet, collabClient] = await Promise.all([
      loadCollabStylesheet(),
      importCollabClient(__COLLAB_CLIENT_MODULE__),
    ]);
    stylesheet = loadedStylesheet;
    startCollabWithCapability = collabClient.startCollabWithCapability;
  } catch {
    if (superseded()) return false;
    fail("offline", "The collaboration client did not start. Try again.");
    return false;
  }
  if (superseded()) return false;

  let response: Response;
  try {
    response = await fetch(`/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`, {
      method: "POST",
      headers: { ...API_REQUEST_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        generation: session.generation,
        ...(mode === "control" && requestId !== undefined ? { requestId } : {}),
      }),
      cache: "no-store",
      credentials: "same-origin",
      redirect: "manual",
    });
  } catch {
    if (superseded()) return false;
    fail("offline", "Gateway unavailable. Check your tailnet connection and try again.");
    return false;
  }
  if (superseded()) return false;

  if (isSignInRequired(response)) {
    // Never retried automatically: renewing access needs the user to navigate through sign-in.
    const message = signInCopy(response);
    settle();
    resetButton();
    if (activeCollabShell === undefined && location.pathname === "/client/") history.replaceState(null, "", "/");
    enterAuthorizationDenied(message);
    applyActivatedWorkerUpdate();
    return false;
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 409) {
      // The exact identity is gone or changed; a reload must not try to reopen it again.
      if (requestId === undefined) forgetActiveSelection(session.instanceId, session.generation);
      const preservedShell = fail("expired", "That session changed or expired. Try again.");
      if (!preservedShell && await refreshAndConnect() && selection === selectionSequence) {
        setStatus("expired", "That session changed or expired. The list has been refreshed.");
      }
    } else {
      fail("offline", "The session could not be opened. Try again.");
    }
    return false;
  }

  let capability: string | undefined;
  try {
    const payload = parseLaunchResponse(await response.json());
    if (payload.mode !== mode || payload.generation !== session.generation) {
      throw new Error("invalid launch response");
    }
    if (superseded()) {
      // The user chose something else, or left, while this launch was in flight. Drop its
      // capability unused rather than mount over the newer choice.
      return false;
    }
    capability = payload.capability;
    settle();
    enterCollabClient(capability, startCollabWithCapability, session, mode, requestId);
    capability = undefined;
    return true;
  } catch {
    capability = undefined;
    if (superseded()) return false;
    fail("offline", "The gateway returned an invalid launch response.");
    return false;
  }
}

function applyEvent(event: SessionEvent, epoch: number): boolean {
  if (epoch !== directoryEpoch || event.revision < directoryRevision) return false;
  directoryRevision = event.revision;
  authorizationDenied = false;
  directoryLoaded = true;
  lastFreshAt = Date.now();
  if (event.type === "snapshot") {
    // A fleet snapshot replaces sessions and machines together, including one sent mid-stream
    // because only a machine's reachability changed.
    hosts = event.hosts;
    fleetStatus = event.fleetStatus;
    replaceSessionSnapshot(event.sessions);
  } else if (event.type === "session_upsert") {
    sessions.set(event.session.instanceId, event.session);
  } else {
    const current = sessions.get(event.instanceId);
    if (current?.generation === event.generation) sessions.delete(event.instanceId);
  }
  if (event.type !== "snapshot") reconcileLocalRecords();
  render();
  if (!intentStatusLocked) showFleetDirectoryUnavailable();
  reconcileActiveCollabShell();
  return true;
}

async function loadSnapshot(epoch: number): Promise<boolean> {
  const controller = new AbortController();
  snapshotController = controller;
  let timedOut = false;
  let responseReceived = false;
  const timeoutMs =
    directoryLoaded || transportFailureSince !== undefined || navigator.onLine === false
      ? RECOVERY_SNAPSHOT_TIMEOUT_MS
      : SNAPSHOT_TIMEOUT_MS;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (!directoryLoaded) setStatus("loading", "Loading sessions…");
  try {
    const response = await fetch("/api/v1/sessions", {
      headers: API_REQUEST_HEADERS,
      cache: "no-store",
      credentials: "same-origin",
      redirect: "manual",
      signal: controller.signal,
    });
    responseReceived = true;
    if (epoch !== directoryEpoch) return false;
    // Also the probe behind every directory-stream failure: a native EventSource cannot send the
    // AJAX header, so an expired sign-in is recognized here and stops the retry chain.
    if (isSignInRequired(response)) {
      directoryLoaded = false;
      sessions.clear();
      hosts = undefined;
      fleetStatus = undefined;
      render();
      enterAuthorizationDenied(signInCopy(response));
      return false;
    }
    if (!response.ok) throw new Error("snapshot failed");
    const payload = parseSessionListResponse(await response.json());
    if (epoch !== directoryEpoch || payload.revision < directoryRevision) return false;
    directoryRevision = payload.revision;
    authorizationDenied = false;
    directoryLoaded = true;
    lastFreshAt = Date.now();
    hosts = payload.hosts;
    fleetStatus = payload.fleetStatus;
    replaceSessionSnapshot(payload.sessions);
    render();
    setStatus("ready", "");
    showFleetDirectoryUnavailable();
    return true;
  } catch {
    if (epoch !== directoryEpoch || (controller.signal.aborted && !timedOut)) return false;
    authorizationDenied = false;
    showTransportFailure(
      navigator.onLine === false ? "offline" : timedOut || responseReceived ? "desktop" : "tailnet",
    );
    return false;
  } finally {
    window.clearTimeout(timeout);
    if (snapshotController === controller) snapshotController = undefined;
  }
}

function connectEvents(epoch: number): void {
  if (authorizationDenied || epoch !== directoryEpoch) return;
  const source = new EventSource("/api/v1/events", { withCredentials: true });
  events = source;
  let opened = false;
  source.onopen = () => {
    if (events !== source || epoch !== directoryEpoch) return;
    if (opened) directoryRevision = -1;
    opened = true;
    clearReconnectTimeout();
    reconnectAttempt = 0;
    eventStreamStale = false;
    clearStreamInterruption();
    armEventLiveness(source, epoch);
  };
  for (const type of ["snapshot", "session_upsert", "session_remove"] as const) {
    source.addEventListener(type, event => {
      if (events !== source || epoch !== directoryEpoch) return;
      if (eventStreamStale) {
        failEventStream(source, epoch);
        return;
      }
      armEventLiveness(source, epoch);
      try {
        if (applyEvent(parseSessionEvent(JSON.parse(event.data)), epoch) && !intentStatusLocked && fleetStatus !== "unreachable") {
          setStatus("ready", "");
        }
      } catch {
        failEventStream(source, epoch);
      }
    });
  }
  source.addEventListener("keepalive", () => {
    if (events !== source || epoch !== directoryEpoch) return;
    if (eventStreamStale) {
      failEventStream(source, epoch);
      return;
    }
    lastFreshAt = Date.now();
    armEventLiveness(source, epoch);
    if (!intentStatusLocked && !authorizationDenied && fleetStatus !== "unreachable") setStatus("ready", "");
  });
  source.onerror = () => {
    // Native EventSource reconnects on network restoration even when Android Chrome loses a
    // scheduled JavaScript timer. Keep that browser-owned recovery path alive; the snapshot retry
    // remains a bounded fallback and will close this source if it fires first.
    markEventStreamInterrupted(source, epoch);
  };
}

async function resolvePendingNotificationRoute(): Promise<void> {
  if (!pendingNotificationRoute) return;
  pendingNotificationRoute = false;
  const pending = pendingNotificationLaunch;
  pendingNotificationLaunch = undefined;
  const session = pending === undefined ? undefined : sessions.get(pending.instanceId);
  // A tap for the collaboration this page already shows keeps it: an activity stop never
  // downgrades Control to View, and an attention tap relaunches only to gain Control.
  const shell = activeCollabShell;
  const shown =
    shell !== undefined &&
    session !== undefined &&
    shell.instanceId === session.instanceId &&
    shell.generation === session.generation;
  const stopMode: LaunchMode | undefined =
    session === undefined || !isAvailable(session) ? undefined : session.canView ? "view" : primaryMode(session);
  if (pending?.kind === "activity_stop" && session?.generation === pending.generation && stopMode !== undefined) {
    if (shown) return;
    if (shell !== undefined) showTriageBar(shell, "sending", stopMode === "view" ? "Opening view…" : "Opening control…");
    await launch(session, stopMode);
  } else if (
    pending?.kind === "attention" &&
    session?.ask?.requestId === pending.requestId &&
    session.inputRequired &&
    session.canControl &&
    isAvailable(session)
  ) {
    if (shown && shell.mode === "control") return;
    if (shell !== undefined) showTriageBar(shell, "sending", "Opening control…");
    await launch(session, "control", undefined, pending.requestId);
  } else if (shell !== undefined) {
    // The collaboration stays open. The directory banner is hidden behind it, so say so in the
    // triage bar, unless that bar already holds a live prompt such as Hold for the open ask.
    if (shell.triageBar.hidden) showTriageBar(shell, "clear", "That alert changed or expired.", "Sessions", returnToDirectory);
  } else {
    setStatus("expired", "That notification changed or expired. Choose a current session.");
    applyActivatedWorkerUpdate();
  }
}

async function refreshAndConnect(resetBackoff = true): Promise<boolean> {
  if (authorizationDenied) return false;
  if (resetBackoff) reconnectAttempt = 0;
  clearReconnectTimeout();
  const epoch = directoryEpoch + 1;
  directoryEpoch = epoch;
  directoryRevision = -1;
  snapshotController?.abort();
  snapshotController = undefined;
  events?.close();
  events = undefined;
  clearEventLiveness();
  eventStreamStale = false;
  const loaded = await loadSnapshot(epoch);
  if (loaded && epoch === directoryEpoch) {
    reconnectAttempt = 0;
    connectEvents(epoch);
    warmCollabClient();
    await resolvePendingNotificationRoute();
    await resolvePendingResume();
    return true;
  }
  if (!authorizationDenied && epoch === directoryEpoch) scheduleReconnect();
  return false;
}
settingsButton.addEventListener("click", () => notificationSettings.showModal());
notificationButton.addEventListener("click", () => void toggleBackgroundNotifications());
notificationSettingsClose.addEventListener("click", () => notificationSettings.close());
localActionToastUndo.addEventListener("click", undoPendingDismissal);
networkRecoveryHelpClose.addEventListener("click", () => networkRecoveryHelp.close());
for (const input of notificationDetailInputs) {
  input.addEventListener("change", () => {
    if (!input.checked || notificationRegistration === undefined) return;
    const detailLevel = input.value as PushDetailLevel;
    void (async () => {
      const subscription = await notificationRegistration?.pushManager.getSubscription();
      if (subscription === null || subscription === undefined) return;
      try {
        selectNotificationDetail(await savePushSubscription(subscription, detailLevel));
      } catch {
        selectNotificationDetail(currentNotificationDetail);
      }
    })();
  });
}
window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  if (collabShellDisposedOnPageHide) {
    void resumeDisposedCollabShell();
    return;
  }
  void refreshAndConnect();
});
window.addEventListener("online", () => void refreshAndConnect());
window.addEventListener("offline", () => {
  if (authorizationDenied) return;
  directoryEpoch += 1;
  directoryRevision = -1;
  snapshotController?.abort();
  snapshotController = undefined;
  events?.close();
  clearEventLiveness();
  clearReconnectTimeout();
  reconnectAttempt = 0;
  eventStreamStale = false;
  events = undefined;
  authorizationDenied = false;
  showTransportFailure("offline");
  // `online` is not a dependable wake-up. Issue #65 measured `navigator.onLine` reporting true
  // through a total outage on the device, so an offline state whose only exit is an `online` event
  // is a state the page can never leave. Keep the bounded retry chain running instead.
  scheduleReconnect();
});

/**
 * A frozen page cannot read the directory stream, but Chrome keeps the connection open and the
 * phone keeps waking for its five-second keepalives. On a Pixel 10 Pro (Android 17, Chrome 154) a
 * backgrounded directory received them for all of a twelve-minute measurement; the same Chrome
 * delivered `freeze` 60 seconds after the page was hidden. Release the stream then, without a
 * failure or a retry: nothing failed, and becoming visible rebuilds it from a fresh snapshot.
 */
document.addEventListener("freeze", () => {
  directoryEpoch += 1;
  directoryRevision = -1;
  snapshotController?.abort();
  snapshotController = undefined;
  events?.close();
  events = undefined;
  clearEventLiveness();
  clearReconnectTimeout();
  eventStreamStale = false;
});

/**
 * Resume is a recovery signal Android actually delivers, so treat it as one.
 *
 * A page frozen across a network change has no way to notice the change: its timers did not run and
 * its `EventSource` still reports open. `pageshow` does not cover this — it fires for a bfcache
 * restore, not for freeze/resume of the foreground page. So on resume, unless the stream can be
 * shown to be live, throw the whole connection away and build a new one now rather than waiting out
 * a timer that was frozen with it.
 */
document.addEventListener("visibilitychange", () => {
  // A drop while hidden is not an outage the user saw; the grace restarts from the resume.
  clearStreamInterruption();
  if (document.visibilityState !== "visible") {
    clearTransportFailureTracking();
    return;
  }
  if (authorizationDenied || directoryStreamIsLive()) return;
  void refreshAndConnect();
});

const applicationWorkerRegistration = initializeApplicationWorker();
void initializeNotifications(applicationWorkerRegistration);
await refreshAndConnect();
