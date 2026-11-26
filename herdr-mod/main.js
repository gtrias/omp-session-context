// Session context: what the focused OMP agent is doing, for switching back into it. A side block (layout id
// `session-context`, F6 toggles it); the palette entry opens a launcher copy that toggles the block and closes.
// Data: `<state>/omp-session-context/<terminal>.json`, written on the agent's machine by the OMP extension
// `session-context`; the verdict buttons run its `verdict.ts` there.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, checking, closeOverlay, exec, focused, props, readTextFile, run, spaces, theme, window } from "herdr";
import { contextPath, linkTone, panelState, parentAddress, parentLine, showsLastReply, splitAddress, statChips, statusLine, verdictPath } from "./view.js";

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

    const label = (text) => div().text_size(10.5).font_medium().text_color(t.dim).child(text.toUpperCase());
    const section = (title, body) => v_flex().gap(6).child(label(title)).child(body);
    const root = v_flex().id("session-context").size_full().bg(t.chrome).text_size(12.5).text_color(t.foreground);
    const close = div().id("sc-close").flex_shrink_0().text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .child("✕").on_click(() => run("layout.hide", { id: BLOCK }));

    if (!c) {
      const message = state.kind === "offline" ? `Machine unreachable: ${this.error}` : state.kind === "loading" ? "Loading…" : "No OMP context for this terminal";
      return root
        .child(h_flex().px(16).py(12).border_b(1).border_color(t.border).justify_between().items_center()
          .child(div().font_semibold().text_size(14).child("Session context")).child(close))
        .child(div().p(16).text_color(state.kind === "offline" ? t.blocked : t.dim).child(message));
    }

    const status = statusLine(agent?.status ?? null, c, tab?.working_since ?? null, now);
    const gone = !agent && !c.ended;
    const statusColor = gone ? t.dim : c.waiting || agent?.status === "blocked" ? t.blocked : agent?.status === "working" ? t.working : agent?.status === "done" ? t.done : t.muted;
    const todo = c.todo;
    const verdict = this.currentVerdict ?? null;
    const verdictLink = (value, text) => div().id(`sc-verdict-${value}`).px(8).py(2).rounded(5).cursor_pointer()
      .text_color(verdict === value ? (value === "good" ? t.done : t.blocked) : t.dim)
      .when(verdict === value, (el) => el.bg(t.raised))
      .hover((s) => s.text_color(t.foreground))
      .child(text)
      .on_click((_e, cx) => this.verdict(c.sessionId, verdict === value ? "clear" : value, cx));

    // Orientation: what this session is, whether it needs me, and where it came from.
    const header = v_flex().px(16).pt(14).pb(12).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(10).justify_between().items_start()
        .child(div().flex_1().min_w_0().font_semibold().text_size(15).line_height("20px").child(c.title ?? "Untitled session"))
        .child(close))
      .child(h_flex().gap(8).items_center().flex_wrap()
        .child(h_flex().gap(6).items_center().px(8).py(2).rounded_full().bg(t.raised)
          .child(div().size(7).rounded_full().bg(statusColor))
          .child(div().text_size(11.5).font_medium().text_color(statusColor).child(status)))
        .child(div().text_size(11).text_color(t.dim).child(`updated ${state.ageText}`)))
      .when(Boolean(c.parent), (el) => el.child(h_flex().id("sc-parent").gap(6).items_center().cursor_pointer()
        .text_size(11.5).text_color(t.muted).hover((s) => s.text_color(t.foreground))
        .child(div().text_color(t.accent).child("↖"))
        .child(div().child(`from ${parentLine(c.parent)}`))
        .on_click(() => run("agent.focus", { terminal: parentAddress(this.terminal, c.parent.terminalId) }))));

    const body = v_flex().id("sc-body").flex_1().overflow_y_scroll().px(16).pt(16).pb(20).gap(22)
      .when(state.stale || gone, (el) => el.opacity(0.6))
      .child(section("You asked", v_flex().gap(8)
        .child(div().text_size(13.5).line_height("20px").child(c.ask.first ?? "—"))
        .when(Boolean(c.ask.last), (el) => el.child(div().text_color(t.muted).line_height("18px").child(`Latest: ${c.ask.last}`)))))
      .when(Boolean(todo), (el) => el.child(v_flex().gap(8)
        .child(h_flex().justify_between().items_center()
          .child(label("Progress"))
          .child(div().text_size(11).text_color(todo.done === todo.total ? t.done : t.muted).child(`${todo.done} of ${todo.total}`)))
        .child(h_flex().h(4).w_full().rounded_full().bg(t.border)
          .child(div().h_full().rounded_full().bg(todo.done === todo.total ? t.done : t.accent).w(`${todo.total ? Math.round((todo.done / todo.total) * 100) : 0}%`)))
        .when(Boolean(todo.current), (el) => el.child(div().font_medium().child(todo.current)))
        .when(Boolean(todo.next), (el) => el.child(div().text_color(t.dim).child(`Next: ${todo.next}`)))
        .child(div().id("sc-phases").text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.accent))
          .child(this.phasesOpen ? "Hide tasks" : "Show tasks")
          .on_click((_e, cx) => { this.phasesOpen = !this.phasesOpen; cx.notify(); }))
        .when(this.phasesOpen, (el) => el.children(todo.phases.map((p) => v_flex().gap(3)
          .child(div().text_color(t.muted).child(p.name))
          .children(p.tasks.map((task) => div().text_color(task.status === "completed" || task.status === "abandoned" ? t.dim : t.foreground)
            .child(`${{ completed: "✓", abandoned: "✗", in_progress: "▶" }[task.status] ?? "·"} ${task.content}`))))))))
      .when(showsLastReply(agent?.status ?? null, c), (el) => el.child(section("Last reply",
        div().p(10).rounded(6).bg(t.raised).text_color(t.muted).line_height("18px").child(c.lastReply))))
      .when(c.links.length > 0, (el) => el.child(section("Links", v_flex().gap(8).children(c.links.map((link, i) =>
        v_flex().id(`sc-link-${i}`).gap(2).cursor_pointer().hover((s) => s.opacity(0.8))
          .child(h_flex().gap(8).items_center()
            .child(div().font_medium().text_color(t.accent).child(`${link.pinned ? "📌 " : ""}${link.label}`))
            .when(Boolean(link.state), (el) => el.child(div().px(6).rounded(4).border_1().border_color(t[linkTone(link.state)])
              .text_size(10.5).text_color(t[linkTone(link.state)]).child(link.state))))
          .when(Boolean(link.title), (el) => el.child(div().text_color(t.muted).child(link.title)))
          .on_click(() => { exec("xdg-open", [link.url], { timeout: 10_000 }).catch(() => {}); }))))))
      .when(c.tasks.length > 0, (el) => el.child(section("Tasks", div().text_color(t.muted).child(c.tasks.join("  ")))))
      .child(v_flex().gap(10).pt(14).border_t(1).border_color(t.border)
        .child(h_flex().gap(6).flex_wrap().children(statChips(c.stats).map((chip) =>
          div().px(7).py(2).rounded(4).bg(t.raised).text_size(11).text_color(t[chip.tone]).child(chip.text))))
        .child(div().text_size(11).text_color(t.dim).child([c.cwd, c.branch].filter(Boolean).join(" · ")))
        .child(h_flex().gap(4).items_center()
          .child(div().text_size(11).text_color(t.dim).mr(4).child("Did it work?"))
          .child(verdictLink("good", "Yes"))
          .child(verdictLink("bad", "No")))
        .when(Boolean(this.verdictError), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.verdictError))));

    return root.child(header).child(body);
  }
}
