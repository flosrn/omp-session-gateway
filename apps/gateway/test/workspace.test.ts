import { describe, expect, test } from "bun:test";
import {
  OUTCOME_UNKNOWN,
  createWorkspaceApi,
  parseWorkspaceRequest,
  parseWorkspaceResponse,
  type WorkspaceBridge,
  type WorkspaceRequest,
} from "../src/workspace.ts";

const REQUEST_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function bridge(reply: (request: WorkspaceRequest) => { status: number; body: unknown } | Error): WorkspaceBridge & { calls: WorkspaceRequest[] } {
  const calls: WorkspaceRequest[] = [];
  return {
    calls,
    async workspace(request) {
      calls.push(request);
      const outcome = reply(request);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const ok = (data: unknown) => ({ status: 200, body: { requestId: REQUEST_ID, ok: true, data } });

describe("workspace request validation", () => {
  test("accepts each operation's exact shape and refuses extra or missing keys", () => {
    expect(parseWorkspaceRequest({ requestId: REQUEST_ID, host: "mac", operation: "inventory", args: {} }).operation).toBe("inventory");
    expect(() => parseWorkspaceRequest({ requestId: REQUEST_ID, host: "mac", operation: "inventory", args: { cwd: "/" } })).toThrow();
    expect(() => parseWorkspaceRequest({ requestId: REQUEST_ID, host: "mac", operation: "send", args: { handle: "t1" } })).toThrow();
    expect(() => parseWorkspaceRequest({ requestId: REQUEST_ID, host: "mac", operation: "exec", args: {} })).toThrow();
    expect(() => parseWorkspaceRequest({ requestId: "not-a-uuid", host: "mac", operation: "inventory", args: {} })).toThrow();
    expect(() => parseWorkspaceRequest({ requestId: REQUEST_ID, host: "../mac", operation: "inventory", args: {} })).toThrow();
    // A set with nothing to set is not a request.
    expect(() => parseWorkspaceRequest({ requestId: REQUEST_ID, host: "mac", operation: "set", args: { worktreeId: "w" } })).toThrow();
    // A transcript or resume still needs the registered session id; a path only narrows the index.
    const transcript = (args: Record<string, unknown>) =>
      parseWorkspaceRequest({ requestId: REQUEST_ID, host: "mac", operation: "transcript", args });
    expect(() => transcript({ path: "/code/app" })).toThrow();
    expect(transcript({ sessionId: "s", path: "/code/app" }).args).toEqual({ sessionId: "s", path: "/code/app" });
    expect(() => transcript({ sessionId: "s", path: "code/app" })).toThrow();
    expect(() => transcript({ sessionId: "s", path: "/code/\u202eapp" })).toThrow();
    expect(() => transcript({ sessionId: "s", path: `/${"a".repeat(512)}` })).toThrow();
    expect(() =>
      parseWorkspaceRequest({ requestId: REQUEST_ID, host: "mac", operation: "resume", args: { sessionId: "s", path: "/code/app" } }),
    ).toThrow();
  });

  test("refuses a send of only whitespace and a worktree name that could escape", () => {
    expect(() => parseWorkspaceRequest({ requestId: REQUEST_ID, host: "mac", operation: "send", args: { handle: "t1", text: "  \n" } })).toThrow();
    expect(() =>
      parseWorkspaceRequest({
        requestId: REQUEST_ID,
        host: "mac",
        operation: "create",
        args: { projectId: "p", name: "../x", agent: "omp", prompt: "go" },
      }),
    ).toThrow();
  });
});

describe("workspace response validation", () => {
  const request = { requestId: REQUEST_ID, host: "mac", operation: "history" as const };

  test("bounds a preview at 240 UTF-16 units, so 120 emoji fit and 121 do not", () => {
    const session = (preview: string) => ({
      requestId: REQUEST_ID,
      ok: true,
      data: { sessions: [{ sessionId: "s1", agent: "omp", path: "/p", title: "t", lastActivityAt: null, preview, host: "mac" }] },
    });
    expect(parseWorkspaceResponse(200, session("a".repeat(240)), request).ok).toBe(true);
    expect(() => parseWorkspaceResponse(200, session("a".repeat(241)), request)).toThrow();
    expect(parseWorkspaceResponse(200, session("😀".repeat(120)), request).ok).toBe(true);
    // 121 code points is within a code-point cap but 242 UTF-16 units: the wire bound is UTF-16.
    expect(() => parseWorkspaceResponse(200, session("😀".repeat(121)), request)).toThrow();
  });

  test("rejects data naming another host than the one asked", () => {
    const session = { sessionId: "s1", agent: "omp", path: "/p", title: "t", lastActivityAt: null, preview: null, host: "vps" };
    expect(() => parseWorkspaceResponse(200, { requestId: REQUEST_ID, ok: true, data: { sessions: [session] } }, request)).toThrow();
    expect(parseWorkspaceResponse(200, { requestId: REQUEST_ID, ok: true, data: { sessions: [{ ...session, host: "mac" }] } }, request).ok).toBe(true);
  });

  test("an error status never parses as success, and a 200 never as an error", () => {
    expect(() => parseWorkspaceResponse(409, { requestId: REQUEST_ID, ok: true, data: {} }, request)).toThrow();
    expect(() => parseWorkspaceResponse(200, { ok: false, error: "conflict" }, request)).toThrow();
    expect(() => parseWorkspaceResponse(502, { ok: false, error: "failed" }, request)).toThrow();
  });

  test("replaces an unsafe peer error string with the status classification", () => {
    const parsed = parseWorkspaceResponse(409, { ok: false, error: "Error: ENOENT /workspace/operator/.secret" }, request);
    expect(parsed).toEqual({ requestId: REQUEST_ID, ok: false, error: "conflict" });
  });
});

describe("workspace api", () => {
  test("a malformed body is 400 and never reaches the bridge", async () => {
    const fake = bridge(() => ok({}));
    const reply = await createWorkspaceApi({ bridge: fake }).handle({ requestId: REQUEST_ID, host: "mac", operation: "inventory" });
    expect(reply).toEqual({ status: 400, body: { requestId: REQUEST_ID, ok: false, error: "invalid-request" } });
    expect(fake.calls).toHaveLength(0);
  });

  test("a host outside the authorized fleet is 404 unknown-host without a bridge call", async () => {
    const fake = bridge(() => ok({ sleeping: true }));
    const api = createWorkspaceApi({ bridge: fake, isAuthorizedHost: (host) => host === "mac" });
    const reply = await api.handle({ requestId: REQUEST_ID, host: "vps", operation: "sleep", args: { worktreeId: "w" } });
    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({ requestId: REQUEST_ID, ok: false, error: "unknown-host" });
    expect(fake.calls).toHaveLength(0);
  });

  test("a lost write is outcome-unknown, a lost read is unavailable", async () => {
    const api = createWorkspaceApi({ bridge: bridge(() => new Error("socket closed")) });
    const write = await api.handle({ requestId: REQUEST_ID, host: "mac", operation: "close", args: { worktreeId: "w" } });
    expect(write).toEqual({ status: 504, body: { requestId: REQUEST_ID, ok: false, error: OUTCOME_UNKNOWN } });
    const read = await api.handle({ requestId: REQUEST_ID, host: "mac", operation: "inventory", args: {} });
    expect(read).toEqual({ status: 503, body: { requestId: REQUEST_ID, ok: false, error: "unavailable" } });
  });

  test("an unreadable success for a write is outcome-unknown, not success", async () => {
    const api = createWorkspaceApi({ bridge: bridge(() => ok({ closed: "yes" })) });
    const reply = await api.handle({ requestId: REQUEST_ID, host: "mac", operation: "close", args: { worktreeId: "w" } });
    expect(reply.status).toBe(504);
    expect(reply.body.ok).toBe(false);
  });

  test("a reply for another request id is refused", async () => {
    const api = createWorkspaceApi({
      bridge: bridge(() => ({ status: 200, body: { requestId: "11111111-1111-4111-8111-111111111111", ok: true, data: { updated: true } } })),
    });
    const reply = await api.handle({ requestId: REQUEST_ID, host: "mac", operation: "set", args: { worktreeId: "w", status: "review" } });
    expect(reply.status).toBe(504);
  });

  test("relays the validated request once and passes a definitive refusal through", async () => {
    const fake = bridge(() => ({ status: 409, body: { requestId: REQUEST_ID, ok: false, error: "terminal-read-only" } }));
    const reply = await createWorkspaceApi({ bridge: fake }).handle({
      requestId: REQUEST_ID,
      host: "mac",
      operation: "send",
      args: { handle: "term-1", text: "continue" },
    });
    expect(fake.calls).toEqual([{ requestId: REQUEST_ID, host: "mac", operation: "send", args: { handle: "term-1", text: "continue" } }]);
    expect(reply).toEqual({ status: 409, body: { requestId: REQUEST_ID, ok: false, error: "terminal-read-only" } });
  });

  test("a HarnessOS 401 or 403 is not an Access status, and its code is unchanged", async () => {
    const cases = [
      { operation: "inventory", args: {}, upstream: 401, error: "token-refused", status: 503 },
      { operation: "send", args: { handle: "term-1", text: "continue" }, upstream: 401, error: "token-refused", status: 503 },
      { operation: "close", args: { worktreeId: "w" }, upstream: 403, error: "forbidden", status: 409 },
      { operation: "inventory", args: {}, upstream: 401, error: "service-refused", status: 503 },
    ] as const;
    for (const item of cases) {
      const fake = bridge(() => ({ status: item.upstream, body: { requestId: REQUEST_ID, ok: false, error: item.error } }));
      const reply = await createWorkspaceApi({ bridge: fake }).handle({
        requestId: REQUEST_ID,
        host: "mac",
        operation: item.operation,
        args: item.args,
      });
      expect(fake.calls).toHaveLength(1);
      expect(reply).toEqual({ status: item.status, body: { requestId: REQUEST_ID, ok: false, error: item.error } });
      expect(reply.status === 401 || reply.status === 403).toBe(false);
      // The browser parser accepts the remapped pair; it does not bind a status to one code.
      const parsed = parseWorkspaceResponse(item.status, { requestId: REQUEST_ID, ok: false, error: item.error }, {
        requestId: REQUEST_ID,
        host: "mac",
        operation: item.operation,
      });
      if (parsed.ok) throw new Error("expected a refusal");
      expect(parsed.error).toBe(item.error);
    }
    const unsafe = bridge(() => ({ status: 401, body: { requestId: REQUEST_ID, ok: false, error: "Error: /workspace/operator/.secret" } }));
    const classified = await createWorkspaceApi({ bridge: unsafe }).handle({ requestId: REQUEST_ID, host: "mac", operation: "inventory", args: {} });
    expect(unsafe.calls).toHaveLength(1);
    expect(classified).toEqual({ status: 503, body: { requestId: REQUEST_ID, ok: false, error: "unauthorized" } });
    expect(JSON.stringify(classified)).not.toContain(".secret");
  });

  test("a disconnected terminal is never reported writable", async () => {
    const terminal = {
      handle: "t1",
      title: "omp",
      worktreeId: null,
      path: null,
      connected: false,
      writable: true,
      lastOutputAt: null,
      preview: null,
      agentType: null,
    };
    const api = createWorkspaceApi({ bridge: bridge(() => ok({ projects: [], workspaces: [], terminals: [terminal], models: [] })) });
    const reply = await api.handle({ requestId: REQUEST_ID, host: "mac", operation: "inventory", args: {} });
    expect(reply.status).toBe(200);
    if (!reply.body.ok || !("terminals" in reply.body.data)) throw new Error("expected an inventory");
    expect(reply.body.data.terminals[0]?.writable).toBe(false);
  });
});
