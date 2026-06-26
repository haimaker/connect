// Core contracts shared by every agent writer.
//
// These interfaces are the foundation that all per-agent writers implement.
// Keep them stable: writer agents depend on the exact shapes below.

/**
 * The HTTP surface an agent expects to talk to.
 * - "messages"  -> Anthropic-style /v1/messages (Claude Code). Base URL is the bare host root.
 * - "chat"      -> OpenAI-style /v1/chat/completions. Base URL is host + "/v1".
 * - "responses" -> OpenAI-style /v1/responses (Codex). Base URL is host + "/v1".
 */
export type Surface = "messages" | "chat" | "responses";

/**
 * Where an agent's config lives and which root to resolve it under.
 *
 * - kind:    "user" writes to the agent's global/user config home;
 *            "project" writes into the repo at `cwd`.
 * - dir:     OPTIONAL override of the base config home. When set, ALL writers
 *            MUST resolve their config paths under this dir instead of the real
 *            home/XDG dir. Used by tests and the --dir flag so we never touch
 *            real user files (~/.claude, ~/.codex, etc).
 * - cwd:     Repo root for project scope (where a project-local config is written
 *            and where .gitignore lives).
 */
export type Scope = {
  kind: "user" | "project";
  dir?: string;
  cwd?: string;
};

/**
 * How `connect` provisions the API key, trading safety for convenience.
 * - "env":     reference an env var the user sets themselves (safest, default).
 *              Nothing secret is written to the shell; agents that read a shell
 *              env var (Codex) require the user to export HAIMAKER_API_KEY.
 * - "profile": also write `export HAIMAKER_API_KEY=…` into the shell startup
 *              file so env-var agents work automatically. The key is persisted
 *              in a plaintext rc file.
 * - "inline":  embed the literal key directly in the agent's own config where
 *              the agent supports it (Hermes api_key in config.yaml). The most
 *              convenient and the most dangerous (secret in a plaintext config).
 *
 * Note: five agents (Claude/opencode/Kilo/OpenClaw/Cline) only support an inline
 * key in their own 0600 config, so they store it there regardless of this mode.
 */
export type KeyMode = "env" | "profile" | "inline";

/**
 * Everything a writer needs to configure (or verify) an agent.
 * `host` is already normalized (no trailing slash, no trailing "/v1").
 */
export interface InstallCtx {
  scope: Scope;
  host: string;
  apiKey: string;
  model: string;
  verify: boolean;
  /** Key-provisioning strategy. Writers that don't care may ignore it; absent => "env". */
  keyMode?: KeyMode;
}

/**
 * Result of probing a surface with one minimal live request.
 * - autoRouterHint is set when the failure looks like the haimaker/auto
 *   auto-router is missing/misconfigured on the key (typically a 400).
 */
export interface VerifyResult {
  ok: boolean;
  status?: number;
  message: string;
  autoRouterHint?: boolean;
}

/**
 * Contract implemented once per supported coding agent.
 *
 * - projectScope: writer can honor `--project` (repo-local config). When false
 *                 or absent the writer is user/global-only, and `--project` is
 *                 rejected for it rather than silently mutating the global config.
 */
export interface AgentWriter {
  id: string;
  displayName: string;
  surface: Surface;
  projectScope?: boolean;
  /**
   * The agent's behavior changes with the chosen KeyMode, so the interactive
   * wizard should offer the key-mode choice when this writer is selected
   * (Codex: env var vs shell export; Hermes: .env vs inline api_key).
   */
  keyModeAware?: boolean;
  /**
   * The agent reads HAIMAKER_API_KEY from the *shell* environment at runtime
   * (Codex). In "profile"/"inline" modes connect writes the export to the user's
   * shell startup file so it's set automatically.
   */
  usesShellEnvKey?: boolean;
  detect(scope: Scope): Promise<boolean>;
  configPath(scope: Scope): string;
  configure(ctx: InstallCtx): Promise<void>;
  verify(ctx: InstallCtx): Promise<VerifyResult>;
  uninstall(scope: Scope): Promise<void>;
}
