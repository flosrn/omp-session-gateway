import { expect, type Page, type Route, test } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { installSilentWebSocket, startDashboardFixture, type DashboardFixture } from "./fixture-server.ts";

function session(instanceId = "pwa-upgrade-0001", title = "Automatic PWA upgrade"): SessionMetadata {
  return {
    instanceId,
    generation: 1,
    title,
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-07-25T05:00:00.000Z",
    lastSeenAt: "2026-07-25T05:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: false,
  };
}


async function installLoadCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const prior = Number.parseInt(sessionStorage.getItem("omp-e2e-loads") ?? "0", 10);
    sessionStorage.setItem("omp-e2e-loads", String(prior + 1));
  });
}

async function waitForControlledWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller !== null) return;
    await new Promise<void>(resolve => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
  });
}

async function triggerWorkerUpgrade(page: Page, fixture: DashboardFixture): Promise<void> {
  await page.evaluate(async () => {
    await caches.open("omp-sessions-shell-e2e-previous");
  });
  fixture.upgradeServiceWorker();
  try {
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
  } catch (error) {
    if (!String(error).includes("Execution context was destroyed")) throw error;
  }
}

/**
 * Upgrades the worker and returns once the new worker has finished its `activate` event and the
 * page's bounded fallback timer has had its chance to fire. Chromium can hold `activate` for about a
 * second after the controller changes, so a shorter wait would observe neither.
 */
async function upgradeThroughActivation(page: Page, fixture: DashboardFixture): Promise<void> {
  await page.evaluate(() => {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      sessionStorage.setItem("omp-e2e-controller-changed-at", String(Date.now()));
    }, { once: true });
  });
  await triggerWorkerUpgrade(page, fixture);
  await expect.poll(
    () => page.evaluate(async () => {
      const changedAt = Number(sessionStorage.getItem("omp-e2e-controller-changed-at") ?? Number.NaN);
      const registration = await navigator.serviceWorker.getRegistration();
      return Date.now() - changedAt > 1_250 &&
        registration?.active?.state === "activated" &&
        registration.installing === null &&
        registration.waiting === null;
    }).catch(() => false),
  ).toBe(true);
}

/** Holds matching requests until released, then settles each with `finish`. */
async function holdRoute(
  page: Page,
  url: string,
  finish: (route: Route) => Promise<void>,
): Promise<{ readonly arrived: Promise<void>; readonly finished: Promise<void>; release(): void }> {
  let release = (): void => undefined;
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  let arrive = (): void => undefined;
  const arrived = new Promise<void>(resolve => {
    arrive = resolve;
  });
  let finishOne = (): void => undefined;
  const finished = new Promise<void>(resolve => {
    finishOne = resolve;
  });
  await page.route(url, async route => {
    arrive();
    await released;
    await finish(route).catch(() => undefined);
    finishOne();
  });
  return { arrived, finished, release: () => release() };
}


async function loadCount(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => Number.parseInt(sessionStorage.getItem("omp-e2e-loads") ?? "0", 10));
  } catch {
    return 0;
  }
}

test("an updated PWA activates and reloads an idle directory automatically", { tag: ["@core", "@serviceworker"] }, async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);
  await installLoadCounter(page);

  try {
    await page.goto(fixture.origin);
    await expect(page.locator(".working-row")).toHaveCount(1);
    await waitForControlledWorker(page);
    expect(await loadCount(page)).toBe(1);

    await triggerWorkerUpgrade(page, fixture);

    await expect.poll(() => loadCount(page)).toBe(2);
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".working-row")).toHaveCount(1);
  } finally {
    await fixture.stop();
  }
});

test("an updated PWA preserves active collaboration until the user leaves", async ({ page }) => {
  // A pending ask offers a Transcript view whose shell can still upgrade to Control.
  const asking: SessionMetadata = {
    ...session(),
    inputRequired: true,
    ask: { requestId: "pwa-upgrade-request-0001", since: "2026-07-25T05:00:01.000Z" },
  };
  const fixture = await startDashboardFixture([asking]);
  await installLoadCounter(page);
  await installSilentWebSocket(page);

  try {
    await page.goto(fixture.origin);
    await waitForControlledWorker(page);
    await page.locator(".queue-hero").getByRole("button", { name: "Transcript" }).click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    expect(await loadCount(page)).toBe(1);

    await upgradeThroughActivation(page, fixture);

    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator(".conn-chip")).toBeVisible();
    expect(await loadCount(page)).toBe(1);

    const failedLaunchRoute = "**/api/v1/sessions/pwa-upgrade-0001/launch";
    await page.route(failedLaunchRoute, route =>
      route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
    );
    await page.locator(".shell-control").click();
    await expect(page.locator(".triage-copy")).toHaveText(
      "The session could not be opened. Try again.",
    );
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => ({
      href: location.href,
      loads: Number.parseInt(sessionStorage.getItem("omp-e2e-loads") ?? "0", 10),
    }))).toEqual({ href: `${fixture.origin}/client/`, loads: 1 });
    await page.unroute(failedLaunchRoute);

    await page.goBack();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect.poll(() => loadCount(page)).toBe(2);
    await expect(page.locator(".queue-hero")).toHaveCount(1);
  } finally {
    await fixture.stop();
  }
});

for (const order of ["the failure settles first", "a collaboration mounts first"] as const) {
  test(`an updated PWA never interrupts concurrent launches when ${order}`, async ({ page }) => {
    // View-only sessions keep View as their one-tap action.
    const failing = { ...session("pwa-upgrade-0002", "Failing launch"), canControl: false };
    const fixture = await startDashboardFixture([{ ...session(), canControl: false }, failing]);
    await installLoadCounter(page);
    await installSilentWebSocket(page);
    const failingLaunch = await holdRoute(page, `**/api/v1/sessions/${failing.instanceId}/launch`, route =>
      route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
    );
    const viewLaunch = await holdRoute(page, "**/api/v1/sessions/pwa-upgrade-0001/launch", route => route.continue());

    try {
      await page.goto(fixture.origin);
      await expect(page.locator(".working-row")).toHaveCount(2);
      await waitForControlledWorker(page);
      await page.getByRole("button", { name: "View Failing launch" }).click();
      await page.getByRole("button", { name: "View Automatic PWA upgrade" }).click();
      await Promise.all([failingLaunch.arrived, viewLaunch.arrived]);

      await upgradeThroughActivation(page, fixture);
      expect(await loadCount(page)).toBe(1);

      if (order === "the failure settles first") {
        // One settled launch must not release the update while the other is still pending. The
        // newer selection supersedes the failed one, so it stays pending and still mounts.
        failingLaunch.release();
        await failingLaunch.finished;
        await expect(page.getByRole("button", { name: "View Automatic PWA upgrade" })).toBeDisabled();
        await page.waitForTimeout(250);
        expect(await loadCount(page)).toBe(1);
        viewLaunch.release();
        await expect(page.locator(".conn-chip")).toBeVisible();
      } else {
        // A late failure must leave the collaboration another launch mounted meanwhile untouched.
        viewLaunch.release();
        await expect(page.locator(".conn-chip")).toBeVisible();
        failingLaunch.release();
        await failingLaunch.finished;
        await page.waitForTimeout(250);
        await expect(page.locator(".conn-chip")).toBeVisible();
        await expect(page.locator("link[data-omp-collab-styles]")).toHaveCount(1);
      }
      await expect(page).toHaveURL(`${fixture.origin}/client/`);
      expect(await loadCount(page)).toBe(1);
      expect(fixture.launchRequests.map(request => request.instanceId)).toEqual(["pwa-upgrade-0001"]);

      await page.goBack();
      await expect(page).toHaveURL(`${fixture.origin}/`);
      await expect.poll(() => loadCount(page)).toBe(2);
      await expect(page.locator(".working-row")).toHaveCount(2);
    } finally {
      failingLaunch.release();
      viewLaunch.release();
      await fixture.stop();
    }
  });
}

test("an updated PWA keeps a routed notification until its snapshot resolves", async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);
  await installLoadCounter(page);
  await installSilentWebSocket(page);

  try {
    await page.goto(fixture.origin);
    await waitForControlledWorker(page);
    const snapshot = await holdRoute(page, "**/api/v1/sessions", route => route.continue());
    await page.goto(`${fixture.origin}/collab/pwa-upgrade-0001?activity=stopped&generation=1`);
    await snapshot.arrived;
    expect(await loadCount(page)).toBe(2);

    await upgradeThroughActivation(page, fixture);
    expect(await loadCount(page)).toBe(2);

    snapshot.release();
    await expect(page.locator(".conn-chip")).toBeVisible();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    expect(fixture.launchRequests).toEqual([{ instanceId: "pwa-upgrade-0001", generation: 1, mode: "view" }]);
    expect(await loadCount(page)).toBe(2);
  } finally {
    await fixture.stop();
  }
});

test("an updated PWA applies its deferred update once a routed notification expires", async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);
  await installLoadCounter(page);

  try {
    await page.goto(fixture.origin);
    await waitForControlledWorker(page);
    const snapshot = await holdRoute(page, "**/api/v1/sessions", route => route.continue());
    // Generation 2 no longer matches the live generation-1 session, so the route resolves as expired.
    await page.goto(`${fixture.origin}/collab/pwa-upgrade-0001?activity=stopped&generation=2`);
    await snapshot.arrived;

    await upgradeThroughActivation(page, fixture);
    expect(await loadCount(page)).toBe(2);

    snapshot.release();
    await expect.poll(() => loadCount(page)).toBe(3);
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".working-row")).toHaveCount(1);
    expect(fixture.launchRequests).toEqual([]);
  } finally {
    await fixture.stop();
  }
});

test("an updated PWA waits while a workspace write is pending or uncertain, and reloads once the user clears it", async ({ page }) => {
  const fixture = await startDashboardFixture([session()], { hosts: [{ host: "mac", status: "live", ageSeconds: 1 }] });
  await installLoadCounter(page);
  const createReplies: { status: number; error: string }[] = [
    { status: 504, error: "outcome-unknown" },
    { status: 429, error: "rate-limited" },
  ];
  const createIds: string[] = [];
  const firstCreate = Promise.withResolvers<void>();
  const releaseFirstCreate = Promise.withResolvers<void>();
  await page.route("**/api/v1/workspace", async route => {
    const body = route.request().postDataJSON() as { requestId: string; operation: string };
    if (body.operation === "inventory") {
      const data = { projects: [{ id: "p1", name: "app", path: "/code/app" }], workspaces: [], terminals: [], models: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requestId: body.requestId, ok: true, data }) });
      return;
    }
    createIds.push(body.requestId);
    if (createIds.length === 1) {
      firstCreate.resolve();
      await releaseFirstCreate.promise;
    }
    const reply = createReplies.shift() ?? { status: 503, error: "unavailable" };
    await route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: JSON.stringify({ requestId: body.requestId, ok: false, error: reply.error }),
    });
  });

  try {
    await page.goto(fixture.origin);
    await expect(page.locator(".working-row")).toHaveCount(1);
    await waitForControlledWorker(page);
    expect(await loadCount(page)).toBe(1);

    await page.getByRole("button", { name: "Workspaces" }).click();
    const panel = page.getByRole("dialog", { name: "Workspaces" });
    await panel.getByRole("tab", { name: "New" }).click();
    await expect(panel.getByLabel("Project")).toHaveValue("p1");
    await panel.getByLabel("Workspace name").fill("feature-x");
    await panel.getByLabel("Prompt").fill("build it");
    await expect(panel.getByLabel("Prompt")).toHaveValue("build it");
    await panel.getByRole("button", { name: "Create workspace" }).click();
    await firstCreate.promise;
    const outcome = panel.locator(".wsp-outcome-line");
    await expect(outcome).toHaveAttribute("data-state", "pending");

    // A receipt in flight would be lost by a reload.
    await upgradeThroughActivation(page, fixture);
    expect(await loadCount(page)).toBe(1);

    // The lost receipt leaves the write uncertain: the update still waits.
    releaseFirstCreate.resolve();
    await expect(outcome).toHaveAttribute("data-state", "uncertain");
    await expect(panel.getByRole("button", { name: "Create workspace" })).toBeDisabled();
    // The app's deferred-update fallback fires within 1 s of a settle; outlast it before asserting.
    await page.waitForTimeout(1_250);
    expect(await loadCount(page)).toBe(1);

    // A refused retry says nothing about the first attempt, which may still have run.
    await panel.getByRole("button", { name: "Retry same request" }).click();
    await expect.poll(() => createIds.length).toBe(2);
    await expect(outcome).toContainText("Retry was refused");
    await expect(outcome).toHaveAttribute("data-state", "uncertain");
    expect(createIds[1]).toBe(createIds[0]);
    await page.waitForTimeout(1_250);
    expect(await loadCount(page)).toBe(1);

    // Only the user's explicit acknowledgement settles it, and then the deferred update applies.
    await panel.getByRole("button", { name: "Checked the machine — clear" }).click();
    await expect.poll(() => loadCount(page)).toBe(2);
    await expect(page).toHaveURL(`${fixture.origin}/`);
    expect(createIds).toHaveLength(2);
  } finally {
    await fixture.stop();
  }
});
