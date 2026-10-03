---
title: Return OMP Sessions to omp.shipmate.bot
type: approach-plan
status: executed-rolled-back
date: 2026-10-03
---

# Return OMP Sessions to omp.shipmate.bot

Move the private fleet portal from `https://omp.ofmchat.ai` to
`https://omp.shipmate.bot`, subject to successful public workspace operations.
Execution was subsequently authorized; the cutover failed its public-operation gate and was rolled back.

## Agreed scope

- Use the existing `shipmate.bot` domain; buy no domain.
- Keep the PWA name **OMP Sessions**, repository and CLI names, service accounts,
  listener, dedicated tunnel and Access application.
- Accept a short interruption and preserve the exact single-origin mutation check.
- Start with fresh browser preferences, triage and resume selection; do not build
  a cross-origin state transfer.
- Migrate this portal only. Other services and the standalone Tailscale path stay unchanged.
- Keep the current origin in service until an explicitly authorized cutover. This
  document is not evidence that the candidate origin works.

`omp.shipmate.bot` won over `cockpit.shipmate.bot` and `sessions.shipmate.bot`.
It directly identifies the tool and reuses Flo's existing personal domain rather
than the agency-owned `ofmchat.ai` zone. In a browser tab the visited hostname
remains visible; installed standalone PWA mode can omit the address bar, not
substitute a different origin.

## Observed state and risk

Read-only Cloudflare API inspection on 2026-10-03 found:

- The Access application **OMP Sessions** has destination `omp.ofmchat.ai` and
  policy **Flo only**.
- The dedicated tunnel's remotely managed ingress routes `omp.ofmchat.ai` to
  `http://127.0.0.1:4317`, followed by a 404 fallback.
- `omp.ofmchat.ai` has a proxied CNAME to that tunnel. There is no exact DNS record
  for `omp.shipmate.bot`.

HarnessOS declares `https://omp.ofmchat.ai` in
`components/omp-session-gateway/gateway.toml` and `network.toml`. The current
Gateway source is `c791402559b8a965d1734eea2c83677380377af8`; the present worktree
is `feat/change-adress`, not the handoff's main checkout. No running host version
or authenticated browser behavior was verified in this design session.

Historical HarnessOS evidence in `docs/qualification.md` records a working
`omp.shipmate.bot` directory but Cloudflare HTML 403 responses to
`POST /api/v1/workspace`, with firewall event source and rule `l7ddos`. The existing
zone override did not unblock those requests. Moving to `omp.ofmchat.ai` passed
subsequent public operation checks. Neither the cause nor the current persistence
of the old block is established. Missing DNS is not evidence that it disappeared.

**Cutover gate:** authenticated workspace POSTs must succeed at the candidate
origin. A successful GET or Access login alone is insufficient. If the block
returns, restore the current origin and investigate separately; do not broaden
Access or disable zone-wide protection to force this migration through.

## Ownership and change surface

Paths in this table are relative to the named repository.

| Repository / system | Change at execution time |
|---|---|
| HarnessOS: `components/omp-session-gateway/gateway.toml` | Change `publicOrigin`; preserve existing source pin and unrelated settings. |
| HarnessOS: `network.toml` | Align the Access domains and portal hostname declaration. |
| Cloudflare | Align proxied DNS, tunnel ingress and the existing Access application's domain/destination. Verify its audience and owner-only policy remain unchanged. |
| Gateway: `README.md`, `docs/OPERATIONS.md`, `docs/COMPATIBILITY.md`, `docs/DECISIONS.md`, `CHANGELOG.md` | Update current-address statements only after public proof; add new dated evidence without rewriting old observations. |
| HarnessOS: `docs/installation.md`, `docs/hub.md`, `docs/qualification.md` | Update current instructions and append cutover/rollback evidence; preserve historical URLs and failures. |

The Gateway consumes a configured exact `http.publicOrigin`; no hostname is
hardcoded in application code. Existing relative client, manifest and service
worker routes fit a hostname-only migration. Preserve the mutation Origin,
`Sec-Fetch-Site`, JWT issuer/audience, no-store and secret non-persistence contracts
in `docs/SECURITY.md`, `docs/PROTOCOL.md` and ADR-033/034. No protocol or trust-boundary
change is proposed.

HarnessOS application and Cloudflare changes are separate. The public
`hos component apply --host gapicore --apply` applies the host, not just this
portal. Prior deployments used the existing scoped lifecycle API. Before
execution, establish and preview that scoped call; do not invent a public
`--only` flag or apply unrelated pending host changes. An ingress hostname change
alone does not require replacing the tunnel or rotating its token.

## Cutover

1. **Establish the live baseline and rollback inputs.** Read the current rendered
   Gateway config, source/release pins, readiness and Cloudflare routing without
   exposing credentials. Preserve the old origin's configuration and only the
   specific DNS/ingress/Access entries this migration owns. Preview the targeted
   HarnessOS service change; leave Hub/operator versions and all other components
   untouched.
   List the browsers/devices in use and each one's old-origin PWA and Push state;
   use that list for disablement, candidate checks and any rollback restoration.
2. **Prepare the candidate behind the same owner-only Access policy.** Align its
   DNS, ingress and Access destination while retaining the old route during
   preparation. Verify TLS and anonymous rejection. While `publicOrigin` still
   names the working origin, send an authenticated candidate-origin workspace
   POST with its actual Origin, same-origin fetch context and a valid read body.
   Expect the Gateway's workspace JSON 403 refusal: the exact Origin check runs
   before reading the body or calling the broker. Cloudflare HTML, a challenge,
   an Access redirect or any other result is not this proof; stop preparation,
   remove only the candidate entries and leave the working origin and Push intact.
   This is a non-executing reachability preflight, not proof of successful
   operations or absence of payload-specific Cloudflare filtering.
   If old-origin Push is enabled, disable it on every listed Push-enabled browser
   while that origin still accepts authenticated mutations, before switching
   `publicOrigin`. This overlap never authorizes mutations from two origins.
3. **Switch the configured origin in a short interruption.** Apply only the needed
   Gateway service/config change, then prove local readiness. The existing exact
   Origin check now accepts the candidate and rejects the old origin. Preserve
   application audience, allowlist, tunnel and source versions.
4. **Exercise the candidate publicly.** Apply the verification gate below. If any
   gate check fails, execute rollback rather than declaring the new URL live.
5. **Retire the old route after success.** Remove its portal-specific DNS, ingress
   and Access destination. Do not add a permanent second origin or masked iframe.
   Update current-address docs and append evidence. Record the result as **Tested**,
   not Supported or Qualified.

## Verification gate for the future migration

- Anonymous directory and workspace POST requests are rejected through Access;
  they cannot reach private metadata or execute operations.
- An authenticated owner sees Mac, gapicore and netcup-vie inventory. A rejected
  identity remains rejected by both Access and the Gateway.
- Correct-origin workspace reads and a disposable create/send/sleep/resume/close
  cycle return actual broker replies rather than Cloudflare HTML. A send starts
  a real turn; inspect the saved transcript to establish delivery. Preserve
  at-most-once request IDs and never automatically retry writes. An unreadable
  reply remains `outcome-unknown`, not success.
- A state-changing request with the old or a foreign Origin is rejected. Access
  audience and allowlist are unchanged.
- Control opens the pinned same-origin client, reload obtains a fresh launch for
  the exact generation, and Back restores a scrollable directory. Stale-generation
  launch remains rejected.
- SSE updates work. API/client responses remain no-store and capabilities stay
  out of storage, URLs, logs, screenshots and evidence artifacts. Capture directory
  proof only, never a capability or collaboration transcript screen.
- Install and reopen the PWA at the new origin on the actual devices in use. Do
  not claim physical iPhone, Home Screen or Push proof from desktop emulation.
- If background notifications are used, disable them at the old origin before
  switching `publicOrigin`, then explicitly enable them at the new origin. Verify
  delivery and tap routing on that device; do not silently transfer subscriptions.

Run relevant existing checks and leak scans after actual config/documentation
changes. Add regression coverage only if execution discovers behavior requiring
an application fix; this approach does not propose new production code or tests.

## Browser transition and rollback

The new origin has separate Access login cookies, local storage, service worker,
PWA installation, notification permission and Push subscription. Existing OMP
sessions and saved history remain on their hosts; they are not migrated or erased.
The user's fresh-state choice concerns browser-local preferences and metadata.

Retain the old PWA/bookmark until the new one passes, then remove it and install
from the new URL. An origin change cannot retarget the installed old PWA.

On failed candidate verification, disable candidate-origin Push on any listed
browser where it was enabled, while the candidate still accepts mutations.
If unsubscribe is unreachable, record the stale subscription and proceed with
rollback; notification cleanup must not delay restoring access. Restore the old
rendered `publicOrigin` and its exact DNS/ingress/Access destination, restart only
what the targeted config change requires, and prove readiness plus authenticated
old-origin workspace behavior. Remove the candidate's entries after the old path
works again. Restore old-origin notifications explicitly on the browsers where
they were disabled. Rollback changes the origin configuration, not the
Gateway/HarnessOS protocol pins; ADR-034's paired version rollback still applies
if a later execution changes those versions.

Do not publish current-address replacements after a failed cutover. Record the
failure and leave `omp.ofmchat.ai` as the working address.

## Execution outcome

The candidate later passed authenticated reachability and real create/send/sleep/resume operations
without a Cloudflare protection change. The final disposable close returned HTML 504 instead of
the required broker receipt; no write was retried. Read-only checks showed the terminal had closed,
but that did not convert the unreadable reply into success. The cause remains undetermined.

The previous configured origin, delivered engine and owner-only Access/DNS/ingress were restored.
Readiness and authenticated inventories on all three hosts passed at `https://omp.ofmchat.ai`.
Candidate routing and the disposable fixture were removed. Current-address instructions stay
unchanged. Physical-device PWA installation and Push remain unverified; Chrome Push was off.
See [the complete tested evidence](../COMPATIBILITY.md#private-flosrn-fork-evidence).

## References

- Gateway: [ADR-033 and planned origin](../DECISIONS.md#adr-033--add-a-private-flosrn-access-authenticated-fleet-variant),
  [private deployment](../OPERATIONS.md#private-flosrn-fleet-deployment),
  [private evidence](../COMPATIBILITY.md#private-flosrn-fork-evidence).
- HarnessOS: `network.toml`, `components/omp-session-gateway/gateway.toml`,
  `components/omp-session-gateway/install.ts`, `components/omp-session-gateway/tunnel.ts`,
  `scripts/components/engine.ts`, `cli/verbs/component.ts`, `docs/qualification.md`.
- Browser: [same-origin History URLs](https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState),
  [standalone PWA display](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display).
