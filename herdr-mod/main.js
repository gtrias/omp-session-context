// Session context: what the focused OMP agent is doing, for switching back into it. A side block (layout id
// `session-context`, F6 toggles it); the palette entry opens a launcher copy that toggles the block and closes.
// Data: `<state>/omp-session-context/<terminal>.json`, written on the agent's machine by the OMP extension
// `session-context`; the verdict buttons run its `verdict.ts` there.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, checking, closeOverlay, exec, focused, props, readTextFile, run, spaces, theme, window } from "herdr";
import { contextPath, panelState, showsLastReply, splitAddress, statusLine, verdictPath } from "./view.js";

const BLOCK = "session-context";
const POLL_MS = 3_000;
const SYNC_MS = 300;
const STATE_DIRS = new Map();

/** Where the extension writes on `machine` (null = this computer): `$XDG_STATE_HOME` or `~/.local/state`. */
async function stateDir(machine) {
  const key = machine ?? "";
  if (STATE_DIRS.has(key)) return STATE_DIRS.get(key);
  const r = await exec("sh", ["-c", 'printf %s "${XDG_STATE_HOME:-$HOME/.local/state}/omp-session-context"'], { on: machine, timeout: 10_000 });
  const dir = r.stdout.trim();
  if (r.code !== 0 || !dir) throw new Error(r.stderr.trim() || `cannot resolve state dir (exit ${r.code})`);
  STATE_DIRS.set(key, dir);
  return dir;
}

// The extension is installed (usually symlinked) at ~/.omp/agent/extensions/session-context; bun may live in ~/.bun/bin.
const RUN_VERDICT = 'PATH="$HOME/.bun/bin:$PATH" exec bun "$HOME/.omp/agent/extensions/session-context/verdict.ts" "$@"';

export default class SessionContext extends View {
  init(_props, cx) {
    this.terminal = null;
    this.text = null;
    this.error = null;
    this.lastGood = null;
    // Each read carries a number; only the newest one for the focused terminal lands.
    this.readSeq = 0;
    this.phasesOpen = false;
    this.verdictError = null;
    if (checking()) return;
    const overlay = props()?.overlay;
    if (overlay) {
      // Opened by `mod.open session-context` (the palette): toggle the block instead.
      this.launcher = true;
      run("layout.toggle", { id: BLOCK });
      closeOverlay(overlay);
      return;
    }
    // Focus moves often: check it cheaply and re-read at once when it changes.
    cx.timer.every(SYNC_MS, (cx) => {
      const terminal = focused()?.terminal ?? null;
      if (terminal === this.terminal) return;
      this.terminal = terminal;
      this.text = null;
      this.error = null;
      this.phasesOpen = false;
      this.verdictError = null;
      this.currentVerdict = null;
      cx.notify();
      cx.spawn(async (cx) => { await this.read(cx); });
    });
    cx.timer.every(POLL_MS, (cx) => {
      if (!window()?.visible) return;
      cx.spawn(async (cx) => { await this.read(cx); });
    });
  }

  /** Reads the focused terminal's context file on its machine. A newer read or a focus change discards this one. */
  async read(cx) {
    const terminal = this.terminal;
    if (!terminal) return;
    const seq = ++this.readSeq;
    const current = () => seq === this.readSeq && terminal === this.terminal;
    const { machine, id } = splitAddress(terminal);
    try {
      const dir = await stateDir(machine);
      const text = await readTextFile(contextPath(dir, id), { on: machine });
      const context = panelState({ terminal, text, now: Date.now() }).context;
      const verdict = context ? await readTextFile(verdictPath(dir, context.sessionId), { on: machine }) : null;
      if (!current()) return;
      this.text = text;
      this.error = null;
      this.loaded = terminal;
      this.currentVerdict = verdict?.trim() || null;
      if (context) this.lastGood = { terminal, context };
    } catch (err) {
      if (!current()) return;
      this.error = String(err?.message ?? err);
      this.loaded = terminal;
    } finally {
      cx.notify();
    }
  }

  verdict(sessionId, value, cx) {
    const terminal = this.terminal;
    const { machine } = splitAddress(terminal);
    this.verdictError = null;
    cx.spawn(async (cx) => {
      let error = null;
      let verdict = null;
      try {
        const r = await exec("sh", ["-c", RUN_VERDICT, "sh", sessionId, value], { on: machine, timeout: 15_000 });
        if (r.code !== 0) error = (r.stderr || r.stdout).trim() || `exit ${r.code}`;
        else verdict = JSON.parse(r.stdout).verdict;
      } catch (err) {
        error = String(err?.message ?? err);
      }
      // The person may have moved to another agent meanwhile: the result belongs to the one clicked.
      if (terminal !== this.terminal) return;
      this.readSeq += 1;
      this.verdictError = error;
      if (!error) this.currentVerdict = verdict;
      cx.notify();
    });
  }

  render() {
    if (this.launcher || checking()) return div();
    const t = theme();
    const now = Date.now();
    const pending = this.loaded !== this.terminal;
    const state = panelState({ terminal: this.terminal, text: this.text, error: this.error, lastGood: this.lastGood, pending, now });
    const c = state.context;
    const agent = agents().find((a) => a.address === this.terminal);
    const tab = agent && spaces().flatMap((s) => s.tabs).find((tb) => tb.id === agent.tab);

    const section = (title, body) => v_flex().gap(4)
      .child(div().text_size(11).text_color(t.dim).child(title.toUpperCase()))
      .child(body);
    const root = v_flex().id("session-context").size_full().bg(t.chrome).text_size(12.5).text_color(t.foreground);
    const header = h_flex().px(14).py(10).border_b(1).border_color(t.border).justify_between().items_center()
      .child(div().font_semibold().text_size(14).child(c?.title ?? "Session context"))
      .child(div().id("sc-close").text_color(t.dim).cursor_pointer().child("✕").on_click(() => run("layout.hide", { id: BLOCK })));

    if (!c) {
      const message = state.kind === "offline" ? `Machine unreachable: ${this.error}` : state.kind === "loading" ? "Loading…" : "No OMP context for this terminal";
      return root.child(header).child(div().p(14).text_color(state.kind === "offline" ? t.blocked : t.dim).child(message));
    }

    const status = statusLine(agent?.status ?? null, c, tab?.working_since ?? null, now);
    const gone = !agent && !c.ended;
    const statusColor = gone ? t.dim : c.waiting || agent?.status === "blocked" ? t.blocked : agent?.status === "working" ? t.working : agent?.status === "done" ? t.done : t.muted;
    const todo = c.todo;
    const bar = todo && h_flex().h(6).w_full().rounded_full().bg(t.border)
      .child(div().h_full().rounded_full().bg(t.accent).w(`${todo.total ? Math.round((todo.done / todo.total) * 100) : 0}%`));
    const stats = c.stats;
    const testsText = stats.tests.status === "none" ? "no tests" : `tests ${stats.tests.status}`;
    const verdict = this.currentVerdict ?? null;
    const verdictButton = (value, label, color) => div().id(`sc-verdict-${value}`).px(10).py(4).rounded(6).border_1()
      .border_color(verdict === value ? color : t.border).text_color(verdict === value ? color : t.muted).cursor_pointer()
      .child(label)
      .on_click((_e, cx) => this.verdict(c.sessionId, verdict === value ? "clear" : value, cx));

    const body = v_flex().id("sc-body").flex_1().overflow_y_scroll().gap(16).p(14)
      .when(state.stale || gone, (el) => el.opacity(0.6))
      .child(v_flex().gap(4)
        .child(div().font_semibold().text_color(statusColor).child(status))
        .child(div().text_size(11).text_color(t.dim).child([c.cwd, c.branch].filter(Boolean).join(" · ") + ` · updated ${state.ageText}`)))
      .child(section("You asked", v_flex().gap(6)
        .child(div().child(c.ask.first ?? "—"))
        .when(Boolean(c.ask.last), (el) => el.child(div().text_color(t.muted).child(`Latest: ${c.ask.last}`)))))
      .when(showsLastReply(agent?.status ?? null, c), (el) => el.child(section("Last reply", div().text_color(t.muted).child(c.lastReply))))
      .when(Boolean(todo), (el) => el.child(section(`Todo ${todo.done}/${todo.total}`, v_flex().gap(6)
        .child(bar)
        .when(Boolean(todo.current), (el) => el.child(div().font_semibold().child(`▶ ${todo.current}`)))
        .when(Boolean(todo.next), (el) => el.child(div().text_color(t.dim).child(`Next: ${todo.next}`)))
        .child(div().id("sc-phases").text_size(11).text_color(t.accent).cursor_pointer()
          .child(this.phasesOpen ? "Hide all tasks" : "Show all tasks")
          .on_click((_e, cx) => { this.phasesOpen = !this.phasesOpen; cx.notify(); }))
        .when(this.phasesOpen, (el) => el.children(todo.phases.map((p) => v_flex().gap(2)
          .child(div().text_color(t.muted).child(p.name))
          .children(p.tasks.map((task) => div().text_color(task.status === "completed" || task.status === "abandoned" ? t.dim : t.foreground)
            .child(`${{ completed: "✓", abandoned: "✗", in_progress: "▶" }[task.status] ?? "·"} ${task.content}`)))))))))
      .when(c.links.length > 0, (el) => el.child(section("Links", v_flex().gap(4).children(c.links.map((link, i) =>
        h_flex().id(`sc-link-${i}`).gap(6).flex_wrap().cursor_pointer()
          .child(div().text_color(t.accent).child(`${link.pinned ? "📌 " : ""}${link.label}`))
          .when(Boolean(link.state), (el) => el.child(div().text_color(t.dim).child(`[${link.state}]`)))
          .when(Boolean(link.title), (el) => el.child(div().text_color(t.muted).child(link.title)))
          .on_click(() => { exec("xdg-open", [link.url], { timeout: 10_000 }).catch(() => {}); }))))))
      .when(c.tasks.length > 0, (el) => el.child(section("Tasks", div().text_color(t.muted).child(c.tasks.join("  ")))))
      .child(section("Session", div().text_size(11.5).text_color(t.muted).child([
        stats.model ?? "model ?",
        `$${stats.cost.toFixed(2)}`,
        `${stats.corrections} corrections`,
        `${stats.toolErrors}/${stats.toolCalls} tool errors`,
        testsText,
      ].join(" · "))))
      .child(section("Did it work?", v_flex().gap(4)
        .child(h_flex().gap(8)
          .child(verdictButton("good", "Works", t.done))
          .child(verdictButton("bad", "Doesn't work", t.blocked)))
        .when(Boolean(this.verdictError), (el) => el.child(div().text_color(t.blocked).child(this.verdictError)))));

    return root.child(header).child(body);
  }
}
