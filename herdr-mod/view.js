// Pure logic for the session context panel: which file the focused terminal has, whether what we hold for it is
// current, stale or someone else's, and the status line. The OMP extension `session-context` writes the files.

/** "host/t1r" → {machine: "host", id: "t1r"}; a bare address is this computer's. */
export function splitAddress(address) {
  const slash = address.lastIndexOf("/");
  return slash < 0 ? { machine: null, id: address } : { machine: address.slice(0, slash), id: address.slice(slash + 1) };
}

export function contextPath(dir, id) {
  return `${dir}/${id.replace(/[^\w.-]/g, "_")}.json`;
}

/** Written by verdict.ts: the session's current verdict, "good" or "bad"; absent when none. */
export function verdictPath(dir, sessionId) {
  return `${dir}/verdicts/${sessionId.replace(/[^\w.-]/g, "_")}`;
}

export function parseContext(text) {
  try {
    const context = JSON.parse(text);
    return context?.version === 1 ? context : null;
  } catch {
    return null;
  }
}

/** "5m ago", "2h ago", "3d ago". */
export function ago(ms, now) {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * What the panel draws for `terminal`:
 * - "none": no terminal, or no (readable) context file — not an OMP session here.
 * - "context": the file just read.
 * - "offline": the machine didn't answer; `context` is the last good one only if it is this terminal's.
 */
export function panelState({ terminal, text = null, error = null, lastGood = null, pending = false, now }) {
  if (!terminal) return { kind: "none", context: null, stale: false, ageText: null };
  if (pending && text === null && !error) return { kind: "loading", context: null, stale: false, ageText: null };
  if (error) {
    const context = lastGood?.terminal === terminal ? lastGood.context : null;
    return { kind: "offline", context, stale: true, ageText: context ? ago(Date.parse(context.updatedAt), now) : null };
  }
  const context = text === null ? null : parseContext(text);
  if (!context) return { kind: "none", context: null, stale: false, ageText: null };
  return { kind: "context", context, stale: false, ageText: ago(Date.parse(context.updatedAt), now) };
}

/**
 * The first line: what the agent is doing, or what it needs from you. No agent status means OMP is gone from the
 * terminal without its shutdown (killed, crashed, ssh dropped): the file then describes the last moment it was seen.
 */
export function statusLine(agentStatus, context, workingSince, now) {
  if (context?.ended) return "Session ended";
  if (!agentStatus) return context ? `Not running · last seen ${ago(Date.parse(context.updatedAt), now)}` : "Not running";
  if (context?.waiting) return `Waiting: ${context.waiting.text}`;
  if (agentStatus === "blocked") return "Waiting for you";
  if (agentStatus === "done") return "Finished — review";
  if (agentStatus === "working") return workingSince ? `Working for ${span(now - workingSince)}` : "Working";
  return "Idle";
}

/** The last reply is worth reading whenever the agent sits still: Herdr's `done` turns `idle` as soon as one looks. */
export function showsLastReply(agentStatus, context) {
  return Boolean(context?.lastReply) && !context.ended && (agentStatus === "done" || agentStatus === "idle");
}
