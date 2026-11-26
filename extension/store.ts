import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionSummary, TestRun } from "./summary.ts";

/**
 * Where a session's context lives for the Herdr Desktop panel (`<terminal>.json`) and the evaluation history
 * (`sessions.jsonl`, latest line per session wins). Every write is best effort: OMP never fails because of it.
 */

export interface ContextLink {
	label: string;
	url: string;
	kind: string;
	pinned: boolean;
	state: string | null;
	title: string | null;
}

export interface ContextFile extends SessionSummary {
	version: 1;
	updatedAt: string;
	sessionId: string;
	terminalId: string;
	cwd: string;
	branch: string | null;
	waiting: { kind: "ask" | "approval"; text: string } | null;
	links: ContextLink[];
	ended: boolean;
	/** The session that started this one, when the terminal was launched from another agent's terminal. */
	parent: ParentSession | null;
}

export interface ParentSession {
	terminalId: string;
	/** From the parent terminal's own context file; null when it has none here (not OMP, another machine, pruned). */
	sessionId: string | null;
	title: string | null;
	ask: string | null;
}

export interface EvaluationRecord {
	sessionId: string;
	title: string | null;
	cwd: string;
	model: string | null;
	models: string[];
	startedAt: string | null;
	endedAt: string | null;
	finished: boolean;
	corrections: number;
	toolCalls: number;
	toolErrors: number;
	tests: TestRun;
	tokens: number;
	cost: number;
	verdict: "good" | "bad" | null;
	verdictAt: string | null;
}

const HISTORY = "sessions.jsonl";

/**
 * A `task` subagent runs the extensions again, with the parent's environment: its session file sits in the
 * parent's artifacts dir (`<parent>.jsonl` → `<parent>/<agent>.jsonl`). It must not write the terminal's file.
 */
export function isSubagentSession(sessionFile: string | undefined): boolean {
	return !!sessionFile && existsSync(`${dirname(sessionFile)}.jsonl`);
}

export function contextDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "omp-session-context");
}

export function contextFileName(terminalId: string): string {
	return `${terminalId.replace(/[^\w.-]/g, "_")}.json`;
}

/** Label a launcher can set on a terminal it starts with `hc run --no-parent`, to still name the terminal it came from. */
export const PARENT_LABEL = "session-context.parent";

/** The terminal this one was started from, out of `hc get <terminal>`: herdr-core's parent, else the launcher's label. */
export function parentTerminal(hcGet: unknown): string | null {
	if (!hcGet || typeof hcGet !== "object") return null;
	const record = hcGet as { parent?: unknown; labels?: Record<string, unknown> };
	if (typeof record.parent === "string" && record.parent) return record.parent;
	const label = record.labels?.[PARENT_LABEL];
	return typeof label === "string" && label ? label : null;
}

/** What the parent terminal's context file says about its session; only its id when the file isn't here. */
export function parentSession(dir: string, terminalId: string): ParentSession {
	try {
		const file = JSON.parse(readFileSync(join(dir, contextFileName(terminalId)), "utf8")) as Partial<ContextFile>;
		return { terminalId, sessionId: file.sessionId ?? null, title: file.title ?? null, ask: file.ask?.first ?? null };
	} catch {
		return { terminalId, sessionId: null, title: null, ask: null };
	}
}

export function writeContext(dir: string, file: ContextFile): void {
	try {
		mkdirSync(dir, { recursive: true });
		const path = join(dir, contextFileName(file.terminalId));
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(file, null, 2));
		renameSync(temp, path);
	} catch {
		// the panel shows the last good file with its age
	}
}

export function appendEvaluation(dir: string, record: EvaluationRecord): void {
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, HISTORY), `${JSON.stringify(record)}\n`);
	} catch {
		// history is for later analysis; losing one line costs one session's record
	}
}

export function latestEvaluation(dir: string, sessionId: string): EvaluationRecord | null {
	let text: string;
	try {
		text = readFileSync(join(dir, HISTORY), "utf8");
	} catch {
		return null;
	}
	let latest: EvaluationRecord | null = null;
	for (const line of text.split("\n")) {
		if (!line.includes(sessionId)) continue;
		try {
			const record = JSON.parse(line) as EvaluationRecord;
			if (record.sessionId === sessionId) latest = record;
		} catch {
			// a torn line from a crash
		}
	}
	return latest;
}

export function pruneContexts(dir: string, now: number, maxAgeMs: number): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		try {
			if (now - statSync(path).mtimeMs > maxAgeMs) unlinkSync(path);
		} catch {
			// gone already
		}
	}
}

/** The history line for a context; the caller carries over any verdict already given. */
export function evaluationOf(file: ContextFile, endedAt: string | null): EvaluationRecord {
	const { stats } = file;
	return {
		sessionId: file.sessionId,
		title: file.title,
		cwd: file.cwd,
		model: stats.model,
		models: stats.models,
		startedAt: stats.startedAt,
		endedAt,
		finished: file.finished,
		corrections: stats.corrections,
		toolCalls: stats.toolCalls,
		toolErrors: stats.toolErrors,
		tests: stats.tests,
		tokens: stats.tokens,
		cost: stats.cost,
		verdict: null,
		verdictAt: null,
	};
}
