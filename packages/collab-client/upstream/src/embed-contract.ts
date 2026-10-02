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
	onStateChange?(state: CollabEmbedState): void;
}
