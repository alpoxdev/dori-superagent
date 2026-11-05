import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { statusLookup } from "../panes.ts";
import type { Runner } from "../run.ts";
import type { TgTarget } from "./telegram.ts";

type Entry = { readonly chatId: number | string; readonly threadId?: number; readonly inboundAt: number; readonly repliedAt?: number };

const keyOf = (t: TgTarget): string => `${t.chatId}/${t.threadId ?? "-"}`;

/**
 * When the owner last wrote in each chat, and when the Dori last answered there. `dori inbound telegram` records the
 * first, `dori send telegram` the second, so `dori typing telegram` knows which chats still wait for an answer. The
 * writers are separate processes: each write re-reads the file and replaces it whole (temp file + rename).
 */
export class TypingLedger {
  constructor(readonly path: string) {}

  private read(): Record<string, Entry> {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, Entry>) : {};
    } catch {
      return {};
    }
  }

  private write(entries: Record<string, Entry>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  inbound(t: TgTarget, at: number): void {
    const entries = this.read();
    entries[keyOf(t)] = { ...entries[keyOf(t)], chatId: t.chatId, ...(t.threadId ? { threadId: t.threadId } : {}), inboundAt: at };
    this.write(entries);
  }

  /** A reply without a thread answers every thread of that chat; a reply in a thread answers that thread only. */
  replied(t: TgTarget, at: number): void {
    const entries = this.read();
    let changed = false;
    for (const [key, e] of Object.entries(entries)) {
      if (String(e.chatId) !== String(t.chatId) || (t.threadId && e.threadId !== t.threadId)) continue;
      entries[key] = { ...e, repliedAt: at };
      changed = true;
    }
    if (changed) this.write(entries);
  }

  /** Chats whose last owner message is newer than the last answer and at most maxMs old. */
  waiting(now: number, maxMs: number): TgTarget[] {
    return Object.values(this.read())
      .filter((e) => e.inboundAt > (e.repliedAt ?? 0) && now - e.inboundAt <= maxMs)
      .map((e) => ({ chatId: e.chatId, ...(e.threadId ? { threadId: e.threadId } : {}) }));
  }
}

export type TypingDeps = {
  readonly run: Runner;
  readonly ledger: TypingLedger;
  readonly typing: (t: TgTarget) => Promise<void>;
  readonly pane: string;
  readonly now: number;
  readonly maxMs: number;
};

/**
 * One pass of the typing indicator: while an owner message waits for an answer and the lead's agent is working on it,
 * Telegram shows the Dori as typing. Telegram clears the indicator after about 5 seconds, so the caller repeats this
 * every 4. An idle, blocked or vanished lead shows nothing: a turn that ended without an answer must not keep typing.
 */
export const typingTick = async (d: TypingDeps): Promise<TgTarget[]> => {
  const waiting = d.ledger.waiting(d.now, d.maxMs);
  if (waiting.length === 0) return [];
  if ((await statusLookup(d.run, d.pane)).status !== "working") return [];
  for (const t of waiting) await d.typing(t);
  return waiting;
};
