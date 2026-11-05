import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { send } from "../src/harness.ts";
import { ompScreenIdle } from "../src/herdr.ts";
import { World } from "./fake.ts";

// omp screens captured from a live omp 18.16 session, sanitized (titles, costs, paths, models replaced).
const screen = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "screens", `${name}.txt`)).text();

describe("ompScreenIdle (#62: herdr can report an agent with background jobs as working)", () => {
  test("empty input under the π status line between turns, a background job still running: idle", async () => {
    expect(ompScreenIdle(await screen("omp-idle-background-job"))).toBe(true);
  });

  test("a fresh session with the right-aligned hint on its input line: idle", async () => {
    expect(ompScreenIdle(await screen("omp-idle-fresh"))).toBe(true);
  });

  test("a real turn shows the spinner on the status line: not idle", async () => {
    expect(ompScreenIdle(await screen("omp-turn"))).toBe(false);
  });

  test("doubt keeps it working: dialog, draft in the input, autocomplete list, no input, empty read", async () => {
    expect(ompScreenIdle(await screen("omp-dialog"))).toBe(false);
    expect(ompScreenIdle(await screen("omp-draft"))).toBe(false);
    expect(ompScreenIdle(await screen("omp-autocomplete"))).toBe(false);
    expect(ompScreenIdle("$ ls\nREADME.md\n$ ")).toBe(false);
    expect(ompScreenIdle("╰─\n")).toBe(false);
    expect(ompScreenIdle("")).toBe(false);
  });

  test("an esc-to-interrupt row right above an idle-looking status line is a turn: not idle", async () => {
    const idle = (await screen("omp-idle-fresh")).split("\n");
    expect(ompScreenIdle(["  ⎋ Working…", ...idle.slice(-3)].join("\n"))).toBe(false);
  });

  test("an idle input scrolled up above other output is not the bottom of the screen: not idle", async () => {
    const idle = await screen("omp-idle-background-job");
    expect(ompScreenIdle(idle + ["more", "output", "below"].join("\n"))).toBe(false);
  });
});

describe("delivery to a pane herdr calls working", () => {
  function setup(screenText?: string) {
    const w = new World();
    const d = w.deps();
    const lead = w.addPane("w1:p1", "working");
    lead.screen = screenText;
    d.store.setRole("lead", "w1:p1");
    return { w, d, lead };
  }

  test("a background job and an idle screen: the message is delivered", async () => {
    const { d, lead } = setup(await screen("omp-idle-background-job"));
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
  });

  test("a real turn: the message is queued and nothing is typed", async () => {
    const { w, d, lead } = setup(await screen("omp-turn"));
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(w.calls.some((c) => c.argv[1] === "send-text" || c.argv[0] === "agent")).toBe(false);
  });

  test("a failed screen read keeps the message queued", async () => {
    const { d, lead } = setup(undefined);
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
  });

  test("blocked is never read as idle, whatever the screen shows", async () => {
    const { w, d, lead } = setup(await screen("omp-idle-background-job"));
    lead.status = "blocked";
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(w.calls.some((c) => c.argv[1] === "read")).toBe(false);
  });
});
