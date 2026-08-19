import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { HandoffRecord } from "./store";
import {
  createRecord,
  getChildSessionPath,
  getWorktreeDirectory,
  readRecord,
  updateRecord,
  writePrompt,
  writeChildSession,
} from "./store";

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RepoState {
  root: string;
  name: string;
  head: string;
  branch: string | null;
  dirtyEntries: string[];
}

export interface TmuxTarget {
  sessionId: string;
  sourcePaneId: string;
}

export interface CreateHandoffInput {
  objective: string;
  acceptanceCriteria: string[];
  sourceSummary: string;
  slug: string;
  parentSessionId: string;
  parentSessionFile?: string;
  sessionVersion: number;
  model: string;
  thinking?: string;
  repo: RepoState;
  tmux: TmuxTarget;
  /** Internal test seam. Supports {promptPath}, {sessionFile}, and {id} placeholders. */
  agentCommand?: string[];
}

export interface ReconciledRecord {
  record: HandoffRecord;
  worktreeExists: boolean;
  tmuxAlive: boolean;
  displayStatus: string;
}

export function runCommand(command: string, args: string[], cwd?: string): CommandResult {
  try {
    const result = Bun.spawnSync([command, ...args], {
      cwd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.exitCode,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: -1,
    };
  }
}

function requireOutput(result: CommandResult, description: string): string {
  if (!result.ok || !result.stdout) {
    throw new Error(`${description}: ${result.stderr || `exit ${result.exitCode}`}`);
  }
  return result.stdout;
}

export function inspectRepo(cwd: string): RepoState {
  const root = requireOutput(runCommand("git", ["rev-parse", "--show-toplevel"], cwd), "Git repository not found");
  const head = requireOutput(runCommand("git", ["rev-parse", "HEAD"], root), "Could not resolve current HEAD");
  const branchResult = runCommand("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  const status = runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
  if (!status.ok) throw new Error(`Could not inspect repository status: ${status.stderr}`);

  return {
    root,
    name: basename(root),
    head,
    branch: branchResult.ok && branchResult.stdout ? branchResult.stdout : null,
    dirtyEntries: status.stdout ? status.stdout.split("\n") : [],
  };
}

export function resolveTmuxTarget(): TmuxTarget {
  const sourcePaneId = process.env.TMUX_PANE?.trim();
  if (!process.env.TMUX || !sourcePaneId) {
    throw new Error("/worktree handoff requires the current OMP session to run inside tmux.");
  }
  const sessionId = requireOutput(
    runCommand("tmux", ["display-message", "-p", "-t", sourcePaneId, "#{session_id}"]),
    "Could not resolve the current tmux session",
  );
  return { sessionId, sourcePaneId };
}

function sanitizeSlug(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function makeHandoffId(slug: string): string {
  const safeSlug = sanitizeSlug(slug, "task");
  return `${safeSlug}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
}

function tmuxTargetExists(target: string | undefined): boolean {
  if (!target) return false;
  const result = runCommand("tmux", ["display-message", "-p", "-t", target, "#{pane_id}"]);
  return result.ok && Boolean(result.stdout);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return false;
    throw error;
  }
}

function getDisplayStatus(record: HandoffRecord, worktreeExists: boolean, tmuxAlive: boolean): string {
  if (record.status === "closed") return "closed";
  if (record.status === "closing") return "closing";
  if (record.status === "failed") return "failed";
  if (!worktreeExists) return "orphaned (directory missing)";
  if (record.status === "completed") return "completed · awaiting close";
  if (record.status === "dropped") return "dropped · awaiting close";
  if (record.status === "paused") return tmuxAlive ? "paused" : "paused · agent stopped";
  if (!tmuxAlive) return "interrupted · awaiting resume or close";
  if (record.status === "creating") return "creating";
  return "active";
}

export async function reconcileRecord(record: HandoffRecord): Promise<ReconciledRecord> {
  const worktreeExists = await pathExists(record.worktreePath);
  const tmuxAlive = tmuxTargetExists(record.tmuxPaneId || record.tmuxWindowId);
  return {
    record,
    worktreeExists,
    tmuxAlive,
    displayStatus: getDisplayStatus(record, worktreeExists, tmuxAlive),
  };
}

export function renderChildPrompt(record: HandoffRecord): string {
  const criteria = record.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n");
  return `<handoff-worktree>\nHandoff id: ${record.id}\nSource session: ${record.parentSessionId}\nSource summary: ${record.sourceSummary}\n\nActive goal:\n${record.objective}\n\nAcceptance criteria:\n${criteria}\n\nRequired execution contract:\n1. Goal mode was pre-created for this child session. Call the goal tool with op=get before implementation and verify that its objective exactly matches the active goal above. Stop with an explicit error if it does not.\n2. Treat this worktree as dedicated to that objective. Do not redefine or silently narrow it.\n3. Read any source file, URL, issue, or Linear ticket named in the source summary before deciding the implementation.\n4. Ask the user only when a material decision cannot be resolved from the repository, source, or existing conventions.\n5. Implement and verify every acceptance criterion end to end.\n6. Call goal complete only after verification. The handoff-worktree extension uses that event to mark this worktree as completed and awaiting /worktree close.\n</handoff-worktree>`;
}

function createInitialRecord(input: CreateHandoffInput, id: string): HandoffRecord {
  const now = new Date().toISOString();
  const repoSegment = sanitizeSlug(input.repo.name, "repo");
  const worktreePath = join(getWorktreeDirectory(), repoSegment, id);
  const childSessionId = Bun.randomUUIDv7();
  return {
    version: 1,
    id,
    slug: sanitizeSlug(input.slug, "task"),
    status: "creating",
    objective: input.objective.trim(),
    acceptanceCriteria: input.acceptanceCriteria.map((criterion) => criterion.trim()).filter(Boolean),
    sourceSummary: input.sourceSummary.trim(),
    repoRoot: input.repo.root,
    repoName: input.repo.name,
    worktreePath,
    baseCommit: input.repo.head,
    baseBranch: input.repo.branch,
    branch: `handoff/${id}`,
    promptPath: "",
    parentSessionId: input.parentSessionId,
    parentSessionFile: input.parentSessionFile,
    sessionVersion: input.sessionVersion,
    childSessionId,
    childSessionFile: getChildSessionPath(id),
    model: input.model,
    thinking: input.thinking,
    tmuxSessionId: input.tmux.sessionId,
    goalId: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
    tmuxWindowName: sanitizeSlug(input.slug, "handoff").slice(0, 40),
    createdAt: now,
    updatedAt: now,
  };
}

function launchAgent(record: HandoffRecord, commandOverride?: string[]): { windowId: string; paneId: string } {
  const agentCommand = commandOverride?.length
    ? commandOverride.map((argument) =>
        argument
          .replaceAll("{promptPath}", record.promptPath)
          .replaceAll("{sessionFile}", record.childSessionFile)
          .replaceAll("{id}", record.id),
      )
    : ["omp", `--resume=${record.childSessionFile}`, `--model=${record.model}`];
  if (!commandOverride?.length && record.thinking) agentCommand.push(`--thinking=${record.thinking}`);
  if (!commandOverride?.length) agentCommand.push(`@${record.promptPath}`);

  const environment = ["OMP_HANDOFF_WORKTREE_STATE_DIR", "OMP_HANDOFF_WORKTREE_ROOT"].flatMap((name) => {
    const value = process.env[name]?.trim();
    return value ? ["-e", `${name}=${value}`] : [];
  });
  const launched = runCommand("tmux", [
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{window_id}\t#{pane_id}",
    "-t",
    `${record.tmuxSessionId}:`,
    "-n",
    record.tmuxWindowName,
    "-c",
    record.worktreePath,
    "-e",
    `OMP_HANDOFF_WORKTREE_ID=${record.id}`,
    ...environment,
    ...agentCommand,
  ]);
  const [windowId, paneId] = launched.stdout.split("\t");
  if (!launched.ok || !windowId || !paneId) {
    throw new Error(`Could not launch OMP in a new tmux window: ${launched.stderr || launched.stdout}`);
  }
  return { windowId, paneId };
}

function rollbackCreation(record: HandoffRecord, windowId?: string): void {
  if (windowId) runCommand("tmux", ["kill-window", "-t", windowId]);
  runCommand("git", ["worktree", "remove", "--force", record.worktreePath], record.repoRoot);
  runCommand("git", ["branch", "-D", record.branch], record.repoRoot);
}

export async function createHandoff(input: CreateHandoffInput): Promise<HandoffRecord> {
  const id = makeHandoffId(input.slug);
  let record = createInitialRecord(input, id);
  await writeChildSession(record);
  await mkdir(dirname(record.worktreePath), { recursive: true, mode: 0o700 });
  const promptPath = await writePrompt(id, renderChildPrompt(record));
  record.promptPath = promptPath;
  await createRecord(record);

  let windowId: string | undefined;
  try {
    const added = runCommand(
      "git",
      ["worktree", "add", "-b", record.branch, record.worktreePath, record.baseCommit],
      record.repoRoot,
    );
    if (!added.ok) throw new Error(`Could not create git worktree: ${added.stderr || added.stdout}`);

    const launched = launchAgent(record, input.agentCommand);
    windowId = launched.windowId;
    record =
      (await updateRecord(record.id, (current) => ({
        ...current,
        status: current.status === "creating" ? "active" : current.status,
        tmuxWindowId: launched.windowId,
        tmuxPaneId: launched.paneId,
      }))) || record;

    const selected = runCommand("tmux", ["select-window", "-t", launched.windowId]);
    if (!selected.ok) {
      record =
        (await updateRecord(record.id, (current) => ({
          ...current,
          lastError: `Handoff created, but tmux could not focus its window: ${selected.stderr}`,
        }))) || record;
    }
    return record;
  } catch (error) {
    rollbackCreation(record, windowId);
    const message = error instanceof Error ? error.message : String(error);
    await updateRecord(record.id, (current) => ({ ...current, status: "failed", lastError: message }));
    throw error;
  }
}

export async function closeHandoff(record: HandoffRecord): Promise<HandoffRecord> {
  const current = await readRecord(record.id);
  if (!current) throw new Error(`Handoff not found: ${record.id}`);
  if (current.status === "closed") return current;

  if (await pathExists(current.worktreePath)) {
    const status = runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], current.worktreePath);
    if (!status.ok) throw new Error(`Could not inspect worktree before close: ${status.stderr}`);
    if (status.stdout) {
      throw new Error(
        `Worktree ${current.id} has uncommitted changes and was not removed. Commit or discard them explicitly first.`,
      );
    }
  }

  await updateRecord(current.id, (value) => ({ ...value, status: "closing" }));
  try {
    if (tmuxTargetExists(current.tmuxWindowId)) {
      const killed = runCommand("tmux", ["kill-window", "-t", current.tmuxWindowId!]);
      if (!killed.ok) throw new Error(`Could not close tmux window: ${killed.stderr}`);
    }

    if (await pathExists(current.worktreePath)) {
      const removed = runCommand("git", ["worktree", "remove", current.worktreePath], current.repoRoot);
      if (!removed.ok) throw new Error(`Could not remove worktree: ${removed.stderr}`);
    }

    return (
      (await updateRecord(current.id, (value) => ({
        ...value,
        status: "closed",
        closedAt: new Date().toISOString(),
        lastError: undefined,
      }))) || current
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateRecord(current.id, (value) => ({ ...value, status: current.status, lastError: message }));
    throw error;
  }
}
