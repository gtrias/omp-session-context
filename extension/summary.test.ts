import { describe, expect, it } from "bun:test";
import { isTestCommand, summarize } from "./summary.ts";

let seq = 0;
const at = () => new Date(Date.UTC(2026, 10, 25, 10, 0, seq++)).toISOString();

const user = (text: string) => ({ type: "message", timestamp: at(), message: { role: "user", content: [{ type: "text", text }] } });

function assistant(
	text: string,
	opts: { toolCalls?: Array<{ id: string; name: string; arguments: unknown }>; stopReason?: string; model?: string; cost?: number; tokens?: number } = {},
) {
	const content: unknown[] = text ? [{ type: "text", text }] : [];
	for (const call of opts.toolCalls ?? []) content.push({ type: "toolCall", ...call });
	return {
		type: "message",
		timestamp: at(),
		message: {
			role: "assistant",
			content,
			provider: "llama-server",
			model: opts.model ?? "qwen38-27b",
			stopReason: opts.stopReason ?? (opts.toolCalls ? "toolUse" : "stop"),
			usage: { totalTokens: opts.tokens ?? 10, cost: { total: opts.cost ?? 0.5 } },
		},
	};
}

const toolResult = (id: string, name: string, opts: { isError?: boolean; details?: unknown; output?: string } = {}) => ({
	type: "message",
	timestamp: at(),
	message: { role: "toolResult", toolCallId: id, toolName: name, isError: opts.isError ?? false, content: opts.output ? [{ type: "text", text: opts.output }] : [], details: opts.details },
});
const todo = (id: string, statuses: string[]) => [
	assistant("", { toolCalls: [{ id, name: "todo", arguments: {} }] }),
	toolResult(id, "todo", {
		details: { phases: [{ name: "Work", tasks: statuses.map((status, i) => ({ content: `task ${i}`, status })) }] },
	}),
];

const bash = (id: string, command: string, isError = false, output?: string) => [
	assistant("", { toolCalls: [{ id, name: "bash", arguments: { command } }] }),
	toolResult(id, "bash", { isError, output }),
];
describe("ask", () => {
	it("keeps the first request and the latest different one", () => {
		const s = summarize([user("build the panel"), assistant("ok"), user("now add tests")]);
		expect(s.ask).toEqual({ first: "build the panel", last: "now add tests" });
	});
	it("has no latest with a single request", () => {
		expect(summarize([user("only one")]).ask.last).toBeNull();
	});
	it("truncates to 400 chars", () => {
		expect(summarize([user("x".repeat(500))]).ask.first?.length).toBe(400);
	});
});

describe("todo", () => {
	it("summarizes the latest todo result", () => {
		const s = summarize([user("go"), ...todo("a", ["pending", "pending"]), ...todo("b", ["completed", "completed", "in_progress", "pending"])]);
		expect(s.todo).toMatchObject({ done: 2, total: 4, current: "task 2", next: "task 3" });
	});
	it("is null without a todo call", () => {
		expect(summarize([user("go"), assistant("done")]).todo).toBeNull();
	});
});

describe("corrections", () => {
	it("counts user messages while the todo is open", () => {
		const s = summarize([user("go"), ...todo("a", ["in_progress", "pending"]), user("no, not like that")]);
		expect(s.stats.corrections).toBe(1);
	});
	it("does not count a new request after the todo is closed", () => {
		const s = summarize([user("go"), ...todo("a", ["completed"]), user("next thing")]);
		expect(s.stats.corrections).toBe(0);
	});
	it("never counts the first message", () => {
		expect(summarize([user("go")]).stats.corrections).toBe(0);
	});
	it("counts an aborted turn as an interrupt", () => {
		const s = summarize([user("go"), assistant("work", { stopReason: "aborted" })]);
		expect(s.stats.corrections).toBe(1);
		expect(s.stats.interrupted).toBe(true);
	});
});

describe("tool calls", () => {
	it("counts results and errors", () => {
		const s = summarize([user("go"), ...bash("a", "ls"), ...bash("b", "false", true)]);
		expect(s.stats.toolCalls).toBe(2);
		expect(s.stats.toolErrors).toBe(1);
	});
});

describe("tests", () => {
	it("takes the last test run", () => {
		const s = summarize([user("go"), ...bash("a", "npm test", true), ...bash("b", "cd web && npm test")]);
		expect(s.stats.tests).toMatchObject({ status: "passed", command: "cd web && npm test" });
	});
	it("reports a failed last run", () => {
		const s = summarize([user("go"), ...bash("a", "bun test", true)]);
		expect(s.stats.tests.status).toBe("failed");
	});
	it("reads failures from the output of a piped run", () => {
		const s = summarize([user("go"), ...bash("a", "npx vitest run 2>&1 | tail -20", false, " Tests  1 failed | 3 passed (4)")]);
		expect(s.stats.tests.status).toBe("failed");
	});
	it("keeps a clean piped run as passed", () => {
		const s = summarize([user("go"), ...bash("a", "bun test 2>&1 | tail -3", false, " 12 pass\n 0 fail")]);
		expect(s.stats.tests.status).toBe("passed");
	});
	it("is none without test runs", () => {
		expect(summarize([user("go"), ...bash("a", "ls")]).stats.tests).toEqual({ status: "none", command: null, at: null });
	});
});

describe("isTestCommand", () => {
	for (const cmd of [
		"npm test",
		"bun test",
		"pnpm run test",
		"cd a && npm test",
		"FOO=1 pytest -q",
		"go test ./...",
		"cargo test",
		"tsx --test src/x.test.ts",
		"just test",
		"make test",
		"vitest run",
	])
		it(`matches ${cmd}`, () => expect(isTestCommand(cmd)).toBe(true));
	for (const cmd of ["cat src/test/foo.ts", "cd tests && ls", "grep test file"])
		it(`ignores ${cmd}`, () => expect(isTestCommand(cmd)).toBe(false));
});

describe("refs", () => {
	it("collects nothing without a pattern", () => {
		expect(summarize([user("fix T-12")]).tasks).toEqual([]);
	});
	it("lists distinct matches of the pattern, most recent first", () => {
		expect(summarize([user("fix T-12 then T-7, T-12 again")], /\bT-\d+\b/g).tasks).toEqual(["T-12", "T-7"]);
	});
});

describe("finished", () => {
	it("is true with every todo task done", () => {
		expect(summarize([user("go"), ...todo("a", ["completed", "completed"])]).finished).toBe(true);
	});
	it("counts abandoned tasks as settled", () => {
		const s = summarize([user("go"), ...todo("a", ["completed", "abandoned"]), user("next thing")]);
		expect(s.finished).toBe(true);
		expect(s.todo?.done).toBe(2);
		expect(s.stats.corrections).toBe(0);
	});
	it("is false with open tasks", () => {
		expect(summarize([user("go"), ...todo("a", ["completed", "pending"])]).finished).toBe(false);
	});
	it("is true without todo when not interrupted", () => {
		expect(summarize([user("go"), assistant("done")]).finished).toBe(true);
	});
});

describe("stats", () => {
	it("names the last model and sums usage", () => {
		const s = summarize([user("go"), assistant("a", { model: "m1", cost: 0.25, tokens: 5 }), assistant("b", { model: "m2", cost: 0.25, tokens: 5 })]);
		expect(s.stats.model).toBe("llama-server/m2");
		expect(s.stats.models).toEqual(["llama-server/m1", "llama-server/m2"]);
		expect(s.stats.cost).toBeCloseTo(0.5);
		expect(s.stats.tokens).toBe(10);
	});
	it("keeps the last assistant text as the reply", () => {
		expect(summarize([user("go"), assistant("all done here")]).lastReply).toBe("all done here");
	});
	it("shows the reply as plain text", () => {
		const reply = "**Done**\n- fixed `foo`\n- see [docs](https://x.y)";
		expect(summarize([user("go"), assistant(reply)]).lastReply).toBe("Done\n• fixed foo\n• see docs (https://x.y)");
	});
});
