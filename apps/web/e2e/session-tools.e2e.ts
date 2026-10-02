import { expect, test, type Page } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { installSilentWebSocket, startDashboardFixture } from "./fixture-server.ts";

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
