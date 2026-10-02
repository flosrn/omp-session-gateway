// The live-session directory: order, project/machine grouping, and the activity and workspace
// facts a row shows. It owns no session state and never imports the app: the caller hands it the
// working sessions and a callback that builds each native row (launch and hide actions stay the
// app's), so the needs-you queue is untouched and there is no import cycle.
//
// Display rules: a missing fact is omitted, never drawn as zero; tool and intent show only while
// the session is busy; a stale machine's facts read "Last known"; no instance, session or
// workspace identity, path, or capability reaches visible text; a PR becomes a link only when it
// is an https GitHub pull request URL.
import type { SessionMetadata } from "@omp-session-gateway/protocol";

export type DirectoryGrouping = "project" | "host";

export const DIRECTORY_GROUPING_STORAGE_KEY = "omp.sessions.directory-grouping.v1";
export const DIRECTORY_COLLAPSED_STORAGE_KEY = "omp.sessions.directory-collapsed.v1";
const MAX_COLLAPSED_GROUPS = 64;
const MAX_COLLAPSED_KEY_LENGTH = 300;
const GROUPING_LABELS: Readonly<Record<DirectoryGrouping, string>> = { project: "Project", host: "Machine" };

/** Cosmetic preferences only; a storage failure falls back to defaults and never throws. */
export type DirectoryStorage = Pick<Storage, "getItem" | "setItem">;

export interface ActivityDirectoryGroup {
  /** Stable grouping key: the project or machine name, `""` for none. Never a session identity. */
  readonly key: string;
  readonly label: string;
  readonly sessions: readonly SessionMetadata[];
}

export interface ActivityDirectoryOptions {
  /** Builds the app's native row (`createWorkingRow`); facts are added inside it afterwards. */
  readonly renderRow: (session: SessionMetadata) => HTMLElement;
  /** Defaults to `localStorage` when available. */
  readonly storage?: DirectoryStorage | null;
  /** Test seam; defaults to the global `document`. */
  readonly document?: Document;
}

export interface ActivityDirectory {
  readonly element: HTMLElement;
  /** Rebuilds the groups from these working sessions; keeps grouping and collapse preferences. */
  render(sessions: readonly SessionMetadata[]): void;
}

/** Activity time, else start time, in epoch ms; an unparseable start sorts last. */
function recencyOf(session: SessionMetadata): number {
  const at = session.activity?.at;
  if (at !== null && at !== undefined) return at;
  const started = Date.parse(session.startedAt);
  return Number.isNaN(started) ? Number.NEGATIVE_INFINITY : started;
}

/** Working (`busy === true`) first, then most recent activity (start time as fallback), then id. */
export function compareWorkingSessions(left: SessionMetadata, right: SessionMetadata): number {
  const working = Number(right.busy === true) - Number(left.busy === true);
  if (working !== 0) return working;
  const leftRecency = recencyOf(left);
  const rightRecency = recencyOf(right);
  if (leftRecency !== rightRecency) return rightRecency > leftRecency ? 1 : -1;
  return left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0;
}

export function orderWorkingSessions(sessions: readonly SessionMetadata[]): SessionMetadata[] {
  return [...sessions].sort(compareWorkingSessions);
}

/**
 * Groups in the order of each group's best row, rows in session order. Project is the Orca
 * workspace project, else the cwd label; machine is the fleet host, else this gateway's machine.
 */
export function groupWorkingSessions(
  sessions: readonly SessionMetadata[],
  grouping: DirectoryGrouping,
): ActivityDirectoryGroup[] {
  const groups = new Map<string, { key: string; label: string; sessions: SessionMetadata[] }>();
  for (const session of orderWorkingSessions(sessions)) {
    const key = grouping === "host" ? session.host ?? "" : session.workspace?.project ?? session.cwdLabel ?? "";
    let group = groups.get(key);
    if (group === undefined) {
      const fallback = grouping === "host" ? "This machine" : "No project";
      group = { key, label: key === "" ? fallback : key, sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  return [...groups.values()];
}

function defaultStorage(): DirectoryStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readDirectoryGrouping(storage: DirectoryStorage | null): DirectoryGrouping {
  try {
    return storage?.getItem(DIRECTORY_GROUPING_STORAGE_KEY) === "host" ? "host" : "project";
  } catch {
    return "project";
  }
}

function readCollapsed(storage: DirectoryStorage | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(DIRECTORY_COLLAPSED_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((value): value is string => typeof value === "string" && value.length <= MAX_COLLAPSED_KEY_LENGTH)
        .slice(0, MAX_COLLAPSED_GROUPS),
    );
  } catch {
    return new Set();
  }
}

function writePreference(storage: DirectoryStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // A full or blocked store only loses a cosmetic preference.
  }
}

const GITHUB_PULL_PATH = /^\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/[1-9][0-9]{0,9}\/?$/u;

/** The URL only when it is exactly an https github.com pull request, without credentials, port, query or fragment. */
export function safeGithubPullUrl(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" ||
    (url.hostname !== "github.com" && url.hostname !== "www.github.com") ||
    url.search !== "" || url.hash !== "" || !GITHUB_PULL_PATH.test(url.pathname)
  ) {
    return undefined;
  }
  return url.href;
}

export interface ActivityFacts {
  /** The machine is not live: every fact below is its last known reading. */
  readonly stale: boolean;
  readonly preview?: string;
  /** Present only while the session is busy on a live machine. */
  readonly tool?: string;
  readonly intent?: string;
  /** Present when tokens and a positive window are both known; `ratio` is clamped to 0..1. */
  readonly gauge?: { readonly tokens: number; readonly window: number; readonly ratio: number };
  /** Tokens without a known window: an honest count, never a fabricated gauge. */
  readonly tokens?: number;
  readonly cost?: number;
  readonly subagents?: number;
  readonly project?: string;
  readonly branch?: string;
  readonly comment?: string;
  readonly status?: string;
  readonly unread: boolean;
  readonly pullRequest?: string;
}

/** What a row may show, decided once so rendering and tests agree. Nothing is invented. */
export function activityFacts(session: SessionMetadata): ActivityFacts {
  const activity = session.activity;
  const workspace = session.workspace;
  const stale = session.available === false || (session.hostStatus !== undefined && session.hostStatus !== "live");
  const current = session.busy === true && !stale;
  const tokens = activity?.contextTokens ?? null;
  const contextWindow = activity?.contextWindow ?? null;
  const pullRequest = safeGithubPullUrl(workspace?.pr);
  return {
    stale,
    ...(activity?.preview == null ? {} : { preview: activity.preview }),
    ...(current && activity?.tool != null ? { tool: activity.tool } : {}),
    ...(current && activity?.intent != null ? { intent: activity.intent } : {}),
    ...(tokens !== null && contextWindow !== null && contextWindow > 0
      ? { gauge: { tokens, window: contextWindow, ratio: Math.min(1, tokens / contextWindow) } }
      : tokens !== null ? { tokens } : {}),
    ...(activity?.cost == null ? {} : { cost: activity.cost }),
    ...(activity?.subagents == null ? {} : { subagents: activity.subagents }),
    ...(workspace === undefined ? {} : { project: workspace.project }),
    ...(workspace?.branch == null ? {} : { branch: workspace.branch }),
    ...(workspace?.comment == null ? {} : { comment: workspace.comment }),
    ...(workspace?.status == null ? {} : { status: workspace.status }),
    unread: workspace?.unread === true,
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
}

const integerFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Cumulative session cost in dollars; sub-cent totals keep enough digits to stay non-zero. */
export function formatCost(cost: number): string {
  if (cost === 0) return "$0";
  const digits = cost >= 1 ? 2 : cost >= 0.01 ? 3 : 4;
  return `$${cost.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits })}`;
}

function textNode(doc: Document, tagName: string, className: string, text: string): HTMLElement {
  const element = doc.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

function createFactsElement(doc: Document, facts: ActivityFacts): HTMLElement | undefined {
  const container = doc.createElement("span");
  container.className = facts.stale ? "activity-facts activity-stale" : "activity-facts";
  if (facts.stale) container.append(textNode(doc, "span", "activity-last-known", "Last known"));

  if (facts.tool !== undefined || facts.intent !== undefined) {
    const now = doc.createElement("span");
    now.className = "activity-now";
    if (facts.tool !== undefined) now.append(textNode(doc, "span", "activity-tool", facts.tool));
    if (facts.intent !== undefined) now.append(textNode(doc, "span", "activity-intent", facts.intent));
    container.append(now);
  }
  if (facts.preview !== undefined) container.append(textNode(doc, "span", "activity-preview", facts.preview));

  const meters = doc.createElement("span");
  meters.className = "activity-meters";
  if (facts.gauge !== undefined) {
    const { tokens, window: contextWindow, ratio } = facts.gauge;
    const gauge = doc.createElement("span");
    gauge.className = "activity-gauge";
    gauge.setAttribute("role", "meter");
    gauge.setAttribute("aria-valuemin", "0");
    gauge.setAttribute("aria-valuemax", String(contextWindow));
    gauge.setAttribute("aria-valuenow", String(Math.min(tokens, contextWindow)));
    gauge.setAttribute("aria-label", `Context ${integerFormat.format(tokens)} of ${integerFormat.format(contextWindow)} tokens`);
    const fill = doc.createElement("span");
    fill.className = "activity-gauge-fill";
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    gauge.append(fill);
    meters.append(
      gauge,
      textNode(doc, "span", "activity-context", `${compactFormat.format(tokens)} / ${compactFormat.format(contextWindow)}`),
    );
  } else if (facts.tokens !== undefined) {
    meters.append(textNode(doc, "span", "activity-context", `${integerFormat.format(facts.tokens)} tokens`));
  }
  if (facts.cost !== undefined) meters.append(textNode(doc, "span", "activity-cost", formatCost(facts.cost)));
  if (facts.subagents !== undefined) {
    meters.append(
      textNode(doc, "span", "activity-subagents", `${facts.subagents} ${facts.subagents === 1 ? "subagent" : "subagents"}`),
    );
  }
  if (meters.childElementCount > 0) container.append(meters);

  if (facts.project !== undefined) {
    const workspace = doc.createElement("span");
    workspace.className = "activity-workspace";
    const branch = facts.branch === undefined ? facts.project : `${facts.project} · ${facts.branch}`;
    workspace.append(textNode(doc, "span", "activity-branch", branch));
    if (facts.status !== undefined) workspace.append(textNode(doc, "span", "activity-status", facts.status));
    if (facts.unread) workspace.append(textNode(doc, "span", "activity-unread", "Unread"));
    container.append(workspace);
    if (facts.comment !== undefined) container.append(textNode(doc, "span", "activity-comment", facts.comment));
  }
  // The row is one button; a nested link would be invalid, so the caller places it beside the row.
  return container.childElementCount === 0 ? undefined : container;
}

function createPullRequestLink(doc: Document, href: string, title: string): HTMLAnchorElement {
  const link = doc.createElement("a");
  link.className = "activity-pr";
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  link.textContent = `PR #${href.replace(/\/$/u, "").split("/").pop() ?? ""}`;
  link.setAttribute("aria-label", `Open pull request for ${title} on GitHub`);
  return link;
}

/** Where a row's facts and PR link go when the row is not the working-row shape. */
export interface ActivityFactsPlacement {
  /** Receives the facts; default `.working-copy` inside the row, else the row. */
  readonly factsRoot?: HTMLElement;
  /** The row's action button; the PR link becomes its next sibling. Default `.working-row`. */
  readonly actionRoot?: HTMLElement;
}

/**
 * Adds a row's facts to `factsRoot` and its PR link right after the action button, never inside a
 * button: with no action the link follows a button row, or is appended to any other row (e.g. the
 * hero article). Idempotent, and it removes only what it placed: `.activity-facts` children of the
 * facts root and an `.activity-pr` in the link's own slot. A link with no safe slot (a detached
 * button row) is left out rather than nested.
 */
export function appendActivityFacts(
  row: HTMLElement,
  session: SessionMetadata,
  doc: Document = document,
  placement: ActivityFactsPlacement = {},
): void {
  const factsRoot = placement.factsRoot ?? row.querySelector<HTMLElement>(".working-copy") ?? row;
  const action =
    placement.actionRoot ?? (row.matches(".working-row") ? row : row.querySelector<HTMLElement>(".working-row"));
  const linkAfter = action ?? (row.matches("button") ? row : null);
  Array.from(factsRoot.children).forEach(child => {
    if (child.matches(".activity-facts")) child.remove();
  });
  if (linkAfter === null) {
    Array.from(row.children).forEach(child => {
      if (child.matches(".activity-pr")) child.remove();
    });
  } else if (linkAfter.nextElementSibling?.matches(".activity-pr") === true) {
    linkAfter.nextElementSibling.remove();
  }

  const facts = activityFacts(session);
  const element = createFactsElement(doc, facts);
  if (element !== undefined) factsRoot.append(element);
  if (facts.pullRequest === undefined) return;
  if (linkAfter !== null && linkAfter.parentElement === null) return;
  const title = row.querySelector(".row-title")?.textContent ?? "this session";
  const link = createPullRequestLink(doc, facts.pullRequest, title);
  if (linkAfter === null) row.append(link);
  else linkAfter.after(link);
}

/** The directory element and its renderer. Preferences live in cosmetic storage, not in sessions. */
export function createActivityDirectory(options: ActivityDirectoryOptions): ActivityDirectory {
  const doc = options.document ?? document;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  let grouping = readDirectoryGrouping(storage);
  const collapsed = readCollapsed(storage);
  let current: readonly SessionMetadata[] = [];

  const element = doc.createElement("section");
  element.className = "activity-directory";
  element.setAttribute("aria-label", "Live sessions");

  const persistCollapsed = (): void => {
    writePreference(storage, DIRECTORY_COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsed].slice(-MAX_COLLAPSED_GROUPS)));
  };

  const createPicker = (): HTMLElement => {
    const picker = doc.createElement("div");
    picker.className = "activity-group-picker";
    picker.setAttribute("role", "group");
    picker.setAttribute("aria-label", "Group live sessions by");
    picker.append(textNode(doc, "span", "activity-group-picker-label", "Group by"));
    for (const option of ["project", "host"] as const) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "activity-group-option";
      button.dataset.grouping = option;
      button.textContent = GROUPING_LABELS[option];
      button.setAttribute("aria-pressed", String(option === grouping));
      button.addEventListener("click", () => {
        if (option === grouping) return;
        grouping = option;
        writePreference(storage, DIRECTORY_GROUPING_STORAGE_KEY, option);
        render(current);
      });
      picker.append(button);
    }
    return picker;
  };

  const createGroup = (group: ActivityDirectoryGroup): HTMLElement => {
    const key = `${grouping}:${group.key}`;
    const section = doc.createElement("section");
    section.className = "activity-group";
    const rows = doc.createElement("div");
    rows.className = "activity-group-rows";
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "activity-group-toggle";
    const working = group.sessions.filter(session => session.busy === true).length;
    toggle.append(
      textNode(doc, "span", "activity-group-chevron", "›"),
      textNode(doc, "span", "activity-group-label", group.label),
      textNode(
        doc,
        "span",
        "activity-group-count",
        working > 0 ? `${working} working · ${group.sessions.length}` : String(group.sessions.length),
      ),
    );
    const apply = (isCollapsed: boolean): void => {
      toggle.setAttribute("aria-expanded", String(!isCollapsed));
      section.dataset.collapsed = String(isCollapsed);
      rows.hidden = isCollapsed;
    };
    apply(collapsed.has(key));
    toggle.addEventListener("click", () => {
      const isCollapsed = !collapsed.has(key);
      if (isCollapsed) collapsed.add(key);
      else collapsed.delete(key);
      persistCollapsed();
      apply(isCollapsed);
    });
    for (const session of group.sessions) {
      const row = options.renderRow(session);
      appendActivityFacts(row, session, doc);
      rows.append(row);
    }
    section.append(toggle, rows);
    return section;
  };

  const render = (sessions: readonly SessionMetadata[]): void => {
    current = sessions;
    element.dataset.grouping = grouping;
    if (sessions.length === 0) {
      element.replaceChildren();
      element.hidden = true;
      return;
    }
    element.hidden = false;
    element.replaceChildren(createPicker(), ...groupWorkingSessions(sessions, grouping).map(createGroup));
  };

  return { element, render };
}

/** One-shot convenience for a render pass that rebuilds its container: create, render, append. */
export function renderActivityDirectory(
  container: HTMLElement,
  sessions: readonly SessionMetadata[],
  options: ActivityDirectoryOptions,
): ActivityDirectory {
  const directory = createActivityDirectory(options);
  directory.render(sessions);
  container.append(directory.element);
  return directory;
}
