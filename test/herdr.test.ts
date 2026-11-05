import { describe, expect, test } from "bun:test";
import { Herdr, HerdrError, interactiveShellInFront, shq, type Exec, type ExecResult } from "../src/herdr.ts";

// A recorder in place of the herdr binary: every argv is kept, and each reply is chosen per call.
function recorder(reply: (argv: readonly string[]) => ExecResult = () => ok({})) {
  const calls: (readonly string[])[] = [];
  const exec: Exec = async (cmd, argv) => {
    expect(cmd).toBe("herdr");
    calls.push(argv);
    return reply(argv);
  };
  return { calls, exec };
}
const ok = (result: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
const fail = (stderr: string, stdout = ""): ExecResult => ({ code: 1, stdout, stderr });
const pane = { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" };

describe("herdr argv", () => {
  test("a named session goes in front of every call, pane read included; no session adds nothing", async () => {
    const named = recorder(() => ok({}));
    const h = new Herdr(named.exec, "iso");
    await h.run("w1:p1", "omp");
    await h.read("w1:p1", 40);
    await h.close("w1:p1");
    expect(named.calls).toEqual([
      ["--session", "iso", "pane", "run", "w1:p1", "omp"],
      ["--session", "iso", "pane", "read", "w1:p1", "--lines", "40", "--source", "recent"],
      ["--session", "iso", "pane", "close", "w1:p1"],
    ]);
    const plain = recorder();
    await new Herdr(plain.exec, "").read("w1:p1");
    expect(plain.calls).toEqual([["pane", "read", "w1:p1", "--lines", "80", "--source", "recent"]]);
  });

  test("workspace, tab and split never take focus, and pass workspace and env as flags", async () => {
    const r = recorder((argv) => ok(argv[1] === "split" ? { pane } : { root_pane: pane }));
    const h = new Herdr(r.exec, "");
    expect(await h.createWorkspace("dori", "/w")).toEqual({ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" });
    await h.createTab("fix-login", "/w", "w3", { DORI_LANE: "fix-login", NOTE: "a b" });
    await h.createTab("other", "/w");
    await h.split("w1:p1", "/w", { DORI_ROLE: "duty" });
    expect(r.calls).toEqual([
      ["workspace", "create", "--label", "dori", "--cwd", "/w", "--no-focus"],
      ["tab", "create", "--label", "fix-login", "--cwd", "/w", "--no-focus", "--workspace", "w3", "--env", "DORI_LANE=fix-login", "--env", "NOTE=a b"],
      ["tab", "create", "--label", "other", "--cwd", "/w", "--no-focus"],
      ["pane", "split", "w1:p1", "--direction", "down", "--ratio", "0.3", "--cwd", "/w", "--no-focus", "--env", "DORI_ROLE=duty"],
    ]);
  });

  test("a message is one argv element, delivered verbatim: quotes, $(...) and newlines are never expanded", async () => {
    const r = recorder((argv) => ok(argv[1] === "process-info" ? { process_info: { foreground_processes: [{ name: "omp", argv: ["omp"] }] } } : {}));
    const h = new Herdr(r.exec, "");
    const text = `it's "done" $(rm -rf ~) \`id\`\nline two`;
    expect(await h.deliver("w1:p1", text)).toBe(true);
    expect(r.calls).toEqual([["pane", "process-info", "--pane", "w1:p1"], ["agent", "prompt", "w1:p1", text]]);
  });
});

describe("herdr replies", () => {
  test("a create that returns no pane id throws instead of handing back an empty pane", async () => {
    const h = new Herdr(recorder(() => ok({ root_pane: { tab_id: "w1:t2" } })).exec, "");
    await expect(h.createTab("x", "/w")).rejects.toThrow("herdr did not return a pane id");
  });

  test("a failed call throws HerdrError with herdr's own reason, from stderr or else stdout", async () => {
    const onStdout = new Herdr(recorder(() => fail("", '{"error":{"code":"pane_not_found"}}\n')).exec, "iso");
    const e = await onStdout.close("w1:p7").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HerdrError);
    expect((e as HerdrError).message).toBe('herdr --session iso pane close w1:p7 failed (1): {"error":{"code":"pane_not_found"}}');
    const onStderr = new Herdr(recorder(() => fail("socket closed", "partial")).exec, "");
    await expect(onStderr.read("w1:p7")).rejects.toThrow("failed (1): socket closed");
  });

  test("a successful call whose output is not JSON reads as an empty result", async () => {
    const h = new Herdr(recorder(() => ({ code: 0, stdout: "ok\n", stderr: "" })).exec, "");
    await expect(h.run("w1:p1", "omp")).resolves.toBeUndefined();
  });

  test("status: pane_not_found is gone, but a herdr server that is down is an error, never a lost pane", async () => {
    const status = (reply: ExecResult) => new Herdr(recorder(() => reply).exec, "").status("w1:p1");
    expect(await status(fail('{"error":{"code":"pane_not_found","message":"pane w1:p1 not found"}}'))).toBe("gone");
    expect(await status(ok({}))).toBe("gone");
    await expect(status(fail('{"error":{"code":"server_not_running","message":"no herdr server is running"}}'))).rejects.toThrow(
      "server_not_running",
    );
  });

  test("status: no agent is a shell; herdr's four states pass through and anything else is unknown", async () => {
    const status = (p: Record<string, unknown>) => new Herdr(recorder(() => ok({ pane: p })).exec, "").status("w1:p1");
    expect(await status({ agent: null, agent_status: "idle" })).toBe("shell");
    for (const s of ["idle", "working", "blocked", "done"] as const) expect(await status({ agent: "omp", agent_status: s })).toBe(s);
    expect(await status({ agent: "omp", agent_status: "compacting" })).toBe("unknown");
    expect(await status({ agent: "omp" })).toBe("unknown");
  });
});

describe("shq", () => {
  test("a quoted word reaches a real shell unchanged, single quotes and $ included", async () => {
    for (const s of ["plain", "two words", "it's", "''", "$HOME `id` $(echo x)", "back\\slash", "new\nline", ""]) {
      const proc = Bun.spawn(["sh", "-c", `printf %s ${shq(s)}`], { stdout: "pipe" });
      expect(await new Response(proc.stdout).text()).toBe(s);
    }
  });
});

describe("interactiveShellInFront (#66: a suspended agent leaves its shell in front)", () => {
  const front = (...procs: { name?: string; argv?: string[] }[]) => interactiveShellInFront({ foreground_processes: procs });
  test.each([
    ["login shell", [{ name: "-bash", argv: ["-bash"] }], true],
    ["interactive zsh by path, upper case", [{ name: "/bin/ZSH", argv: ["/bin/zsh", "-i"] }], true],
    ["bash -C (noclobber) is still interactive", [{ name: "bash", argv: ["bash", "-C"] }], true],
    ["busybox sh applet", [{ name: "busybox", argv: ["busybox", "sh"] }], true],
    ["shell entry without argv", [{ name: "fish" }], true],
    ["agent with a sh -c child", [{ name: "omp", argv: ["omp"] }, { name: "sh", argv: ["sh", "-c", "sleep 1"] }], false],
    ["shell running a script is held, the safe side", [{ name: "bash", argv: ["bash", "tool.sh"] }], true],
    ["interactive bash with --rcfile FILE", [{ name: "bash", argv: ["bash", "--rcfile", "/tmp/rc"] }], true],
    ["interactive zsh with -o OPT", [{ name: "zsh", argv: ["zsh", "-o", "vi"] }], true],
    ["login shell running a command: -lc", [{ name: "bash", argv: ["bash", "-lc", "make"] }], false],
    ["pwsh -File", [{ name: "pwsh", argv: ["pwsh", "-File", "x.ps1"] }], false],
    ["bash -f (noglob) is still interactive", [{ name: "bash", argv: ["bash", "-f"] }], true],
    ["bash --init-file F", [{ name: "bash", argv: ["bash", "--init-file", "/tmp/rc"] }], true],
    ["fish -C cmd (init command, still interactive)", [{ name: "fish", argv: ["fish", "-C", "set x 1"] }], true],
    ["bash -ic cmd runs a command", [{ name: "bash", argv: ["bash", "-ic", "make"] }], false],
    ["pwsh -EncodedCommand", [{ name: "pwsh", argv: ["pwsh", "-EncodedCommand", "ZQBjAGgAbwA="] }], false],
    ["pwsh -Interactive", [{ name: "pwsh", argv: ["pwsh", "-Interactive"] }], true],
    ["pwsh -NoProfile -ExecutionPolicy Bypass", [{ name: "pwsh", argv: ["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass"] }], true],
    ["pwsh -NoExit -Command keeps a prompt", [{ name: "pwsh", argv: ["pwsh", "-NoExit", "-Command", "ls"] }], true],
    ["pwsh -noex -c keeps a prompt", [{ name: "pwsh", argv: ["pwsh", "-noex", "-c", "ls"] }], true],
    ["pwsh --noexi -Command keeps a prompt", [{ name: "pwsh", argv: ["pwsh", "--noexi", "-Command", "ls"] }], true],
    ["powershell -c", [{ name: "powershell", argv: ["powershell", "-c", "ls"] }], false],
    ["pwsh -Command", [{ name: "pwsh", argv: ["pwsh", "-Command", "ls"] }], false],
    ["exec'd agent", [{ name: "bun", argv: ["bun", "omo.js"] }], false],
  ] as const)("%s", (_, procs, want) => {
    expect(front(...(procs as unknown as { name?: string; argv?: string[] }[]))).toBe(want);
  });
  test("an empty or missing process list is doubt", () => {
    expect(interactiveShellInFront({ foreground_processes: [] })).toBe(true);
    expect(interactiveShellInFront({})).toBe(true);
    expect(interactiveShellInFront(undefined)).toBe(true);
  });
});
