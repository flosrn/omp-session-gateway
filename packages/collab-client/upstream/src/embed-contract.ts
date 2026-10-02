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
}
