/**
 * One-tap replies shown above the composer in Control mode. The directory owns the list and its
 * storage; the embedded client only receives the bounded strings through its embed options.
 */
export const QUICK_REPLIES_STORAGE_KEY = "omp.sessions.quick-replies.v1";
export const DEFAULT_QUICK_REPLIES: readonly string[] = ["continue", "oui", "go", "résume"];
export const MAX_QUICK_REPLIES = 8;
/** Characters (code points), not UTF-16 units, so an accent or emoji is never split. */
export const MAX_QUICK_REPLY_LENGTH = 200;
const MAX_STORED_BYTES = 8_192;

type QuickReplyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Trim, fold whitespace, cut to length, drop blanks and duplicates, keep the first eight. */
function boundQuickReplies(values: readonly unknown[]): string[] {
  const replies: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const reply = Array.from(value.replace(/\s+/gu, " ").trim()).slice(0, MAX_QUICK_REPLY_LENGTH).join("");
    if (reply.length === 0 || replies.includes(reply)) continue;
    replies.push(reply);
    if (replies.length === MAX_QUICK_REPLIES) break;
  }
  return replies;
}

/** The Settings textarea holds one reply per line. */
export function parseQuickReplyLines(text: string): string[] {
  return boundQuickReplies(text.split(/\r?\n/u));
}

export function readQuickReplies(storage: Pick<QuickReplyStorage, "getItem" | "removeItem"> | undefined): readonly string[] {
  if (storage === undefined) return DEFAULT_QUICK_REPLIES;
  let serialized: string | null;
  try {
    serialized = storage.getItem(QUICK_REPLIES_STORAGE_KEY);
  } catch {
    return DEFAULT_QUICK_REPLIES;
  }
  if (serialized === null) return DEFAULT_QUICK_REPLIES;
  try {
    if (serialized.length > MAX_STORED_BYTES) throw new Error("quick replies exceed bound");
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value)) throw new Error("quick replies are not a list");
    return boundQuickReplies(value);
  } catch {
    try {
      storage.removeItem(QUICK_REPLIES_STORAGE_KEY);
    } catch {
      // A corrupt record that cannot be removed is ignored on every read instead.
    }
    return DEFAULT_QUICK_REPLIES;
  }
}

export function writeQuickReplies(storage: QuickReplyStorage | undefined, replies: readonly string[]): void {
  try {
    storage?.setItem(QUICK_REPLIES_STORAGE_KEY, JSON.stringify(boundQuickReplies(replies)));
  } catch {
    // Persistence is best-effort; denied storage keeps whatever list was readable before.
  }
}

/** Forget the edited list so the defaults apply again. */
export function resetQuickReplies(storage: Pick<QuickReplyStorage, "removeItem"> | undefined): void {
  try {
    storage?.removeItem(QUICK_REPLIES_STORAGE_KEY);
  } catch {
    // Nothing persisted that could be reused.
  }
}
