# OMP Session Gateway

## Language

**OMP Sessions**:
The browser application for finding live OMP sessions and opening their collaboration client.
_Avoid_: HarnessOS, Orca, or OMP Session Gateway when naming the browser application.

**OMP Session Gateway**:
The directory and capability broker used by OMP Sessions.
_Avoid_: OMP Sessions when naming the broker or repository.

**Private fleet path**:
Flo's owner-only variant of OMP Sessions, with fleet activity and Orca workspace operations supplied by HarnessOS.
_Avoid_: Upstream generic path, which does not include these fleet operations.
