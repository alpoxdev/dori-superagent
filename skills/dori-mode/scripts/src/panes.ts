import type { Clock, Runner } from "./run.ts";

/**
 * Where panes live. `hc` (the default) is herdr-core: each pane is an `hc` terminal addressed by its name or address
 * (`t7`), and the agent's status comes from the program's own OSC 7501 reports. `herdr` is the older herdr
 * multiplexer (`herdr pane ...`). The CLI sets it once from the config; every helper below reads it.
 */
export type TerminalKind = "herdr" | "hc";
let kind: TerminalKind = "hc";
export const setTerminal = (k: TerminalKind): void => {
  kind = k;
};
export const terminal = (): TerminalKind => kind;

type HcTerminal = {
  readonly address: string;
  readonly name?: string;
  readonly agent?: string;
  readonly cwd?: string;
  readonly state?: string;
  readonly status?: string | { readonly state?: string };
  readonly labels?: Readonly<Record<string, string>>;
  readonly pid?: number;
  readonly foreground?: { readonly name?: string; readonly argv?: readonly string[]; readonly cwd?: string; readonly pid?: number };
};

const hcStatus = (t: HcTerminal): string | undefined => (typeof t.status === "string" ? t.status : t.status?.state);

/** One terminal as `hc get` reports it, or undefined when hc says there is no such terminal (exit 3). */
export const hcGet = async (run: Runner, t: string): Promise<HcTerminal | undefined> => {
  const r = await run(["hc", "get", "--json", t]);
  if (r.code === 3) return undefined;
  if (r.code !== 0) throw new Error(`hc get ${t} failed: ${r.err || r.out}`);
  return JSON.parse(r.out) as HcTerminal;
};

export type Pane = {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly tab_id?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly title?: string;
  readonly cwd?: string;
};

export class UnsafeTextError extends Error {}

export const listPanes = async (run: Runner): Promise<Pane[]> => {
  if (kind === "hc") {
    const r = await run(["hc", "ls", "--json"]);
    if (r.code !== 0) throw new Error(`hc ls failed: ${r.err || r.out}`);
    const live = (JSON.parse(r.out) as { terminals: HcTerminal[] }).terminals.filter((t) => t.state === "live");
    // ls carries no labels, and labels are how lanes are grouped (`workspace=<laneWorkspace>`): read each terminal.
    const full = await Promise.all(live.map(async (t) => (await hcGet(run, t.address)) ?? t));
    return full.map((t) => {
      const agent = t.agent && !SHELLS.has(baseName(t.agent)) ? t.agent : undefined;
      const status = hcStatus(t);
      return {
        pane_id: t.name ?? t.address,
        workspace_id: t.labels?.workspace ?? "",
        ...(agent ? { agent } : {}),
        ...(agent && status ? { agent_status: status } : {}),
        ...(t.name ? { title: t.name } : {}),
        ...(t.foreground?.cwd ?? t.cwd ? { cwd: t.foreground?.cwd ?? t.cwd } : {}),
      };
    });
  }
  const r = await run(["herdr", "pane", "list"]);
  if (r.code !== 0) throw new Error(`herdr pane list failed: ${r.err || r.out}`);
  return (JSON.parse(r.out) as { result: { panes: Pane[] } }).result.panes;
};

export const readScreen = async (run: Runner, pane: string, lines?: number): Promise<string> =>
  kind === "hc"
    ? (await run(["hc", "read", pane, "--lines", String(lines ?? 0)])).out
    : (await run(["herdr", "pane", "read", pane, "--source", lines ? "recent" : "visible", ...(lines ? ["--lines", String(lines)] : [])])).out;

/** States a pane's agent reports while it runs. A screen read never stands in for these. */
export const ALIVE_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done"]);

export const agentStatus = async (run: Runner, pane: string): Promise<string | undefined> => {
  if (kind === "hc") {
    // hc resolves a name or an address itself; a plain program (a shell) reports no status.
    const t = await hcGet(run, pane);
    return t?.state === "live" ? hcStatus(t) : undefined;
  }
  return (await listPanes(run)).find((p) => p.pane_id === pane)?.agent_status;
};

/** Like agentStatus, but a failed lookup comes back as its error text instead of being swallowed. */
export const statusLookup = async (run: Runner, pane: string): Promise<{ readonly status?: string; readonly error?: string }> => {
  try {
    return { status: await agentStatus(run, pane) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

const SHELLS: ReadonlySet<string> = new Set([
  "sh", "ash", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh", "powershell", "busybox",
]);
const baseName = (value: unknown): string => String(value ?? "").replace(/^-/, "").split("/").pop()!.toLowerCase();
// A shell runs a command (not a prompt) only with an explicit command flag: -c, also inside combined short flags such
// as -lc, or PowerShell's -Command/-File/-EncodedCommand (whole words only: its other long flags contain a 'c'). Any other operand (a script path, --rcfile FILE, -o OPT) stays held.
const runsCommand = (shell: string, arg: string): boolean =>
  shell === "pwsh" || shell === "powershell"
    ? /^-(c|command|f|file|e|ec|encodedcommand)$/i.test(arg)
    : /^-[A-Za-z]*c[A-Za-z]*$/.test(arg);
// PowerShell's -NoExit (any prefix it accepts: -noe, -noex, -noexi, -noexit, one or two dashes) keeps an interactive
// prompt after the command runs, so that shell is held.
const keepsPrompt = (shell: string, arg: string): boolean => (shell === "pwsh" || shell === "powershell") && /^--?noe(x(i(t)?)?)?$/i.test(arg);

/**
 * True when `herdr pane process-info` shows an interactive shell in the pane's foreground group, or cannot be read.
 * herdr still reports an agent suspended with Ctrl+Z as idle while its shell is in front (#66); a shell running a
 * command flag (`sh -c ...`) is the agent's child and does not count; any other shell, `bash script.sh` included,
 * is held. Same rule as dori's src/herdr.ts.
 */
export const shellInFront = async (run: Runner, pane: string): Promise<boolean> => {
  try {
    let procs: unknown;
    if (kind === "hc") {
      const t = await hcGet(run, pane);
      procs = t?.foreground ? [t.foreground] : [];
    } else {
      const r = await run(["herdr", "pane", "process-info", "--pane", pane]);
      if (r.code !== 0) throw new Error(r.err || r.out);
      procs = (JSON.parse(r.out) as { result?: { process_info?: { foreground_processes?: unknown } } }).result?.process_info?.foreground_processes;
    }
    if (!Array.isArray(procs) || procs.length === 0) return true;
    for (const proc of procs as { name?: unknown; argv?: unknown }[]) {
      let name = baseName(proc?.name);
      let args = Array.isArray(proc?.argv) ? proc.argv.map(String).slice(1) : undefined;
      if (name === "busybox" && args && args.length > 0) [name, args] = [baseName(args[0]), args.slice(1)];
      if (!SHELLS.has(name)) continue;
      if (args === undefined) return true;
      if (!args.some((a) => runsCommand(name, a)) || args.some((a) => keepsPrompt(name, a))) return true;
    }
    return false;
  } catch (e) {
    console.error(`sendVerified ${pane}: reading the pane's foreground process failed (${e instanceof Error ? e.message : String(e)}); holding the send`);
    return true;
  }
};

export type Delivery = "delivered" | "unconfirmed" | "failed";

/**
 * Types the text and presses Enter exactly once. Delivery is confirmed only by a state change: the pane's agent_status
 * moving to "working" from something else. A pane that was already working cannot show that change, so its send comes
 * back "unconfirmed" and the caller decides. The screen is never read here, and Enter is never pressed again.
 */
export const sendVerified = async (run: Runner, clock: Clock, pane: string, text: string): Promise<Delivery> => {
  if (/`|\$\(/.test(text)) throw new UnsafeTextError("refusing to send text containing a backtick or $(");
  const before = await statusLookup(run, pane);
  if (before.error) console.error(`sendVerified ${pane}: status lookup failed before send: ${before.error}`);
  // No running agent means a bare shell, where typed text runs as a command (#66). A failed lookup is doubt: refuse.
  if (before.status === undefined || !ALIVE_STATUSES.has(before.status)) return "failed";
  if (await shellInFront(run, pane)) return "failed";
  if (kind === "hc") {
    // hc pastes, waits for a person at the keyboard to pause, then presses Enter itself; it refuses a blocked program.
    if ((await run(["hc", "send", "--json", pane, text])).code !== 0) return "failed";
  } else {
    if ((await run(["herdr", "pane", "send-text", pane, text])).code !== 0) return "failed";
    await run(["herdr", "pane", "send-keys", pane, "enter"]);
  }
  if (before.status === "working") return "unconfirmed";
  for (let attempt = 0; attempt < 6; attempt++) {
    await clock.sleep(700);
    const after = await statusLookup(run, pane);
    if (after.error) console.error(`sendVerified ${pane}: status lookup failed: ${after.error}`);
    if (after.status === "working") return "delivered";
  }
  return "unconfirmed";
};

/** Presses one named key in the pane: `escape` or `enter`. */
export const pressKey = async (run: Runner, pane: string, key: "escape" | "enter"): Promise<boolean> =>
  (await run(kind === "hc" ? ["hc", "keys", pane, key === "escape" ? "esc" : key] : ["herdr", "pane", "send-keys", pane, key])).code === 0;

/**
 * Opens a lane and starts its agent. herdr: a new tab in `workspace`, then the agent typed into it as one shell line.
 * hc: one terminal that runs the agent argv directly (no shell, nothing to quote), labelled `workspace=<workspace>` so
 * the sweeps find it, and kept alive when the process that launched it ends.
 */
export const openLane = async (run: Runner, key: string, cwd: string, workspace: string, argv: readonly string[], shellLine: string): Promise<{ readonly pane: string; readonly tab?: string }> => {
  if (kind === "hc") {
    const r = await run(["hc", "run", "--bg", "--json", "--no-parent", "--cwd", cwd, "--label", `workspace=${workspace}`, "--label", `lane=${key}`, "--", ...argv]);
    if (r.code !== 0) throw new Error(`hc run failed: ${r.err || r.out}`);
    return { pane: (JSON.parse(r.out) as { address: string }).address };
  }
  const created = await run(["herdr", "tab", "create", ...(workspace ? ["--workspace", workspace] : []), "--cwd", cwd, "--label", key, "--no-focus"]);
  if (created.code !== 0) throw new Error(`herdr tab create failed: ${created.err || created.out}`);
  const made = (JSON.parse(created.out) as { result: { root_pane: { pane_id: string; tab_id?: string }; tab_id?: string } }).result;
  const tab = made.tab_id ?? made.root_pane.tab_id;
  await run(["herdr", "pane", "run", made.root_pane.pane_id, shellLine]);
  return { pane: made.root_pane.pane_id, ...(tab ? { tab } : {}) };
};

/** Closes a lane's tab or pane (herdr), or ends and removes its terminal (hc). Returns what was closed, or why not. */
export const closeLanePane = async (run: Runner, lane: { readonly pane?: string; readonly tab?: string }): Promise<string | undefined> => {
  if (kind === "hc") {
    if (!lane.pane) return undefined;
    const killed = (await run(["hc", "kill", lane.pane])).code === 0;
    await run(["hc", "rm", lane.pane]);
    return killed ? `terminal ${lane.pane} closed` : `terminal ${lane.pane} not closed`;
  }
  if (lane.tab) return (await run(["herdr", "tab", "close", lane.tab])).code === 0 ? `tab ${lane.tab} closed` : `tab ${lane.tab} not closed`;
  if (lane.pane) return (await run(["herdr", "pane", "close", lane.pane])).code === 0 ? `pane ${lane.pane} closed` : `pane ${lane.pane} not closed`;
  return undefined;
};
