import { homedir } from "node:os";
import { join } from "node:path";

import type { TerminalKind } from "./panes.ts";
import type { SupervisionOptions } from "./supervision.ts";
import type { CommitIdentity } from "./verify-pr.ts";

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly threadDone?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

export type DoriConfig = {
  readonly stateDir: string;
  /** Where panes live: the herdr multiplexer, or herdr-core's `hc` terminals. */
  readonly terminal: TerminalKind;
  readonly laneWorkspace: string;
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  readonly leadPane: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  readonly launchKeywords: string;
  readonly goalMarker: string;
  readonly sessionsDir: string;
  readonly nudgeAfterMin: number;
  readonly postAfterMin: number;
  readonly closeAfterMin: number;
  readonly heavySlots: number;
  readonly heavyMaxLoad: number;
  readonly deadPanePatterns: readonly string[];
  readonly guard: GuardThresholds;
  readonly hooks: Hooks;
  /** Expected Git author and committer per lowercase `owner/repo`, for `verify-pr` and the lane footer. */
  readonly repoIdentities: Readonly<Record<string, CommitIdentity>>;
  readonly supervision: SupervisionOptions;
  /**
   * kakaotalk-bridge: its data folder (credentials and archives), the profile it was logged in with, and the Unix socket
   * its resident receiver serves (empty: `<dataDir>/<profile>.sock`), and the open chats the Dori may answer, by chat id
   * (empty: every open chat; any other room stays read-only).
   */
  readonly kakaotalk: { readonly dataDir: string; readonly profile: string; readonly socket: string; readonly openChats: readonly string[] };
};

export const defaultConfig = (home = homedir()): DoriConfig => ({
  stateDir: join(home, ".dori", "state"),
  terminal: "hc",
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  // `--goal` starts omp in goal mode with the prompt as its objective, so the lane keeps going until the goal is met.
  agentCommand: ["omp", "--model", "{model}", "--goal", "{prompt}"],
  defaultModel: "anthropic/claude-opus-5-5",
  launchKeywords: "",
  goalMarker: "🎯 Goal",
  sessionsDir: join(home, ".omp", "agent", "sessions"),
  nudgeAfterMin: 15,
  postAfterMin: 20,
  closeAfterMin: 5,
  heavySlots: 1,
  heavyMaxLoad: 80,
  // omo prints `has stopped`; omp prints `Closing session…` as it exits, and the shell prompt follows it.
  deadPanePatterns: ["has stopped", "closing session", "no suitable jobs"],
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 },
  hooks: {},
  repoIdentities: {},
  supervision: { hungAfterMinutes: 20, staleAfterMinutes: 20, defaults: { wallMinutes: null, tokens: null, costUsd: null } },
  kakaotalk: { dataDir: join(home, ".local", "share", "kakaotalk-bridge"), profile: "dori", socket: "", openChats: [] },
});

export const configPath = (): string => process.env.DORI_CONFIG ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);

const isIdentity = (value: unknown): value is CommitIdentity => {
  const v = value as { name?: unknown; email?: unknown } | null;
  return typeof v === "object" && v !== null && typeof v.name === "string" && !!v.name.trim() && typeof v.email === "string" && !!v.email.trim();
};

// The file is untrusted JSON: keep only well-formed identities, so a bad entry reads as an unconfigured repo.
const repoIdentities = (value: unknown): Record<string, CommitIdentity> =>
  typeof value !== "object" || value === null || Array.isArray(value) ? {}
    : Object.fromEntries(Object.entries(value).flatMap(([repo, identity]) => (isIdentity(identity) ? [[repo.toLowerCase(), identity]] : [])));

export class ConfigError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const SUPERVISION_KEYS = new Set(["hungAfterMinutes", "staleAfterMinutes", "defaults", "lanes", "usageArgv", "recordCostArgv", "activityPaths", "gitActivity"]);
const CEILINGS = new Set(["wallMinutes", "tokens", "costUsd"]);
const checkCeilingNames = (where: string, budget: Record<string, unknown>): void => {
  for (const name of Object.keys(budget)) {
    if (!CEILINGS.has(name)) throw new ConfigError(`invalid supervision ${where}.${name}: unknown ceiling (expected wallMinutes, tokens or costUsd)`);
  }
};

// A malformed supervision entry stops with its name: dropping it could turn a ceiling off, and keeping it would crash
// every sweep later. A misspelt name is refused for the same reason.
const checkSupervision = (value: unknown): void => {
  if (value === undefined) return;
  if (!isRecord(value)) throw new ConfigError("invalid supervision: expected an object");
  for (const name of Object.keys(value)) {
    if (!SUPERVISION_KEYS.has(name)) throw new ConfigError(`invalid supervision ${name}: unknown setting`);
  }
  for (const name of ["defaults", "lanes"] as const) {
    if (value[name] !== undefined && !isRecord(value[name])) throw new ConfigError(`invalid supervision ${name}: expected an object`);
  }
  if (isRecord(value.defaults)) checkCeilingNames("defaults", value.defaults);
  for (const [key, budget] of Object.entries(isRecord(value.lanes) ? value.lanes : {})) {
    if (!isRecord(budget)) throw new ConfigError(`invalid supervision lanes.${key}: expected an object`);
    checkCeilingNames(`lanes.${key}`, budget);
  }
  for (const name of ["usageArgv", "recordCostArgv", "activityPaths"] as const) {
    const list = value[name];
    if (list !== undefined && !(Array.isArray(list) && list.every((item) => typeof item === "string"))) {
      throw new ConfigError(`invalid supervision ${name}: expected an array of strings`);
    }
  }
  if (value.gitActivity !== undefined && typeof value.gitActivity !== "boolean") throw new ConfigError("invalid supervision gitActivity: expected true or false");
};

export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const raw = (await file.exists()) ? ((await file.json()) as Partial<DoriConfig>) : {};
  checkSupervision(raw.supervision);
  const merged: DoriConfig = {
    ...base, ...raw, guard: { ...base.guard, ...raw.guard }, hooks: { ...base.hooks, ...raw.hooks }, repoIdentities: repoIdentities(raw.repoIdentities),
    // Only a string is a marker: null or false would quietly turn the goal check off, and an object would never show.
    goalMarker: typeof raw.goalMarker === "string" ? raw.goalMarker : base.goalMarker,
    supervision: { ...base.supervision, ...raw.supervision, defaults: { ...base.supervision.defaults, ...raw.supervision?.defaults } },
    kakaotalk: { ...base.kakaotalk, ...raw.kakaotalk },
  };
  for (const [name, value] of Object.entries({
    hungAfterMinutes: merged.supervision.hungAfterMinutes,
    staleAfterMinutes: merged.supervision.staleAfterMinutes,
    ...merged.supervision.defaults,
  })) {
    if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new ConfigError(`invalid supervision ${name}: expected a nonnegative number or null`);
  }
  for (const [key, budget] of Object.entries(merged.supervision.lanes ?? {})) {
    for (const [name, value] of Object.entries(budget)) {
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new ConfigError(`invalid supervision lanes.${key}.${name}: expected a nonnegative number or null`);
    }
  }
  return {
    ...merged,
    stateDir: expandHome(process.env.DORI_STATE_DIR ?? merged.stateDir, home),
    defaultCwd: expandHome(merged.defaultCwd, home),
    sessionsDir: expandHome(merged.sessionsDir, home),
    leadPane: process.env.DORI_LEAD_PANE ?? merged.leadPane,
    kakaotalk: {
      dataDir: expandHome(merged.kakaotalk.dataDir, home),
      profile: merged.kakaotalk.profile,
      socket: expandHome(merged.kakaotalk.socket || join(merged.kakaotalk.dataDir, `${merged.kakaotalk.profile}.sock`), home),
      // Ids past 2^53 lose digits as JSON numbers, so only strings are accepted.
      openChats: Array.isArray(merged.kakaotalk.openChats) && merged.kakaotalk.openChats.every((id) => typeof id === "string" && /^\d+$/.test(id))
        ? merged.kakaotalk.openChats
        : (() => { throw new ConfigError("invalid kakaotalk.openChats: expected a list of chat ids as strings, e.g. [\"18498738616482001\"]"); })(),
    },
    terminal: terminalKind(process.env.DORI_TERMINAL ?? merged.terminal),
  };
};

const terminalKind = (value: unknown): TerminalKind => {
  if (value === "herdr" || value === "hc") return value;
  throw new ConfigError(`invalid terminal: expected "herdr" or "hc", got ${JSON.stringify(value)}`);
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));
