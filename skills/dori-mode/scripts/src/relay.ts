import { sendVerified, statusLookup } from "./panes.ts";
import type { Clock, Runner } from "./run.ts";

/**
 * Wakes a pane's agent with the lines a long-running command prints. omp has no line-filtered monitor: a background
 * job reports only when it ends, so `dori watch`, the inbound loops and the sweeps would never reach the lead. The
 * relay runs the command, echoes all of its output, and types each line that matches the filter into the pane as a
 * message of its own, in order.
 */
export type RelayDeps = { readonly run: Runner; readonly clock: Clock; readonly pane: string; readonly filter: RegExp };

// sendVerified refuses a backtick or `$(` (a pane that turns out to be a shell would run them). A relayed line is data,
// so those are defused instead of dropped: an owner message that quotes code still arrives.
export const relayText = (line: string): string => line.replace(/`/g, "'").replace(/\$\(/g, "$ (");

export class Relay {
  private readonly pending: string[] = [];
  private flushing: Promise<number> | null = null;

  constructor(readonly deps: RelayDeps) {}

  /** Queues the line when it matches the filter. Lines that do not match are only echoed by the caller. */
  offer(line: string): boolean {
    if (!this.deps.filter.test(line)) return false;
    this.pending.push(relayText(line));
    return true;
  }

  get waiting(): number {
    return this.pending.length;
  }

  /**
   * Sends queued lines in order while the pane's agent is ready to read; returns how many are left. Text typed into an
   * omp that is mid-turn can be lost (it lands in whatever the turn has in front), so a line goes out only when the agent
   * reports idle or done; while it works, the lines wait and the next flush tries again. Each line is typed once:
   * "unconfirmed" (the agent did not visibly pick it up) counts as sent, because typing it again could deliver it twice.
   * Only "failed" (no live agent, a shell in front, the terminal refused the text) keeps it. Concurrent calls share one
   * pass.
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
    while (this.pending.length > 0) {
      const { status } = await statusLookup(this.deps.run, this.deps.pane);
      if (status !== "idle" && status !== "done") break;
      if ((await sendVerified(this.deps.run, this.deps.clock, this.deps.pane, this.pending[0]!)) === "failed") break;
      this.pending.shift();
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
