import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

import { launchLane } from "../src/launch.ts";
import { listPanes, setTerminal, statusLookup } from "../src/panes.ts";
import { Relay } from "../src/relay.ts";
import type { Ran, Runner } from "../src/run.ts";
import { resolveSession } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

// herdr-core's `hc` as the dori CLI sees it: `ls`, `get`, `send`, `run`, `kill`, `rm`.
type Term = { address: string; name?: string; agent: string; state: "live" | "finished"; status?: string; labels?: Record<string, string>; pid?: number; foreground?: { name: string; argv: string[] } };

const hcWorld = (terms: Term[]) => {
  const calls: string[][] = [];
  const sent: string[] = [];
  let runFails = false;
  const find = (t: string) => terms.find((x) => x.address === t || x.name === t);
  const ok = (out: unknown): Ran => ({ code: 0, out: typeof out === "string" ? out : JSON.stringify(out), err: "" });
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    const [cmd, sub] = argv;
    if (cmd !== "hc") return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
    if (sub === "ls") return ok({ terminals: terms.map(({ address, name, agent, state, status }) => ({ address, name, agent, state, status })) });
    const target = argv.at(-1)!;
    if (sub === "get") {
      const t = find(target);
      return t ? ok({ ...t, status: t.status ? { app: t.agent, state: t.status } : undefined }) : { code: 3, out: "", err: "not_found" };
    }
    if (sub === "send") {
      const t = find(argv[3]!);
      if (t?.status === "blocked") return { code: 9, out: "", err: "blocked" };
      sent.push(argv[4]!);
      return ok({ started: true });
    }
    if (sub === "run") {
      if (runFails) return { code: 1, out: "", err: "spawn_failed" };
      const address = `t${terms.length + 1}`;
      const labels = Object.fromEntries(argv.flatMap((a, i) => (argv[i - 1] === "--label" ? [a.split("=") as [string, string]] : [])));
      terms.push({ address, agent: argv[argv.indexOf("--") + 1]!, state: "live", status: "working", labels });
      return ok({ address });
    }
    return ok({});
  };
  return { run, calls, sent, terms, failRun: () => { runFails = true; } };
};

let state = withState();
beforeAll(() => setTerminal("hc"));
afterAll(() => setTerminal("herdr"));
afterEach(() => {
  state.done();
  state = withState();
});

test("hc terminals become panes: a shell is no agent, lanes are grouped by their workspace label, finished ones drop out", async () => {
  const hc = hcWorld([
    { address: "t1", agent: "zsh", state: "live" },
    { address: "t2", name: "dori-lead", agent: "omp", state: "live", status: "done" },
    { address: "t3", agent: "omp", state: "live", status: "working", labels: { workspace: "lanes" } },
    { address: "t4", agent: "omp", state: "finished" },
  ]);
  expect(await listPanes(hc.run)).toEqual([
    { pane_id: "t1", workspace_id: "" },
    { pane_id: "dori-lead", workspace_id: "", agent: "omp", agent_status: "done", title: "dori-lead" },
    { pane_id: "t3", workspace_id: "lanes", agent: "omp", agent_status: "working" },
  ]);
  expect(await statusLookup(hc.run, "dori-lead")).toEqual({ status: "done" });
  expect(await statusLookup(hc.run, "t9")).toEqual({ status: undefined });
});

test("the relay holds lines while the lead works, sends them together with hc send once it is done, and never into a blocked lead", async () => {
  const lead: Term = { address: "t2", name: "dori-lead", agent: "omp", state: "live", status: "working", foreground: { name: "omp", argv: ["omp"] } };
  const hc = hcWorld([lead]);
  const relay = new Relay({ run: hc.run, clock: fakeClock(0), pane: "dori-lead", filter: /^INBOUND/ });
  relay.offer('INBOUND dm 1 - 2 1 "first"');
  relay.offer('INBOUND dm 1 - 3 1 "second"');
  expect(await relay.flush()).toBe(2);
  lead.status = "blocked";
  expect(await relay.flush()).toBe(2);
  expect(hc.sent).toEqual([]);
  lead.status = "done";
  expect(await relay.flush()).toBe(0);
  expect(hc.sent).toEqual(['INBOUND dm 1 - 2 1 "first"\nINBOUND dm 1 - 3 1 "second"']);
});

test("an hc lane is registered before its terminal starts the agent; a terminal that cannot start leaves no lane behind", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const hc = hcWorld([]);
  const base = depsFor(newWorld(), fakeClock(0), state.dir, { laneWorkspace: "lanes" });
  let registeredAtStart = false;
  const deps = { ...base, run: async (argv: readonly string[]) => {
    if (argv[1] === "run") registeredAtStart = (await base.registry.read("fast-lane")) !== null;
    return hc.run(argv);
  } };
  hc.failRun();
  await expect(launchLane(deps, { key: "fast-lane", title: "t", brief, done: "closed acme/app#3" })).rejects.toThrow("spawn_failed");
  expect(await base.registry.read("fast-lane")).toBeNull();
  const fresh = hcWorld([]);
  const r = await launchLane({ ...deps, run: async (argv) => {
    if (argv[1] === "run") registeredAtStart = (await base.registry.read("fast-lane")) !== null;
    return fresh.run(argv);
  } }, { key: "fast-lane", title: "t", brief, done: "closed acme/app#3" });
  expect(registeredAtStart).toBe(true);
  expect(r.lane.pane).toBe("t1");
  const run = fresh.calls.find((c) => c[1] === "run")!;
  expect(run.slice(run.indexOf("--") + 1, run.indexOf("--") + 2)).toEqual(["omp"]);
  expect(run).toContain("workspace=lanes");
});

test("under hc the session lookup starts from the terminal's own pid: there is no shell around the agent", async () => {
  const hc = hcWorld([{ address: "t5", agent: "omp", state: "live", status: "idle", pid: 40 }]);
  const run: Runner = async (argv) => (argv[0] === "hc" ? hc.run(argv) : argv[0] === "ps" && argv[1] === "eww" && argv.at(-1) === "41"
    ? { code: 0, out: "bun mcp PI_SESSION_ID=01a11440-ee81-7f90-b2ed-dcc7d51a0adf", err: "" }
    : { code: 1, out: "", err: "" });
  const table = [{ pid: 40, ppid: 1, cmd: "omp --model m" }, { pid: 41, ppid: 40, cmd: "bun mcp" }];
  expect(await resolveSession("t5", "/repo", table, { run, sessionsDir: "/s" })).toEqual({ id: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf", via: "child-env", pid: 40 });
});
