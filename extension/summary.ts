import { messageText, textOf, truncate } from "./links.ts";

/**
 * What a session branch says about the work: the request, the todo, whether it was corrected or interrupted, tool
 * errors, the last test run and the models it used. Pure: it reads the entries `sessionManager.getBranch()` returns.
 */

export interface TodoSummary {
	done: number;
	total: number;
	current: string | null;
	next: string | null;
	phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
}

export interface TestRun {
	status: "passed" | "failed" | "none";
	command: string | null;
	at: string | null;
}

export interface SessionSummary {
	title: string | null;
	ask: { first: string | null; last: string | null };
	todo: TodoSummary | null;
	lastReply: string | null;
	/** T-NNN refs, most recently mentioned first. */
	tasks: string[];
	stats: {
		model: string | null;
		models: string[];
		startedAt: string | null;
		tokens: number;
		cost: number;
		toolCalls: number;
		toolErrors: number;
		corrections: number;
		/** The last assistant turn was aborted. */
		interrupted: boolean;
		tests: TestRun;
	};
	/** Every todo task completed, or (without a todo) the last turn wasn't aborted. */
	finished: boolean;
}

/** The panel shows plain text: drop emphasis, heading and code markers, and turn list dashes into bullets. */
export function plainText(markdown: string): string {
	return markdown
		.replace(/^```.*$/gm, "")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^(\s*)[-*]\s+/gm, "$1• ")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const ASK_CHARS = 400;
const REPLY_CHARS = 300;
const TEST_RUNNER =
	/^(?:(?:npm|pnpm|yarn|bun)(?: run)? test\b|tsx --test\b|(?:npx )?(?:vitest|jest)\b|pytest\b|python3? -m pytest\b|go test\b|cargo test\b|(?:just|make) test\b)/;
/** A runner's failure summary: vitest/jest "1 failed", bun "1 fail", pytest "1 failed", go/jest "FAIL" lines. */
const FAILURES = /\b[1-9]\d* (?:failed|fail|failures?)\b|^\s*FAIL\b|^--- FAIL/m;

/** A shell command runs a test suite: some `&&`/`;`/`|` segment starts with a test runner, env assignments skipped. */
export function isTestCommand(command: string): boolean {
	return command.split(/&&|\|\||;|\|/).some((segment) => TEST_RUNNER.test(segment.trim().replace(/^(?:\w+=\S*\s+)+/, "")));
}

function todoSummary(details: unknown): TodoSummary | null {
	if (!details || typeof details !== "object" || !("phases" in details) || !Array.isArray(details.phases)) return null;
	const phases: TodoSummary["phases"] = details.phases.map((phase: { name?: unknown; tasks?: unknown }) => ({
		name: typeof phase?.name === "string" ? phase.name : "",
		tasks: Array.isArray(phase?.tasks)
			? phase.tasks.map((task: { content?: unknown; status?: unknown }) => ({ content: String(task?.content ?? ""), status: String(task?.status ?? "") }))
			: [],
	}));
	const tasks = phases.flatMap((phase) => phase.tasks);
	return {
		// OMP settles a task either way: done or dropped.
		done: tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length,
		total: tasks.length,
		current: tasks.find((task) => task.status === "in_progress")?.content ?? null,
		next: tasks.find((task) => task.status === "pending")?.content ?? null,
		phases,
	};
}

export function summarize(entries: readonly unknown[], refPattern?: RegExp): SessionSummary {
	const calls = new Map<string, { name: string; args: unknown }>();
	const models: string[] = [];
	const tasks: string[] = [];
	let title: string | null = null;
	let startedAt: string | null = null;
	let first: string | null = null;
	let last: string | null = null;
	let todo: TodoSummary | null = null;
	let lastReply: string | null = null;
	let tokens = 0;
	let cost = 0;
	let toolCalls = 0;
	let toolErrors = 0;
	let corrections = 0;
	let interrupted = false;
	let tests: TestRun = { status: "none", command: null, at: null };

	for (const entry of entries as Array<Record<string, any>>) {
		if (!entry || typeof entry !== "object") continue;
		startedAt ??= typeof entry.timestamp === "string" ? entry.timestamp : null;
		if (entry.type === "title" && typeof entry.title === "string") title = entry.title;
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		const text = messageText(message).trim();
		for (const ref of refPattern ? text.match(refPattern) ?? [] : []) {
			const known = tasks.indexOf(ref);
			if (known >= 0) tasks.splice(known, 1);
			tasks.unshift(ref);
		}

		if (message.role === "user") {
			if (!text) continue;
			if (first === null) first = truncate(text, ASK_CHARS);
			else {
				last = truncate(text, ASK_CHARS);
				if (todo && todo.done < todo.total) corrections += 1;
			}
		} else if (message.role === "assistant") {
			const model = message.provider && message.model ? `${message.provider}/${message.model}` : (message.model ?? null);
			if (model && models.at(-1) !== model) {
				const seen = models.indexOf(model);
				if (seen >= 0) models.splice(seen, 1);
				models.push(model);
			}
			tokens += Number(message.usage?.totalTokens ?? 0);
			cost += Number(message.usage?.cost?.total ?? 0);
			interrupted = message.stopReason === "aborted";
			if (interrupted) corrections += 1;
			if (text) lastReply = truncate(plainText(text), REPLY_CHARS);
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part?.type === "toolCall" && typeof part.id === "string") calls.set(part.id, { name: part.name, args: part.arguments });
			}
		} else if (message.role === "toolResult") {
			toolCalls += 1;
			if (message.isError) toolErrors += 1;
			if (message.toolName === "todo") todo = todoSummary(message.details) ?? todo;
			const call = calls.get(message.toolCallId);
			const command = (call?.args as { command?: unknown } | undefined)?.command;
			if (message.toolName === "bash" && typeof command === "string" && isTestCommand(command)) {
				// `cmd | tail` exits with tail's status: a piped run's verdict is in its output.
				const output = Array.isArray(message.content) ? message.content.map(textOf).join("\n") : "";
				const failed = message.isError || (command.includes("|") && FAILURES.test(output));
				tests = { status: failed ? "failed" : "passed", command, at: entry.timestamp ?? null };
			}
		}
	}

	return {
		title,
		ask: { first, last: last === first ? null : last },
		todo,
		lastReply,
		tasks,
		stats: { model: models.at(-1) ?? null, models, startedAt, tokens, cost, toolCalls, toolErrors, corrections, interrupted, tests },
		finished: todo ? todo.total > 0 && todo.done === todo.total : !interrupted,
	};
}
