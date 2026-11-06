import { expect, test } from "bun:test";

import { lines, Relay } from "../src/relay.ts";
import { fakeClock, fakeRunner, newWorld, sent } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

const setup = (status: string | undefined, settleMs = 0, burstKey?: RegExp) => {
  const world = newWorld();
  world.panes = [{ pane_id: "lead:p1", workspace_id: "lead", agent: "omp", ...(status ? { agent_status: status } : {}) }];
  const clock = fakeClock(T0);
  const relay = new Relay({ run: fakeRunner(world), clock, pane: "lead:p1", filter: /^LANE_/, settleMs, ...(burstKey ? { burstKey } : {}) });
  return { world, relay, clock };
};

test("a working lead is typed into, a blocked one never: lines wait out a dialog, then go out once, together and in order", async () => {
  // omp reads a message typed mid-turn as an interjection, so a lead waiting on a long background job still hears it.
  const { world, relay } = setup("blocked");
  for (const line of ["LANE_WATCH_READY", "checking 3 lanes", "LANE_DONE_CLAIMED fix-login"]) relay.offer(line);
  expect(await relay.flush()).toBe(2);
  expect(sent(world)).toEqual([]);
  world.panes[0]!.agent_status = "working";
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toEqual(["LANE_WATCH_READY\nLANE_DONE_CLAIMED fix-login"]);
  // A line that went out is never typed again.
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toHaveLength(1);
});

test("a lead pane with no live agent keeps the lines, and they go out in order once it is back", async () => {
  const { world, relay } = setup(undefined);
  relay.offer("LANE_DONE_CLAIMED a");
  relay.offer("LANE_CLOSED a");
  expect(await relay.flush()).toBe(2);
  expect(sent(world)).toEqual([]);
  world.panes[0]!.agent_status = "idle";
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toEqual(["LANE_DONE_CLAIMED a\nLANE_CLOSED a"]);
});

test("backticks and $( in a relayed line are defused, so the line still arrives", async () => {
  const { world, relay } = setup("idle");
  relay.offer("LANE_NOT_DONE a: run `make` then $(cat x)");
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toEqual(["LANE_NOT_DONE a: run 'make' then $ (cat x)"]);
});

test("lines() splits chunks on newlines, across chunk edges and multi-byte characters, and keeps a last line without one", async () => {
  const bytes = new TextEncoder().encode("LANE_A 한글\r\nLANE_B\nlast");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 9));
      controller.enqueue(bytes.slice(9));
      controller.close();
    },
  });
  const got: string[] = [];
  for await (const line of lines(stream)) got.push(line);
  expect(got).toEqual(["LANE_A 한글", "LANE_B", "last"]);
});

test("a flush on an empty queue does not stall the relay: a line offered afterwards still goes out", async () => {
  // The relay retries every 5 s, so in practice the queue is almost always empty when a flush runs.
  const { world, relay } = setup("idle");
  expect(await relay.flush()).toBe(0);
  expect(await relay.flush()).toBe(0);
  relay.offer('LANE_DONE_CLAIMED second-lane');
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toEqual(['LANE_DONE_CLAIMED second-lane']);
});

test("a sender seen for the first time waits the settle window: one line goes out once they have been quiet that long", async () => {
  const { world, relay, clock } = setup("idle", 6_000);
  relay.offer("LANE_A 회의");
  clock.at += 5_999;
  expect(await relay.flush()).toBe(1);
  clock.at += 1;
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toEqual(["LANE_A 회의"]);
});

test("someone who sends short lines quickly is answered quickly: the wait follows their own pace, as one message", async () => {
  const { world, relay, clock } = setup("idle", 6_000);
  relay.offer("LANE_A 회의");
  clock.at += 1_000;
  relay.offer("LANE_A 금요일에");
  clock.at += 1_000;
  relay.offer("LANE_A 가능하세요?");
  // Their gap is 1 s, so 2 s of quiet is enough (never less than a third of the 6 s window).
  clock.at += 1_999;
  expect(await relay.flush()).toBe(3);
  expect(relay.dueIn()).toBe(1);
  clock.at += 1;
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toEqual(["LANE_A 회의\nLANE_A 금요일에\nLANE_A 가능하세요?"]);
});

test("someone who types slowly gets a longer wait, up to twice the settle window", async () => {
  const { world, relay, clock } = setup("idle", 6_000);
  relay.offer("LANE_A 그게");
  clock.at += 5_000;
  relay.offer("LANE_A 제 생각에는");
  clock.at += 5_000;
  relay.offer("LANE_A 좀 어려울 것 같아요");
  // Their gap is 5 s: 6 s of quiet is not enough, 10 s is.
  clock.at += 9_999;
  expect(await relay.flush()).toBe(3);
  expect(sent(world)).toEqual([]);
  clock.at += 1;
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toHaveLength(1);
});

test("a burst that never pauses still goes out once six settle windows have passed since its first line", async () => {
  const { world, relay, clock } = setup("idle", 6_000);
  for (let i = 0; i < 8; i++) {
    relay.offer(`LANE_A ${i}`);
    expect(await relay.flush()).toBe(i + 1);
    if (i < 7) clock.at += 5_000;
  }
  // The last line came 1 s ago, but the first came 36 s ago.
  clock.at += 1_000;
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toHaveLength(1);
});

test("in a busy chat each sender settles on their own: one who has finished is not held back by one still typing", async () => {
  // One group: the sender only, so no turn-taking applies and each sender waits out their own window.
  const { world, relay, clock } = setup("idle", 6_000, /^LANE_\w+ (\w+)/);
  relay.offer("LANE_room A 점심"); // 0 s
  clock.at += 2_000;
  relay.offer("LANE_room B 저는"); // 2 s
  clock.at += 1_000;
  relay.offer("LANE_room A 뭐 먹어요?"); // 3 s: A's pace is 3 s, so A is done after 6 s of quiet
  clock.at += 2_000;
  relay.offer("LANE_room B 아무거나"); // 5 s
  clock.at += 3_000;
  relay.offer("LANE_room B 좋아요"); // 8 s: B is still typing
  expect(await relay.flush()).toBe(5);
  clock.at += 1_000; // 9 s
  expect(await relay.flush()).toBe(3);
  expect(sent(world)).toEqual(["LANE_room A 점심\nLANE_room A 뭐 먹어요?"]);
  clock.at += 12_000;
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toEqual(["LANE_room A 점심\nLANE_room A 뭐 먹어요?", "LANE_room B 저는\nLANE_room B 아무거나\nLANE_room B 좋아요"]);
});

test("a sender's next burst starts fresh once their last one went out", async () => {
  const { world, relay, clock } = setup("idle", 6_000, /^LANE_(\w+) (\w+)/);
  relay.offer("LANE_room A 하나");
  clock.at += 6_000;
  expect(await relay.flush()).toBe(0);
  clock.at += 60_000;
  relay.offer("LANE_room A 둘");
  // A burst that ended a minute ago must not count toward the cap of this one.
  expect(await relay.flush()).toBe(1);
  clock.at += 6_000;
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toEqual(["LANE_room A 하나", "LANE_room A 둘"]);
});

test("in a conversation, someone else speaking ends the earlier speaker's turn: their lines go out without waiting", async () => {
  const { world, relay, clock } = setup("idle", 6_000, /^LANE_(\w+) (\w+)/);
  relay.offer("LANE_room A 점심");
  clock.at += 1_000;
  relay.offer("LANE_room A 뭐 먹어요?");
  relay.offer("LANE_other C 다른 방"); // another room does not end A's turn
  expect(await relay.flush()).toBe(3);
  clock.at += 1_000;
  relay.offer("LANE_room B 김치찌개요");
  expect(await relay.flush()).toBe(2);
  expect(sent(world)).toEqual(["LANE_room A 점심\nLANE_room A 뭐 먹어요?"]);
  // A speaks again: B's turn is over, A's new burst waits for A.
  clock.at += 1_000;
  relay.offer("LANE_room A 좋아요");
  expect(await relay.flush()).toBe(2);
  expect(sent(world)).toEqual(["LANE_room A 점심\nLANE_room A 뭐 먹어요?", "LANE_room B 김치찌개요"]);
});
