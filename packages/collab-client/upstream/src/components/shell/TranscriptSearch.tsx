import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Transcript search. Matching runs twice on purpose: over the entries the client holds, so a match
 * older than the rendered window can widen it (`oldestMatchIndex`), and over the rendered text, so
 * what is counted, highlighted and scrolled to is exactly what the reader sees.
 */

const MATCH_HIGHLIGHT = "omp-search-match";
const ACTIVE_HIGHLIGHT = "omp-search-active";

/** Start offsets of every non-overlapping, case-insensitive occurrence of `query` in `text`. */
export function findMatches(text: string, query: string): number[] {
	if (query.length === 0) return [];
	// Lower-casing keeps offsets only when it keeps length; otherwise match case-sensitively.
	const foldedText = text.toLowerCase();
	const foldedQuery = query.toLowerCase();
	const folded = foldedText.length === text.length && foldedQuery.length === query.length;
	const haystack = folded ? foldedText : text;
	const needle = folded ? foldedQuery : query;
	const offsets: number[] = [];
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
		offsets.push(at);
	}
	return offsets;
}

/** The text an entry renders without interaction: message text, never tool arguments or folded thinking. */
function entrySearchText(entry: SessionEntry): string {
	const textOf = (content: string | readonly { type: string; text?: string }[]): string =>
		typeof content === "string"
			? content
			: content.map(block => (block.type === "text" && typeof block.text === "string" ? block.text : "")).join("\n");
	if (entry.type === "message") {
		const { message } = entry;
		if (message.role === "user") return textOf(message.content);
		if (message.role === "assistant") return textOf(message.content);
		return "";
	}
	if (entry.type === "custom_message" && (entry.customType === "collab-prompt" || entry.display)) {
		return textOf(entry.content);
	}
	return "";
}

/** Index of the oldest held entry whose text matches, or null. */
export function oldestMatchIndex(entries: readonly SessionEntry[], query: string): number | null {
	if (query.length === 0) return null;
	const index = entries.findIndex(entry => findMatches(entrySearchText(entry), query).length > 0);
	return index === -1 ? null : index;
}

/** The CSS Custom Highlight API paints matches without touching React's DOM; absent, only scrolling works. */
function paintHighlight(name: string, ranges: readonly Range[]): void {
	if (typeof CSS === "undefined" || CSS.highlights === undefined || typeof Highlight === "undefined") return;
	if (ranges.length === 0) CSS.highlights.delete(name);
	else CSS.highlights.set(name, new Highlight(...ranges));
}

function collectRanges(root: Element, query: string): Range[] {
	const ranges: Range[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		const text = node.nodeValue ?? "";
		for (const offset of findMatches(text, query)) {
			const range = document.createRange();
			range.setStart(node, offset);
			range.setEnd(node, offset + query.length);
			ranges.push(range);
		}
	}
	return ranges;
}

export interface TranscriptSearchState {
	count: number;
	/** Zero-based active match, or -1 with no match. */
	active: number;
	next(): void;
	previous(): void;
}

/**
 * Finds `query` in the rendered transcript under `container`, highlights every match, and keeps
 * the active one scrolled into view. It re-scans when the transcript DOM changes (live appends, a
 * widened window); the active match starts at the newest one, nearest the tail being read.
 */
export function useTranscriptSearch(container: HTMLElement | null, query: string): TranscriptSearchState {
	const rangesRef = useRef<Range[]>([]);
	const [count, setCount] = useState(0);
	const [active, setActive] = useState(-1);
	const [scanned, setScanned] = useState(0);
	// Bumped by a new query and by next/previous: only those move the reader, never a live re-scan.
	const [reveal, setReveal] = useState(0);

	useLayoutEffect(() => {
		if (container === null || query.length === 0) {
			rangesRef.current = [];
			setCount(0);
			setActive(-1);
			paintHighlight(MATCH_HIGHLIGHT, []);
			return;
		}
		let frame: number | null = null;
		let first = true;
		const scan = (): void => {
			frame = null;
			const before = rangesRef.current;
			const ranges = collectRanges(container.querySelector(".tr-root") ?? container, query);
			rangesRef.current = ranges;
			paintHighlight(MATCH_HIGHLIGHT, ranges);
			setCount(ranges.length);
			// The newest match first; afterwards the same match stays active when rows mount above it.
			const isFirst = first;
			setActive(previous => {
				if (isFirst) return ranges.length - 1;
				const prior = before[previous];
				const kept =
					prior === undefined
						? -1
						: ranges.findIndex(
								range => range.startContainer === prior.startContainer && range.startOffset === prior.startOffset,
							);
				return kept !== -1 ? kept : Math.min(previous, ranges.length - 1);
			});
			setScanned(n => n + 1);
			if (isFirst) setReveal(n => n + 1);
			first = false;
		};
		scan();
		const observer = new MutationObserver(() => {
			if (frame === null) frame = requestAnimationFrame(scan);
		});
		observer.observe(container, { childList: true, subtree: true, characterData: true });
		return () => {
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
			paintHighlight(MATCH_HIGHLIGHT, []);
		};
	}, [container, query]);

	useLayoutEffect(() => {
		const range = rangesRef.current[active];
		paintHighlight(ACTIVE_HIGHLIGHT, range === undefined ? [] : [range]);
	}, [active, scanned]);
	useEffect(() => () => paintHighlight(ACTIVE_HIGHLIGHT, []), []);

	useLayoutEffect(() => {
		const range = rangesRef.current[active];
		if (range === undefined || container === null) return;
		const scroller = container.querySelector(".tr-root");
		if (scroller === null) return;
		const target = range.getBoundingClientRect();
		const view = scroller.getBoundingClientRect();
		if (target.top >= view.top + 8 && target.bottom <= view.bottom - 8) return;
		scroller.scrollTop += target.top - view.top - scroller.clientHeight / 2;
	}, [active, reveal, container]);

	const next = useCallback(() => {
		setActive(current => (count === 0 ? -1 : (current + 1) % count));
		setReveal(n => n + 1);
	}, [count]);
	const previous = useCallback(() => {
		setActive(current => (count === 0 ? -1 : (current - 1 + count) % count));
		setReveal(n => n + 1);
	}, [count]);
	return { count, active, next, previous };
}

export interface TranscriptSearchBarProps {
	query: string;
	entryCount: number;
	search: TranscriptSearchState;
	onQuery(query: string): void;
	onClose(): void;
}

/**
 * Compact search field over the transcript. Search starts at the newest match and walks back:
 * Enter/↑ goes to the older match, Shift+Enter/↓ to the newer one, Escape closes and clears.
 */
export function TranscriptSearchBar({ query, entryCount, search, onQuery, onClose }: TranscriptSearchBarProps): ReactNode {
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose();
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (event.shiftKey) search.next();
			else search.previous();
		}
	};
	const hasQuery = query.trim().length > 0;
	const counter = hasQuery ? `${search.count === 0 ? 0 : search.active + 1}/${search.count}` : "";
	return (
		<div className="sh-search" role="search">
			<input
				ref={inputRef}
				className="sh-search-input"
				type="search"
				value={query}
				onChange={event => onQuery(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={`Search ${entryCount} loaded ${entryCount === 1 ? "entry" : "entries"}`}
				aria-label="Search transcript"
				enterKeyHint="search"
				autoCapitalize="off"
				autoComplete="off"
				spellCheck={false}
			/>
			<span
				className="sh-search-count"
				role="status"
				aria-live="polite"
				aria-label={hasQuery ? (search.count === 0 ? "No matches" : `Match ${search.active + 1} of ${search.count}`) : undefined}
			>
				{counter}
			</span>
			<button
				type="button"
				className="sh-btn sh-btn-icon sh-search-step"
				onClick={search.previous}
				disabled={search.count === 0}
				aria-label="Previous match (older)"
				title="previous match"
			>
				<ChevronUp size={16} />
			</button>
			<button
				type="button"
				className="sh-btn sh-btn-icon sh-search-step"
				onClick={search.next}
				disabled={search.count === 0}
				aria-label="Next match (newer)"
				title="next match"
			>
				<ChevronDown size={16} />
			</button>
			<button type="button" className="sh-btn sh-btn-icon sh-search-step" onClick={onClose} aria-label="Close search" title="close search">
				<X size={16} />
			</button>
		</div>
	);
}
