// @orca-managed-pi-extension
// Why: no package-specific type import here. Pi and OMP expose the same
// extension API, but publish their types under different package names.
// Why: warn-once so a recurring parse error on a malformed endpoint
// file does not spam stderr inside the pi TUI on every event.
let warnedBadEndpoint = false
// Why: Pi awaits extension handlers. Status delivery stays off that
// critical path, and the latest-only pending slot prevents a stalled
// Orca receiver from building an unbounded queue of obsolete snapshots.
const HOOK_POST_TIMEOUT_MS = 1000
type HookPost = { hookEventName: string; extra: Record<string, unknown>; metadata: Record<string, unknown>; ompRuntime: boolean; revision: number; attempts: number; delivered: boolean; final?: boolean }
type HookPostQueue = { activePost: HookPost | null; pendingPost: HookPost | null; latestPost: HookPost | null; finalPosts: HookPost[]; finalRetryTimer: ReturnType<typeof setTimeout> | null; postRevision: number; retryTimer: ReturnType<typeof setTimeout> | null }
declare global { var __orcaPiStatusPostQueue: HookPostQueue | undefined }
const postQueue: HookPostQueue = globalThis.__orcaPiStatusPostQueue ??= { activePost: null, pendingPost: null, latestPost: null, finalPosts: [], finalRetryTimer: null, postRevision: 0, retryTimer: null }

function cancelPostRetry(): void {
  if (postQueue.retryTimer !== null) clearTimeout(postQueue.retryTimer)
  postQueue.retryTimer = null
}

// Why: a queued or scheduled post builds its body later, so it already carries newer state.
function hasQueuedPost(): boolean {
  return postQueue.pendingPost !== null || postQueue.retryTimer !== null
}

function resetPostQueue(): void {
  cancelPostRetry()
  postQueue.postRevision++
  for (const post of [postQueue.activePost, postQueue.pendingPost, postQueue.latestPost]) {
    if (!post || post.hookEventName !== 'agent_end' || post.delivered || post.final) continue
    post.final = true
    postQueue.finalPosts.push(post)
  }
  postQueue.pendingPost = null
  postQueue.latestPost = null
  drainPosts()
}

function retireTurnCompletionPosts(metadata: Record<string, unknown>): void {
  const first = postQueue.finalPosts[0]
  for (const post of postQueue.finalPosts) {
    if (post.extra.session_boundary !== true && post.metadata.session_id === metadata.session_id) post.final = false
  }
  postQueue.finalPosts = postQueue.finalPosts.filter((post) => post.final)
  if (first && !first.final && postQueue.finalRetryTimer !== null) {
    clearTimeout(postQueue.finalRetryTimer)
    postQueue.finalRetryTimer = null
  }
}

function drainPosts(): void {
  if (postQueue.activePost || postQueue.finalRetryTimer !== null) return
  const next = postQueue.finalPosts[0] ?? postQueue.pendingPost
  if (!next) return
  if (!next.final) postQueue.pendingPost = null
  postQueue.activePost = next
  void postOnce(next.hookEventName, next.extra, next.metadata, next.ompRuntime, next.final === true)
    .then(() => {
      next.delivered = true
      if (next.final) postQueue.finalPosts.shift()
    })
    .catch(() => {
      if (next.final) {
        if (next.attempts >= 3) {
          postQueue.finalPosts.shift()
          console.warn('[orca-pi-status] hook delivery failed after retries:', next.hookEventName)
          return
        }
        postQueue.finalRetryTimer = setTimeout(() => {
          postQueue.finalRetryTimer = null
          drainPosts()
        }, 250 * 2 ** next.attempts++)
        if (typeof postQueue.finalRetryTimer.unref === 'function') postQueue.finalRetryTimer.unref()
        return
      }
      if (!next.ompRuntime || next.revision !== postQueue.postRevision) return
      if (next.attempts >= 3) {
        console.warn('[orca-pi-status] hook delivery failed after retries:', next.hookEventName)
        return
      }
      const delay = 250 * 2 ** next.attempts++
      postQueue.retryTimer = setTimeout(() => {
        postQueue.retryTimer = null
        if (next.revision !== postQueue.postRevision) return
        postQueue.pendingPost = next
        drainPosts()
      }, delay)
      if (typeof postQueue.retryTimer.unref === 'function') postQueue.retryTimer.unref()
    })
    .finally(() => {
      postQueue.activePost = null
      drainPosts()
    })
}

let piUiPromptDepth = 0
let piTurnInFlight = false
let modelMetadata: Record<string, unknown> = {}
let ompModelSwitchSupported = false
let modelSessionId: unknown = undefined

// Why: OMP switches sessions in-process; a model belongs to the session that
// reported it, so it must not leak onto the first posts of the next one.
function trackModelSession(sessionId: unknown): void {
  if (sessionId === modelSessionId) return
  modelSessionId = sessionId
  modelMetadata = {}
}

// Why: pi and OMP expose the active model as { provider, id } on both the event
// context and model_select events; the joined selector is what --model accepts.
function updateModelMetadata(source: unknown): void {
  try {
    if (!source || typeof source !== 'object' || !('model' in source)) return
    const model = source.model
    if (!model || typeof model !== 'object') return
    const provider = 'provider' in model && typeof model.provider === 'string' ? model.provider : ''
    const id = 'id' in model && typeof model.id === 'string' ? model.id : ''
    if (provider && id) modelMetadata = { model: provider + '/' + id, ...(ompModelSwitchSupported ? { model_switch_command: 'orca-model' } : {}) }
  } catch {
    // Why: a throwing model getter must never break status delivery.
  }
}

type SubagentDetail = { agentType?: string; description?: string; startedAt: number; workflow?: boolean; parent?: string; registration?: object }
type SubagentRoster = { active: Set<string>; exited?: Set<string>; details?: Map<string, SubagentDetail>; waiting: boolean; ownsPane?: boolean; runGeneration?: number; endedRunGeneration?: number; completionPostedGeneration?: number; parked?: Map<string, Map<string, SubagentDetail>>; onEvent?: (event: unknown, forcedStatus?: string) => void; listener?: (event: unknown) => void; onRunnerExit?: (event: unknown) => void; runnerExitListener?: (event: unknown) => void; runnerExitCheck?: ReturnType<typeof setTimeout> | null; onRunnerExitSettled?: () => void }
const MAX_SUBAGENT_SNAPSHOT = 32
let subagentRoster: SubagentRoster | null = null

function isVisibleSubagent(roster: SubagentRoster, id: string): boolean {
  return roster.active.has(id) && !roster.exited?.has(id) && roster.details?.get(id)?.workflow !== true
}

function subagentPayload(): Record<string, unknown> {
  if (!subagentRoster) return {}
  const subagents: Record<string, unknown>[] = []
  for (const id of subagentRoster.active) {
    if (!isVisibleSubagent(subagentRoster, id)) continue
    const detail = subagentRoster.details?.get(id)
    subagents.push({ id, state: 'working', startedAt: detail?.startedAt ?? 0, ...(detail?.agentType ? { agentType: detail.agentType } : {}), ...(detail?.description ? { description: detail.description } : {}) })
    if (subagents.length >= MAX_SUBAGENT_SNAPSHOT) break
  }
  return subagents.length > 0 ? { subagents } : {}
}

let sessionMetadata: Record<string, unknown> = {}
let runtimeOmpSessionMetadata: Record<string, unknown> = {}

function updateSessionMetadata(ctx: unknown): void {
  const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => unknown; getSessionFile?: () => unknown } } | null)?.sessionManager
  const sessionId = sessionManager?.getSessionId?.()
  const sessionFile = sessionManager?.getSessionFile?.()
  sessionMetadata = typeof sessionId === 'string' && sessionId ? {
    session_id: sessionId,
    ...(typeof sessionFile === 'string' && sessionFile ? { session_file: sessionFile } : {}),
  } : {}
}

function updateRuntimeOmpSessionMetadata(ctx: unknown): void {
  if (!isOmpRuntime()) return
  const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => unknown; getSessionFile?: () => unknown } } | null)?.sessionManager
  const sessionId = sessionManager?.getSessionId?.()
  const sessionFile = sessionManager?.getSessionFile?.()
  runtimeOmpSessionMetadata = typeof sessionId === 'string' && sessionId && typeof sessionFile === 'string' && sessionFile ? { session_id: sessionId, session_file: sessionFile } : {}
  trackModelSession(runtimeOmpSessionMetadata.session_id)
  updateModelMetadata(ctx)
}

function getPostSessionMetadata(ompRuntime: boolean): Record<string, unknown> {
  return ompRuntime ? { ...runtimeOmpSessionMetadata, ...modelMetadata } : sessionMetadata
}

function getPersistedSessionMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sessionFile = metadata.session_file
  if (typeof sessionFile !== 'string' || !sessionFile) return {}
  try {
    const fs = require('fs')
    // Why: Pi publishes its planned path before creating the transcript;
    // recheck on every post so the first completed turn becomes resumable.
    return fs.existsSync(sessionFile) ? metadata : {}
  } catch {
    return {}
  }
}


// Why: re-reading the endpoint file on every event is cheap (small file,
// rare changes) but stat+mtime caching avoids re-parsing on every event
// during streaming tool execution. Mirrors the OpenCode plugin cache shape.
let cachedEndpointKey = ''
let cachedEndpointValues: Record<string, string> | null = null

function readEndpointFile(): Record<string, string> | null {
  const path = process.env.ORCA_AGENT_HOOK_ENDPOINT
  if (!path) return null
  try {
    const fs = require('fs')
    try {
      const stat = fs.statSync(path)
      const cacheKey = stat.mtimeMs + ':' + stat.size + ':' + stat.ino
      if (cacheKey === cachedEndpointKey && cachedEndpointValues) {
        return cachedEndpointValues
      }
      const contents: string = fs.readFileSync(path, 'utf8')
      const out: Record<string, string> = {}
      for (const line of contents.split(/\r?\n/)) {
        // Why: parse `KEY=VALUE` (POSIX endpoint.env) and `set KEY=VALUE`
        // (Windows endpoint.cmd) with one regex; strip a trailing CR so
        // mixed-EOL files do not leak \r into the value.
        const m = line.match(/^(?:set\s+)?([A-Z0-9_]+)=(.*)$/)
        if (m) out[m[1]] = m[2].replace(/\r$/, '')
      }
      cachedEndpointKey = cacheKey
      cachedEndpointValues = out
      return out
    } catch (ioErr) {
      cachedEndpointKey = ''
      cachedEndpointValues = null
      throw ioErr
    }
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code
    if (err && code !== 'ENOENT' && !warnedBadEndpoint) {
      warnedBadEndpoint = true
      console.warn('[orca-pi-status] failed to parse endpoint file:', (err as Error).message)
    }
    return null
  }
}

function resolveHookCoords() {
  const fileEnv = readEndpointFile() || {}
  return {
    port: fileEnv.ORCA_AGENT_HOOK_PORT || process.env.ORCA_AGENT_HOOK_PORT,
    token: fileEnv.ORCA_AGENT_HOOK_TOKEN || process.env.ORCA_AGENT_HOOK_TOKEN,
    env: fileEnv.ORCA_AGENT_HOOK_ENV || process.env.ORCA_AGENT_HOOK_ENV || '',
    version: fileEnv.ORCA_AGENT_HOOK_VERSION || process.env.ORCA_AGENT_HOOK_VERSION || '',
  }
}

function processName(value: unknown): string {
  return String(value || '').split(/[\\/]/).pop()?.toLowerCase() || ''
}

const CONFIGURED_HOOK_PATH = '/hook/pi'
let cachedOmpRuntime: boolean | null = null

function isOmpRuntime(): boolean {
  if (cachedOmpRuntime !== null) return cachedOmpRuntime
  if (CONFIGURED_HOOK_PATH === '/hook/omp') {
    cachedOmpRuntime = true
    return true
  }
  const executableNames = [
    processName(process.title),
    processName(process.env._),
    processName(process.argv[1]),
    processName(process.argv[0])
  ]
  cachedOmpRuntime = executableNames.some((name) =>
    ['omp', 'omp.js', 'omp.sh', 'omp.cmd', 'omp.exe', 'omp.bat'].includes(name)
  )
  return cachedOmpRuntime
}

function resolveHookPath(ompRuntime: boolean): string {
  // Why: runtime detection keeps a bare-shell OMP launch from reporting as Pi.
  if (ompRuntime) return '/hook/omp'
  return CONFIGURED_HOOK_PATH
}

function post(hookEventName: string, extra: Record<string, unknown> = {}, final = false): void {
  const ompRuntime = isOmpRuntime()
  const metadata = getPostSessionMetadata(ompRuntime)
  if (final) {
    postQueue.finalPosts.push({ revision: postQueue.postRevision, attempts: 0, delivered: false, hookEventName, extra, metadata, ompRuntime, final })
    drainPosts()
    return
  }
  cancelPostRetry()
  if (hookEventName === 'before_agent_start' || hookEventName === 'agent_start') retireTurnCompletionPosts(metadata)
// Model changes must not erase an unacknowledged completion in the latest-only slot.
  const previousCompletion = postQueue.latestPost?.hookEventName === 'agent_end' && !postQueue.latestPost.delivered && postQueue.latestPost.metadata.session_id === metadata.session_id
  postQueue.pendingPost = {
    revision: ++postQueue.postRevision,
    attempts: 0,
    delivered: false,
    hookEventName: ompRuntime && hookEventName === 'model_select' && previousCompletion ? 'agent_end' : hookEventName,
    extra: { ...extra, ...(!ompRuntime && piUiPromptDepth > 0 ? { ui_prompt_active: true } : {}) },
    metadata,
    ompRuntime,
  }
  postQueue.latestPost = postQueue.pendingPost
  drainPosts()
}

async function postOnce(
  hookEventName: string,
  extra: Record<string, unknown>,
  metadata: Record<string, unknown>,
  ompRuntime: boolean,
  final: boolean
): Promise<void> {
  const coords = resolveHookCoords()
  const paneKey = process.env.ORCA_PANE_KEY
  if (!coords.port || !coords.token || !paneKey) return
  const url = `http://127.0.0.1:${coords.port}${resolveHookPath(ompRuntime)}`
  const body = JSON.stringify({
    paneKey,
    launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN || '',
    tabId: process.env.ORCA_TAB_ID || '',
    worktreeId: process.env.ORCA_WORKTREE_ID || '',
    env: coords.env,
    version: coords.version,
    payload: { hook_event_name: hookEventName, ...(ompRuntime ? metadata : getPersistedSessionMetadata(metadata)), ...(final ? {} : subagentPayload()), ...extra },
  })
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller?.abort()
      reject(new Error('Orca hook delivery timed out'))
    }, HOOK_POST_TIMEOUT_MS)
    if (typeof timeout.unref === 'function') timeout.unref()
  })
  try {
    const response = await Promise.race([
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': coords.token,
        },
        body,
        ...(controller ? { signal: controller.signal } : {}),
      }),
      timeoutPromise,
    ])
    if (!response.ok) throw new Error('Orca hook HTTP ' + response.status)
  } catch (error) {
    // Why: status reporting must never fail the pi run just because Orca
    // is unavailable or the loopback request failed (e.g. Orca restart).
    if (!isWslRuntime()) throw error
    await postViaWindowsCurl(body, ompRuntime)
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

// Why: WSL-ness and curl.exe presence cannot change within a process
// lifetime; re-probing /proc and /mnt/c on every failed event would add
// filesystem work to the per-event path.
let cachedIsWslRuntime: boolean | null = null
let cachedWindowsCurlPath: string | null | undefined

function isWslRuntime(): boolean {
  if (cachedIsWslRuntime !== null) return cachedIsWslRuntime
  cachedIsWslRuntime = detectWslRuntime()
  return cachedIsWslRuntime
}

function detectWslRuntime(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true
  try {
    const fs = require('fs')
    for (const path of ['/proc/sys/kernel/osrelease', '/proc/version']) {
      try {
        const contents = String(fs.readFileSync(path, 'utf8'))
        if (/microsoft|wsl/i.test(contents)) return true
      } catch {
        // Why: probe the next runtime hint when a proc file is absent or unreadable.
      }
    }
  } catch {
    return false
  }
  return false
}

function resolveWindowsCurlPath(): string | null {
  if (cachedWindowsCurlPath !== undefined) return cachedWindowsCurlPath
  try {
    const fs = require('fs')
    const curlPath = '/mnt/c/Windows/System32/curl.exe'
    cachedWindowsCurlPath = fs.existsSync(curlPath) ? curlPath : null
  } catch {
    cachedWindowsCurlPath = null
  }
  return cachedWindowsCurlPath
}

// Why: WSL loopback is not the Windows loopback, so use curl.exe on the host.
async function postViaWindowsCurl(body: string, ompRuntime: boolean): Promise<void> {
  const curlPath = resolveWindowsCurlPath()
  const windowsPort = process.env.ORCA_AGENT_HOOK_PORT
  const windowsToken = process.env.ORCA_AGENT_HOOK_TOKEN
  if (!curlPath || !windowsPort || !windowsToken) throw new Error('Orca WSL hook bridge unavailable')
  // Why: a stale guest endpoint must fall back to current host coordinates.
  const windowsUrl = `http://127.0.0.1:${windowsPort}${resolveHookPath(ompRuntime)}`
  await new Promise<void>((resolve, reject) => {
    const { spawn } = require('child_process')
    const child = spawn(
      curlPath,
      [
        '-sS', '--fail',
        // WSL interop needs a bounded, acknowledged delivery window.
        '--connect-timeout', '3',
        '--max-time', '10',
        '--noproxy', '127.0.0.1',
        '-o', 'NUL',
        '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-H', `X-Orca-Agent-Hook-Token: ${windowsToken}`,
        '--data-binary', '@-',
        windowsUrl
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] }
    )
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      reject(new Error('Orca WSL hook delivery timed out'))
    }, 11000)
    if (typeof timer.unref === 'function') timer.unref()
    const fail = (error: Error): void => { clearTimeout(timer); reject(error) }
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (code === 0) resolve(); else reject(new Error('Orca WSL hook exit ' + code))
    })
    child.stdin.end(body)
  })
}

function statusInputReferencesCredentialPath(value: string): boolean {
  const path = value.replace(/\\/g, '/')
  return /(?:^|[^a-z0-9_.-]|\$(?:[a-z_][a-z0-9_]*|[0-9]))\.(?:ssh|ssh-mcp)(?=$|[^a-z0-9_.-])/i.test(path) ||
    /\.mcp-secrets\.env(?=$|[^a-z0-9_.-])/i.test(path) ||
    /(?:^|[^a-z0-9_.-]|\$(?:[a-z_][a-z0-9_]*|[0-9]))\.omp-backups-archive\/omp-bak-keyfile(?=$|[^a-z0-9_.-])/i.test(path)
}

function sanitizeStatusToolInput(input: unknown): unknown {
  const ancestors = new WeakSet<object>()
  let remainingNodes = 4096
  let remainingChars = 262144
  function checkText(text: string): void {
    remainingChars -= text.length
    if (remainingChars < 0 || statusInputReferencesCredentialPath(text)) throw new Error('redact')
  }
  function copy(value: unknown, depth: number): unknown {
    if (--remainingNodes < 0 || depth > 64) throw new Error('redact')
    if (typeof value === 'string') { checkText(value); return value }
    if (value === null || value === undefined || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'object' || ancestors.has(value)) throw new Error('redact')
    const array = Array.isArray(value)
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
      if (!Number.isSafeInteger(length) || length < 0 || length > remainingNodes) throw new Error('redact')
      remainingNodes -= length
    }
    const prototype = Object.getPrototypeOf(value)
    if (!array && prototype !== null) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
      if (Object.getPrototypeOf(prototype) !== null || !constructor || !('value' in constructor) ||
          typeof constructor.value !== 'function' ||
          Object.getOwnPropertyDescriptor(constructor.value, 'name')?.value !== 'Object') {
        throw new Error('redact')
      }
    }
    ancestors.add(value)
    // Copy data descriptors only; never return an object that can run toJSON later.
    const result = array ? [] : Object.create(null)
    if (array) Object.setPrototypeOf(result, null)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error('redact')
      checkText(key)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) throw new Error('redact')
      const copied = copy(descriptor.value, depth + 1)
      Object.defineProperty(result, key, { value: copied, enumerable: descriptor.enumerable,
        writable: true, configurable: key !== 'length' || !array })
    }
    ancestors.delete(value)
    return result
  }
  try { return copy(input, 0) } catch { return { redacted: true } }
}
// Why: pi assistant messages carry content as an array of parts
// ({ type: 'text', text } / tool_use / tool_result / reasoning). We only
// surface the concatenated text parts as the visible 'last assistant
// message' for the dashboard preview — tool_use / reasoning would be
// noise (the dashboard already shows the active tool name + input).
function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') out += text
    }
  }
  return out
}

// Preserve ordinary preview data; credential references never leave the agent host.
// Why: a restarted agent inherits the previous owner PID through env, so a
// dead owner must be claimable or the pane goes silent for good. Only ESRCH
// proves the owner is gone -- every other probe result keeps suppression, so
// a live foreign owner still cannot double-report. Mirrors the tri-state in
// main/agent-hooks/managed-hook-owner-identity.ts, which this runtime cannot
// import (the extension loads inside pi/omp with no Orca deps).
function isStatusOwnerAlive(pid: string): boolean {
  const parsed = Number(pid)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 0x7fffffff) return false
  if (typeof process.kill !== 'function') return true
  try {
    process.kill(parsed, 0)
    return true
  } catch (err: unknown) {
    return (err as { code?: string } | null)?.code !== 'ESRCH'
  }
}

// Why: child agents inherit the lead's pane env; only its process may
// register status hooks. PID identity keeps in-process reloads reporting.
export default function (pi): void {
  const ownerPid = process.env.ORCA_PI_STATUS_OWNED
  const selfPid = String(process.pid)
  if (ownerPid && ownerPid !== selfPid && isStatusOwnerAlive(ownerPid)) return
  process.env.ORCA_PI_STATUS_OWNED = selfPid
  resetPostQueue()
  const piEventBus = (pi as { events?: { __orcaPiSubagents?: SubagentRoster; __orcaPiSubagentsHeard?: boolean; __orcaPiRunnerExitsHeard?: boolean; on?: (name: string, handler: (event: unknown) => void) => void } }).events
  const runStateHome: { __orcaPiSubagents?: SubagentRoster } | undefined = isOmpRuntime() ? piEventBus : (globalThis as { __orcaPiSubagents?: SubagentRoster })
  const busRoster = piEventBus?.__orcaPiSubagents
  const lifecycleState: SubagentRoster = busRoster ?? runStateHome?.__orcaPiSubagents ?? { active: new Set<string>(), waiting: false }
  if (runStateHome) runStateHome.__orcaPiSubagents = lifecycleState
  const subagentDetails = (lifecycleState.details ??= new Map<string, SubagentDetail>())
  lifecycleState.runGeneration ??= 0
  lifecycleState.endedRunGeneration ??= 0
  lifecycleState.completionPostedGeneration ??= -1
  subagentRoster ??= lifecycleState
  const ownsPaneRoster = subagentRoster === lifecycleState
  const registration = {}
  function resetSubagentRoster(): void {
    clearRunnerExitCheck()
    lifecycleState.active.clear()
    lifecycleState.exited?.clear()
    subagentDetails.clear()
    lifecycleState.waiting = false
  }
  if (ownsPaneRoster && piEventBus?.on && !piEventBus.__orcaPiSubagentsHeard && !busRoster?.listener) {
    piEventBus.__orcaPiSubagentsHeard = true
    piEventBus.on('task:subagent:lifecycle', (event: unknown) => lifecycleState.onEvent?.(event))
    piEventBus.on('subagent:async-started', (event: unknown) => lifecycleState.onEvent?.(event, 'started'))
    piEventBus.on('subagent:async-complete', (event: unknown) => lifecycleState.onEvent?.(event, 'completed'))
  }
  if (ownsPaneRoster && piEventBus?.on && !piEventBus.__orcaPiRunnerExitsHeard && !busRoster?.runnerExitListener) {
    piEventBus.__orcaPiRunnerExitsHeard = true
    piEventBus.on('subagent:process-terminal', (event: unknown) => lifecycleState.onRunnerExit?.(event))
  }
  // SessionManager survives reload/new/resume; task children own a different instance.
  function sessionProvenance(ctx): { manager: unknown; id?: string; file?: string; parent?: string } | undefined {
    const manager = ctx?.sessionManager
    if (!manager || typeof manager !== 'object') return undefined
    const id = typeof manager.getSessionId === "function" ? manager.getSessionId() : undefined
    const file = typeof manager.getSessionFile === "function" ? manager.getSessionFile() : undefined
    const header = typeof manager.getHeader === "function" ? manager.getHeader() : undefined
    return { manager, id, file, parent: typeof header?.parentSession === "string" ? header.parentSession : undefined }
  }

  function normalizeSessionPath(file): string {
    const normalized = file.replace(/\\/g, "/")
    return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
  }

  function isNestedTaskTranscript(parentFile, candidateFile): boolean {
    if (typeof parentFile !== "string" || typeof candidateFile !== "string") return false
    const parent = normalizeSessionPath(parentFile)
    const candidate = normalizeSessionPath(candidateFile)
    const root = parent.endsWith(".jsonl") ? parent.slice(0, -6) : parent
    return candidate.startsWith(`${root}/`) && candidate !== parent
  }

  function ownsSessionStatus(ctx): boolean {
    if (!isOmpRuntime()) return true
    // Newer OMP builds may expose this computed runtime provenance directly.
    if (ctx?.agentKind === "sub") return false
    const current = sessionProvenance(ctx)
    if (!current) return true
    // A task transcript is never the pane's resumable root, even when its
    // callback arrives before the root session reports on the shared hook.
    if (current.parent) return false
    // Keep ownership through module reload and shutdown while child sessions drain.
    const key = Symbol.for('orca.omp.status-session-owners')
    let owners = Reflect.get(globalThis, key)
    if (!(owners instanceof Map)) {
      owners = new Map()
      Reflect.set(globalThis, key, owners)
    }
    const pane = JSON.stringify([process.env.ORCA_PANE_KEY, process.env.ORCA_AGENT_LAUNCH_TOKEN])
    const owner = owners.get(pane)
    if (owner) {
      if (owner.manager === current.manager) return true
      if (current.parent === owner.file || current.parent === owner.id) return false
      if (isNestedTaskTranscript(owner.file, current.file)) return false
      return false
    }
    owners.set(pane, current)
    return true
  }

  function onStatus(name, handler): void {
    pi.on(name, (event, ctx) => {
      if (!ownsSessionStatus(ctx)) return
      lifecycleState.ownsPane = true
      return handler(event, ctx)
    })
  }

  onStatus('session_start', () => {})

  const onOmpSessionChange = (event, ctx) => {
    if (!isOmpRuntime()) return
    if (event?.reason === 'fork' || event?.reason === 'resume') {
      if (isTurnInFlight()) {
        lifecycleState.endedRunGeneration = lifecycleState.runGeneration
        postAgentEndOnce()
      }
    } else {
      closeOutRun()
    }
    updateRuntimeOmpSessionMetadata(ctx)
  }
  pi.on('session_switch', onOmpSessionChange)
  pi.on('session_branch', onOmpSessionChange)
  onStatus('session_shutdown', (event) => {
    clearPendingAgentEndCheck()
    if (isOmpRuntime()) {
      clearRunnerExitCheck()
      resetPostQueue()
      return
    }
    piUiPromptDepth = 0
    const reason = (event as { reason?: unknown } | null)?.reason
    const target = (event as { targetSessionFile?: unknown } | null)?.targetSessionFile
    const keepsSession = reason === 'reload' || (reason === 'resume' && typeof target === 'string' && target === sessionMetadata.session_file)
    if (!keepsSession) clearRunnerExitCheck()
    if (keepsSession || reason === 'quit') {
      resetPostQueue()
      return
    }
    closeOutRun(sessionMetadata.session_file)
    lifecycleState.onEvent = undefined
  })

  if (isOmpRuntime() && typeof pi.registerCommand === 'function' && typeof pi.setModel === 'function') {
    pi.registerCommand('orca-model', {
      description: 'Switch the model selected in Orca',
      handler: async (selector, ctx) => {
        const models = ctx.modelRegistry.getAvailable()
        const model = models.find((candidate) => candidate.provider + '/' + candidate.id === selector.trim())
        if (!model) {
          ctx.ui.notify('Model is no longer available. Refresh the Orca model picker.', 'error')
          return
        }
        if (!await pi.setModel(model)) {
          ctx.ui.notify('Could not switch model: no API key is available.', 'error')
          return
        }
        updateRuntimeOmpSessionMetadata(ctx)
        updateModelMetadata({ model })
        post('model_select')
      }
    })
    ompModelSwitchSupported = true
  }
  onStatus('session_start', (event, ctx) => {
    updateSessionMetadata(ctx)
    piUiPromptDepth = 0
    // Why: /reload re-registers the active session, but it is not a
    // turn boundary and must not clear the visible status or unread state.
    if (event.reason === 'reload') return
    post('session_start')
    restoreParkedSubagents()
    if (lifecycleState.waiting) post('agent_start')
  })

  onStatus('before_agent_start', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    post('before_agent_start', { prompt: event.prompt ?? '' })
  })

  onStatus('agent_start', (_event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    clearPendingAgentEndCheck()
    lifecycleState.waiting = false
    lifecycleState.runGeneration += 1
    piUiPromptDepth = 0
    piTurnInFlight = true
    post('agent_start')
  })

  onStatus('tool_execution_start', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    post('tool_execution_start', {
      tool_name: event.toolName,
      tool_input: sanitizeStatusToolInput(event.args),
    })
  })

  onStatus('tool_call', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    post('tool_call', {
      tool_name: event.toolName,
      tool_input: sanitizeStatusToolInput(event.input),
    })
  })

  onStatus('tool_execution_end', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    post('tool_execution_end', {
      tool_name: event.toolName,
    })
  })

  onStatus('tool_approval_requested', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    if (!isOmpRuntime()) return
    post('tool_approval_requested', {
      tool_name: event.toolName,
      reason: event.reason,
      approval_mode: event.approvalMode,
    })
  })

  onStatus('tool_approval_resolved', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    if (!isOmpRuntime()) return
    post('tool_approval_resolved', {
      tool_name: event.toolName,
      approved: event.approved,
    })
  })

  onStatus('ui_prompt_start', () => {
    // Idle utility dialogs are not agent work; do not create a completion boundary for them.
    if (isOmpRuntime() || !piTurnInFlight) return
    piUiPromptDepth++
    if (piUiPromptDepth > 1) return
    post('ui_prompt_start')
  })

  onStatus('ui_prompt_end', (_event, ctx) => {
    if (isOmpRuntime() || piUiPromptDepth === 0) return
    piUiPromptDepth--
    if (piUiPromptDepth > 0) return
    // Why: ctx.isIdle throws outright once a session-switching modal invalidates the
    // runner (it calls assertActive), so local turn state is the floor, not a fallback:
    // with no turn in flight, no later event is coming to correct a working verdict, so
    // only consult ctx when this process believes work is running.
    let isIdle = !piTurnInFlight
    try {
      if (!isIdle && typeof ctx?.isIdle === 'function') isIdle = ctx.isIdle() === true
    } catch {
      // Why: a runner this very modal invalidated cannot answer; keep the local verdict.
    }
    // Why: Pi reports idle once its own turn settles, but children still hold the run open.
    isIdle &&= !isHeldByChildren()
    post('ui_prompt_end', { is_idle: isIdle })
  })

  pi.on('model_select', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    if (!isOmpRuntime()) return
    updateModelMetadata(event)
    post('model_select')
  })

  // Why: capture the assistant's final text on each completed message
  // so the dashboard preview reflects the most recent reply even before
  // agent_end fires. message_end is the right hook because pi guarantees
  // it fires after the message is finalized (post-streaming).
  onStatus('message_end', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    if (event.message?.role !== 'assistant') return
    const text = extractAssistantText(event.message)
    if (!text) return
    post('message_end', { role: 'assistant', text })
  })

  // Why: modern Pi stays non-idle across retry/compaction/follow-up work,
  // while legacy Pi becomes idle after its final agent_end handlers.
  // OMP instead marks non-terminal agent_end events with willContinue, so it
  // returns before the recheck timer is ever armed.
  const AGENT_END_IDLE_RECHECK_MS = 25
  const AGENT_END_IDLE_RECHECK_MAX_MS = 250
  let agentSettledSupported = false
  let agentEndIdleRecheckMs = AGENT_END_IDLE_RECHECK_MS
  let pendingAgentEndCheck: ReturnType<typeof setTimeout> | null = null
  let pendingAgentEndContext: { isIdle: () => boolean } | null = null

  function clearPendingAgentEndCheck(): void {
    if (pendingAgentEndCheck !== null) clearTimeout(pendingAgentEndCheck)
    pendingAgentEndCheck = null
    pendingAgentEndContext = null
  }
  const RUNNER_EXIT_GRACE_MS = 2000
  function clearRunnerExitCheck(): void {
    if (lifecycleState.runnerExitCheck != null) clearTimeout(lifecycleState.runnerExitCheck)
    lifecycleState.runnerExitCheck = null
  }
  function forgetSubagent(id: string): void {
    lifecycleState.active.delete(id)
    lifecycleState.exited?.delete(id)
    subagentDetails.delete(id)
  }
  function postSubagentsUpdate(): void {
    if (!hasQueuedPost()) post('subagents_update')
  }
  const readLabel = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined
  lifecycleState.onEvent = (event: unknown, forcedStatus?: string): void => {
    if (!event || typeof event !== 'object') return
    const record = event as { id?: unknown; runId?: unknown; agent?: unknown; description?: unknown; workflowKey?: unknown; mode?: unknown; parentWorkflowRunId?: unknown }
    const id = typeof record.id === 'string' && record.id ? record.id : typeof record.runId === 'string' ? record.runId : ''
    const status = forcedStatus ?? (event as { status?: unknown }).status
    if (!id) return
    if (isOmpRuntime() && !lifecycleState.ownsPane) return
    if (status === 'started') {
      lifecycleState.active.add(id)
      if (!subagentDetails.has(id)) subagentDetails.set(id, { agentType: readLabel(record.agent), description: readLabel(record.description) ?? readLabel(record.workflowKey), startedAt: Date.now(), workflow: record.mode === 'workflow', parent: readLabel(record.parentWorkflowRunId), registration })
      if (!isTurnInFlight() && (isOmpRuntime() || lifecycleState.runGeneration === 0 || lifecycleState.completionPostedGeneration === lifecycleState.runGeneration)) {
        lifecycleState.waiting = true
        lifecycleState.completionPostedGeneration = -1
      }
      post('agent_start')
      return
    }
    if (status !== 'completed' && status !== 'failed' && status !== 'aborted') return
    let wasVisible = isVisibleSubagent(lifecycleState, id)
    forgetSubagent(id)
    for (const [childId, detail] of subagentDetails) {
      if (detail.parent !== id || detail.registration === registration) continue
      wasVisible ||= isVisibleSubagent(lifecycleState, childId)
      forgetSubagent(childId)
    }
    if (lifecycleState.waiting && postAgentEndOnce()) return
    if (wasVisible) postSubagentsUpdate()
  }
  lifecycleState.onRunnerExitSettled = (): void => {
    if (lifecycleState.waiting) postAgentEndOnce()
  }
  lifecycleState.onRunnerExit = (event: unknown): void => {
    const runId = event && typeof event === 'object' ? (event as { runId?: unknown }).runId : undefined
    if (typeof runId !== 'string' || !lifecycleState.active.has(runId)) return
    if (!lifecycleState.exited) lifecycleState.exited = new Set<string>()
    const wasVisible = isVisibleSubagent(lifecycleState, runId)
    lifecycleState.exited.add(runId)
    if (wasVisible) postSubagentsUpdate()
    if (!lifecycleState.waiting) return
    clearRunnerExitCheck()
    lifecycleState.runnerExitCheck = setTimeout(() => {
      lifecycleState.runnerExitCheck = null
      lifecycleState.onRunnerExitSettled?.()
    }, RUNNER_EXIT_GRACE_MS)
    if (typeof lifecycleState.runnerExitCheck.unref === 'function') lifecycleState.runnerExitCheck.unref()
  }
  function isHeldByChildren(): boolean {
    return lifecycleState.active.size > 0
  }

  function isTurnInFlight(): boolean {
    return lifecycleState.runGeneration !== lifecycleState.endedRunGeneration
  }

  function postAgentEndOnce(final = false): boolean {
    for (const id of lifecycleState.exited ?? []) forgetSubagent(id)
    if (isHeldByChildren()) {
      lifecycleState.waiting = true
      return false
    }
    lifecycleState.waiting = false
    if (lifecycleState.completionPostedGeneration === lifecycleState.endedRunGeneration) return false
    lifecycleState.completionPostedGeneration = lifecycleState.endedRunGeneration
    piTurnInFlight = false
    post('agent_end', final ? { session_boundary: true } : {}, final)
    return true
  }

  function restoreParkedSubagents(): void {
    const file = sessionMetadata.session_file
    if (typeof file !== 'string') return
    const parked = lifecycleState.parked?.get(file)
    if (!parked) return
    lifecycleState.parked?.delete(file)
    for (const [id, detail] of parked) {
      lifecycleState.active.add(id)
      subagentDetails.set(id, detail)
    }
    if (!isHeldByChildren()) return
    lifecycleState.waiting = true
    lifecycleState.completionPostedGeneration = -1
  }

  function closeOutRun(parkUnder?: unknown): void {
    const unsettled = lifecycleState.waiting || isTurnInFlight()
    if (typeof parkUnder === 'string' && isHeldByChildren()) {
      const parked = new Map<string, SubagentDetail>()
      for (const id of lifecycleState.active) {
        const detail = subagentDetails.get(id)
        if (detail && !lifecycleState.exited?.has(id)) parked.set(id, detail)
      }
      ;(lifecycleState.parked ??= new Map()).set(parkUnder, parked)
    }
    resetSubagentRoster()
    resetPostQueue()
    if (!unsettled) return
    lifecycleState.endedRunGeneration = lifecycleState.runGeneration
    postAgentEndOnce(true)
  }

  function checkPendingAgentEnd(): void {
    pendingAgentEndCheck = null
    const ctx = pendingAgentEndContext
    if (!ctx || agentSettledSupported || lifecycleState.completionPostedGeneration === lifecycleState.endedRunGeneration) {
      pendingAgentEndContext = null
      return
    }
    try {
      if (ctx.isIdle()) {
        pendingAgentEndContext = null
        postAgentEndOnce()
        return
      }
    } catch {
      pendingAgentEndContext = null
      return
    }
    pendingAgentEndCheck = setTimeout(checkPendingAgentEnd, agentEndIdleRecheckMs)
    if (typeof pendingAgentEndCheck.unref === 'function') pendingAgentEndCheck.unref()
    agentEndIdleRecheckMs = Math.min(agentEndIdleRecheckMs * 2, AGENT_END_IDLE_RECHECK_MAX_MS)
  }

  onStatus('agent_settled', (_event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    agentSettledSupported = true
    clearPendingAgentEndCheck()
    postAgentEndOnce()
  })

  onStatus('agent_end', (event, ctx) => {
    updateRuntimeOmpSessionMetadata(ctx)
    if (event?.willContinue === true) {
      clearPendingAgentEndCheck()
      return
    }
    lifecycleState.endedRunGeneration = lifecycleState.runGeneration
    if (isOmpRuntime()) {
      postAgentEndOnce()
      return
    }
    if (agentSettledSupported) return
    if (!ctx || typeof ctx.isIdle !== 'function') {
      postAgentEndOnce()
      return
    }
    clearPendingAgentEndCheck()
    agentEndIdleRecheckMs = AGENT_END_IDLE_RECHECK_MS
    pendingAgentEndContext = ctx
    pendingAgentEndCheck = setTimeout(checkPendingAgentEnd, 0)
    if (typeof pendingAgentEndCheck.unref === 'function') pendingAgentEndCheck.unref()
  })
}
