import { describe, expect, test } from "bun:test";
import {
  DEFAULT_QUICK_REPLIES,
  MAX_QUICK_REPLIES,
  MAX_QUICK_REPLY_LENGTH,
  QUICK_REPLIES_STORAGE_KEY,
  parseQuickReplyLines,
  readQuickReplies,
  writeQuickReplies,
} from "../src/quick-replies.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("quick replies", () => {
  test("defaults to Flo's French replies until the list is edited", () => {
    expect(DEFAULT_QUICK_REPLIES).toEqual(["continue", "oui", "go", "résume"]);
    expect(readQuickReplies(new MemoryStorage())).toEqual(DEFAULT_QUICK_REPLIES);
    expect(readQuickReplies(undefined)).toEqual(DEFAULT_QUICK_REPLIES);
  });

  test("one reply per line: trimmed, blank and duplicate lines dropped, bounded in count and length", () => {
    const long = "é".repeat(MAX_QUICK_REPLY_LENGTH + 20);
    const lines = ["  ship it  ", "", "   ", "ship it", "a\tb  c", long, ...Array.from({ length: 12 }, (_, i) => `r${i}`)];
    const parsed = parseQuickReplyLines(lines.join("\r\n"));
    expect(parsed).toHaveLength(MAX_QUICK_REPLIES);
    expect(parsed.slice(0, 4)).toEqual(["ship it", "a b c", "é".repeat(MAX_QUICK_REPLY_LENGTH), "r0"]);
    expect(parsed.at(-1)).toBe("r4");
  });

  test("an emptied list stays empty instead of reverting to the defaults", () => {
    const storage = new MemoryStorage();
    writeQuickReplies(storage, parseQuickReplyLines("\n  \n"));
    expect(storage.getItem(QUICK_REPLIES_STORAGE_KEY)).toBe("[]");
    expect(readQuickReplies(storage)).toEqual([]);
  });

  test("round-trips an edited list and re-bounds what storage holds", () => {
    const storage = new MemoryStorage();
    writeQuickReplies(storage, ["vas-y", "stop"]);
    expect(readQuickReplies(storage)).toEqual(["vas-y", "stop"]);
    storage.setItem(QUICK_REPLIES_STORAGE_KEY, JSON.stringify([" a ", 3, null, "a", "x".repeat(500)]));
    expect(readQuickReplies(storage)).toEqual(["a", "x".repeat(MAX_QUICK_REPLY_LENGTH)]);
  });

  test("malformed or oversized storage falls back to the defaults and is discarded", () => {
    for (const stored of ["{not json", JSON.stringify({ replies: ["a"] }), JSON.stringify("go"), "x".repeat(20_000)]) {
      const storage = new MemoryStorage();
      storage.setItem(QUICK_REPLIES_STORAGE_KEY, stored);
      expect(readQuickReplies(storage)).toEqual(DEFAULT_QUICK_REPLIES);
      expect(storage.getItem(QUICK_REPLIES_STORAGE_KEY)).toBeNull();
    }
  });

  test("storage denial never breaks reading or writing", () => {
    const denied = {
      getItem(): string | null {
        throw new Error("denied");
      },
      setItem(): void {
        throw new Error("denied");
      },
      removeItem(): void {
        throw new Error("denied");
      },
    };
    expect(readQuickReplies(denied)).toEqual(DEFAULT_QUICK_REPLIES);
    expect(() => writeQuickReplies(denied, ["go"])).not.toThrow();
  });
});
