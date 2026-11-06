import { sendVerified, statusLookup } from "./panes.ts";
import type { Clock, Runner } from "./run.ts";

/**
 * Wakes a pane's agent with the lines a long-running command prints. omp has no line-filtered monitor: a background
 * job reports only when it ends, so `dori watch`, the inbound loops and the sweeps would never reach the lead. The
 * relay runs the command, echoes all of its output, and types the lines that match the filter into the pane, in order.
 *
 * `settleMs` holds a burst together: people send one thought as several short messages a few seconds apart, and an
 * agent woken by the first one answers it before the rest arrive. With a settle window, queued lines wait until no new
 * matching line has come for that long (at most six windows from the first, so a chat that never pauses still gets
 * through), then go out as one message. 0 sends as soon as the agent can read.
 */
export type RelayDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly pane: string;
  readonly filter: RegExp;
  readonly settleMs?: number;
};

// sendVerified refuses a backtick or `$(` (a pane that turns out to be a shell would run them). A relayed line is data,
// so those are defused instead of dropped: an owner message that quotes code still arrives.
export const relayText = (line: string): string => line.replace(/`/g, "'").replace(/\$\(/g, "$ (");

export class Relay {
  private readonly pending: string[] = [];
  private flushing: Promise<number> | null = null;
  private firstAt = 0;
  private lastAt = 0;

  constructor(readonly deps: RelayDeps) {}

  /** Queues the line when it matches the filter. Lines that do not match are only echoed by the caller. */
  offer(line: string): boolean {
    if (!this.deps.filter.test(line)) return false;
    const now = this.deps.clock.now();
    if (this.pending.length === 0) this.firstAt = now;
    this.lastAt = now;
    this.pending.push(relayText(line));
    return true;
  }

  get waiting(): number {
    return this.pending.length;
  }

  /** True while a burst is still arriving: the settle window since the last line has not passed. */
  get settling(): boolean {
    const settle = this.deps.settleMs ?? 0;
    if (settle <= 0 || this.pending.length === 0) return false;
    const now = this.deps.clock.now();
    return now - this.lastAt < settle && now - this.firstAt < settle * 6;
  }

  /**
   * Sends the queued lines while the pane's agent is ready to read; returns how many are left. Text typed into an omp
   * that is mid-turn can be lost (it lands in whatever the turn has in front), so lines go out only when the agent
   * reports idle or done and the burst has settled; until then they wait and the next flush tries again. Everything
   * queued by then goes out as one message, one line each, in order, so the agent reads a burst together and answers it
   * once. A message is typed once: "unconfirmed" (the agent did not visibly pick it up) counts as sent, because typing it
   * again could deliver it twice. Only "failed" (no live agent, a shell in front, the terminal refused the text) keeps
   * the lines. Concurrent calls share one pass.
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
    while (this.pending.length > 0 && !this.settling) {
      const { status } = await statusLookup(this.deps.run, this.deps.pane);
      if (status !== "idle" && status !== "done") break;
      const batch = this.pending.slice();
      if ((await sendVerified(this.deps.run, this.deps.clock, this.deps.pane, batch.join("\n"))) === "failed") break;
      this.pending.splice(0, batch.length);
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
