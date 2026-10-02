import { expect, test, type Page } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { installSilentWebSocket, startDashboardFixture } from "./fixture-server.ts";

interface CapturedWorkspaceRequest {
  readonly requestId: string;
  readonly host: string;
  readonly operation: string;
  readonly args: Record<string, unknown>;
}

function workingSession(id: string, title: string, startedAt: string, cwdLabel = "project"): SessionMetadata {
  return {
    instanceId: id,
    generation: 1,
    title,
    cwdLabel,
    model: "provider/model",
    startedAt,
    lastSeenAt: "2026-07-21T12:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: false,
  };
}

function waitingSession(id: string, title: string): SessionMetadata {
  return {
    ...workingSession(id, title, "2026-07-21T07:00:00.000Z", "inbox"),
    inputRequired: true,
    ask: { requestId: `${id}-request`, since: "2026-07-21T12:00:00.000Z" },
  };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const ROOM_KEY = new Uint8Array(32).fill(41);

interface FakeCollabControls {
  /** The next welcome frame reports a read-only (View) guest. */
  __fakeReadOnly?: boolean;
  /** Text of every guest `prompt` frame, decrypted. */
  __fakePrompts?: string[];
  __fakeSocket?: { sendAsk(): Promise<void> };
}

/**
 * An encrypted collab relay stand-in (same envelope as launch.e2e.ts): a welcome, then the given
 * transcript as assistant text entries; guest prompts are decrypted, recorded and echoed back.
 */
async function installFakeCollab(page: Page, texts: readonly string[]): Promise<void> {
  await page.addInitScript(({ keyBytes, transcript }) => {
    const controls = globalThis as typeof globalThis & FakeCollabControls;
    controls.__fakePrompts = [];
    const key = crypto.subtle.importKey("raw", new Uint8Array(keyBytes), "AES-GCM", false, ["encrypt", "decrypt"]);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const entry = (id: string, text: string, index: number): unknown => ({
      id,
      parentId: null,
      timestamp: new Date(Date.UTC(2026, 6, 25, 0, 0, index)).toISOString(),
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        model: "test/model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: "stop",
        timestamp: 0,
      },
    });

    class FakeCollabSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = FakeCollabSocket.CONNECTING;
      binaryType: BinaryType = "arraybuffer";
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      welcomed = false;
      echoes = 0;

      constructor(url: string) {
        this.url = url;
        controls.__fakeSocket = this;
        queueMicrotask(() => {
          this.readyState = FakeCollabSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      close(): void {
        this.readyState = FakeCollabSocket.CLOSED;
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        void this.receive(data);
        if (this.welcomed) return;
        this.welcomed = true;
        void this.welcome();
      }

      async receive(data: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<void> {
        if (typeof data === "string" || data instanceof Blob) return;
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        if (bytes.byteLength <= 16) return;
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(4, 16) }, await key, bytes.slice(16));
        const frame = JSON.parse(decoder.decode(plaintext)) as { t?: unknown; text?: unknown };
        if (frame.t !== "prompt" || typeof frame.text !== "string") return;
        controls.__fakePrompts?.push(frame.text);
        this.echoes += 1;
        await this.frame({
          t: "entry",
          entry: {
            id: `guest-${this.echoes}`,
            parentId: null,
            timestamp: "2026-07-25T01:00:00.000Z",
            type: "custom_message",
            customType: "collab-prompt",
            content: frame.text,
            details: { from: "guest" },
            display: true,
          },
        });
      }

      async frame(frame: unknown): Promise<void> {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = new Uint8Array(
          await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key, encoder.encode(JSON.stringify(frame))),
        );
        const envelope = new Uint8Array(4 + iv.byteLength + ciphertext.byteLength);
        new DataView(envelope.buffer).setUint32(0, 1, false);
        envelope.set(iv, 4);
        envelope.set(ciphertext, 4 + iv.byteLength);
        this.onmessage?.(new MessageEvent("message", { data: envelope.buffer }));
      }

      async welcome(): Promise<void> {
        const entries = transcript.map((text, index) => entry(`entry-${index}`, text, index));
        await this.frame({
          t: "welcome",
          proto: 3,
          header: { type: "session", id: "session-tools", title: "Session tools", timestamp: "2026-07-25T00:00:00.000Z", cwd: "/test" },
          state: { isStreaming: false, queuedMessageCount: 0, cwd: "/test", participants: [{ name: "host", role: "host" }] },
          agents: [],
          entryCount: entries.length,
          readOnly: controls.__fakeReadOnly === true,
        });
        await this.frame({ t: "snapshot-chunk", entries, final: true });
        await this.frame({ t: "gateway-health-pong", seq: 0 });
      }

      async sendAsk(): Promise<void> {
        await this.frame({
          t: "ui-request",
          request: { reqId: 9, kind: "select", title: "Ship it?", options: [{ label: "Yes" }, { label: "No" }], initialIndex: 0, selectionMarker: "radio" },
        });
      }
    }

    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeCollabSocket });
  }, { keyBytes: [...ROOM_KEY], transcript: [...texts] });
}

function fakePrompts(page: Page): Promise<string[]> {
  return page.evaluate(() => (globalThis as typeof globalThis & FakeCollabControls).__fakePrompts ?? []);
}

test("the session title switches to another live session without going back", async ({ page }) => {
  const current = workingSession("switch-current-00001", "Current build", "2026-07-21T11:00:00.000Z");
  const other = workingSession("switch-other-0000001", "Other build", "2026-07-21T09:00:00.000Z", "other-repo");
  const waiting = waitingSession("switch-waiting-00001", "Waiting question");
  const fixture = await startDashboardFixture([current, other, waiting]);

  try {
    await installSilentWebSocket(page);
    await page.goto(fixture.origin);
    await page.getByRole("button", { name: "Control Current build" }).click();
    await expect(page.locator(".shell-title")).toHaveText("Current build");

    const heading = page.locator(".shell-heading");
    const sheet = page.getByRole("dialog", { name: "Switch session" });
    await heading.click();
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".switch-row .row-title")).toHaveText(["Waiting question", "Other build"]);
    await expect(sheet.locator(".switch-row").nth(1).locator(".switch-detail")).toHaveText("other-repo");
    const rowBox = await sheet.locator(".switch-row").first().boundingBox();
    expect(rowBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `/tmp/omp-session-switcher-${test.info().project.name}.png` });

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await heading.click();
    await expect(sheet).toBeVisible();
    await page.mouse.click(8, 8);
    await expect(sheet).toBeHidden();

    await heading.click();
    await sheet.getByRole("button", { name: "Control Other build" }).click();
    await expect(page.locator(".shell-title")).toHaveText("Other build");
    await expect(page.locator(".shell-cwd")).toHaveText("other-repo");
    expect(fixture.launchRequests.at(-1)).toEqual({ instanceId: other.instanceId, generation: 1, mode: "control" });
    await expect(page).toHaveURL(`${fixture.origin}/client/`);

    // Back still lands on the directory, not on the session it switched away from.
    await page.locator(".shell-back").click();
    await expect(page.locator("#session-list")).toBeVisible();
  } finally {
    await fixture.stop();
  }
});

test("quick replies send in one tap in Control, never in View or during an ask, and follow Settings", async ({ page }) => {
  const control = workingSession("quick-control-000001", "Quick build", "2026-07-21T11:00:00.000Z");
  const viewOnly = { ...workingSession("quick-view-000000001", "Watch build", "2026-07-21T10:00:00.000Z"), canControl: false };
  const fixture = await startDashboardFixture([control, viewOnly], { roomKey: ROOM_KEY });
  const replies = page.getByRole("group", { name: "Quick replies" });

  try {
    await installFakeCollab(page, ["Ready when you are."]);
    await page.goto(fixture.origin);
    await page.getByRole("button", { name: "Control Quick build" }).click();
    await expect(replies.getByRole("button")).toHaveText(["continue", "oui", "go", "résume"]);
    const chip = await replies.getByRole("button").first().boundingBox();
    expect(chip?.height ?? 0).toBeGreaterThanOrEqual(44);

    // One tap sends through the composer's prompt path and leaves a half-typed draft alone.
    await page.locator(".sh-composer-input").fill("draft kept");
    await replies.getByRole("button", { name: "oui" }).click();
    await expect.poll(() => fakePrompts(page)).toEqual(["oui"]);
    await expect(page.locator(".sh-composer-input")).toHaveValue("draft kept");
    await expect(page.locator(".tr-row--user").last()).toContainText("oui");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `/tmp/omp-quick-replies-${test.info().project.name}.png` });

    // An ask takes the composer over; its own controls answer it.
    await page.evaluate(() => (globalThis as typeof globalThis & FakeCollabControls).__fakeSocket?.sendAsk());
    await expect(page.locator(".sh-composer-ask")).toBeVisible();
    await expect(replies).toHaveCount(0);

    // Settings edits the list the next session receives.
    await page.locator(".shell-back").click();
    await page.locator("#settings").click();
    const editor = page.locator("#quick-replies-input");
    await expect(editor).toHaveValue("continue\noui\ngo\nrésume");
    await editor.fill("vas-y\n\n  stop  ");
    await page.locator("#notification-settings-close").click();
    await page.getByRole("button", { name: "Control Quick build" }).click();
    await expect(replies.getByRole("button")).toHaveText(["vas-y", "stop"]);

    // View is read-only: no replies at all.
    await page.locator(".shell-back").click();
    await page.evaluate(() => {
      (globalThis as typeof globalThis & FakeCollabControls).__fakeReadOnly = true;
    });
    await page.getByRole("button", { name: "View Watch build" }).click();
    await expect(page.locator(".sh-composer-input")).toHaveAttribute("placeholder", "Read-only session — watching only");
    await expect(replies).toHaveCount(0);
    expect(await fakePrompts(page)).toEqual(["oui"]);
  } finally {
    await fixture.stop();
  }
});

/** Rects of the active match and of the transcript viewport, read from the painted highlight. */
function activeMatchGeometry(page: Page): Promise<{ text: string; top: number; bottom: number; viewTop: number; viewBottom: number } | null> {
  return page.evaluate(() => {
    const highlight = CSS.highlights.get("omp-search-active");
    const view = document.querySelector(".tr-root")?.getBoundingClientRect();
    const range = highlight === undefined ? undefined : [...highlight][0];
    if (!(range instanceof Range) || view === undefined) return null;
    const rect = range.getBoundingClientRect();
    const row = range.startContainer.parentElement?.closest(".tr-row")?.textContent ?? "";
    return { text: row, top: rect.top, bottom: rect.bottom, viewTop: view.top, viewBottom: view.bottom };
  });
}

test("transcript search highlights matches across the windowed history and steps through them", async ({ page }) => {
  const target = workingSession("search-session-00001", "Search build", "2026-07-21T11:00:00.000Z");
  const fixture = await startDashboardFixture([target], { roomKey: ROOM_KEY });
  const needles = new Set([5, 300, 390]);
  const transcript = Array.from({ length: 400 }, (_, index) =>
    needles.has(index) ? `Found the Needle at step ${index}` : `Routine step ${index}`,
  );

  try {
    await installFakeCollab(page, transcript);
    await page.goto(fixture.origin);
    await page.getByRole("button", { name: "Control Search build" }).click();
    await expect(page.locator(".tr-earlier")).toHaveText("Show earlier · 250 more");

    const toggle = page.locator(".shell-tools").getByRole("button", { name: "search transcript" });
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(toggleBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    await toggle.click();
    const field = page.getByRole("searchbox", { name: "Search transcript" });
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("placeholder", "Search 400 loaded entries");

    // The oldest match sits outside the rendered window: the window widens to mount it.
    await field.fill("needle");
    const counter = page.locator(".sh-search-count");
    await expect(counter).toHaveText("3/3");
    await expect(page.locator(".tr-earlier")).toHaveText("Show earlier · 5 more");
    expect(await page.evaluate(() => CSS.highlights.get("omp-search-match")?.size)).toBe(3);
    expect((await activeMatchGeometry(page))?.text).toContain("step 390");

    await field.press("Enter");
    await expect(counter).toHaveText("2/3");
    await page.getByRole("button", { name: "Previous match (older)" }).click();
    await expect(counter).toHaveText("1/3");
    const oldest = await activeMatchGeometry(page);
    expect(oldest?.text).toContain("step 5");
    expect(oldest!.top).toBeGreaterThanOrEqual(oldest!.viewTop);
    expect(oldest!.bottom).toBeLessThanOrEqual(oldest!.viewBottom);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `/tmp/omp-transcript-search-${test.info().project.name}.png` });

    await page.getByRole("button", { name: "Next match (newer)" }).click();
    await expect(counter).toHaveText("2/3");
    expect((await activeMatchGeometry(page))?.text).toContain("step 300");

    await field.fill("absent phrase");
    await expect(counter).toHaveText("0/0");
    await expect(page.getByRole("button", { name: "Next match (newer)" })).toBeDisabled();

    await field.press("Escape");
    await expect(field).toHaveCount(0);
    expect(await page.evaluate(() => [CSS.highlights.has("omp-search-match"), CSS.highlights.has("omp-search-active")])).toEqual([false, false]);
    // Reopening starts from an empty field.
    await toggle.click();
    await expect(page.getByRole("searchbox", { name: "Search transcript" })).toHaveValue("");
  } finally {
    await fixture.stop();
  }
});

test("creating a workspace sends no model for the agent default and exactly the chosen one otherwise", async ({ page }) => {
  const fixture = await startDashboardFixture([workingSession("workspace-host-00001", "Host build", "2026-07-21T11:00:00.000Z")], {
    hosts: [{ host: "mac", status: "live", ageSeconds: 1 }],
  });
  const creates: CapturedWorkspaceRequest[] = [];
  let inventories = 0;
  let reordered = false;
  const modelA = { provider: "first", id: "model-a", name: "Model A" };
  const modelB = { provider: "second", id: "model-b", name: "Model B" };
  // The gateway route itself is covered server-side; here the page's serialized RPC is the contract.
  await page.route("**/api/v1/workspace", async route => {
    const body = route.request().postDataJSON() as CapturedWorkspaceRequest;
    const data = body.operation === "inventory"
      ? {
          projects: [{ id: "p1", name: "app", path: "/code/app" }],
          workspaces: [],
          terminals: [],
          models: reordered ? [modelB, modelA] : [modelA, modelB],
        }
      : { worktreeId: `wt-${creates.push(body)}`, accepted: true };
    if (body.operation === "inventory") inventories += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requestId: body.requestId, ok: true, data }) });
  });

  try {
    await installSilentWebSocket(page);
    await page.goto(fixture.origin);
    await page.getByRole("button", { name: "Workspaces" }).click();
    const panel = page.getByRole("dialog", { name: "Workspaces" });
    await panel.getByRole("tab", { name: "New" }).click();
    await expect(panel.getByLabel("Model")).toContainText("Model B");
    await panel.getByLabel("Workspace name").fill("feature-x");
    await panel.getByLabel("Prompt").fill("build it");

    // Left on "Agent default": the request must not name any model, least of all the first one.
    await panel.getByRole("button", { name: "Create workspace" }).click();
    await expect.poll(() => creates.length).toBe(1);
    expect(creates[0]).toMatchObject({ host: "mac", operation: "create" });
    expect(creates[0]?.args).toEqual({ projectId: "p1", name: "feature-x", agent: "omp", prompt: "build it" });
    await expect(panel.locator(".wsp-outcome-line")).toContainText("accepted");

    await panel.getByLabel("Model").selectOption({ label: "Model B · second" });
    // The catalog comes back in another order while B is chosen; the choice must stay B.
    reordered = true;
    const before = inventories;
    await panel.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(() => inventories).toBeGreaterThan(before);
    await expect(panel.getByLabel("Model").locator("option").nth(1)).toHaveText("Model B · second");
    await panel.getByRole("button", { name: "Create workspace" }).click();
    await expect.poll(() => creates.length).toBe(2);
    expect(creates[1]?.args).toEqual({
      projectId: "p1",
      name: "feature-x",
      agent: "omp",
      model: { provider: "second", id: "model-b" },
      prompt: "build it",
    });
    expect(creates[1]?.requestId).not.toBe(creates[0]?.requestId);
    await expectNoHorizontalOverflow(page);
  } finally {
    await fixture.stop();
  }
});
