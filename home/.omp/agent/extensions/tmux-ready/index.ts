import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const READY_MARK = "";
const QUESTION_MARK = "";
const QUESTION_TAB_BG = "colour223";
const QUESTION_TAB_FG = "black";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 250;
const READY_SETTLE_GRACE_MS = 500;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TMUX_STYLE = String.raw`(?:#\[[^\]]+\])*`;
const INDICATOR_CHARS = ["✅", READY_MARK, QUESTION_MARK, ...SPINNER_FRAMES]
  .map(escapeRegExp)
  .join("|");
const TRAILING_INDICATOR_RE = new RegExp(
  String.raw`\s*${TMUX_STYLE}(?:${INDICATOR_CHARS})${TMUX_STYLE}\s*$`,
  "u",
);

function runTmuxRaw(args: string[]): string | undefined {
  if (!process.env.TMUX) return undefined;

  try {
    const result = Bun.spawnSync(["tmux", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.toString().replace(/\r?\n$/, "");
  } catch {
    return undefined;
  }
}

function runTmux(args: string[]): string | undefined {
  return runTmuxRaw(args)?.trim();
}

function getTargetWindow(): string | undefined {
  const targetPane = process.env.TMUX_PANE || undefined;
  if (!targetPane) return undefined;
  return runTmux(["display-message", "-p", "-t", targetPane, "#{window_id}"]);
}

function getWindowName(targetWindow?: string): string | undefined {
  if (targetWindow) return runTmuxRaw(["display-message", "-p", "-t", targetWindow, "#W"]);

  const targetPane = process.env.TMUX_PANE || undefined;
  return targetPane
    ? runTmuxRaw(["display-message", "-p", "-t", targetPane, "#W"])
    : runTmuxRaw(["display-message", "-p", "#W"]);
}

let cachedIndicatorTargetWindow: string | undefined;
let cachedIndicatorBase: string | undefined;
let lastIndicatorWindowName: string | undefined;
let automaticRenameDisabledFor: string | undefined;

function setWindowName(name: string, targetWindow?: string, disableAutomaticRename = true): void {
  const targetKey = targetWindow ?? "__default__";
  if (disableAutomaticRename && automaticRenameDisabledFor !== targetKey) {
    const args = targetWindow
      ? ["set-window-option", "-t", targetWindow, "automatic-rename", "off"]
      : ["set-window-option", "automatic-rename", "off"];
    runTmux(args);
    automaticRenameDisabledFor = targetKey;
  }

  const args = targetWindow
    ? ["rename-window", "-t", targetWindow, name]
    : ["rename-window", name];
  runTmux(args);
}

function withoutIndicator(name: string): string {
  return name.replace(TRAILING_INDICATOR_RE, "").trimEnd();
}

function setIndicator(indicator: string): void {
  if (!cachedIndicatorBase) {
    cachedIndicatorTargetWindow = getTargetWindow();
    const current = getWindowName(cachedIndicatorTargetWindow);
    if (!current) return;
    const base = withoutIndicator(current);
    if (!base) return;
    cachedIndicatorBase = base;
    lastIndicatorWindowName = current;
  } else {
    const current = getWindowName(cachedIndicatorTargetWindow);
    if (current) {
      const base = withoutIndicator(current);
      if (base && base !== cachedIndicatorBase) {
        cachedIndicatorBase = base;
        lastIndicatorWindowName = current;
      }
    }
  }

  const next = `${cachedIndicatorBase} ${indicator}`;
  if (lastIndicatorWindowName !== next) {
    setWindowName(next, cachedIndicatorTargetWindow);
    lastIndicatorWindowName = next;
  }
}

function clearIndicator(): void {
  const targetWindow = cachedIndicatorTargetWindow ?? getTargetWindow();
  const current = getWindowName(targetWindow) ?? lastIndicatorWindowName;
  cachedIndicatorTargetWindow = undefined;
  cachedIndicatorBase = undefined;
  lastIndicatorWindowName = undefined;
  if (!current) return;

  const next = withoutIndicator(current);
  if (next && current !== next) setWindowName(next, targetWindow);
}

type WindowStatusFormatOption = "window-status-current-format" | "window-status-format";

interface TmuxOptionSnapshot {
  option: WindowStatusFormatOption;
  targetWindow: string;
  value: string;
  wasSetLocally: boolean;
}

function getWindowStatusFormat(
  option: WindowStatusFormatOption,
  targetWindow: string,
): TmuxOptionSnapshot | undefined {
  const localOption = runTmuxRaw(["show-options", "-wq", "-t", targetWindow, option]);

  if (localOption !== undefined && localOption !== "") {
    const local = runTmuxRaw(["show-options", "-wqv", "-t", targetWindow, option]);
    if (local === undefined) return undefined;
    return { option, targetWindow, value: local, wasSetLocally: true };
  }

  const global = runTmuxRaw(["show-options", "-gwqv", option]);
  if (global === undefined) return undefined;
  return { option, targetWindow, value: global, wasSetLocally: false };
}

function setWindowStatusFormat(
  option: WindowStatusFormatOption,
  targetWindow: string,
  format: string,
): void {
  runTmux(["set-window-option", "-q", "-t", targetWindow, option, format]);
  runTmux(["refresh-client", "-S"]);
}

function restoreWindowStatusFormat(snapshot: TmuxOptionSnapshot): void {
  if (!snapshot.wasSetLocally) {
    runTmux(["set-window-option", "-q", "-u", "-t", snapshot.targetWindow, snapshot.option]);
    runTmux(["refresh-client", "-S"]);
    return;
  }

  setWindowStatusFormat(snapshot.option, snapshot.targetWindow, snapshot.value);
}

function withQuestionTabBg(format: string): string {
  const baseBg = format.match(/(?:^|[,\[])bg=([^,\]]+)/)?.[1];
  if (!baseBg) return format;

  return format.replace(/#\[([^\]]*)\]/g, (full, attrs: string, offset: number) => {
    const nextStyleIndex = format.indexOf("#[", offset + full.length);
    const segment = format.slice(offset + full.length, nextStyleIndex === -1 ? undefined : nextStyleIndex);
    const isTextSegment = /#(?:I|W|\{(?:window_index|window_name|pane_current_command)\})/.test(segment);
    const parts = attrs.split(",");
    const hasBaseBg = parts.some((part) => part === `bg=${baseBg}`);
    const nextParts = parts.map((part) => {
      if (part === `bg=${baseBg}`) return `bg=${QUESTION_TAB_BG}`;
      if (part === `fg=${baseBg}`) return `fg=${QUESTION_TAB_BG}`;
      if (hasBaseBg && isTextSegment && part.startsWith("fg=")) return `fg=${QUESTION_TAB_FG}`;
      return part;
    });

    return `#[${nextParts.join(",")}]`;
  });
}

export default function tmuxReadyExtension(pi: ExtensionAPI) {
  let spinnerTimer: Timer | undefined;
  let readyTimer: Timer | undefined;
  let spinnerIndex = 0;
  let agentRunning = false;
  let savedWindowStatusFormats: TmuxOptionSnapshot[] = [];
  let questionAttentionActive = false;
  const pendingQuestionToolCallIds = new Set<string>();

  function isWaitingForQuestion(): boolean {
    return pendingQuestionToolCallIds.size > 0;
  }

  function stopSpinner(): void {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  }

  function stopReadyTimer(): void {
    if (!readyTimer) return;
    clearTimeout(readyTimer);
    readyTimer = undefined;
  }

  function enableQuestionAttention(): void {
    if (questionAttentionActive) return;
    const targetWindow = getTargetWindow();
    if (!targetWindow) return;

    const snapshots = [
      getWindowStatusFormat("window-status-current-format", targetWindow),
      getWindowStatusFormat("window-status-format", targetWindow),
    ].filter((snapshot): snapshot is TmuxOptionSnapshot => Boolean(snapshot));
    if (snapshots.length === 0) return;

    savedWindowStatusFormats = snapshots;
    for (const snapshot of snapshots) {
      setWindowStatusFormat(snapshot.option, targetWindow, withQuestionTabBg(snapshot.value));
    }
    questionAttentionActive = true;
  }

  function disableQuestionAttention(): void {
    if (!questionAttentionActive) return;
    for (const snapshot of savedWindowStatusFormats) restoreWindowStatusFormat(snapshot);
    savedWindowStatusFormats = [];
    questionAttentionActive = false;
  }

  function markReady(): void {
    stopReadyTimer();
    pendingQuestionToolCallIds.clear();
    disableQuestionAttention();
    stopSpinner();
    setIndicator(READY_MARK);
  }

  function markReadySoon(ctx: ExtensionContext): void {
    stopReadyTimer();

    const checkSettled = () => {
      readyTimer = undefined;
      if (agentRunning) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        readyTimer = setTimeout(checkSettled, 50);
        return;
      }
      markReady();
    };

    readyTimer = setTimeout(checkSettled, READY_SETTLE_GRACE_MS);
  }

  function markWorking(): void {
    stopReadyTimer();
    pendingQuestionToolCallIds.clear();
    disableQuestionAttention();
    stopSpinner();
    clearIndicator();
  }

  function markWaitingForQuestion(): void {
    stopSpinner();
    enableQuestionAttention();
    setIndicator(QUESTION_MARK);
  }

  function startSpinner(): void {
    if (spinnerTimer || isWaitingForQuestion()) return;
    disableQuestionAttention();

    spinnerIndex = 0;
    setIndicator(SPINNER_FRAMES[spinnerIndex]);
    spinnerTimer = setInterval(() => {
      if (isWaitingForQuestion()) {
        markWaitingForQuestion();
        return;
      }
      spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
      setIndicator(SPINNER_FRAMES[spinnerIndex]);
    }, SPINNER_INTERVAL_MS);
  }

  pi.on("session_start", async (_event, ctx) => {
    agentRunning = false;
    markReadySoon(ctx);
  });

  pi.on("input", async (event, ctx) => {
    const text = event.text.trimStart();
    const isDirectCommand = text.startsWith("/") || text.startsWith("!") || text.startsWith("$");
    agentRunning = !isDirectCommand;
    markWorking();
    if (isDirectCommand) markReadySoon(ctx);
  });

  pi.on("agent_start", async () => {
    agentRunning = true;
    startSpinner();
  });

  pi.on("turn_start", async () => {
    // session_stop continuations start a new turn without a new agent_start.
    agentRunning = true;
    stopReadyTimer();
    startSpinner();
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "ask") return;
    pendingQuestionToolCallIds.add(event.toolCallId);
    markWaitingForQuestion();
  });

  pi.on("tool_execution_start", async (event) => {
    if (event.toolName !== "ask") return;
    pendingQuestionToolCallIds.add(event.toolCallId);
    markWaitingForQuestion();
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "ask") return;
    pendingQuestionToolCallIds.delete(event.toolCallId);
    if (isWaitingForQuestion()) return;

    disableQuestionAttention();
    if (agentRunning) {
      startSpinner();
      return;
    }
    markReadySoon(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    const lastMessage = event.messages.at(-1);
    if (lastMessage?.role !== "assistant" || lastMessage.stopReason !== "aborted") return;

    agentRunning = false;
    markReadySoon(ctx);
  });

  pi.on("session_stop", async (_event, ctx) => {
    // agent_end also fires between internal continuations. session_stop is the
    // main-session settle boundary, so only it may mark the task as complete.
    agentRunning = false;
    markReadySoon(ctx);
  });

  pi.on("session_shutdown", async () => {
    agentRunning = false;
    markWorking();
  });
}
