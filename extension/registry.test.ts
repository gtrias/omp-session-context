import { describe, expect, it } from "bun:test";
import { LinkRegistry } from "./registry.ts";

const GH = "https://github.com/gtrias/omp-session-context/pull/1";
const GL = "https://gitlab.com/gtrias/sunflare/-/merge_requests/86";
const LINEAR = "https://linear.app/ticketdoor/issue/TIC-5014";

describe("LinkRegistry", () => {
	it("orders by most recent mention", () => {
		const registry = new LinkRegistry();
		registry.record(`see ${GH}`);
		registry.record(`and ${GL}`);
		expect(registry.ordered().map((link) => link.label)).toEqual(["gtrias/sunflare!86", "omp-session-context#1"]);
	});

	it("counts repeat mentions of the same link", () => {
		const registry = new LinkRegistry();
		registry.record(`${GH} first`);
		expect(registry.record(`${GH} again`)).toBe(1);
		const [link] = registry.ordered();
		expect(link.mentions).toBe(2);
		expect(registry.size()).toBe(1);
	});

	it("puts pinned links first, in pin order, without duplicating them", () => {
		const registry = new LinkRegistry();
		registry.record(`${GH} ${GL} ${LINEAR}`);
		registry.togglePin("linear:tic-5014");
		registry.togglePin("gl:gtrias/sunflare!86");
		expect(registry.ordered().map((link) => link.label)).toEqual([
			"gtrias/sunflare!86",
			"TIC-5014",
			"omp-session-context#1",
		]);
	});

	it("restores stored pins with setPins and reports them back", () => {
		const registry = new LinkRegistry();
		registry.record(GH);
		registry.setPins(["gh:gtrias/omp-session-context#1"]);
		expect(registry.pins).toEqual(["gh:gtrias/omp-session-context#1"]);
		expect(registry.isPinned("gh:gtrias/omp-session-context#1")).toBe(true);
	});

	it("togglePin pins then unpins", () => {
		const registry = new LinkRegistry();
		registry.record(GH);
		expect(registry.togglePin("gh:gtrias/omp-session-context#1")).toBe(true);
		expect(registry.pins).toEqual(["gh:gtrias/omp-session-context#1"]);
		expect(registry.togglePin("gh:gtrias/omp-session-context#1")).toBe(false);
		expect(registry.pins).toEqual([]);
	});

	it("describes a link with pin marker, state and title", () => {
		const registry = new LinkRegistry();
		registry.record(GH);
		const [link] = registry.ordered();
		expect(registry.describe(link)).toBe("omp-session-context#1");
		expect(registry.describe(link, { title: "Panel: clearer hierarchy", state: "open" })).toBe(
			"omp-session-context#1 [open] Panel: clearer hierarchy",
		);
		registry.togglePin(link.key);
		expect(registry.describe(link).startsWith("📌 ")).toBe(true);
	});

	it("truncates a long title to the widget width", () => {
		const registry = new LinkRegistry();
		registry.record(GH);
		const [link] = registry.ordered();
		const line = registry.describe(link, { title: "x".repeat(100), state: "open" });
		expect(line.length).toBe("omp-session-context#1 [open] ".length + 64);
		expect(line.endsWith("…")).toBe(true);
	});

	it("reset empties the list and the pins", () => {
		const registry = new LinkRegistry();
		registry.record(GH);
		registry.togglePin("gh:gtrias/omp-session-context#1");
		registry.reset();
		expect(registry.size()).toBe(0);
		expect(registry.pins).toEqual([]);
		expect(registry.ordered()).toEqual([]);
	});
});
