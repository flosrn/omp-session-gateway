export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

export type PathHealthState = "checking" | "healthy" | "degraded" | "unreachable";

export interface PathHealth {
	state: PathHealthState;
	rttMs: number | null;
	lastSuccessAt: number | null;
	failureSince: number | null;
	retryAt: number | null;
}

export interface CollabEmbedState {
	phase: ConnectionPhase;
	endedReason: string | null;
	requestPending: boolean;
	responsePending: boolean;
	gatewayHealth: PathHealth;
	relayHealth: PathHealth;
}

export interface CollabEmbedOptions {
	focusPendingRequest?: boolean;
	shellOwnsLifecycle?: boolean;
	/** Host-owned header element the client fills with its session tools (context, agents). */
	headerSlot?: HTMLElement;
	/**
	 * One-tap replies shown above the composer in Control mode, already bounded by the host. Each tap
	 * sends its text as a prompt; an empty or absent list shows nothing. The client never stores them.
	 */
	quickReplies?: readonly string[];
	onStateChange?(state: CollabEmbedState): void;
	/**
	 * Fired once when the same-origin gateway probe is refused by the edge or the gateway (401,
	 * 403, or an Access login redirect). Before this fires the client has already closed its relay
	 * transport, dropped queued frames, cancelled retries, and ended the session, so the composer is
	 * disabled. The client never resumes on its own, even if a later probe would succeed: only a new
	 * explicit launch, after fresh authorization, connects again. The host disposes the embed and
	 * shows sign-in. Detection is bounded by the probe interval, not instant: Access session
	 * revocation is visible only once the edge refuses the next request.
	 */
	onAuthorizationDenied?(): void;
}

/**
 * Whether a same-origin request sent with `redirect: "manual"` and `X-Requested-With:
 * XMLHttpRequest` was refused authorization, rather than failing transiently. Access answers such a
 * request with 401 or a login redirect (an `opaqueredirect` response); the gateway answers 401 or
 * 403. Timeouts, network errors, and 5xx are never refusals; callers keep their retry path for those.
 */
export function isAuthorizationDeniedResponse(response: { readonly status: number; readonly type: string }): boolean {
	return response.status === 401 || response.status === 403 || response.type === "opaqueredirect";
}
