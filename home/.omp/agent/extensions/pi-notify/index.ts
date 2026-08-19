import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const OMP_ICON_URL = pathToFileURL(join(import.meta.dir, "omp-icon.png")).href;
const TERMINAL_NOTIFIER = "terminal-notifier";
const COMPLETION_SETTLE_GRACE_MS = 500;

interface TmuxClient {
  activity: number;
  name: string;
  pid: number;
}

interface WezTermTarget {
  paneId: string;
  windowTitle: string | undefined;
}
function runCommand(args: string[]): string | undefined {
  try {
    const result = Bun.spawnSync(args, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.toString().trim();
  } catch {
    return undefined;
  }
}

function runTmux(args: string[]): string | undefined {
  if (!process.env.TMUX) return undefined;
  return runCommand(["tmux", ...args]);
}
function getNotificationTitle(ctx: ExtensionContext): string {
  const targetPane = process.env.TMUX_PANE?.trim();
  const windowName = targetPane
    ? runTmux(["display-message", "-p", "-t", targetPane, "#{window_name}"])
    : undefined;
  return windowName?.trim() || ctx.sessionManager.getSessionName()?.trim() || "Oh My Pi";
}


function getTmuxClient(targetSession: string): TmuxClient | undefined {
  const clients = runTmux([
    "list-clients",
    "-F",
    "#{client_name}\t#{session_id}\t#{client_activity}\t#{client_pid}",
  ]);
  if (!clients) return undefined;

  return clients
    .split("\n")
    .map((line): TmuxClient | undefined => {
      const [name, session, activityText, pidText] = line.split("\t");
      if (!name || session !== targetSession) return undefined;

      const activity = Number(activityText);
      const pid = Number(pidText);
      if (!Number.isFinite(activity) || !Number.isInteger(pid) || pid <= 0) return undefined;
      return { activity, name, pid };
    })
    .filter((client): client is TmuxClient => client !== undefined)
    .sort((left, right) => right.activity - left.activity)[0];
}

function getProcessAncestry(pid: number): number[] {
  const pids: number[] = [];
  let current = pid;

  for (let depth = 0; depth < 16 && current > 1; depth += 1) {
    pids.push(current);
    const parent = Number(
      runCommand(["/bin/ps", "-o", "ppid=", "-p", String(current)]),
    );
    if (!Number.isInteger(parent) || parent <= 1 || pids.includes(parent)) break;
    current = parent;
  }

  return pids;
}

function getWezTermTarget(
  weztermExecutable: string,
  clientName: string,
): WezTermTarget | undefined {
  const output = runCommand([weztermExecutable, "cli", "list", "--format", "json"]);
  if (!output) return undefined;

  try {
    const panes: unknown = JSON.parse(output);
    if (!Array.isArray(panes)) return undefined;

    for (const value of panes) {
      if (!value || typeof value !== "object") continue;
      const pane = value as Record<string, unknown>;
      if (pane.tty_name !== clientName) continue;
      if (typeof pane.pane_id !== "number" && typeof pane.pane_id !== "string") {
        return undefined;
      }
      return {
        paneId: String(pane.pane_id),
        windowTitle:
          typeof pane.window_title === "string" ? pane.window_title : undefined,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function getAeroSpaceWindowId(
  aerospaceExecutable: string,
  applicationPids: number[],
  windowTitle: string | undefined,
): string | undefined {
  const output = runCommand([
    aerospaceExecutable,
    "list-windows",
    "--all",
    "--format",
    "%{window-id}\t%{app-pid}\t%{window-title}",
  ]);
  if (!output) return undefined;

  const pids = new Set(applicationPids);
  const candidates = output
    .split("\n")
    .map((line) => {
      const [id, pidText, ...titleParts] = line.split("\t");
      const pid = Number(pidText);
      if (!id || !Number.isInteger(pid) || !pids.has(pid)) return undefined;
      return { id, title: titleParts.join("\t") };
    })
    .filter(
      (candidate): candidate is { id: string; title: string } =>
        candidate !== undefined,
    );

  if (windowTitle) {
    const titleMatches = candidates.filter(
      (candidate) => candidate.title === windowTitle,
    );
    if (titleMatches.length === 1) return titleMatches[0].id;
  }

  return candidates.length === 1 ? candidates[0].id : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function getClickCommand(group: string): string {
  const command = (args: string[]) => args.map(shellQuote).join(" ");
  const terminalNotifier = Bun.which(TERMINAL_NOTIFIER) ?? TERMINAL_NOTIFIER;
  const removeNotification = command([terminalNotifier, "-remove", group]);
  const dismissNotification = `${command([
    "/usr/bin/nohup",
    "/bin/sh",
    "-c",
    `${command(["/bin/sleep", "1"])}; ${removeNotification}`,
  ])} >/dev/null 2>&1 &`;
  const targetPane = process.env.TMUX_PANE?.trim();
  const tmuxSocket = process.env.TMUX?.split(",", 1)[0]?.trim();
  const tmuxExecutable = Bun.which("tmux");
  if (!targetPane || !tmuxSocket || !tmuxExecutable) return dismissNotification;

  const targetSession = runTmux([
    "display-message",
    "-p",
    "-t",
    targetPane,
    "#{session_id}",
  ]);
  if (!targetSession) return dismissNotification;

  const client = getTmuxClient(targetSession);
  if (!client) return dismissNotification;

  const tmux = (args: string[]) =>
    command([tmuxExecutable, "-S", tmuxSocket, ...args]);
  const ancestry = getProcessAncestry(client.pid);
  const weztermExecutable = Bun.which("wezterm");
  const weztermTarget = weztermExecutable
    ? getWezTermTarget(weztermExecutable, client.name)
    : undefined;
  const weztermPane =
    weztermTarget?.paneId ?? process.env.WEZTERM_PANE?.trim();
  const aerospaceExecutable = Bun.which("aerospace");
  const aerospaceWindowId =
    aerospaceExecutable && weztermTarget
      ? getAeroSpaceWindowId(
          aerospaceExecutable,
          ancestry,
          weztermTarget.windowTitle,
        )
      : undefined;
  const activationCommands =
    weztermExecutable && weztermPane
      ? [
          command([
            weztermExecutable,
            "cli",
            "activate-pane",
            "--pane-id",
            weztermPane,
          ]),
          ...(aerospaceExecutable && aerospaceWindowId
            ? [
                command([
                  aerospaceExecutable,
                  "focus",
                  "--window-id",
                  aerospaceWindowId,
                ]),
              ]
            : []),
          command(["/usr/bin/open", "-a", "WezTerm"]),
        ]
      : [
          command([
            "/usr/bin/osascript",
            "-l",
            "JavaScript",
            "-e",
            `ObjC.import("AppKit"); for (const pid of ${JSON.stringify(ancestry)}) { const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid); if (app && !app.isNil()) { app.activateWithOptions(3); break; } }`,
          ]),
        ];

  return [
    tmux(["select-window", "-t", targetPane]),
    tmux(["select-pane", "-t", targetPane]),
    tmux(["switch-client", "-c", client.name, "-t", targetSession]),
    ...activationCommands,
    dismissNotification,
  ].join("; ");
}

type NotificationMessage = "Concluída" | "Precisa de input";

async function sendNotification(
  ctx: ExtensionContext,
  message: NotificationMessage,
): Promise<void> {
  const title = getNotificationTitle(ctx);
  const group = `omp-${ctx.sessionManager.getSessionId()}`;
  const clickCommand = getClickCommand(group);

  try {
    const child = Bun.spawn(
      [
        TERMINAL_NOTIFIER,
        "-title",
        title,
        "-message",
        message,
        "-group",
        group,
        "-appIcon",
        OMP_ICON_URL,
        "-contentImage",
        OMP_ICON_URL,
        "-execute",
        clickCommand,
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      ctx.ui.notify(
        `pi-notify: terminal-notifier exited with code ${exitCode}: ${stderr.trim()}`,
        "error",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`pi-notify: ${message}`, "error");
  }
}

export default function piNotifyExtension(pi: ExtensionAPI) {
  const notifiedQuestionIds = new Set<string>();
  let completionTimer: Timer | undefined;
  let taskRunning = false;

  function cancelCompletion(): void {
    if (!completionTimer) return;
    clearTimeout(completionTimer);
    completionTimer = undefined;
  }

  function notifyWhenSettled(ctx: ExtensionContext): void {
    cancelCompletion();

    const checkSettled = () => {
      completionTimer = undefined;
      if (taskRunning) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        completionTimer = setTimeout(checkSettled, 50);
        return;
      }
      void sendNotification(ctx, "Concluída");
    };

    completionTimer = setTimeout(checkSettled, COMPLETION_SETTLE_GRACE_MS);
  }

  pi.on("agent_start", async () => {
    taskRunning = true;
    cancelCompletion();
  });

  pi.on("turn_start", async () => {
    taskRunning = true;
    cancelCompletion();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "ask" || notifiedQuestionIds.has(event.toolCallId)) return;
    notifiedQuestionIds.add(event.toolCallId);
    await sendNotification(ctx, "Precisa de input");
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName === "ask") notifiedQuestionIds.delete(event.toolCallId);
  });


  pi.on("session_stop", async (_event, ctx) => {
    taskRunning = false;
    notifyWhenSettled(ctx);
  });

  pi.on("session_shutdown", async () => {
    cancelCompletion();
    notifiedQuestionIds.clear();
  });
}
