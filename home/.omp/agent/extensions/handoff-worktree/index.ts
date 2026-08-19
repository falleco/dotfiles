import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildEvaluationPrompt } from "./prompts";
import {
  closeHandoff,
  createHandoff,
  inspectRepo,
  reconcileRecord,
  resolveTmuxTarget,
  type ReconciledRecord,
  type RepoState,
  type TmuxTarget,
} from "./runtime";
import { listRecords, readRecord, updateRecord, type GoalStatus, type HandoffRecord } from "./store";

interface GoalSnapshot {
  id: string;
  objective: string;
  status: GoalStatus;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}

interface PendingHandoff {
  requestId: string;
  sessionId: string;
  sessionVersion: number;
  repo: RepoState;
  tmux: TmuxTarget;
  model: string;
  thinking?: string;
}

const CHILD_ID = process.env.OMP_HANDOFF_WORKTREE_ID?.trim();
const TERMINAL_GOAL_STATUSES = new Set<GoalStatus>(["complete", "dropped"]);

const WORKTREE_SUBCOMMANDS = [
  {
    value: "list",
    label: "list",
    description: "List handoff worktrees and their lifecycle state",
  },
  {
    value: "handoff",
    label: "handoff",
    description: "Evaluate the current goal and start it in a dedicated worktree",
  },
  {
    value: "close",
    label: "close",
    description: "Close a handoff worktree while preserving its branch",
  },
] as const;

function completeWorktreeArgument(argumentPrefix: string) {
  const prefix = argumentPrefix.trimStart().toLowerCase();
  if (prefix.includes(" ") || WORKTREE_SUBCOMMANDS.some((item) => item.value === prefix)) return null;
  return WORKTREE_SUBCOMMANDS.filter((item) => item.value.startsWith(prefix));
}

function asGoal(value: unknown): GoalSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const status = candidate.status;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.objective !== "string" ||
    (status !== "active" &&
      status !== "paused" &&
      status !== "budget-limited" &&
      status !== "complete" &&
      status !== "dropped")
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    objective: candidate.objective,
    status,
    tokensUsed: typeof candidate.tokensUsed === "number" ? candidate.tokensUsed : undefined,
    timeUsedSeconds: typeof candidate.timeUsedSeconds === "number" ? candidate.timeUsedSeconds : undefined,
  };
}

function getPersistedGoal(ctx: ExtensionContext): GoalSnapshot | undefined {
  const entries = ctx.sessionManager.getBranch() as unknown[];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (candidate.type !== "mode_change") continue;
    const data = candidate.data;
    if (!data || typeof data !== "object") continue;
    const goal = asGoal((data as Record<string, unknown>).goal);
    if (goal) return goal;
  }
  return undefined;
}

function modelSpec(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  if (!model) return undefined;
  return `${model.provider}/${model.id}`;
}

function toolText(text: string, isError = false, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    ...(details === undefined ? {} : { details }),
    ...(isError ? { isError: true } : {}),
  };
}

function cleanCriteria(criteria: string[]): string[] {
  return [...new Set(criteria.map((criterion) => criterion.trim()).filter(Boolean))];
}

function goalMatches(goal: GoalSnapshot | undefined, objective: string): boolean {
  return Boolean(
    goal &&
      (goal.status === "active" || goal.status === "budget-limited") &&
      goal.objective.trim() === objective.trim(),
  );
}

function formatRecord(record: ReconciledRecord): string {
  const { record: state } = record;
  const branch = state.branch;
  const window = state.tmuxWindowId ? ` · tmux ${state.tmuxWindowId}` : "";
  const warning = state.lastError ? `\n  warning: ${state.lastError}` : "";
  return `${state.id}\n  ${record.displayStatus} · ${branch}${window}\n  ${state.worktreePath}\n  ${state.objective}${warning}`;
}

async function showList(ctx: ExtensionContext): Promise<void> {
  const records = await listRecords();
  if (records.length === 0) {
    ctx.ui.notify("No handoff worktrees have been created.", "info");
    return;
  }
  const reconciled = await Promise.all(records.map(reconcileRecord));
  ctx.ui.notify(`Handoff worktrees (${records.length}):\n\n${reconciled.map(formatRecord).join("\n\n")}`, "info");
}

function findRecord(records: HandoffRecord[], query: string): HandoffRecord | undefined {
  const exact = records.find((record) => record.id === query);
  if (exact) return exact;
  const matches = records.filter((record) => record.id.startsWith(query));
  return matches.length === 1 ? matches[0] : undefined;
}

async function chooseRecordToClose(ctx: ExtensionContext, query: string): Promise<HandoffRecord | undefined> {
  const records = (await listRecords()).filter((record) => record.status !== "closed");
  if (records.length === 0) {
    ctx.ui.notify("There are no open worktrees to close.", "info");
    return undefined;
  }
  if (query) {
    const record = findRecord(records, query);
    if (!record) ctx.ui.notify(`Handoff not found or ambiguous prefix: ${query}`, "error");
    return record;
  }

  const options = records.map((record) => ({
    label: record.id,
    description: `${record.status} · ${record.repoName} · ${record.objective.slice(0, 80)}`,
  }));
  const selected = await ctx.ui.select("Which worktree do you want to close?", options);
  return selected ? records.find((record) => record.id === selected) : undefined;
}

async function closeFromCommand(ctx: ExtensionContext, query: string): Promise<void> {
  const record = await chooseRecordToClose(ctx, query);
  if (!record) return;
  const reconciled = await reconcileRecord(record);
  const activeWarning = reconciled.tmuxAlive ? " The tmux window and running agent will be terminated." : "";
  const confirmed = await ctx.ui.confirm(
    "Close worktree?",
    `Remove ${record.worktreePath}? Branch ${record.branch} will be preserved.${activeWarning}`,
  );
  if (!confirmed) return;

  const closed = await closeHandoff(record);
  ctx.ui.notify(`Worktree closed: ${closed.id}\nBranch preserved: ${closed.branch}`, "info");
}

function commandUsage(ctx: ExtensionContext): void {
  ctx.ui.notify(
    "Usage: /worktree list | /worktree handoff [goal source] | /worktree close [id or prefix]",
    "warning",
  );
}

export default function handoffWorktreeExtension(pi: ExtensionAPI) {
  const { z } = pi.zod;
  const pending = new Map<string, PendingHandoff>();
  const latestGoals = new Map<string, GoalSnapshot>();

  pi.setLabel("Handoff Worktree");

  pi.registerCommand("worktree", {
    description: "List, create, or close dedicated goal-driven worktrees",
    getArgumentCompletions: completeWorktreeArgument,
    handler: async (rawArgs, ctx) => {
      const trimmed = rawArgs.trim();
      const [action = "", ...rest] = trimmed.split(/\s+/);
      const argument = rest.join(" ").trim();

      try {
        if (action === "list") {
          if (argument) return commandUsage(ctx);
          await showList(ctx);
          return;
        }
        if (action === "close") {
          await closeFromCommand(ctx, argument);
          return;
        }
        if (action !== "handoff") {
          commandUsage(ctx);
          return;
        }

        await ctx.waitForIdle();
        const repo = inspectRepo(ctx.cwd);
        if (repo.dirtyEntries.length > 0) {
          const preview = repo.dirtyEntries.slice(0, 8).join("\n");
          const suffix = repo.dirtyEntries.length > 8 ? `\n… and ${repo.dirtyEntries.length - 8} more` : "";
          ctx.ui.notify(
            `Handoff blocked: the current checkout has uncommitted changes. Commit or stash them before continuing.\n${preview}${suffix}`,
            "warning",
          );
          return;
        }

        const tmux = resolveTmuxTarget();
        const model = modelSpec(ctx);
        if (!model) throw new Error("Could not resolve the current model to inherit it in the new agent.");
        const requestId = crypto.randomUUID();
        const sessionId = ctx.sessionManager.getSessionId();
        const currentGoal = latestGoals.get(sessionId) || getPersistedGoal(ctx);
        const sessionVersion = ctx.sessionManager.getHeader().version;
        pending.set(requestId, {
          requestId,
          sessionId,
          sessionVersion,
          repo,
          tmux,
          model,
          thinking: pi.getThinkingLevel(),
        });
        ctx.ui.notify("Evaluating the current session and goal before creating the worktree.", "info");
        pi.sendUserMessage(
          buildEvaluationPrompt({
            requestId,
            sourceHint: argument,
            currentGoal,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`handoff-worktree: ${message}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "handoff_worktree_create",
    label: "Create Handoff Worktree",
    description:
      "Create a dedicated git worktree and tmux window after /worktree handoff has established a clear persisted goal. Never call without the request id from the evaluation prompt.",
    loadMode: "essential",
    approval: "write",
    parameters: z.object({
      requestId: z.string().uuid().describe("Request id supplied by /worktree handoff"),
      objective: z.string().min(20).describe("Exact objective of the active persisted goal"),
      acceptanceCriteria: z.array(z.string().min(3)).min(1).max(20),
      sourceSummary: z.string().min(3).max(1000),
      slug: z.string().min(1).max(60).describe("Short filesystem-safe task slug"),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const request = pending.get(params.requestId);
      if (!request || request.sessionId !== ctx.sessionManager.getSessionId()) {
        return toolText("No matching /worktree handoff request is pending in this session.", true);
      }

      const goal = latestGoals.get(request.sessionId) || getPersistedGoal(ctx);
      if (!goalMatches(goal, params.objective)) {
        return toolText(
          "Handoff refused: create or resume a persisted goal first, then pass its objective verbatim. Ask the user if replacing the current goal requires a decision.",
          true,
        );
      }

      const criteria = cleanCriteria(params.acceptanceCriteria);
      if (criteria.length === 0) return toolText("Handoff refused: at least one acceptance criterion is required.", true);

      try {
        const currentRepo = inspectRepo(ctx.cwd);
        if (currentRepo.root !== request.repo.root || currentRepo.head !== request.repo.head) {
          return toolText("Repository root or HEAD changed while evaluating the handoff. Run /worktree handoff again.", true);
        }
        if (currentRepo.dirtyEntries.length > 0) {
          return toolText("Checkout became dirty while evaluating the handoff. Commit or stash, then retry.", true);
        }

        const record = await createHandoff({
          objective: goal!.objective,
          acceptanceCriteria: criteria,
          sourceSummary: params.sourceSummary,
          slug: params.slug,
          parentSessionId: request.sessionId,
          parentSessionFile: ctx.sessionManager.getSessionFile(),
          sessionVersion: request.sessionVersion,
          model: request.model,
          thinking: request.thinking,
          repo: request.repo,
          tmux: request.tmux,
        });
        pending.delete(params.requestId);
        const warning = record.lastError ? `\nWarning: ${record.lastError}` : "";
        return toolText(
          `Handoff created.\nId: ${record.id}\nBranch: ${record.branch}\nWorktree: ${record.worktreePath}\nTmux: ${record.tmuxWindowId}${warning}`,
          false,
          record,
        );
      } catch (error) {
        return toolText(error instanceof Error ? error.message : String(error), true);
      }
    },
  });

  pi.on("goal_updated", async (event, ctx) => {
    const goal = asGoal(event.goal);
    const sessionId = ctx.sessionManager.getSessionId();
    if (goal) latestGoals.set(sessionId, goal);
    else latestGoals.delete(sessionId);

    if (!CHILD_ID || !goal) return;
    const record = await readRecord(CHILD_ID);
    if (!record || record.worktreePath !== ctx.cwd) return;
    await updateRecord(CHILD_ID, (current) => {
      if (current.status === "closing" || current.status === "closed") return current;
      if (goal.objective.trim() !== current.objective.trim()) {
        return {
          ...current,
          status: "failed",
          goalId: goal.id,
          goalStatus: goal.status,
          lastError: "Child agent created a goal that does not match the handoff objective.",
        };
      }
      const status =
        goal.status === "complete"
          ? "completed"
          : goal.status === "dropped"
            ? "dropped"
            : goal.status === "paused"
              ? "paused"
              : "active";
      return {
        ...current,
        status,
        goalId: goal.id,
        goalStatus: goal.status,
        goalTokensUsed: goal.tokensUsed,
        goalTimeUsedSeconds: goal.timeUsedSeconds,
        completedAt: TERMINAL_GOAL_STATUSES.has(goal.status) ? new Date().toISOString() : current.completedAt,
        lastError: undefined,
      };
    });
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!CHILD_ID) return;
    const record = await readRecord(CHILD_ID);
    if (!record || record.worktreePath !== ctx.cwd) return;
    await updateRecord(CHILD_ID, (current) => {
      if (current.status === "closing" || current.status === "closed") return current;
      return {
        ...current,
        status: current.status === "creating" ? "active" : current.status,
        childSessionId: ctx.sessionManager.getSessionId(),
      };
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!CHILD_ID) return;
    const record = await readRecord(CHILD_ID);
    if (!record || record.worktreePath !== ctx.cwd) return;
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Handoff Worktree\n\nThis is handoff ${record.id}. Before implementation, ensure goal mode is active with this exact objective: ${JSON.stringify(record.objective)}. Complete and verify every recorded acceptance criterion. The extension tracks goal_updated events; call goal complete only when the deliverable is actually done.`,
    };
  });
}
