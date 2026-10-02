import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, test } from "bun:test";
import { findMatches, oldestMatchIndex } from "../upstream/src/components/shell/TranscriptSearch";

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };

function user(id: string, content: string): SessionEntry {
  return { id, parentId: null, timestamp: "2026-08-01T00:00:00.000Z", type: "message", message: { role: "user", content, timestamp: 0 } };
}

function assistant(id: string, text: string, thinking = ""): SessionEntry {
  return {
    id,
    parentId: null,
    timestamp: "2026-08-01T00:00:00.000Z",
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking },
        { type: "text", text },
        { type: "toolCall", id: `${id}-call`, name: "grep", arguments: { pattern: "needle" } },
      ],
      model: "test/model",
      usage: USAGE,
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

function guestPrompt(id: string, text: string): SessionEntry {
  return {
    id,
    parentId: null,
    timestamp: "2026-08-01T00:00:00.000Z",
    type: "custom_message",
    customType: "collab-prompt",
    content: [{ type: "text", text }],
    details: { from: "guest" },
    display: true,
  };
}

describe("transcript search matching", () => {
  test("finds every non-overlapping, case-insensitive occurrence", () => {
    expect(findMatches("Deploy, deploy, DEPLOY", "deploy")).toEqual([0, 8, 16]);
    expect(findMatches("aaaa", "aa")).toEqual([0, 2]);
    expect(findMatches("Résumé du résumé", "RÉSUMÉ")).toEqual([0, 10]);
    expect(findMatches("anything", "")).toEqual([]);
    expect(findMatches("short", "longer query")).toEqual([]);
  });

  test("locates the oldest entry whose rendered text matches, ignoring tool arguments and hidden thinking", () => {
    const entries = [
      assistant("a0", "nothing here", "needle in thoughts"),
      user("u1", "where is the Needle?"),
      guestPrompt("g2", "needle again"),
      assistant("a3", "final needle"),
    ];
    expect(oldestMatchIndex(entries, "needle")).toBe(1);
    expect(oldestMatchIndex(entries, "AGAIN")).toBe(2);
    expect(oldestMatchIndex(entries, "grep")).toBeNull();
    expect(oldestMatchIndex(entries, "")).toBeNull();
  });
});
