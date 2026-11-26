/** GitHub PR/issue, GitLab MR and Linear issue URLs in message text. */

export type LinkKind = "github" | "gitlab" | "linear";

export interface SessionLink {
	key: string;
	url: string;
	kind: LinkKind;
	/** `monorepo#608`, `TIC-4597`, `group/project!3`. */
	label: string;
	/** Order of the last mention: higher is more recent. */
	lastSeen: number;
	mentions: number;
	github?: { owner: string; repo: string; number: string };
}

export interface LinkDetails {
	title: string;
	state: string;
}

export const PATTERNS: Array<{ kind: LinkKind; re: RegExp }> = [
	{ kind: "github", re: /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/g },
	{ kind: "gitlab", re: /https:\/\/gitlab\.com\/([\w./-]+?)\/-\/merge_requests\/(\d+)/g },
	{ kind: "linear", re: /https:\/\/linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]*-\d+)/g },
];

export function linksIn(text: string): Array<Omit<SessionLink, "lastSeen" | "mentions">> {
	const found: Array<Omit<SessionLink, "lastSeen" | "mentions">> = [];
	for (const { kind, re } of PATTERNS) {
		for (const match of text.matchAll(re)) {
			if (kind === "github") {
				const [url, owner, repo, , number] = match;
				found.push({
					key: `gh:${owner}/${repo}#${number}`.toLowerCase(),
					url,
					kind,
					label: `${repo}#${number}`,
					github: { owner, repo, number },
				});
			} else if (kind === "gitlab") {
				const [url, project, number] = match;
				found.push({ key: `gl:${project}!${number}`.toLowerCase(), url, kind, label: `${project}!${number}` });
			} else {
				const [url, id] = match;
				found.push({ key: `linear:${id}`.toLowerCase(), url, kind, label: id });
			}
		}
	}
	return found;
}

/** The text a user or assistant message carries; tool output is left out (search results, logs). */
export function messageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("role" in message) || !("content" in message)) return "";
	if (message.role !== "user" && message.role !== "assistant") return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(textOf).join("\n");
}

export function textOf(part: unknown): string {
	if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text" || !("text" in part)) return "";
	return typeof part.text === "string" ? part.text : "";
}

export function pinsIn(data: unknown): string[] {
	if (!data || typeof data !== "object" || !("pins" in data) || !Array.isArray(data.pins)) return [];
	return data.pins.filter((pin): pin is string => typeof pin === "string");
}

export const truncate = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);
