import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ContextFile, type EvaluationRecord, appendEvaluation, contextDir, evaluationOf, latestEvaluation } from "./store.ts";
import { summarize } from "./summary.ts";

/**
 * Your verdict on a session, from the Herdr Desktop panel: `bun verdict.ts <sessionId> good|bad|clear`.
 * Appends a history line carrying the verdict and prints it. A running session has no history line yet, so the
 * record comes from its context file; with neither, a minimal record keeps the verdict.
 */

type Verdict = "good" | "bad" | "clear";

function contextOf(dir: string, sessionId: string): ContextFile | null {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const file = JSON.parse(readFileSync(join(dir, name), "utf8")) as ContextFile;
			if (file.sessionId === sessionId) return file;
		} catch {
			// half-written or foreign file
		}
	}
	return null;
}

export function applyVerdict(dir: string, sessionId: string, verdict: Verdict, now: number): EvaluationRecord {
	const context = contextOf(dir, sessionId);
	const base =
		latestEvaluation(dir, sessionId) ??
		evaluationOf(context ?? ({ ...summarize([]), sessionId, cwd: "" } as ContextFile), null);
	const record: EvaluationRecord = {
		...base,
		verdict: verdict === "clear" ? null : verdict,
		verdictAt: verdict === "clear" ? null : new Date(now).toISOString(),
	};
	appendEvaluation(dir, record);
	// The panel reads the current verdict from this small file rather than the whole history.
	const marker = join(dir, "verdicts", sessionId.replace(/[^\w.-]/g, "_"));
	if (record.verdict) {
		mkdirSync(join(dir, "verdicts"), { recursive: true });
		writeFileSync(marker, record.verdict);
	} else rmSync(marker, { force: true });
	return record;
}

if (import.meta.main) {
	const [sessionId, verdict] = process.argv.slice(2);
	if (!sessionId || (verdict !== "good" && verdict !== "bad" && verdict !== "clear")) {
		console.error("usage: bun verdict.ts <sessionId> good|bad|clear");
		process.exit(2);
	}
	console.log(JSON.stringify(applyVerdict(contextDir(), sessionId, verdict, Date.now())));
}
