import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";
export type HandoffStatus =
  | "creating"
  | "active"
  | "paused"
  | "completed"
  | "dropped"
  | "failed"
  | "closing"
  | "closed";

export interface HandoffRecord {
  version: 1;
  id: string;
  slug: string;
  status: HandoffStatus;
  objective: string;
  acceptanceCriteria: string[];
  sourceSummary: string;
  repoRoot: string;
  repoName: string;
  worktreePath: string;
  baseCommit: string;
  baseBranch: string | null;
  branch: string;
  promptPath: string;
  parentSessionId: string;
  parentSessionFile?: string;
  sessionVersion: number;
  childSessionId: string;
  childSessionFile: string;
  model: string;
  thinking?: string;
  tmuxSessionId: string;
  tmuxWindowId?: string;
  tmuxPaneId?: string;
  tmuxWindowName: string;
  goalId: string;
  goalStatus?: GoalStatus;
  goalTokensUsed?: number;
  goalTimeUsedSeconds?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  closedAt?: string;
  lastError?: string;
}

const LOCK_RETRIES = 100;
const LOCK_DELAY_MS = 20;

export function getStateDirectory(): string {
  return (
    process.env.OMP_HANDOFF_WORKTREE_STATE_DIR?.trim() || join(homedir(), ".omp", "agent", "handoff-worktree")
  );
}

export function getWorktreeDirectory(): string {
  return process.env.OMP_HANDOFF_WORKTREE_ROOT?.trim() || join(homedir(), ".omp", "wt", "handoff");
}

export function getRecordPath(id: string): string {
  return join(getStateDirectory(), `${id}.json`);
}

export function getPromptPath(id: string): string {
  return join(getStateDirectory(), `${id}.prompt.txt`);
}

export function getChildSessionPath(id: string): string {
  return join(getStateDirectory(), `${id}.session.jsonl`);
}

function isRecord(value: unknown): value is HandoffRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<HandoffRecord>;
  return (
    record.version === 1 &&
    typeof record.id === "string" &&
    typeof record.status === "string" &&
    typeof record.objective === "string" &&
    typeof record.worktreePath === "string"
  );
}

async function readRecordFile(path: string): Promise<HandoffRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (code !== "EEXIST") throw error;
      await delay(LOCK_DELAY_MS);
    }
  }

  throw new Error(`Timed out waiting for handoff state lock: ${lockPath}`);
}

async function writeAtomic(path: string, value: HandoffRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function createRecord(record: HandoffRecord): Promise<void> {
  const path = getRecordPath(record.id);
  const release = await acquireLock(path);
  try {
    if (await readRecordFile(path)) throw new Error(`Handoff record already exists: ${record.id}`);
    await writeAtomic(path, record);
  } finally {
    await release();
  }
}

export async function readRecord(id: string): Promise<HandoffRecord | undefined> {
  return await readRecordFile(getRecordPath(id));
}

export async function updateRecord(
  id: string,
  update: (current: HandoffRecord) => HandoffRecord,
): Promise<HandoffRecord | undefined> {
  const path = getRecordPath(id);
  const release = await acquireLock(path);
  try {
    const current = await readRecordFile(path);
    if (!current) return undefined;
    const next = update(current);
    next.updatedAt = new Date().toISOString();
    await writeAtomic(path, next);
    return next;
  } finally {
    await release();
  }
}

export async function listRecords(): Promise<HandoffRecord[]> {
  let names: string[];
  try {
    names = await readdir(getStateDirectory());
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }

  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) => readRecordFile(join(getStateDirectory(), name))),
  );
  return records
    .filter((record): record is HandoffRecord => Boolean(record))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function writeChildSession(record: HandoffRecord): Promise<string> {
  const timestamp = record.createdAt;
  const header = {
    type: "session",
    version: record.sessionVersion,
    id: record.childSessionId,
    timestamp,
    cwd: record.worktreePath,
    ...(record.parentSessionFile ? { parentSession: record.parentSessionFile } : {}),
  };
  const goal = {
    type: "mode_change",
    id: crypto.randomUUID().replaceAll("-", "").slice(0, 8),
    parentId: null,
    timestamp,
    mode: "goal",
    data: {
      goal: {
        id: record.goalId,
        objective: record.objective,
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: Date.parse(timestamp),
        updatedAt: Date.parse(timestamp),
      },
    },
  };
  await mkdir(dirname(record.childSessionFile), { recursive: true, mode: 0o700 });
  await writeFile(record.childSessionFile, `${JSON.stringify(header)}\n${JSON.stringify(goal)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return record.childSessionFile;
}

export async function writePrompt(id: string, content: string): Promise<string> {
  const path = getPromptPath(id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}
