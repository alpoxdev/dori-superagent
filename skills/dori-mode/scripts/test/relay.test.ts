import { expect, test } from "bun:test";

import { lines, Relay } from "../src/relay.ts";
import { fakeClock, fakeRunner, newWorld, sent } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

const setup = (status: string | undefined) => {
  const world = newWorld();
  world.panes = [{ pane_id: "lead:p1", workspace_id: "lead", agent: "omp", ...(status ? { agent_status: status } : {}) }];
  const relay = new Relay({ run: fakeRunner(world), clock: fakeClock(T0), pane: "lead:p1", filter: /^LANE_/ });
  return { world, relay };
};

test("a working lead is never typed into: matching lines wait, then go out once each, in order, when it is idle", async () => {
  const { world, relay } = setup("working");
  for (const line of ["LANE_WATCH_READY", "checking 3 lanes", "LANE_DONE_CLAIMED fix-login"]) relay.offer(line);
  expect(await relay.flush()).toBe(2);
  expect(sent(world)).toEqual([]);
  world.panes[0]!.agent_status = "done";
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toEqual(["LANE_WATCH_READY", "LANE_DONE_CLAIMED fix-login"]);
  // A line that went out is never typed again.
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toHaveLength(2);
});

test("a lead pane with no live agent keeps the lines, and they go out in order once it is back", async () => {
  const { world, relay } = setup(undefined);
  relay.offer("LANE_DONE_CLAIMED a");
  relay.offer("LANE_CLOSED a");
  expect(await relay.flush()).toBe(2);
  expect(sent(world)).toEqual([]);
  world.panes[0]!.agent_status = "idle";
  expect(await relay.flush()).toBe(0);
  expect(sent(world)).toEqual(["LANE_DONE_CLAIMED a", "LANE_CLOSED a"]);
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
