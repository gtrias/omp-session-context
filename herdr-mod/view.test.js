import { describe, expect, it } from "bun:test";
import { contextPath, panelState, parentAddress, parentLine, parseContext, showsLastReply, splitAddress, statusLine, verdictPath } from "./view.js";

const ctx = (over = {}) => JSON.stringify({ version: 1, sessionId: "s1", terminalId: "t1r", updatedAt: "2026-11-25T10:00:00.000Z", waiting: null, ended: false, lastReply: "All done", ...over });
const NOW = Date.parse("2026-11-25T10:05:00.000Z");

describe("splitAddress", () => {
  it("splits a remote address", () => expect(splitAddress("host/t1r")).toEqual({ machine: "host", id: "t1r" }));
  it("keeps a local one", () => expect(splitAddress("t1r")).toEqual({ machine: null, id: "t1r" }));
});

describe("contextPath", () => {
  it("names the file after the sanitized id", () => expect(contextPath("/state", "t1r")).toBe("/state/t1r.json"));
});

describe("verdictPath", () => {
  it("names the session's verdict marker", () => expect(verdictPath("/state", "01a2/b")).toBe("/state/verdicts/01a2_b"));
});

describe("parseContext", () => {
  it("rejects bad JSON", () => expect(parseContext("{")).toBeNull());
  it("rejects another version", () => expect(parseContext(ctx({ version: 2 }))).toBeNull());
  it("reads a good file", () => expect(parseContext(ctx())?.sessionId).toBe("s1"));
});

describe("panelState", () => {
  it("is none without a focused terminal", () => expect(panelState({ terminal: null, now: NOW }).kind).toBe("none"));
  it("is none when the terminal has no file", () => expect(panelState({ terminal: "host/t9", text: null, now: NOW }).kind).toBe("none"));
  it("shows the context of the focused terminal", () => {
    const s = panelState({ terminal: "host/t1r", text: ctx(), now: NOW });
    expect(s.kind).toBe("context");
    expect(s.ageText).toBe("5m ago");
  });
  it("keeps the last good context greyed when the machine is unreachable", () => {
    const lastGood = { terminal: "host/t1r", context: parseContext(ctx()) };
    const s = panelState({ terminal: "host/t1r", error: "ssh: timeout", lastGood, now: NOW });
    expect(s).toMatchObject({ kind: "offline", stale: true });
    expect(s.context?.sessionId).toBe("s1");
  });
  it("never shows another terminal's last good context", () => {
    const lastGood = { terminal: "host/t1r", context: parseContext(ctx()) };
    const s = panelState({ terminal: "host/t2", error: "ssh: timeout", lastGood, now: NOW });
    expect(s.kind).toBe("offline");
    expect(s.context).toBeNull();
  });
  it("treats a half-written file as missing", () => expect(panelState({ terminal: "t1r", text: "{\"vers", now: NOW }).kind).toBe("none"));
  it("is loading while the first read for a terminal is pending", () => expect(panelState({ terminal: "t1r", text: null, pending: true, now: NOW }).kind).toBe("loading"));
});

describe("statusLine", () => {
  const c = (over) => parseContext(ctx(over));
  it("says what it waits for", () => expect(statusLine("blocked", c({ waiting: { kind: "ask", text: "Pick A?" } }), null, NOW)).toBe("Waiting: Pick A?"));
  it("asks for review when done", () => expect(statusLine("done", c(), null, NOW)).toBe("Finished — review"));
  it("says a vanished agent is not running", () => expect(statusLine(null, c(), null, NOW)).toBe("Not running · last seen 5m ago"));
  it("names an ended session", () => expect(statusLine("idle", c({ ended: true }), null, NOW)).toBe("Session ended"));
  it("says since when it works", () => expect(statusLine("working", c(), Date.parse("2026-11-25T10:02:00.000Z"), NOW)).toBe("Working for 3m"));
  it("is idle otherwise", () => expect(statusLine("idle", c(), null, NOW)).toBe("Idle"));
});

describe("showsLastReply", () => {
  const c = (over) => parseContext(ctx(over));
  it("shows it when the agent is done or idle", () => {
    expect(showsLastReply("done", c())).toBe(true);
    expect(showsLastReply("idle", c())).toBe(true);
  });
  it("hides it while working, waiting, ended or empty", () => {
    expect(showsLastReply("working", c())).toBe(false);
    expect(showsLastReply("blocked", c())).toBe(false);
    expect(showsLastReply("idle", c({ ended: true }))).toBe(false);
    expect(showsLastReply("idle", c({ lastReply: null }))).toBe(false);
  });
});

describe("parentAddress", () => {
  it("puts the parent on the focused terminal's machine", () => expect(parentAddress("host/t5", "t4")).toBe("host/t4"));
  it("keeps a local one bare", () => expect(parentAddress("t5", "t4")).toBe("t4"));
});

describe("parentLine", () => {
  it("prefers the title", () => expect(parentLine({ terminalId: "t4", title: "Plan", ask: "Do it" })).toBe("Plan"));
  it("falls back to the terminal", () => expect(parentLine({ terminalId: "t4", title: null, ask: null })).toBe("terminal t4"));
});
