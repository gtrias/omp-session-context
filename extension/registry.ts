import { type LinkDetails, type SessionLink, linksIn, truncate } from "./links.ts";

/**
 * The session's link registry: which PR/issue/MR links were mentioned, how often, and which are pinned. Pure state
 * with no OMP dependencies: the extension entrypoint feeds it message text and stored pins, and reads back the
 * ordered list, pin state and widget line for each link. The list survives compaction, resume and branching because
 * `reset` + `record` rebuild it from the session's own history.
 */

const TITLE_WIDTH = 64;

export class LinkRegistry {
	private readonly links = new Map<string, SessionLink>();
	private pinList: string[] = [];
	private counter = 0;

	/** Records every link in `text` as just mentioned; returns how many it found. */
	record(text: string): number {
		const found = linksIn(text);
		for (const link of found) {
			this.counter += 1;
			const known = this.links.get(link.key);
			this.links.set(link.key, { ...link, lastSeen: this.counter, mentions: (known?.mentions ?? 0) + 1 });
		}
		return found.length;
	}

	/** The pins a previous `session_branch` stored, restored on rebuild. */
	setPins(pins: readonly string[]): void {
		this.pinList = [...pins];
	}

	/** The pin keys to store again when one changes. */
	get pins(): string[] {
		return [...this.pinList];
	}

	isPinned(key: string): boolean {
		return this.pinList.includes(key);
	}

	/** Pins or unpins a key; returns whether it is pinned now. */
	togglePin(key: string): boolean {
		this.pinList = this.isPinned(key) ? this.pinList.filter((k) => k !== key) : [key, ...this.pinList];
		return this.isPinned(key);
	}

	/** Pinned first (in pin order), then the rest by most recent mention. */
	ordered(): SessionLink[] {
		const all = [...this.links.values()].sort((a, b) => b.lastSeen - a.lastSeen);
		const pinned = this.pinList.map((key) => this.links.get(key)).filter((link): link is SessionLink => link !== undefined);
		return [...pinned, ...all.filter((link) => !this.isPinned(link.key))];
	}

	/** Widget line for a link: pin marker, label, then state and title once `gh` has answered. */
	describe(link: SessionLink, info?: LinkDetails): string {
		const pin = this.isPinned(link.key) ? "📌 " : "";
		const state = info?.state ? ` [${info.state}]` : "";
		const title = info?.title ? ` ${truncate(info.title, TITLE_WIDTH)}` : "";
		return `${pin}${link.label}${state}${title}`;
	}

	size(): number {
		return this.links.size;
	}

	/** A new, resumed, forked or navigated session starts from a clean list. */
	reset(): void {
		this.links.clear();
		this.counter = 0;
		this.pinList = [];
	}
}
