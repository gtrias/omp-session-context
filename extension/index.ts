import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type LinkDetails, type SessionLink, linksIn, messageText, pinsIn, truncate } from "./links.ts";
import { type ContextFile, appendEvaluation, contextDir, evaluationOf, isSubagentSession, latestEvaluation, pruneContexts, writeContext } from "./store.ts";
import { summarize } from "./summary.ts";

/**
 * Session context: what this session is about, kept in sight here and in Herdr Desktop.
 *
 * In omp: every GitHub PR/issue, GitLab MR and Linear issue URL written in a user or assistant message is collected.
 * A widget above the editor shows the pinned ones and the most recent, with their title and state from `gh`; the
 * status line names the first. `/links` lists them all and pins or unpins one; `/links off` / `/links on` hides or
 * shows the widget. The list is rebuilt from the session's own history, so it survives compaction, resume and
 * branching; only pins are stored.
 *
 * In a Herdr Desktop terminal (`HC_TERMINAL_ID`), the session's summary — request, todo, what it waits for, links,
 * tasks, stats — goes to `<state>/omp-session-context/<terminal>.json` for the `session-context` panel, and each
 * session's evaluation record to `sessions.jsonl` there when it ends.
 */

const PINS_ENTRY = "session-context.pins";
const WIDGET_KEY = "session-context";
const STATUS_KEY = "session-context";
const WIDGET_ROWS = 3;
const TITLE_WIDTH = 64;
const WRITE_DEBOUNCE_MS = 1000;
const KEEP_CONTEXT_MS = 7 * 24 * 60 * 60 * 1000;
const WAITING_CHARS = 200;
// A nested omp (started from a parent session's shell) is not the terminal's own agent, nor a session to evaluate.
const NESTED = process.env.OMPCODE === "1";
const TERMINAL_ID = NESTED ? undefined : process.env.HC_TERMINAL_ID;
// Optional: collect custom references (e.g. ticket ids like `T-\d+`) from messages and list them in the panel.
const REF_PATTERN = process.env.SESSION_CONTEXT_REF ? new RegExp(process.env.SESSION_CONTEXT_REF, "g") : undefined;
const CONTEXT_DIR = contextDir();

/** The first question of an `ask` call: structured questions, or the text of an HTML form. */
function askText(args: unknown): string {
	const record = (args && typeof args === "object" ? args : {}) as { questions?: Array<{ question?: unknown }>; html?: unknown };
	const question = record.questions?.find((q) => typeof q?.question === "string")?.question;
	const text =
		typeof question === "string"
			? question
			: typeof record.html === "string"
				? record.html.split(/<(?:label|input|select|textarea)\b/i)[0].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
				: "";
	return truncate(text || "A question", WAITING_CHARS);
}

export default function sessionContext(pi: ExtensionAPI) {
	pi.setLabel("Session context");

	const links = new Map<string, SessionLink>();
	const details = new Map<string, LinkDetails>();
	const fetching = new Set<string>();
	const branches = new Map<string, string | null>();
	let pins: string[] = [];
	let counter = 0;
	let widgetOn = true;
	let waiting: ContextFile["waiting"] = null;
	let writeTimer: ReturnType<typeof setTimeout> | undefined;
	let lastCtx: ExtensionContext | undefined;
	// No file and no history from a nested omp or a `task` subagent (which shares the parent's terminal).
	let silent = NESTED;

	/** Records every link in `text` as just mentioned; returns how many it found. */
	const record = (text: string): number => {
		const found = linksIn(text);
		for (const link of found) {
			counter += 1;
			const known = links.get(link.key);
			links.set(link.key, { ...link, lastSeen: counter, mentions: (known?.mentions ?? 0) + 1 });
		}
		return found.length;
	};

	const ordered = (): SessionLink[] => {
		const all = [...links.values()].sort((a, b) => b.lastSeen - a.lastSeen);
		const pinned = pins.map((key) => links.get(key)).filter((link): link is SessionLink => link !== undefined);
		return [...pinned, ...all.filter((link) => !pins.includes(link.key))];
	};

	const describe = (link: SessionLink): string => {
		const info = details.get(link.key);
		const pin = pins.includes(link.key) ? "📌 " : "";
		const state = info?.state ? ` [${info.state}]` : "";
		const title = info?.title ? ` ${truncate(info.title, TITLE_WIDTH)}` : "";
		return `${pin}${link.label}${state}${title}`;
	};

	/** The git branch of `cwd`, asked once per directory. */
	const branchOf = async (cwd: string): Promise<string | null> => {
		if (branches.has(cwd)) return branches.get(cwd) ?? null;
		branches.set(cwd, null);
		try {
			const result = await pi.exec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
			branches.set(cwd, result.code === 0 ? result.stdout.trim() || null : null);
		} catch {
			// not a repo
		}
		return branches.get(cwd) ?? null;
	};

	const contextFile = (ctx: ExtensionContext, ended: boolean): ContextFile => {
		const summary = summarize(ctx.sessionManager.getBranch(), REF_PATTERN);
		return {
			...summary,
			title: pi.getSessionName() ?? summary.title,
			version: 1,
			updatedAt: new Date().toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			terminalId: TERMINAL_ID ?? "",
			cwd: ctx.cwd,
			branch: branches.get(ctx.cwd) ?? null,
			waiting: ended ? null : waiting,
			links: ordered().map((link) => ({
				label: link.label,
				url: link.url,
				kind: link.kind,
				pinned: pins.includes(link.key),
				state: details.get(link.key)?.state ?? null,
				title: details.get(link.key)?.title ?? null,
			})),
			ended,
		};
	};

	/** Writes the context now; waiting changes go out at once, the rest through `scheduleWrite`. */
	const writeNow = (ctx: ExtensionContext) => {
		if (!TERMINAL_ID || silent) return;
		clearTimeout(writeTimer);
		writeTimer = undefined;
		writeContext(CONTEXT_DIR, contextFile(ctx, false));
	};

	const scheduleWrite = (ctx: ExtensionContext) => {
		if (!TERMINAL_ID || silent) return;
		lastCtx = ctx;
		writeTimer ??= setTimeout(() => {
			writeTimer = undefined;
			if (lastCtx) writeContext(CONTEXT_DIR, contextFile(lastCtx, false));
		}, WRITE_DEBOUNCE_MS);
	};

	const render = (ctx: ExtensionContext) => {
		scheduleWrite(ctx);
		const shown = ordered().slice(0, WIDGET_ROWS);
		ctx.ui.setStatus(STATUS_KEY, shown[0] ? `🔗 ${shown[0].label}` : undefined);
		if (!widgetOn || shown.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const more = links.size - shown.length;
		const lines = shown.map((link) => `🔗 ${describe(link)}  ${link.url}`);
		if (more > 0) lines.push(`   +${more} more · /links`);
		ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
	};

	/** Title and state from `gh`, once per link; the widget redraws when they arrive. */
	const fetchDetails = (ctx: ExtensionContext, targets: SessionLink[]) => {
		for (const link of targets) {
			if (!link.github || details.has(link.key) || fetching.has(link.key)) continue;
			fetching.add(link.key);
			const { owner, repo, number } = link.github;
			pi.exec("gh", [
				"api",
				`repos/${owner}/${repo}/issues/${number}`,
				"--jq",
				'[.title, (if .pull_request then (if .pull_request.merged_at then "merged" elif .draft then "draft" else .state end) else .state end)] | @tsv',
			])
				.then((result) => {
					if (result.code !== 0) return;
					const [title = "", state = ""] = result.stdout.trim().split("\t");
					details.set(link.key, { title, state });
					render(ctx);
				})
				.catch(() => {})
				.finally(() => fetching.delete(link.key));
		}
	};

	const rebuild = (ctx: ExtensionContext) => {
		links.clear();
		counter = 0;
		pins = [];
		waiting = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") record(messageText(entry.message));
			if (entry.type === "custom" && entry.customType === PINS_ENTRY) pins = pinsIn(entry.data);
		}
		render(ctx);
		fetchDetails(ctx, ordered().slice(0, WIDGET_ROWS));
		if (TERMINAL_ID) branchOf(ctx.cwd).then(() => scheduleWrite(ctx)).catch(() => {});
	};

	// The list follows the branch on screen: a new, resumed, forked or navigated session rebuilds it.
	pi.on("session_start", async (_event, ctx) => {
		silent = NESTED || isSubagentSession(ctx.sessionManager.getSessionFile());
		if (TERMINAL_ID && !silent) pruneContexts(CONTEXT_DIR, Date.now(), KEEP_CONTEXT_MS);
		rebuild(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => rebuild(ctx));
	pi.on("session_branch", async (_event, ctx) => rebuild(ctx));
	pi.on("session_tree", async (_event, ctx) => rebuild(ctx));

	pi.on("message_end", async (event, ctx) => {
		if (record(messageText(event.message)) > 0) fetchDetails(ctx, ordered().slice(0, WIDGET_ROWS));
		render(ctx);
	});

	// Todo progress, tool errors and test runs land with tool results.
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName === "ask" && waiting?.kind === "ask") {
			waiting = null;
			writeNow(ctx);
			return;
		}
		scheduleWrite(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (event.toolName !== "ask") return;
		waiting = { kind: "ask", text: askText(event.args) };
		writeNow(ctx);
	});

	pi.on("tool_approval_requested", async (event, ctx) => {
		waiting = { kind: "approval", text: truncate(event.reason || `${event.toolName} approval`, WAITING_CHARS) };
		writeNow(ctx);
	});

	pi.on("tool_approval_resolved", async (_event, ctx) => {
		if (waiting?.kind !== "approval") return;
		waiting = null;
		writeNow(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (silent) return;
		clearTimeout(writeTimer);
		writeTimer = undefined;
		const file = contextFile(ctx, true);
		if (TERMINAL_ID) writeContext(CONTEXT_DIR, file);
		const previous = latestEvaluation(CONTEXT_DIR, file.sessionId);
		appendEvaluation(CONTEXT_DIR, {
			...evaluationOf(file, file.updatedAt),
			verdict: previous?.verdict ?? null,
			verdictAt: previous?.verdictAt ?? null,
		});
	});

	pi.registerCommand("links", {
		description: "List the PRs, issues and tickets of this session; pin/unpin one. `/links off|on` hides/shows the widget",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off" || arg === "on") {
				widgetOn = arg === "on";
				render(ctx);
				return;
			}
			const all = ordered();
			if (all.length === 0) {
				ctx.ui.notify("No PR, issue or ticket links in this session yet.", "info");
				return;
			}
			fetchDetails(ctx, all);
			const options = all.map((link) => ({
				label: describe(link),
				description: `${link.url} · ${link.mentions} mention${link.mentions === 1 ? "" : "s"} · ${pins.includes(link.key) ? "select to unpin" : "select to pin"}`,
			}));
			const chosen = await ctx.ui.select("Session links", options);
			const link = all.find((item) => describe(item) === chosen);
			if (!link) return;
			pins = pins.includes(link.key) ? pins.filter((key) => key !== link.key) : [link.key, ...pins];
			pi.appendEntry(PINS_ENTRY, { pins });
			render(ctx);
			ctx.ui.notify(`${pins.includes(link.key) ? "Pinned" : "Unpinned"} ${link.label}`, "info");
		},
	});
}
