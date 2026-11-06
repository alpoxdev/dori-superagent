import { sendVerified, statusLookup } from "./panes.ts";
import type { Clock, Runner } from "./run.ts";

/**
 * Wakes a pane's agent with the lines a long-running command prints. omp has no line-filtered monitor: a background
 * job reports only when it ends, so `dori watch`, the inbound loops and the sweeps would never reach the lead. The
 * relay runs the command, echoes all of its output, and types the lines that match the filter into the pane, in order.
 *
 * `settleMs` holds a burst together: people send one thought as several short messages a few seconds apart, and an
 * agent woken by the first one answers it before the rest arrive. With a settle window, a sender's lines wait until that
 * sender has sent nothing new for that long (at most six windows from their first line, so someone who never pauses
 * still gets through), then go out together. 0 sends as soon as the agent can read.
 *
 * `burstKey` says who a line is from: its capture groups, joined, name the sender. Each sender settles on their own,
 * so in a busy chat one person still typing does not hold back someone who has finished. With two or more groups the
 * first names the conversation (say the room): when someone else speaks there, the earlier speakers' turns are over and
 * their lines go out without waiting out the window. Without `burstKey` the whole stream is one sender.
 */
export type RelayDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly pane: string;
  readonly filter: RegExp;
  readonly settleMs?: number;
  readonly burstKey?: RegExp;
};

// sendVerified refuses a backtick or `$(` (a pane that turns out to be a shell would run them). A relayed line is data,
// so those are defused instead of dropped: an owner message that quotes code still arrives.
export const relayText = (line: string): string => line.replace(/`/g, "'").replace(/\$\(/g, "$ (");

type Queued = { readonly text: string; readonly key: string };
type Burst = { readonly room: string | undefined; firstAt: number; lastAt: number; ended: boolean };

export class Relay {
  private readonly pending: Queued[] = [];
  private readonly bursts = new Map<string, Burst>();
  private flushing: Promise<number> | null = null;

  constructor(readonly deps: RelayDeps) {}

  /** Queues the line when it matches the filter. Lines that do not match are only echoed by the caller. */
  offer(line: string): boolean {
    if (!this.deps.filter.test(line)) return false;
    const { key, room } = this.senderOf(line);
    const now = this.deps.clock.now();
    const burst = this.bursts.get(key);
    if (burst) {
      burst.lastAt = now;
      burst.ended = false;
    } else this.bursts.set(key, { room, firstAt: now, lastAt: now, ended: false });
    // Someone else spoke in this conversation: whoever spoke before has finished their turn.
    if (room !== undefined) for (const [other, b] of this.bursts) if (other !== key && b.room === room) b.ended = true;
    this.pending.push({ text: relayText(line), key });
    return true;
  }

  get waiting(): number {
    return this.pending.length;
  }

  private senderOf(line: string): { readonly key: string; readonly room?: string } {
    const m = this.deps.burstKey?.exec(line);
    if (!m) return { key: "" };
    const groups = m.slice(1);
    return groups.length >= 2 ? { key: groups.join(" "), room: groups[0] } : { key: groups.join(" ") };
  }

  /** True while this sender's burst is still arriving: their settle window has not passed since their last line. */
  private settling(key: string): boolean {
    const settle = this.deps.settleMs ?? 0;
    const burst = this.bursts.get(key);
    if (settle <= 0 || !burst || burst.ended) return false;
    const now = this.deps.clock.now();
    return now - burst.lastAt < settle && now - burst.firstAt < settle * 6;
  }

  /**
   * Sends the queued lines while the pane's agent is ready to read; returns how many are left. Text typed into an omp
   * that is mid-turn can be lost (it lands in whatever the turn has in front), so lines go out only when the agent
   * reports idle or done; until then they wait and the next flush tries again. Every line whose sender has settled goes
   * out in one message, one line each, in the order they came, so the agent reads a burst together and answers it once;
   * lines from a sender still typing stay for a later flush. A message is typed once: "unconfirmed" (the agent did not
   * visibly pick it up) counts as sent, because typing it again could deliver it twice. Only "failed" (no live agent, a
   * shell in front, the terminal refused the text) keeps the lines. Concurrent calls share one pass.
   */
  flush(): Promise<number> {
    // The reset is chained with .finally, which runs only after the assignment. Clearing it inside the pass itself would
    // run synchronously when the queue is empty, before the assignment, and leave a settled pass here forever: every
    // later flush would then report 0 left without sending anything.
    this.flushing ??= this.pass().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async pass(): Promise<number> {
    for (;;) {
      const ready = this.pending.filter((q) => !this.settling(q.key));
      if (ready.length === 0) break;
      const { status } = await statusLookup(this.deps.run, this.deps.pane);
      if (status !== "idle" && status !== "done") break;
      if ((await sendVerified(this.deps.run, this.deps.clock, this.deps.pane, ready.map((q) => q.text).join("\n"))) === "failed") break;
      for (const q of ready) this.pending.splice(this.pending.indexOf(q), 1);
      // A sender with nothing left starts a fresh burst next time.
      for (const key of [...this.bursts.keys()]) if (!this.pending.some((q) => q.key === key)) this.bursts.delete(key);
    }
    return this.pending.length;
  }
}

/** Splits a byte stream into lines; a final line without a newline is still yielded. */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let at = buffered.indexOf("\n");
    while (at >= 0) {
      yield buffered.slice(0, at).replace(/\r$/, "");
      buffered = buffered.slice(at + 1);
      at = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  if (buffered) yield buffered.replace(/\r$/, "");
}
