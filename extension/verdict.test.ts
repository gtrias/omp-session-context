import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContextFile, appendEvaluation, evaluationOf, latestEvaluation, writeContext } from "./store.ts";
import { summarize } from "./summary.ts";
import { applyVerdict } from "./verdict.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "session-verdict-"));
const NOW = Date.UTC(2026, 10, 25, 12);

const context = (sessionId: string): ContextFile => {
	const summary = summarize([]);
	return {
		...summary,
		stats: { ...summary.stats, toolErrors: 3, model: "llama-server/qwen38-27b" },
		version: 1,
		updatedAt: "2026-11-25T10:00:00.000Z",
		sessionId,
		terminalId: "t1r",
		cwd: "/repo",
		branch: null,
		waiting: null,
		links: [],
		ended: false,
	};
};

describe("applyVerdict", () => {
	it("copies the latest record with the verdict", () => {
		const dir = tmp();
		appendEvaluation(dir, { ...evaluationOf(context("s1"), "2026-11-25T11:00:00.000Z"), corrections: 2 });
		const record = applyVerdict(dir, "s1", "good", NOW);
		expect(record).toMatchObject({ verdict: "good", corrections: 2, endedAt: "2026-11-25T11:00:00.000Z", verdictAt: new Date(NOW).toISOString() });
		expect(readFileSync(join(dir, "sessions.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
		expect(latestEvaluation(dir, "s1")?.verdict).toBe("good");
	});
	it("builds the record from the context file of a running session", () => {
		const dir = tmp();
		writeContext(dir, context("s2"));
		expect(applyVerdict(dir, "s2", "bad", NOW)).toMatchObject({ verdict: "bad", toolErrors: 3, model: "llama-server/qwen38-27b", cwd: "/repo" });
	});
	it("writes a minimal record when nothing is known", () => {
		const dir = tmp();
		expect(applyVerdict(dir, "s3", "good", NOW)).toMatchObject({ sessionId: "s3", verdict: "good", corrections: 0, cwd: "" });
	});
	it("clears a verdict", () => {
		const dir = tmp();
		applyVerdict(dir, "s4", "good", NOW);
		expect(applyVerdict(dir, "s4", "clear", NOW)).toMatchObject({ verdict: null, verdictAt: null });
	});
	it("keeps the current verdict where the panel reads it", () => {
		const dir = tmp();
		applyVerdict(dir, "s5", "bad", NOW);
		expect(readFileSync(join(dir, "verdicts", "s5"), "utf8")).toBe("bad");
		applyVerdict(dir, "s5", "clear", NOW);
		expect(existsSync(join(dir, "verdicts", "s5"))).toBe(false);
	});
});
