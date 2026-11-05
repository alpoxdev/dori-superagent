import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { TgTarget } from "../src/messenger/telegram.ts";
import { TypingLedger, typingTick } from "../src/messenger/typing-ledger.ts";
import { fakeRunner, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MAX = 15 * 60_000;
const OWNER = 1314731072;
let state = withState();
afterEach(() => {
  state.done();
  state = withState();
});

const rig = (status: string | undefined) => {
  const world = newWorld();
  world.panes = [{ pane_id: "lead:p1", workspace_id: "lead", agent: "omp", ...(status ? { agent_status: status } : {}) }];
  const ledger = new TypingLedger(join(state.dir, "telegram-typing.json"));
  const typed: TgTarget[] = [];
  const tick = (now: number) => typingTick({ run: fakeRunner(world), ledger, typing: async (t) => void typed.push(t), pane: "lead:p1", now, maxMs: MAX });
  return { world, ledger, typed, tick };
};

test("an unanswered owner message shows typing while the lead works, and the reply stops it", async () => {
  const { ledger, typed, tick } = rig("working");
  expect(await tick(T0)).toEqual([]);
  ledger.inbound({ chatId: OWNER }, T0);
  expect(await tick(T0 + 4_000)).toEqual([{ chatId: OWNER }]);
  ledger.replied({ chatId: String(OWNER) }, T0 + 8_000);
  expect(await tick(T0 + 12_000)).toEqual([]);
  expect(typed).toEqual([{ chatId: OWNER }]);
  // The next owner message waits again.
  ledger.inbound({ chatId: OWNER }, T0 + 20_000);
  expect(await tick(T0 + 24_000)).toEqual([{ chatId: OWNER }]);
});

test("a lead that is idle, blocked or gone shows nothing, even with a message waiting", async () => {
  for (const status of ["idle", "blocked", undefined]) {
    const { ledger, typed, tick } = rig(status);
    ledger.inbound({ chatId: OWNER }, T0);
    expect(await tick(T0 + 1_000)).toEqual([]);
    expect(typed).toEqual([]);
  }
});

test("a message older than the limit stops typing; a threadless reply answers every thread of that chat", async () => {
  const { ledger, tick } = rig("working");
  ledger.inbound({ chatId: OWNER }, T0);
  expect(await tick(T0 + MAX + 1)).toEqual([]);
  ledger.replied({ chatId: OWNER }, T0 + 1);
  ledger.inbound({ chatId: -100, threadId: 7 }, T0);
  ledger.inbound({ chatId: -100, threadId: 9 }, T0);
  ledger.replied({ chatId: -100, threadId: 7 }, T0 + 1);
  expect(await tick(T0 + 2)).toEqual([{ chatId: -100, threadId: 9 }]);
  ledger.replied({ chatId: -100 }, T0 + 3);
  expect(await tick(T0 + 4)).toEqual([]);
});
