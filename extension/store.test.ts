import { describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContextFile, type EvaluationRecord, appendEvaluation, contextDir, evaluationOf, isSubagentSession, latestEvaluation, pruneContexts, writeContext } from "./store.ts";
import { summarize } from "./summary.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "session-context-"));

const context = (terminalId: string): ContextFile => ({
	...summarize([]),
	version: 1,
	updatedAt: "2026-11-25T10:00:00.000Z",
	sessionId: "s1",
	terminalId,
	cwd: "/repo",
	branch: "main",
	waiting: null,
	links: [],
	ended: false,
});

const record = (verdict: EvaluationRecord["verdict"]): EvaluationRecord => ({ ...evaluationOf(context("t1"), null), verdict });

describe("writeContext", () => {
	it("writes the file atomically", () => {
		const dir = tmp();
		writeContext(dir, context("t1r"));
		expect(JSON.parse(readFileSync(join(dir, "t1r.json"), "utf8"))).toEqual(context("t1r"));
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
	it("sanitizes the terminal id", () => {
		const dir = tmp();
		writeContext(dir, context("host/t1r"));
		expect(existsSync(join(dir, "host_t1r.json"))).toBe(true);
	});
});

describe("latestEvaluation", () => {
	it("takes the last line for the session and skips garbage", () => {
		const dir = tmp();
		appendEvaluation(dir, record(null));
		appendFileSync(join(dir, "sessions.jsonl"), "{not json\n");
		appendEvaluation(dir, record("good"));
		expect(latestEvaluation(dir, "s1")?.verdict).toBe("good");
		expect(latestEvaluation(dir, "other")).toBeNull();
	});
});

describe("pruneContexts", () => {
	it("removes context files older than the limit only", () => {
		const dir = tmp();
		const now = Date.now();
		for (const name of ["old.json", "new.json", "sessions.jsonl"]) writeFileSync(join(dir, name), "{}");
		utimesSync(join(dir, "old.json"), new Date(now - 8 * 864e5), new Date(now - 8 * 864e5));
		utimesSync(join(dir, "new.json"), new Date(now - 864e5), new Date(now - 864e5));
		utimesSync(join(dir, "sessions.jsonl"), new Date(now - 30 * 864e5), new Date(now - 30 * 864e5));
		pruneContexts(dir, now, 7 * 864e5);
		expect(readdirSync(dir).sort()).toEqual(["new.json", "sessions.jsonl"]);
	});
});

describe("contextDir", () => {
	it("follows XDG_STATE_HOME", () => {
		expect(contextDir({ XDG_STATE_HOME: "/x" })).toBe("/x/omp-session-context");
	});
});

describe("isSubagentSession", () => {
	it("spots a session stored in its parent's artifacts dir", () => {
		const dir = tmp();
		writeFileSync(join(dir, "parent.jsonl"), "");
		mkdirSync(join(dir, "parent"));
		expect(isSubagentSession(join(dir, "parent", "0-Worker.jsonl"))).toBe(true);
		expect(isSubagentSession(join(dir, "parent.jsonl"))).toBe(false);
		expect(isSubagentSession(undefined)).toBe(false);
	});
});
