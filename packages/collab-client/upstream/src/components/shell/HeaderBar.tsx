import { LogOut, PanelRight, Search } from "lucide-react";
import type { ReactNode } from "react";
import type { ConnectionPhase, GuestSnapshot } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import { ThemeToggle } from "./ThemeToggle";

const PHASE_LABEL: Record<ConnectionPhase, string> = {
	connecting: "Connecting",
	waiting: "Joining",
	live: "Live",
	reconnecting: "Reconnecting",
	ended: "Ended",
};

export interface HeaderBarProps {
	snapshot: GuestSnapshot;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
}

/** The context-window fill, from OMP's own percent or tokens over window; null when unknown. */
export function contextPercent(snapshot: GuestSnapshot): number | null {
	const usage = snapshot.state?.contextUsage;
	if (!usage) return null;
	return (
		usage.percent ??
		(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
			? (usage.tokens / usage.contextWindow) * 100
			: null)
	);
}

export function ContextGauge({ pct }: { pct: number }): ReactNode {
	return (
		<span className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"} title={`context · ${fmtPercent(pct)}`}>
			<span className="sh-gauge-track">
				<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
			</span>
			<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
		</span>
	);
}

export function AgentsToggle({ subCount, railOpen, onToggleRail }: { subCount: number; railOpen: boolean; onToggleRail(): void }): ReactNode {
	const label = railOpen ? "hide agents" : subCount > 0 ? `show agents (${subCount})` : "show agents";
	return (
		<button
			type="button"
			className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
			onClick={onToggleRail}
			title={label}
			aria-label={label}
			aria-pressed={railOpen}
		>
			<PanelRight size={14} />
			{subCount > 0 && <span className="sh-badge">{subCount}</span>}
		</button>
	);
}

export function SearchToggle({ searchOpen, onToggleSearch }: { searchOpen: boolean; onToggleSearch(): void }): ReactNode {
	const label = searchOpen ? "close transcript search" : "search transcript";
	return (
		<button
			type="button"
			className={searchOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
			onClick={onToggleSearch}
			title={label}
			aria-label={label}
			aria-pressed={searchOpen}
		>
			<Search size={14} />
		</button>
	);
}

export interface EmbeddedHeaderToolsProps extends Omit<HeaderBarProps, "onLeave"> {
	searchOpen: boolean;
	onToggleSearch(): void;
}

/**
 * The session tools a host shell shows in its own bar when it embeds the client: context fill,
 * transcript search and the agents toggle. Participants and the read-only chip stay out; the host
 * bar owns title, navigation and connection state.
 */
export function EmbeddedHeaderTools({
	snapshot,
	subCount,
	railOpen,
	onToggleRail,
	searchOpen,
	onToggleSearch,
}: EmbeddedHeaderToolsProps): ReactNode {
	const pct = contextPercent(snapshot);
	return (
		<>
			{pct != null && <ContextGauge pct={pct} />}
			<SearchToggle searchOpen={searchOpen} onToggleSearch={onToggleSearch} />
			<AgentsToggle subCount={subCount} railOpen={railOpen} onToggleRail={onToggleRail} />
		</>
	);
}

export function HeaderBar({ snapshot, subCount, railOpen, onToggleRail, onLeave }: HeaderBarProps): ReactNode {
	const { header, state, phase, readOnly } = snapshot;
	const title = header?.title ?? state?.sessionName ?? "session";
	const pct = contextPercent(snapshot);

	return (
		<header className="sh-header">
			<div className="sh-header-left">
				<span className="sh-brand" aria-label="omp collab">
					<span className="sh-brand-slash">/</span>
				</span>
				<span className="sh-title" title={title}>
					{title}
				</span>
				{state?.cwd && (
					<span className="sh-cwd" title={state.cwd}>
						{shortenPath(state.cwd)}
					</span>
				)}
			</div>
			<div className="sh-header-right">
				<span className={`sh-status sh-status-${phase}`} title={`connection: ${phase}`}>
					<span className={`sh-dot sh-dot-${phase}`} />
					{PHASE_LABEL[phase]}
				</span>
				{readOnly && (
					<span className="sh-chip" title="you joined with a read-only link — watching only">
						read-only
					</span>
				)}
				{state?.model && <span className="sh-chip sh-chip-meta">{state.model.name}</span>}
				{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
				{pct != null && <ContextGauge pct={pct} />}
				{state && state.participants.length > 0 && (
					<span className="sh-avatars">
						{state.participants.map((p, i) => (
							<span
								key={`${p.name}:${i}`}
								className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}
								title={`${p.name} · ${p.role}${p.readOnly ? " · view-only" : ""}`}
							>
								{(p.name[0] ?? "?").toUpperCase()}
							</span>
						))}
					</span>
				)}
				<ThemeToggle />
				<AgentsToggle subCount={subCount} railOpen={railOpen} onToggleRail={onToggleRail} />
				<button type="button" className="sh-btn sh-btn-icon" onClick={onLeave} title="leave session">
					<LogOut size={14} />
				</button>
			</div>
		</header>
	);
}
