import type { SessionMetadata } from "@omp-session-gateway/protocol";

/** The Badging API surface, present on Window and ServiceWorker navigators where supported. */
export interface AppBadgeNavigator {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/**
 * Pending asks the operator can answer, by the same rule the gateway uses for push
 * `pendingAskCount`: an open ask on a session this browser may Control. A stale fleet card cannot
 * Control, so it never inflates the badge.
 */
export function pendingAskCount(sessions: readonly SessionMetadata[]): number {
  return sessions.filter(session => session.inputRequired && session.canControl && session.ask !== undefined).length;
}

/**
 * Badge writes per navigator, in call order, so a burst of snapshots cannot leave an older count on
 * the icon. One page or worker has one navigator, hence one queue; separate targets never wait on
 * each other.
 */
const badgeTails = new WeakMap<AppBadgeNavigator, Promise<void>>();

/**
 * Shows `count` on the installed app icon, or clears it at zero. Feature-detected: a browser or a
 * non-installed iOS page without the Badging API is left alone. It never asks for notification
 * permission; iOS shows the badge only once the operator has granted it elsewhere, and a refusal
 * (the API rejects) is not a delivery failure, so it is swallowed here. Calls are serialized: the
 * last call's count is the one left on the icon. The returned promise settles after this write.
 */
export function syncAppBadge(count: number, badgeNavigator?: AppBadgeNavigator): Promise<void> {
  // Navigator typings may predate the Badging API; each member is feature-detected below.
  const target = badgeNavigator ?? (typeof navigator === "undefined" ? undefined : (navigator as AppBadgeNavigator));
  const pending = Number.isSafeInteger(count) && count > 0 ? count : 0;
  if (target === undefined) return Promise.resolve();
  const write = (badgeTails.get(target) ?? Promise.resolve()).then(async () => {
    try {
      if (pending > 0) {
        if (typeof target.setAppBadge === "function") await target.setAppBadge(pending);
      } else if (typeof target.clearAppBadge === "function") {
        await target.clearAppBadge();
      } else if (typeof target.setAppBadge === "function") {
        // The Badging API defines setAppBadge(0) as clear where clearAppBadge is missing.
        await target.setAppBadge(0);
      }
    } catch {
      // Not installed, or badge permission withheld: the count is cosmetic and resynced on next change.
    }
  });
  badgeTails.set(target, write);
  return write;
}
