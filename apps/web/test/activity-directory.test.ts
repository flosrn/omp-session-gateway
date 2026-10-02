import { describe, expect, test } from "bun:test";
import type { SessionActivity, SessionMetadata } from "@omp-session-gateway/protocol";
import {
  DIRECTORY_COLLAPSED_STORAGE_KEY,
  DIRECTORY_GROUPING_STORAGE_KEY,
  activityFacts,
  appendActivityFacts,
  createActivityDirectory,
  formatCost,
  groupWorkingSessions,
  orderWorkingSessions,
  safeGithubPullUrl,
  type DirectoryStorage,
} from "../src/activity-directory.ts";

const NO_ACTIVITY: SessionActivity = {
  at: null, tool: null, intent: null, preview: null, contextTokens: null, contextWindow: null, cost: null, subagents: null,
};

function session(instanceId: string, overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    instanceId,
    generation: 1,
    title: instanceId,
    startedAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-01T00:00:00.000Z",
    canView: true,
    canControl: true,
    inputRequired: false,
    ...overrides,
  };
}

function at(epochMs: number, extra: Partial<SessionActivity> = {}): SessionActivity {
  return { ...NO_ACTIVITY, at: epochMs, ...extra };
}

describe("working order", () => {
  test("working first, then latest activity, start time standing in for unknown activity, then id", () => {
    const ordered = orderWorkingSessions([
      session("idle-old-activity", { busy: false, activity: at(1_000) }),
      session("idle-no-activity-late-start", { busy: false, startedAt: "1970-01-01T00:00:05.000Z" }),
      session("working-old", { busy: true, activity: at(2_000) }),
      session("unknown-new", { activity: at(9_000) }),
      session("working-new", { busy: true, activity: at(8_000) }),
      session("tie-b", { busy: false, activity: at(3_000) }),
      session("tie-a", { busy: false, activity: at(3_000) }),
    ]);
    expect(ordered.map(item => item.instanceId)).toEqual([
      "working-new", "working-old", "unknown-new", "idle-no-activity-late-start", "tie-a", "tie-b", "idle-old-activity",
    ]);
  });

  test("is a pure, stable ordering over the input", () => {
    const input = [session("b"), session("a")];
    expect(orderWorkingSessions(input).map(item => item.instanceId)).toEqual(["a", "b"]);
    expect(input.map(item => item.instanceId)).toEqual(["b", "a"]);
  });
});

describe("grouping", () => {
  const sessions = [
    session("quiet-api", { busy: false, activity: at(5_000), cwdLabel: "api" }),
    session("busy-web", { busy: true, activity: at(1_000), cwdLabel: "ignored-cwd", workspace: {
      id: "w1", path: "/p/web", project: "web", branch: "main", comment: null, status: null, unread: false, pr: null,
    } }),
    session("recent-web", { busy: false, activity: at(9_000), cwdLabel: "web" }),
    session("loose", { busy: false, activity: at(7_000) }),
  ];

  test("groups by workspace project, else cwd label, ordered by each group's best row", () => {
    const groups = groupWorkingSessions(sessions, "project");
    expect(groups.map(group => [group.label, group.sessions.map(item => item.instanceId)])).toEqual([
      ["web", ["busy-web", "recent-web"]],
      ["No project", ["loose"]],
      ["api", ["quiet-api"]],
    ]);
  });

  test("groups by machine, with the gateway's own sessions under one local group", () => {
    const fleet = [
      session("mac-idle", { busy: false, host: "mac", activity: at(9_000) }),
      session("vps-busy", { busy: true, host: "vps", activity: at(1_000) }),
      session("local", { busy: false, activity: at(5_000) }),
    ];
    expect(groupWorkingSessions(fleet, "host").map(group => [group.key, group.label])).toEqual([
      ["vps", "vps"], ["mac", "mac"], ["", "This machine"],
    ]);
  });
});

describe("activity facts", () => {
  const rich = at(1_000, {
    tool: "bash", intent: "Running tests", preview: "All green", contextTokens: 50_000, contextWindow: 200_000, cost: 0.5, subagents: 3,
  });

  test("tool and intent show only while busy on a live machine; the preview always shows", () => {
    expect(activityFacts(session("a", { busy: true, activity: rich }))).toMatchObject({ tool: "bash", intent: "Running tests", preview: "All green" });
    for (const busy of [false, undefined]) {
      const facts = activityFacts(session("a", { ...(busy === undefined ? {} : { busy }), activity: rich }));
      expect(facts).not.toHaveProperty("tool");
      expect(facts).not.toHaveProperty("intent");
      expect(facts.preview).toBe("All green");
    }
  });

  test("a gauge needs a known positive window; otherwise tokens are counted, and nothing is invented", () => {
    expect(activityFacts(session("a", { activity: rich })).gauge).toEqual({ tokens: 50_000, window: 200_000, ratio: 0.25 });
    expect(activityFacts(session("a", { activity: { ...rich, contextTokens: 300_000 } })).gauge?.ratio).toBe(1);
    for (const contextWindow of [null, 0]) {
      const facts = activityFacts(session("a", { activity: { ...rich, contextWindow } }));
      expect(facts).not.toHaveProperty("gauge");
      expect(facts.tokens).toBe(50_000);
    }
    const unknown = activityFacts(session("a", { activity: NO_ACTIVITY }));
    for (const key of ["gauge", "tokens", "cost", "subagents", "preview", "tool"]) expect(unknown).not.toHaveProperty(key);
    const zero = activityFacts(session("a", { activity: { ...NO_ACTIVITY, cost: 0, subagents: 0 } }));
    expect(zero).toMatchObject({ cost: 0, subagents: 0 });
  });

  test("a stale or unavailable machine marks facts as last known and hides the live tool", () => {
    const stale = activityFacts(session("f".repeat(64), {
      busy: true, activity: rich, host: "mac", originalInstanceId: "n", hostStatus: "stale", available: false, canControl: false, canView: false,
    }));
    expect(stale.stale).toBeTrue();
    expect(stale).not.toHaveProperty("tool");
    expect(stale.preview).toBe("All green");
    expect(activityFacts(session("a", { activity: rich })).stale).toBeFalse();
  });

  test("formats cumulative cost without hiding a sub-cent total", () => {
    expect([0, 0.0042, 0.123, 1.5, 1234.567].map(formatCost)).toEqual(["$0", "$0.0042", "$0.123", "$1.5", "$1,234.57"]);
  });
});

describe("pull request links", () => {
  test.each([
    "https://github.com/flosrn/repo/pull/12",
    "https://www.github.com/flosrn/repo.js/pull/1/",
  ])("accepts %s", url => {
    expect(safeGithubPullUrl(url)).toBe(url);
  });

  test.each([
    "http://github.com/o/r/pull/1",
    "javascript:alert(1)//github.com/o/r/pull/1",
    "https://github.com.evil.example/o/r/pull/1",
    "https://evil.example/github.com/o/r/pull/1",
    "https://user:pass@github.com/o/r/pull/1",
    "https://github.com:8443/o/r/pull/1",
    "https://github.com/o/r/pull/1?redirect=https://evil.example",
    "https://github.com/o/r/pull/1#x",
    "https://github.com/o/r/issues/1",
    "https://github.com/o/r/pull/0",
    "https://gist.github.com/o/r/pull/1",
    "not a url",
    "",
  ])("refuses %s", url => {
    expect(safeGithubPullUrl(url)).toBeUndefined();
  });

  test("only a safe URL becomes a fact", () => {
    const workspace = { id: "w", path: "/secret/path", project: "p", branch: null, comment: null, status: null, unread: false };
    expect(activityFacts(session("a", { workspace: { ...workspace, pr: "https://github.com/o/r/pull/7" } })).pullRequest)
      .toBe("https://github.com/o/r/pull/7");
    expect(activityFacts(session("a", { workspace: { ...workspace, pr: "javascript:alert(1)" } }))).not.toHaveProperty("pullRequest");
  });
});

// A minimal DOM: enough element behaviour for the renderer, no layout.
class FakeElement {
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  className = "";
  hidden = false;
  type = "";
  href = "";
  target = "";
  rel = "";
  referrerPolicy = "";
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  #text = "";

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.#text + this.children.map(child => child.textContent).join("");
  }
  set textContent(value: string) {
    this.#text = value;
    this.children.length = 0;
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get nextElementSibling(): FakeElement | null {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  after(node: FakeElement): void {
    const parent = this.parentElement!;
    node.remove();
    node.parentElement = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
  }
  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    this.append(...nodes);
  }
  remove(): void {
    if (this.parentElement === null) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener();
  }
  matches(selector: string): boolean {
    return selector.split(",").map(part => part.trim()).some(part =>
      part.startsWith(".") ? this.className.split(/\s+/u).includes(part.slice(1)) : this.tagName === part,
    );
  }
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (element: FakeElement): void => {
      for (const child of element.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

const fakeDocument = { createElement: (tagName: string) => new FakeElement(tagName) } as unknown as Document;

function memoryStorage(initial: Record<string, string> = {}): DirectoryStorage & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    getItem: key => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

/** Mirrors the app's native row: a frame holding the action button (with `.working-copy`) and Hide. */
function nativeRow(item: SessionMetadata): HTMLElement {
  const frame = new FakeElement("div");
  frame.className = "working-row-frame";
  const button = new FakeElement("button");
  button.className = "working-row";
  const copy = new FakeElement("span");
  copy.className = "working-copy";
  const title = new FakeElement("span");
  title.className = "row-title";
  title.textContent = item.title ?? "";
  copy.append(title);
  button.append(copy);
  const hide = new FakeElement("button");
  hide.className = "dismiss-session";
  hide.textContent = "Hide";
  frame.append(button, hide);
  return frame as unknown as HTMLElement;
}

describe("directory rendering", () => {
  const secretId = "secret-instance-0001";
  const items = [
    session(secretId, {
      title: "Parser work",
      busy: true,
      activity: at(5_000, { tool: "edit", intent: "Fixing", preview: "Done soon", contextTokens: 10, contextWindow: 100, cost: 0.25, subagents: 1 }),
      workspace: {
        id: "workspace-secret-id", path: "/workspace/operator/secret-path", project: "gateway", branch: "feat/x", comment: "note",
        status: "review", unread: true, pr: "https://github.com/o/r/pull/9",
      },
    }),
    session("other-instance-0002", { title: "Other", cwdLabel: "docs", busy: false }),
  ];

  test("renders groups of native rows with facts inside them and the PR link beside the action", () => {
    const storage = memoryStorage();
    const directory = createActivityDirectory({ renderRow: nativeRow, storage, document: fakeDocument });
    directory.render(items);
    const root = directory.element as unknown as FakeElement;
    expect(root.querySelectorAll(".activity-group-label").map(label => label.textContent)).toEqual(["gateway", "docs"]);
    const frame = root.querySelector(".working-row-frame")!;
    expect(frame.children.map(child => child.className)).toEqual(["working-row", "activity-pr", "dismiss-session"]);
    expect(frame.querySelector(".working-copy")!.querySelector(".activity-facts")).not.toBeNull();
    expect(frame.querySelector(".activity-tool")?.textContent).toBe("edit");
    expect(frame.querySelector(".activity-unread")?.textContent).toBe("Unread");
    expect(frame.querySelector(".activity-gauge")?.style.width).toBeUndefined();
    expect(frame.querySelector(".activity-gauge-fill")?.style.width).toBe("10.0%");
    expect((frame.querySelector(".activity-pr") as FakeElement).href).toBe("https://github.com/o/r/pull/9");
    const visible = root.textContent;
    for (const hidden of [secretId, "workspace-secret-id", "/workspace/operator/secret-path"]) expect(visible).not.toContain(hidden);
  });

  test("re-decorating a row replaces its facts instead of duplicating them", () => {
    const directory = createActivityDirectory({ renderRow: nativeRow, storage: memoryStorage(), document: fakeDocument });
    directory.render(items);
    directory.render(items);
    const root = directory.element as unknown as FakeElement;
    expect(root.querySelectorAll(".activity-facts")).toHaveLength(1);
    expect(root.querySelectorAll(".activity-pr")).toHaveLength(1);
  });

  test("the grouping picker and collapsed groups persist as cosmetic preferences only", () => {
    const storage = memoryStorage();
    const directory = createActivityDirectory({ renderRow: nativeRow, storage, document: fakeDocument });
    directory.render(items);
    const root = directory.element as unknown as FakeElement;
    root.querySelectorAll(".activity-group-toggle")[0]!.click();
    expect(root.querySelectorAll(".activity-group")[0]!.dataset.collapsed).toBe("true");
    expect(JSON.parse(storage.values[DIRECTORY_COLLAPSED_STORAGE_KEY]!)).toEqual(["project:gateway"]);

    root.querySelectorAll(".activity-group-option").find(option => option.dataset.grouping === "host")!.click();
    expect(storage.values[DIRECTORY_GROUPING_STORAGE_KEY]).toBe("host");
    expect(root.dataset.grouping).toBe("host");
    expect(root.querySelectorAll(".activity-group-label").map(label => label.textContent)).toEqual(["This machine"]);

    const reopened = createActivityDirectory({ renderRow: nativeRow, storage, document: fakeDocument });
    reopened.render(items);
    expect((reopened.element as unknown as FakeElement).dataset.grouping).toBe("host");
    for (const value of Object.values(storage.values)) expect(value).not.toContain(secretId);
  });

  test("an empty working list hides the directory, and broken storage falls back to defaults", () => {
    const throwing: DirectoryStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("full"); },
    };
    const directory = createActivityDirectory({ renderRow: nativeRow, storage: throwing, document: fakeDocument });
    directory.render([]);
    expect((directory.element as unknown as FakeElement).hidden).toBeTrue();
    directory.render(items);
    const root = directory.element as unknown as FakeElement;
    expect(root.dataset.grouping).toBe("project");
    expect(() => root.querySelectorAll(".activity-group-toggle")[0]!.click()).not.toThrow();
  });
});

describe("facts placement outside the working row", () => {
  const withPr = session("queue-instance-0001", {
    title: "Asking",
    activity: at(1_000, { preview: "Which option?" }),
    workspace: { id: "w", path: "/p", project: "proj", branch: null, comment: null, status: null, unread: false, pr: "https://github.com/o/r/pull/3" },
  });
  const el = (tagName: string, className: string, ...children: FakeElement[]): FakeElement => {
    const element = new FakeElement(tagName);
    element.className = className;
    element.append(...children);
    return element;
  };
  const place = (row: FakeElement, placement: { factsRoot?: FakeElement; actionRoot?: FakeElement } = {}): void => {
    appendActivityFacts(row as unknown as HTMLElement, withPr, fakeDocument, placement as unknown as {
      factsRoot?: HTMLElement; actionRoot?: HTMLElement;
    });
  };

  test("a queue row frame gets facts in its copy span and the PR beside, never inside, its button", () => {
    const copy = el("span", "queue-copy");
    const button = el("button", "queue-row", copy);
    const frame = el("div", "queue-row-frame", button);
    place(frame, { factsRoot: copy, actionRoot: button });
    place(frame, { factsRoot: copy, actionRoot: button });
    expect(frame.children.map(child => child.className)).toEqual(["queue-row", "activity-pr"]);
    expect(copy.querySelectorAll(".activity-facts")).toHaveLength(1);
    expect(button.querySelector(".activity-pr")).toBeNull();
  });

  test("the hero article takes facts and link at its end when decorated before its actions", () => {
    const hero = el("article", "queue-hero", el("h2", "row-title"));
    place(hero);
    hero.append(el("button", "action action-request"));
    expect(hero.children.map(child => child.className)).toEqual(["row-title", "activity-facts", "activity-pr", "action action-request"]);
    place(hero);
    expect(hero.querySelectorAll(".activity-facts")).toHaveLength(1);
    expect(hero.querySelectorAll(".activity-pr")).toHaveLength(1);
  });

  test("a bare button row never nests the link: it follows the button, or is left out when detached", () => {
    const list = el("section", "session-list");
    const button = el("button", "queue-row");
    list.append(button);
    place(button);
    expect(list.children.map(child => child.className)).toEqual(["queue-row", "activity-pr"]);
    expect(button.querySelector(".activity-pr")).toBeNull();
    const detached = el("button", "queue-row");
    place(detached);
    expect(detached.querySelector(".activity-pr")).toBeNull();
    expect(detached.querySelector(".activity-facts")).not.toBeNull();
  });

  test("redecorating removes only what it placed", () => {
    const foreignFacts = el("span", "activity-facts");
    const nested = el("span", "nested", el("span", "activity-facts"));
    const copy = el("span", "queue-copy", nested);
    const button = el("button", "queue-row", copy);
    const foreignLink = el("a", "activity-pr");
    const frame = el("div", "queue-row-frame", button, el("button", "dismiss-session"), foreignLink);
    const held = el("div", "held-copy", foreignFacts);
    place(frame, { factsRoot: copy, actionRoot: button });
    place(frame, { factsRoot: copy, actionRoot: button });
    expect(frame.children.map(child => child.className)).toEqual(["queue-row", "activity-pr", "dismiss-session", "activity-pr"]);
    expect(frame.children[3]).toBe(foreignLink);
    expect(nested.querySelectorAll(".activity-facts")).toHaveLength(1);
    expect(held.children).toEqual([foreignFacts]);
  });
});
