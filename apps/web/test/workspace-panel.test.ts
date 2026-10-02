import { describe, expect, test } from "bun:test";
import type { WorkspaceRequest } from "../../gateway/src/workspace.ts";
import { createWorkspaceController, createWorkspacePanel, type WorkspaceControllerOptions } from "../src/workspace-panel.ts";

const TERMINAL = {
  handle: "term-1",
  title: "omp",
  worktreeId: "wt-1",
  path: "/code/app",
  connected: true,
  writable: true,
  lastOutputAt: null,
  preview: "ready",
  agentType: "omp",
};
const WORKSPACE = {
  id: "wt-1",
  path: "/code/app",
  project: "app",
  branch: "feat/x",
  comment: null,
  status: null,
  unread: false,
  pr: null,
  host: "mac",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function inventory(terminal = TERMINAL, host = "mac") {
  return { projects: [{ id: "p1", name: "app", path: "/code/app" }], workspaces: [{ ...WORKSPACE, host }], terminals: [terminal], models: [] };
}

type Responder = (request: WorkspaceRequest, signal?: AbortSignal) => Promise<Response> | Response;

function harness(respond: Responder, hosts: string[] = ["mac"], extra: Partial<WorkspaceControllerOptions> = {}) {
  const calls: WorkspaceRequest[] = [];
  let counter = 0;
  const controller = createWorkspaceController({
    hosts: () => hosts,
    randomUUID: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    request: async (body, signal) => {
      calls.push(body);
      return respond(body, signal);
    },
    ...extra,
  });
  return { controller, calls, hosts };
}

/** Answers inventory reads with `data`; everything else goes to `write`. */
function withInventory(write: Responder, terminal = TERMINAL): Responder {
  return (request, signal) =>
    request.operation === "inventory" ? json(200, { requestId: request.requestId, ok: true, data: inventory(terminal) }) : write(request, signal);
}

describe("workspace writes", () => {
  test("a definitive error is shown as refused, never as done", async () => {
    const { controller } = harness(withInventory((request) => json(409, { requestId: request.requestId, ok: false, error: "conflict" })));
    await controller.loadInventory();
    controller.selectWorkspace("wt-1");
    expect(await controller.setWorkspace({ status: "review" })).toBeNull();
    const record = controller.getState().writes.workspace;
    expect(record?.state).toBe("failed");
    expect(record?.message).toContain("conflict");
  });

  test("a 200 with updated:false is not-done", async () => {
    const { controller } = harness(withInventory((request) => json(200, { requestId: request.requestId, ok: true, data: { updated: false } })));
    await controller.loadInventory();
    controller.selectWorkspace("wt-1");
    await controller.setWorkspace({ comment: "x" });
    expect(controller.getState().writes.workspace?.state).toBe("not-done");
  });

  test("a write is pending until its receipt, then uncertain when the reply is lost", async () => {
    const receipt = Promise.withResolvers<Response>();
    const { controller, calls } = harness(withInventory(() => receipt.promise));
    await controller.loadInventory();
    controller.selectTerminal("term-1");
    const sending = controller.send("continue");
    expect(controller.getState().writes.send?.state).toBe("pending");
    // A second submit while waiting is refused locally, never sent.
    expect(await controller.send("continue")).toBe("busy");
    receipt.reject(new TypeError("network"));
    await sending;
    expect(controller.getState().writes.send?.state).toBe("uncertain");
    expect(calls.filter((call) => call.operation === "send")).toHaveLength(1);
  });

  test("a 504 or unreadable receipt is uncertain; retry resends the identical body and id", async () => {
    let attempt = 0;
    const { controller, calls } = harness(
      withInventory((request) =>
        ++attempt === 1
          ? json(504, { requestId: request.requestId, ok: false, error: "outcome-unknown" })
          : json(200, { requestId: request.requestId, ok: true, data: { accepted: true, requestId: "orca-1", stage: "queued" } }),
      ),
    );
    await controller.loadInventory();
    controller.selectTerminal("term-1");
    await controller.send("continue");
    expect(controller.getState().writes.send?.state).toBe("uncertain");
    await controller.retry("send");
    const sends = calls.filter((call) => call.operation === "send");
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
    expect(controller.getState().writes.send?.state).toBe("accepted");
  });

  test("after doubt, the same text reuses the request id and different text is refused until cleared", async () => {
    const { controller, calls } = harness(withInventory(() => json(503, { ok: false, error: "unavailable" })));
    await controller.loadInventory();
    controller.selectTerminal("term-1");
    await controller.send("continue");
    await controller.send("continue");
    expect(await controller.send("stop")).toBe("uncertain");
    let ids = calls.filter((call) => call.operation === "send").map((call) => call.requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    // A plain dismiss keeps the doubt; only an acknowledged clear lets a fresh request go.
    controller.dismiss("send");
    expect(await controller.send("stop")).toBe("uncertain");
    controller.dismiss("send", true);
    expect(await controller.send("stop")).toBeNull();
    ids = calls.filter((call) => call.operation === "send").map((call) => call.requestId);
    expect(ids).toHaveLength(3);
    expect(ids[2]).not.toBe(ids[0]);
  });

  test("a lost create cannot be followed by a fresh create, only by its identical retry", async () => {
    let lose = true;
    const { controller, calls } = harness(
      withInventory((request) =>
        lose ? Promise.reject(new TypeError("network")) : json(200, { requestId: request.requestId, ok: true, data: { worktreeId: "wt-2", accepted: true } }),
      ),
    );
    await controller.loadInventory();
    const input = { projectId: "p1", name: "feature", agent: "omp", prompt: "go" };
    await controller.create(input);
    expect(controller.getState().writes.create?.state).toBe("uncertain");
    expect(await controller.create(input)).toBe("uncertain");
    lose = false;
    expect(await controller.retry("create")).toBeNull();
    const creates = calls.filter((call) => call.operation === "create");
    expect(creates).toHaveLength(2);
    expect(creates[1]).toEqual(creates[0]);
    expect(controller.getState().writes.create?.state).toBe("accepted");
  });

  for (const [status, error] of [
    [429, "rate-limited"],
    [404, "not-found"],
  ] as const) {
    test(`a retry refused with ${status} keeps the first lost create uncertain`, async () => {
      let attempt = 0;
      const { controller, calls } = harness(
        withInventory((request) =>
          ++attempt === 1 ? Promise.reject(new TypeError("network")) : json(status, { requestId: request.requestId, ok: false, error }),
        ),
      );
      await controller.loadInventory();
      const input = { projectId: "p1", name: "feature", agent: "omp", prompt: "go" };
      await controller.create(input);
      await controller.retry("create");
      // The refusal is about the retry; the first attempt may still have run.
      expect(controller.getState().writes.create?.state).toBe("uncertain");
      expect(await controller.create(input)).toBe("uncertain");
      await controller.retry("create");
      const creates = calls.filter((call) => call.operation === "create");
      expect(creates).toHaveLength(3);
      expect(new Set(creates.map((call) => call.requestId)).size).toBe(1);
    });
  }

  test("a retry refused with 429 keeps a lost send uncertain and blocks new text", async () => {
    let attempt = 0;
    const { controller, calls } = harness(
      withInventory((request) =>
        ++attempt === 1 ? Promise.reject(new TypeError("network")) : json(429, { requestId: request.requestId, ok: false, error: "rate-limited" }),
      ),
    );
    await controller.loadInventory();
    controller.selectTerminal("term-1");
    await controller.send("continue");
    await controller.retry("send");
    expect(controller.getState().writes.send?.state).toBe("uncertain");
    expect(await controller.send("stop")).toBe("uncertain");
    const sends = calls.filter((call) => call.operation === "send");
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
  });

  test("a lost resume cannot be followed by a fresh resume", async () => {
    const { controller, calls } = harness((request) =>
      request.operation === "transcript"
        ? json(200, { requestId: request.requestId, ok: true, data: { title: "Fix", entries: [] } })
        : json(504, { requestId: request.requestId, ok: false, error: "outcome-unknown" }),
    );
    await controller.openTranscript({ host: "mac", sessionId: "s-1", agent: "omp", path: "/code/app", title: "Fix", origin: "history" });
    await controller.resume();
    expect(controller.getState().writes.resume?.state).toBe("uncertain");
    expect(await controller.resume()).toBe("uncertain");
    expect(calls.filter((call) => call.operation === "resume")).toHaveLength(1);
  });

  test("close needs an explicit confirmation of the selected workspace", async () => {
    const { controller, calls } = harness(withInventory((request) => json(200, { requestId: request.requestId, ok: true, data: { closed: true } })));
    await controller.loadInventory();
    controller.selectWorkspace("wt-1");
    expect(await controller.confirmClose()).toBe("not-confirmed");
    controller.requestClose();
    controller.cancelClose();
    expect(await controller.confirmClose()).toBe("not-confirmed");
    expect(calls.some((call) => call.operation === "close")).toBe(false);
    controller.requestClose();
    expect(controller.getState().confirmClose).toBe("wt-1");
    expect(await controller.confirmClose()).toBeNull();
    expect(calls.filter((call) => call.operation === "close")).toEqual([
      expect.objectContaining({ host: "mac", args: { worktreeId: "wt-1" } }),
    ]);
    expect(controller.getState().writes.workspace?.state).toBe("done");
  });

  test("a host outside the authorized fleet is never contacted", async () => {
    const { controller, calls, hosts } = harness(withInventory(() => json(200, {})));
    await controller.loadInventory();
    controller.selectTerminal("term-1");
    hosts.splice(0, hosts.length, "vps");
    // Not yet reported through hostsChanged: the live fleet check still refuses the old host.
    expect(await controller.send("continue")).toBe("unknown-host");
    controller.hostsChanged();
    expect(controller.getState().host).toBe("vps");
    expect(controller.getState().inventory.data).toBeNull();
    expect(calls.every((call) => call.host === "mac" && call.operation === "inventory")).toBe(true);
  });

  test("a read-only or disconnected terminal is gated before any request", async () => {
    const { controller, calls } = harness(withInventory(() => json(200, {}), { ...TERMINAL, writable: false }));
    await controller.loadInventory();
    controller.selectTerminal("term-1");
    expect(await controller.send("continue")).toBe("read-only");
    expect(calls.some((call) => call.operation === "send")).toBe(false);
  });

  test("revocation drops fetched data and refuses writes", async () => {
    const { controller, calls } = harness(withInventory(() => json(200, {})));
    await controller.loadInventory();
    controller.selectWorkspace("wt-1");
    controller.setAuthorized(false);
    expect(controller.getState().inventory.data).toBeNull();
    expect(await controller.sleepWorkspace()).toBe("unauthorized");
    expect(await controller.create({ projectId: "p1", name: "x", agent: "omp", prompt: "go" })).toBe("unauthorized");
    expect(calls.every((call) => call.operation === "inventory")).toBe(true);
  });

  test("offline refuses a write without sending it", async () => {
    const { controller, calls } = harness(withInventory(() => json(200, {})));
    await controller.loadInventory();
    controller.selectTerminal("term-1");
    controller.setOnline(false);
    expect(await controller.send("continue")).toBe("offline");
    expect(calls.some((call) => call.operation === "send")).toBe(false);
  });

  test("create accepted without a terminal is accepted, with one is started", async () => {
    let handle: string | undefined;
    const { controller } = harness(
      withInventory((request) =>
        json(200, {
          requestId: request.requestId,
          ok: true,
          data: handle === undefined ? { worktreeId: "wt-2", accepted: true } : { worktreeId: "wt-2", accepted: true, terminalHandle: handle },
        }),
      ),
    );
    await controller.loadInventory();
    await controller.create({ projectId: "p1", name: "feature", agent: "omp", prompt: "go" });
    expect(controller.getState().writes.create?.state).toBe("accepted");
    handle = "term-9";
    controller.dismiss("create");
    await controller.create({ projectId: "p1", name: "feature", agent: "omp", prompt: "go" });
    expect(controller.getState().writes.create?.state).toBe("started");
  });
});

describe("workspace reads", () => {
  test("a late inventory for a previous host is discarded", async () => {
    const pending = new Map<string, [WorkspaceRequest, (response: Response) => void]>();
    const { controller } = harness((request) => {
      const { promise, resolve } = Promise.withResolvers<Response>();
      pending.set(request.host, [request, resolve]);
      return promise;
    }, ["mac", "vps"]);
    const answer = (host: string): void => {
      const [request, resolve] = pending.get(host) ?? [];
      if (request === undefined || resolve === undefined) throw new Error(`no request for ${host}`);
      resolve(json(200, { requestId: request.requestId, ok: true, data: inventory(TERMINAL, host) }));
    };
    const first = controller.loadInventory();
    controller.selectHost("vps");
    // Supersedes the read selectHost started, so the test can await the one that lands.
    const second = controller.loadInventory();
    answer("vps");
    answer("mac");
    await Promise.all([first, second]);
    expect(controller.getState().host).toBe("vps");
    expect(controller.getState().inventory.data?.workspaces[0]?.host).toBe("vps");
  });

  test("a failed refresh keeps the previous data, marked stale", async () => {
    let fail = false;
    const { controller } = harness((request) =>
      fail ? Promise.reject(new TypeError("offline")) : json(200, { requestId: request.requestId, ok: true, data: inventory() }),
    );
    await controller.loadInventory();
    fail = true;
    await controller.loadInventory();
    const slot = controller.getState().inventory;
    expect(slot.status).toBe("error");
    expect(slot.data?.workspaces).toHaveLength(1);
  });

  test("search fans out one request per selected host and reports a disabled index", async () => {
    const { controller, calls } = harness(
      (request) =>
        json(200, {
          requestId: request.requestId,
          ok: true,
          data: request.host === "mac" ? { enabled: false, hits: [] } : { enabled: true, hits: [] },
        }),
      ["mac", "vps", "pi"],
    );
    await controller.search("bug", ["mac", "vps"]);
    expect(calls.map((call) => call.host).sort()).toEqual(["mac", "vps"]);
    expect(controller.getState().search.mac?.enabled).toBe(false);
    expect(controller.getState().search.vps?.enabled).toBe(true);
  });

  test("history loads without a query and transcripts use the registered session id", async () => {
    const session = { sessionId: "s-1", agent: "omp", path: "/code/app", title: "Fix", lastActivityAt: 1, preview: null, host: "mac" };
    const { controller, calls } = harness((request) =>
      request.operation === "history"
        ? json(200, { requestId: request.requestId, ok: true, data: { sessions: [session] } })
        : json(200, { requestId: request.requestId, ok: true, data: { title: "Fix", entries: [{ role: "user", text: "<img src=x>" }] } }),
    );
    await controller.loadHistory();
    expect(calls[0]?.args).toEqual({});
    await controller.openTranscript({ host: "mac", sessionId: "s-1", agent: "omp", path: "/code/app", title: "Fix", origin: "history" });
    // The row path travels only as the index filter; a relative one is never sent.
    expect(calls[1]?.args).toEqual({ sessionId: "s-1", agent: "omp", path: "/code/app" });
    await controller.openTranscript({ host: "mac", sessionId: "s-1", agent: "omp", path: "code/app", title: "Fix", origin: "history" });
    expect(calls[2]?.args).toEqual({ sessionId: "s-1", agent: "omp" });
    expect(controller.getState().transcript?.entries[0]?.text).toBe("<img src=x>");
  });

  test("leaving history or search mid-read leaves no slot loading forever", async () => {
    const session = { sessionId: "s-1", agent: "omp", path: "/code/app", title: "Fix", lastActivityAt: 1, preview: null, host: "mac" };
    let hold = true;
    const { controller } = harness((request, signal) => {
      if (hold) {
        return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      return request.operation === "history"
        ? json(200, { requestId: request.requestId, ok: true, data: { sessions: [session], cursor: "c2" } })
        : json(200, { requestId: request.requestId, ok: true, data: { enabled: true, hits: [], cursor: "c2" } });
    });

    // Initial loads aborted by a tab switch return to idle and reload on return.
    controller.selectTab("history");
    expect(controller.getState().history.status).toBe("loading");
    controller.selectTab("search");
    expect(controller.getState().history.status).toBe("idle");
    const searching = controller.search("bug");
    expect(controller.getState().search.mac?.status).toBe("loading");
    controller.selectTab("history");
    await searching;
    expect(controller.getState().search.mac?.status).toBe("idle");

    // An aborted More keeps the loaded page and its cursor, so More can run again.
    hold = false;
    await controller.loadHistory();
    hold = true;
    const more = controller.historyMore();
    expect(controller.getState().history.status).toBe("loading");
    controller.selectTab("search");
    await more;
    expect(controller.getState().history.status).toBe("ready");
    expect(controller.getState().history.data?.cursor).toBe("c2");
    hold = false;
    controller.selectTab("history");
    await controller.historyMore();
    expect(controller.getState().history.data?.sessions).toHaveLength(2);
  });
});

describe("workspace write receipts across authorization", () => {
  test("a refusal before relay is definitive; Access loss after relay stays uncertain", async () => {
    let lost = 0;
    let postRelay = false;
    const { controller } = harness(
      withInventory((request) =>
        postRelay
          ? new Response(JSON.stringify({ code: "authentication_required", message: "Sign in again" }), {
              status: 401,
              headers: { "Content-Type": "application/problem+json" },
            })
          : json(401, { ok: false, error: "unauthorized" }),
      ),
      ["mac"],
      { onAuthorizationLost: () => (lost += 1) },
    );
    await controller.loadInventory();
    controller.selectTerminal("term-1");
    expect(await controller.send("continue")).toBeNull();
    expect(controller.getState().writes.send?.state).toBe("failed");
    expect(lost).toBe(1);
    controller.dismiss("send");
    postRelay = true;
    expect(await controller.send("continue")).toBeNull();
    expect(controller.getState().writes.send?.state).toBe("uncertain");
    expect(lost).toBe(2);
  });

  test("only a 503 marked not-run is definitive, and it never settles an earlier doubt", async () => {
    let marked = true;
    const { controller, calls } = harness(
      withInventory(() =>
        new Response(JSON.stringify({ ok: false, error: "unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json", ...(marked ? { "X-OMP-Workspace-Outcome": "not-run" } : {}) },
        }),
      ),
    );
    await controller.loadInventory();
    controller.selectTerminal("term-1");
    expect(await controller.send("continue")).toBeNull();
    expect(controller.getState().writes.send?.state).toBe("failed");
    controller.dismiss("send");

    marked = false;
    expect(await controller.send("continue")).toBeNull();
    expect(controller.getState().writes.send?.state).toBe("uncertain");

    marked = true;
    expect(await controller.retry("send")).toBeNull();
    expect(controller.getState().writes.send?.state).toBe("uncertain");
    const sends = calls.filter((call) => call.operation === "send");
    expect(sends[2]?.requestId).toBe(sends[1]?.requestId);
  });
});

describe("workspace launchers", () => {
  function fakeDocument(): Document {
    const node = (): Record<string, unknown> =>
      new Proxy(
        {
          open: false,
          value: "",
          hidden: false,
          disabled: false,
          childElementCount: 0,
          dataset: {},
          style: {},
          classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        } as Record<string, unknown>,
        { get: (target, key) => (key in target || typeof key !== "string" ? target[key as string] : () => undefined) },
      );
    return { createElement: node, createElementNS: node, defaultView: null } as unknown as Document;
  }

  test("launchers are hidden until the fleet lists a machine, and disabled without authorization", () => {
    const hosts: string[] = [];
    const panel = createWorkspacePanel({
      hosts: () => hosts,
      request: async () => json(503, { ok: false, error: "unavailable" }),
      document: fakeDocument(),
    });
    const extra = panel.createLauncher();
    expect(panel.launcher.hidden).toBe(true);
    hosts.push("mac");
    panel.hostsChanged();
    expect(panel.launcher.hidden).toBe(false);
    expect(extra.hidden).toBe(false);
    expect(panel.launcher.disabled).toBe(false);
    panel.setAuthorized(false);
    expect(panel.launcher.hidden).toBe(false);
    expect(panel.launcher.disabled).toBe(true);
    hosts.splice(0);
    panel.hostsChanged();
    expect(extra.hidden).toBe(true);
    panel.dispose();
  });
});
