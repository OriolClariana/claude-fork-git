// git-mod: a /git side panel for the repository in the session's directory.
// Shows the branch (and the branch it came from), changed files with
// Stage / Unstage buttons, AI-written commit messages, pull, push, and stashes with
// AI-written titles. Everything runs through `git` (a real executable on both
// Windows and macOS, so no shell or platform branch is needed).
// Helpers that take $ are top-level functions: static analysis refuses $
// passed to nested or imported functions.

import { atom, read, update } from 'claude-code'

const PANE = 'git-mod'
const SETTINGS_PANE = 'git-mod-settings'
const MODEL = 'haiku' // model for commit messages and stash titles
const BASE_BRANCHES = ['develop', 'dev', 'development', 'main', 'master']
const WATCHED_TOOLS = ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const DOUBLE_PRESS_MS = 500 // two presses on one file within this open it
const FOCUS_SETTLE_MS = 250 // a click moves the focus just before its press
const COLS_TERMINAL = 56 // pane width asked for in the terminal
const COLS_DESKTOP = 140 // wider on the desktop: the toolbar and file rows then fit on one line
const MAX_MATCHES = 8 // branch search rows drawn at once

// Editors that can open a file at a line. `scheme` opens `<scheme>://file/<path>:<line>:1`;
// `args` builds the arguments for the editor's own executable.
const EDITORS = [
  { name: 'VS Code Insiders', match: /code - insiders|code-insiders/i, scheme: 'vscode-insiders' },
  { name: 'VSCodium', match: /vscodium|(^|[\\/])codium(\.exe|\.desktop)?$/i, scheme: 'vscodium' },
  { name: 'Cursor', match: /(^|[\\/])cursor(\.exe|\.app|\.desktop)?$/i, scheme: 'cursor' },
  { name: 'Windsurf', match: /(^|[\\/])windsurf(\.exe|\.app|\.desktop)?$/i, scheme: 'windsurf' },
  { name: 'VS Code', match: /visual studio code|(^|[\\/])code(\.exe|\.desktop)?$/i, scheme: 'vscode' },
  { name: 'Sublime Text', match: /sublime/i, args: (file, line) => [file + ':' + line] },
  { name: 'Notepad++', match: /notepad\+\+/i, args: (file, line) => ['-n' + line, file] },
]

// Windows: the program the shell runs for an extension (AssocQueryString, ASSOCSTR_EXECUTABLE)
const PS_ASSOC =
  '$t=Add-Type -MemberDefinition \'[DllImport("Shlwapi.dll",CharSet=CharSet.Unicode)] public static extern uint AssocQueryString(int f,int s,string a,string x,System.Text.StringBuilder o,ref uint n);\' -Name Assoc -Namespace GitMod -PassThru; ' +
  '$n=[uint32]1024; $sb=New-Object System.Text.StringBuilder 1024; ' +
  'if($t::AssocQueryString(0,2,$env:GITMOD_EXT,[NullString]::Value,$sb,[ref]$n) -eq 0){$sb.ToString()}'
// Windows: open a file or URL as Explorer would, or start a program with arguments, without waiting
const PS_START =
  '$i=New-Object System.Diagnostics.ProcessStartInfo; $i.FileName=$env:GITMOD_TARGET; $i.Arguments=$env:GITMOD_ARGS; $i.UseShellExecute=$true; ' +
  'try { [void][System.Diagnostics.Process]::Start($i) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'
// macOS: the app that opens a file
const JXA_APP =
  "function run(argv){ObjC.import('AppKit');var a=$.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(argv[0]));return a.isNil()?'':ObjC.unwrap(a.path)}"

const KIND = {
  added: { glyph: '+', color: 'green', label: 'added' },
  modified: { glyph: '~', color: 'yellow', label: 'modified' },
  deleted: { glyph: '-', color: 'red', label: 'deleted' },
  renamed: { glyph: '→', color: 'cyan', label: 'renamed' },
  conflict: { glyph: '!', color: 'magenta', label: 'conflict' },
}

// Module state: rebuilt by the next refresh after a hot reload
let paneOpen = false
let refreshing = false
let loaded = false
let repo = null // { error } | { root, branch, oid, upstream, ahead, behind, isDetached, isUnborn }
let files = [] // { path, orig, x, y, isUntracked, isConflict }
let stashes = [] // { ref, hash, title, branch, when }
let parentOf = { branch: '', parent: '' }
let lastSig = ''
let busy = '' // label of the running action, '' when idle
let notice = null // { tone: 'ok' | 'error' | 'info', text, hash? }
let draft = null // { subject, body, isEditing }
let stashesOpen = true
let confirmDrop = '' // hash of the stash waiting for a second press to remove it
let confirmDiscard = '' // key of the file row waiting for a second press to discard it
let platform = '' // 'windows' | 'mac' | 'linux'
const openers = new Map() // extension -> the default app's path or id ('' when none)
let lastPress = { key: '', at: 0, opened: false } // the last press on a file name
let focused = { key: '', at: 0 } // the pane element holding the focus ring
let branches = [] // { name, ref, local, remote, when, order, key, full, base }, newest commit first
let branchesError = ''
let branchesLoading = null // the running load, so presses share it
const folded = new Set() // 'Staged' / 'Changes' sections the person folded
let histQuery = '' // History search text, applied to the loaded commits
let histScope = 'all' // 'all' draws every branch and tag, 'head' only the current branch
let confirmBranchDel = '' // ref of the branch whose delete awaits a second press
let divergeAsk = false // the last pull found diverged branches: offer merge or rebase
let branchSearch = null // { query } while the branch search is open
let matchCache = { list: null, query: '', pool: [] } // the last query's matches, narrowed as it grows

// Desktop-only state (the Fork-style view)
let view = { tab: 'changes' } // 'changes' | 'history' | 'stashes'
let diffSel = null // { key, path, orig, isStaged, isUntracked, isConflict, text } the file whose diff is open
let dmsg = { subject: '', body: '' } // the commit message typed in the desktop view
let history = { key: '', commits: [], rows: [], lanes: 1, limit: 100, loading: false, error: '' }
let commitSel = null // { hash, files, fileOpen, isLoading, error } the open commit in History
let subs = [] // { state, sha, path, describe } submodules of the current repository
let navStack = [] // absolute paths of the submodules entered, outermost first
let topRoot = '' // the repository the session started in

// ---------- git ----------

async function git($, args, init) {
  const opts = init ?? {}
  try {
    const r = await $.process.run(['git', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
      timeoutMs: opts.timeoutMs ?? 20000,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    return {
      ok: r.exitCode === 0,
      out: String(r.stdout ?? '').replace(/\r\n/g, '\n'),
      err: String(r.stderr ?? '').replace(/\r\n/g, '\n').trim(),
    }
  } catch (err) {
    return { ok: false, out: '', err: 'git could not start: ' + (err?.message ?? err), isMissing: true }
  }
}

// Runs git in the repository root
async function gitRoot($, args, init) {
  return git($, args, { ...(init ?? {}), cwd: repo?.root })
}

export function parseStatus(out) {
  const info = { branch: '', oid: '', upstream: '', ahead: 0, behind: 0 }
  const list = []
  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t) continue
    if (t.startsWith('# ')) {
      const [, key, ...rest] = t.split(' ')
      const val = rest.join(' ')
      if (key === 'branch.oid') info.oid = val
      else if (key === 'branch.head') info.branch = val
      else if (key === 'branch.upstream') info.upstream = val
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(val)
        if (m) {
          info.ahead = Number(m[1])
          info.behind = Number(m[2])
        }
      }
    } else if (t[0] === '1') {
      const parts = t.split(' ')
      list.push({ path: parts.slice(8).join(' '), orig: '', x: parts[1][0], y: parts[1][1], isUntracked: false, isConflict: false })
    } else if (t[0] === '2') {
      const parts = t.split(' ')
      const orig = tokens[++i] ?? ''
      list.push({ path: parts.slice(9).join(' '), orig, x: parts[1][0], y: parts[1][1], isUntracked: false, isConflict: false })
    } else if (t[0] === 'u') {
      const parts = t.split(' ')
      list.push({ path: parts.slice(10).join(' '), orig: '', x: 'U', y: 'U', isUntracked: false, isConflict: true })
    } else if (t[0] === '?') {
      list.push({ path: t.slice(2), orig: '', x: '.', y: '?', isUntracked: true, isConflict: false })
    }
  }
  return { info, list }
}

export function parseStashes(out) {
  return out
    .split('\x1e')
    .map((rec) => rec.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [ref, hash, subject = '', when = ''] = rec.split('\x1f')
      let title = subject
      let branch = ''
      let m = /^On ([^:]+): (.*)$/s.exec(subject)
      if (m) {
        branch = m[1]
        title = m[2]
      } else if ((m = /^WIP on ([^:]+): (.*)$/s.exec(subject))) {
        branch = m[1]
        title = 'WIP · ' + m[2]
      }
      return { ref, hash, title: title.trim(), branch, when: when.trim() }
    })
}

function kindOf(code) {
  if (code === 'A' || code === '?') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R' || code === 'C') return 'renamed'
  if (code === 'U') return 'conflict'
  return 'modified'
}

function stagedFiles() {
  return files.filter((f) => !f.isUntracked && !f.isConflict && f.x !== '.')
}

function unstagedFiles() {
  return files.filter((f) => f.isUntracked || f.isConflict || f.y !== '.')
}

// The branch this one was created from: its own reflog, then HEAD's reflog,
// then the nearest of the usual base branches by commits ahead.
async function detectParent($, branch) {
  const refsRes = await gitRoot($, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
  const refs = new Set(refsRes.out.split('\n').map((s) => s.trim()).filter(Boolean))
  const known = (name) => name && name !== branch && name !== 'HEAD' && refs.has(name)

  const own = await gitRoot($, ['reflog', 'show', '--format=%gs', 'refs/heads/' + branch, '--'])
  if (own.ok) {
    const lines = own.out.trim().split('\n')
    const m = /^branch: Created from (.+)$/.exec(lines[lines.length - 1] ?? '')
    const from = m ? m[1].replace(/^refs\/(heads|remotes)\//, '') : ''
    if (known(from)) return from
  }

  const head = await gitRoot($, ['reflog', 'show', '--format=%gs', '-n', '5000', 'HEAD', '--'])
  if (head.ok) {
    const lines = head.out.trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /^checkout: moving from (.+) to (.+)$/.exec(lines[i])
      if (m && m[2] === branch && known(m[1])) return m[1]
    }
  }

  let best = ''
  let bestCount = Infinity
  for (const name of BASE_BRANCHES) {
    const candidate = refs.has(name) ? name : [...refs].find((r) => r.endsWith('/' + name) && !r.endsWith('/HEAD')) ?? ''
    if (!known(candidate)) continue
    const r = await gitRoot($, ['rev-list', '--count', candidate + '..HEAD'])
    const n = Number(r.out.trim())
    if (r.ok && n < bestCount) {
      best = candidate
      bestCount = n
    }
  }
  return best
}

async function refresh($) {
  if (refreshing) return
  refreshing = true
  try {
    let top = await git($, ['rev-parse', '--show-toplevel'], navStack.length ? { cwd: navStack[navStack.length - 1] } : {})
    if (!top.ok && navStack.length) {
      // The submodule folder is gone or no longer a repository: back to the top
      navStack = []
      resetRepoView()
      top = await git($, ['rev-parse', '--show-toplevel'])
    }
    if (!top.ok) {
      repo = { error: top.isMissing ? 'git is not installed or not on PATH.' : 'Not inside a git repository.' }
      files = []
      stashes = []
    } else {
      const root = top.out.trim()
      if (!navStack.length) topRoot = root
      const st = await git($, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], { cwd: root })
      const { info, list } = parseStatus(st.out)
      repo = {
        root,
        branch: info.branch,
        oid: info.oid,
        upstream: info.upstream,
        ahead: info.ahead,
        behind: info.behind,
        isDetached: info.branch === '(detached)',
        isUnborn: info.oid === '(initial)',
      }
      files = list
      const sm = await git($, ['submodule', 'status'], { cwd: root })
      subs = sm.ok ? parseSubmodules(sm.out) : []
      // The open diff goes when its file leaves the lists (committed, discarded)
      if (diffSel && !(diffSel.isStaged ? stagedFiles() : unstagedFiles()).some((f) => f.path === diffSel.path)) diffSel = null
      const sl = await git($, ['stash', 'list', '--format=%gd%x1f%h%x1f%gs%x1f%cr%x1e'], { cwd: root })
      stashes = sl.ok ? parseStashes(sl.out) : []

      const b = repo.branch
      if (parentOf.branch !== b) {
        const parent = b.includes('/') && !repo.isDetached && !repo.isUnborn ? await detectParent($, b) : ''
        parentOf = { branch: b, parent }
      }
    }
    loaded = true
    const sig = JSON.stringify([repo, files, stashes, parentOf, subs, navStack])
    if (sig !== lastSig) {
      lastSig = sig
      $.ui.invalidate('ui.render')
    }
    // Desktop view: keep the open diff and the history in step with the repo
    if (diffSel) await fetchSelDiff($)
    if (view.tab === 'history' && history.key !== historyKey()) loadHistory($).catch(() => {})
  } finally {
    refreshing = false
  }
}

function setNotice($, tone, text, hash) {
  notice = { tone, text, ...(hash ? { hash } : {}) }
  $.ui.invalidate('ui.render')
}

function lastLines(text, n) {
  return text.trim().split('\n').filter(Boolean).slice(-n).join('\n')
}

// ---------- settings ----------
// Every option, in the order the settings pane draws it. Choices are cycled by pressing the button.
const pick = (list, fmt = String) => list.map((v) => ({ label: fmt(v), value: v }))
export const SPEC = [
  { group: 'Visual', key: 'glowEffect', label: 'Glow', desc: 'Soft glow on the status orb, the tiles and the clean-state rings.', def: true },
  { group: 'Visual', key: 'pulseEffect', label: 'Pulse', desc: 'The glow and the HEAD dot slowly pulse. Always off when the system asks for reduced motion.', def: true },
  { group: 'Visual', key: 'showOrb', label: 'Status orb', desc: 'The colored dot before the branch name.', def: true },
  { group: 'Visual', key: 'showTiles', label: 'Summary tiles', desc: 'Staged, Changes, Ahead and Behind under the header.', def: true },
  { group: 'Visual', key: 'fileTree', label: 'Folder tree', desc: 'Group the files by folder in Staged and Changes.', def: false },
  { group: 'Visual', key: 'summaryCounter', label: 'Summary counter', desc: 'Show the length of the commit summary against 50 and 72 characters.', def: true },
  { group: 'Visual', key: 'summaryRows', label: 'Summary height', desc: 'Lines of the Summary box.', def: 3, choices: pick([1, 2, 3, 5]) },
  { group: 'Visual', key: 'bodyRows', label: 'Body height', desc: 'Lines of the Body box.', def: 10, choices: pick([4, 6, 10, 15, 20]) },
  { group: 'Behavior', key: 'autoOpenPane', label: 'Open on start', desc: 'Open the panel by itself when the session folder is a git repository.', def: true },
  { group: 'Behavior', key: 'defaultTab', label: 'First tab', desc: 'The tab shown when the panel opens.', def: 0, choices: [{ label: 'Changes', value: 0 }, { label: 'History', value: 1 }] },
  { group: 'Behavior', key: 'pollSeconds', label: 'Refresh every', desc: 'How often the panel reads the repository while open. Local only.', def: 3, choices: pick([1, 3, 5, 10, 30], (v) => v + 's') },
  { group: 'Behavior', key: 'autoFetchMinutes', label: 'Auto fetch', desc: 'Fetch all remotes in the background every N minutes. Needs working credentials.', def: 0, choices: pick([0, 1, 5, 10, 15], (v) => (v ? v + ' min' : 'Off')) },
  { group: 'History and diffs', key: 'historyPageSize', label: 'Commits per page', desc: 'How many commits History loads at a time.', def: 100, choices: pick([50, 100, 200, 500]) },
  { group: 'History and diffs', key: 'diffMaxChars', label: 'Diff size limit', desc: 'Characters of one diff drawn at once. Bigger diffs show the first hunks.', def: 30000, choices: pick([10000, 30000, 60000, 90000], (v) => v / 1000 + 'k') },
  { group: 'Alerts', key: 'toastOnDone', label: 'Toast when done', desc: 'A toast when Fetch, Pull, Push, Commit or Stash finish.', def: true },
]
const cfgDefaults = () => Object.fromEntries(SPEC.map((r) => [r.key, r.def]))
let cfg = cfgDefaults()
const settingsAtom = atom({ plugin: 'fork-git-pane', key: 'settings' }, {}, { shape: 'settings-1' })

async function loadCfg($) {
  try {
    cfg = { ...cfgDefaults(), ...(await read($, settingsAtom)) }
  } catch {
    cfg = cfgDefaults()
  }
}

async function setOpt($, key, value) {
  cfg = { ...cfg, [key]: value }
  if (key === 'pollSeconds') startPoll($)
  if (key === 'historyPageSize') {
    history.limit = value
    history.key = ''
  }
  $.ui.invalidate('ui.render') // draw first: saving can take a moment
  await update($, settingsAtom, (o) => ({ ...o, [key]: value }))
}

async function resetOpts($) {
  cfg = cfgDefaults()
  await update($, settingsAtom, () => ({}))
  startPoll($)
  history.limit = cfg.historyPageSize
  history.key = ''
  $.ui.invalidate('ui.render')
}

let pollTimer
let lastAutoFetch = 0
function startPoll($) {
  pollTimer?.cancel?.()
  pollTimer = $.clock.every(Math.max(1, cfg.pollSeconds) * 1000, async () => {
    saveDrafts($).catch(() => {})
    if (!paneOpen || busy) return
    refresh($).catch(() => {})
    if (cfg.autoFetchMinutes > 0) {
      const now = await $.clock.now()
      if (now - lastAutoFetch >= cfg.autoFetchMinutes * 60000) {
        lastAutoFetch = now
        autoFetch($).catch(() => {})
      }
    }
  })
}

// Silent fetch: no notice and no busy label, so it never gets in the way of a press
async function autoFetch($) {
  const r = await gitRoot($, ['fetch', '--all', '--prune'], { timeoutMs: 180000 })
  if (!r.ok) return
  history.key = ''
  lastSig = ''
  await refresh($)
}

function drawSettings($, e) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const groups = [...new Set(SPEC.map((r) => r.group))]
  const control = (r) => {
    const v = cfg[r.key]
    // Read cfg again at press time: a quick second press must not use the value drawn before the first
    // A Button takes no color, so the state is a green or red Text beside the button
    if (typeof r.def === 'boolean') {
      return Box({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 'sm',
        children: [
          Text({ color: v ? 'success' : 'error', weight: 'semibold', children: [v ? '● On' : '○ Off'] }),
          Button({ key: 'opt-' + r.key, label: v ? 'Turn off' : 'Turn on', onPress: () => setOpt($, r.key, !cfg[r.key]) }),
        ],
      })
    }
    const at = Math.max(0, r.choices.findIndex((c) => c.value === v))
    return Button({
      key: 'opt-' + r.key,
      label: (r.choices[at]?.label ?? String(v)) + ' ▾',
      onPress: () => setOpt($, r.key, r.choices[(Math.max(0, r.choices.findIndex((c) => c.value === cfg[r.key])) + 1) % r.choices.length].value),
    })
  }
  return Box({
    flexDirection: 'column',
    gap: 'sm',
    children: [
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingX: 'sm',
        borderStyle: 'round',
        borderColor: 'suggestion',
        children: [
          Text({ weight: 'semibold', color: 'suggestion', children: ['⚙ Settings · apply instantly'] }),
          Button({ key: 'opt-reset', label: 'Reset', plain: true, dimColor: true, onPress: () => resetOpts($) }),
        ],
      }),
      ...groups.flatMap((g) => [
        Text({ weight: 'semibold', color: 'suggestion', children: [g] }),
        ...SPEC.filter((r) => r.group === g).map((r) =>
          Box({
            key: 'row-' + r.key,
            flexDirection: 'column',
            children: [
              Box({ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 'sm', children: [Text({ weight: 'semibold', wrap: 'truncate-end', children: [r.label] }), control(r)] }),
              Text({ dimColor: true, wrap: 'wrap', children: [r.desc] }),
            ],
          }),
        ),
      ]),
    ],
  })
}

// Runs one action at a time; shows a working line while it runs
// Change the label shown next to the spinning orb while a long action moves to its next phase
function step($, label) {
  busy = label
  $.ui.invalidate('ui.render')
}

async function runAction($, label, work) {
  if (busy) {
    $.ui.toast('git-mod is busy: ' + busy)
    return
  }
  busy = label
  const before = notice
  $.ui.invalidate('ui.render')
  try {
    await work()
    if (cfg.toastOnDone && notice && notice !== before && notice.tone === 'ok') $.ui.toast('✓ ' + notice.text.split('\n')[0])
  } catch (err) {
    setNotice($, 'error', label + ' failed: ' + (err?.message ?? err))
  } finally {
    busy = ''
    lastSig = ''
    if (view.tab === 'history') history.key = '' // an action may have moved refs
    await refresh($)
    $.ui.invalidate('ui.render')
  }
}

// ---------- actions ----------

async function stageFile($, f) {
  const r = await gitRoot($, ['add', '-A', '--', f.path])
  if (!r.ok) setNotice($, 'error', 'Could not stage ' + f.path + ':\n' + lastLines(r.err, 4))
}

async function unstageFile($, f) {
  const paths = f.orig ? [f.path, f.orig] : [f.path]
  const r = repo.isUnborn
    ? await gitRoot($, ['rm', '--cached', '-r', '-q', '--', ...paths])
    : await gitRoot($, ['restore', '--staged', '--', ...paths])
  if (!r.ok) setNotice($, 'error', 'Could not unstage ' + f.path + ':\n' + lastLines(r.err, 4))
}

async function stageAll($) {
  const r = await gitRoot($, ['add', '-A'])
  if (!r.ok) setNotice($, 'error', 'Could not stage all:\n' + lastLines(r.err, 4))
}

async function unstageAll($) {
  const r = repo.isUnborn ? await gitRoot($, ['rm', '--cached', '-r', '-q', '.']) : await gitRoot($, ['reset', '-q'])
  if (!r.ok) setNotice($, 'error', 'Could not unstage all:\n' + lastLines(r.err, 4))
}

// The git commands that throw away a file's changes. In the Changes list: its
// unstaged edits (back to the staged copy), or the file itself when it's new.
// In the Staged list: staged and unstaged edits (back to HEAD), or the file
// itself when the commit would add it.
export function discardCommands(f, isStagedList, isUnborn) {
  if (!isStagedList) {
    if (f.isUntracked) return [['clean', '-f', '-d', '-q', '--', f.path]]
    return [['restore', '--worktree', '--', f.path]]
  }
  if (isUnborn || f.x === 'A' || f.x === 'C') return [['rm', '-f', '-r', '-q', '--', f.path]]
  if (f.x === 'R') return [['rm', '-f', '-r', '-q', '--', f.path], ['restore', '--staged', '--worktree', '--source=HEAD', '--', f.orig]]
  return [['restore', '--staged', '--worktree', '--source=HEAD', '--', f.path]]
}

async function discardFile($, f, isStagedList) {
  confirmDiscard = ''
  if (f.isConflict) {
    setNotice($, 'info', f.path + ' has a merge conflict. Resolve it, or abort the merge, instead of discarding.')
    return
  }
  const isNew = isStagedList ? repo.isUnborn || f.x === 'A' || f.x === 'C' : f.isUntracked
  for (const args of discardCommands(f, isStagedList, repo.isUnborn)) {
    const r = await gitRoot($, args)
    if (!r.ok) {
      setNotice($, 'error', 'Could not discard ' + f.path + ':\n' + lastLines(r.err || r.out, 4))
      return
    }
  }
  setNotice($, 'ok', (isNew ? 'Deleted ' : 'Discarded the changes to ') + f.path)
}

export function parseMessage(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .split('\n')
  while (lines.length && !lines[0].trim()) lines.shift()
  const subject = (lines.shift() ?? '').trim().replace(/^["'`]|["'`]$/g, '')
  const body = lines.join('\n').trim()
  return { subject, body }
}

function fullMessage(d) {
  return d.body ? d.subject + '\n\n' + d.body : d.subject
}

async function generateCommitMessage($) {
  const stat = await gitRoot($, ['diff', '--cached', '--stat'])
  const diff = await gitRoot($, ['diff', '--cached', '--no-ext-diff'])
  const log = repo.isUnborn ? { out: '' } : await gitRoot($, ['log', '--format=%s', '-n', '10'])
  if (!stat.out.trim()) {
    setNotice($, 'info', 'Nothing is staged. Stage files first.')
    return
  }
  const LIMIT = 40000
  const body = diff.out.length > LIMIT ? diff.out.slice(0, LIMIT) + '\n[diff truncated]' : diff.out
  const r = await $.model.complete({
    model: MODEL,
    maxTokens: 600,
    timeoutMs: 90000,
    system:
      'You write git commit messages. Output only the message: one subject line in the imperative mood, at most 72 characters, ' +
      'then optionally a blank line and a short body of "- " bullet lines saying what changed and why. ' +
      'If the recent commits use a convention (such as Conventional Commits prefixes), follow it. No code fences, quotes or preamble.',
    prompt:
      'Branch: ' + repo.branch + '\n\nRecent commit subjects:\n' + (log.out.trim() || '(none)') +
      '\n\nStaged files:\n' + stat.out.trim() + '\n\nStaged diff:\n' + body,
  })
  if (!r.isAnswered || !r.text?.trim()) {
    setNotice($, 'error', 'The model did not write a message' + (r.reason ? ': ' + r.reason : '.') + ' Try Regenerate.')
    return
  }
  const msg = parseMessage(r.text)
  draft = { subject: msg.subject, body: msg.body, isEditing: false }
  notice = null
}

async function commitDraft($) {
  const message = fullMessage(draft).trim()
  if (!draft.subject.trim()) {
    setNotice($, 'error', 'The commit subject is empty. Edit the message first.')
    return
  }
  const r = await gitRoot($, ['commit', '-F', '-'], { stdin: message + '\n', timeoutMs: 60000 })
  if (!r.ok) {
    setNotice($, 'error', 'Commit failed:\n' + lastLines(r.err || r.out, 6))
    return
  }
  const head = await gitRoot($, ['rev-parse', '--short', 'HEAD'])
  draft = null
  setNotice($, 'ok', 'Committed ' + head.out.trim() + ': ' + message.split('\n')[0])
}

async function push($) {
  if (repo.isDetached) {
    setNotice($, 'error', 'HEAD is detached. Check out a branch before pushing.')
    return
  }
  let args = ['push']
  let target = repo.upstream
  if (!repo.upstream) {
    const remotes = (await gitRoot($, ['remote'])).out.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!remotes.length) {
      setNotice($, 'error', 'No remote is configured. Add one with: git remote add origin <url>')
      return
    }
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]
    args = ['push', '-u', remote, repo.branch]
    target = remote + '/' + repo.branch
  }
  step($, 'Pushing ' + repo.branch + ' → ' + target)
  let r = await gitRoot($, args, { timeoutMs: 180000 })
  // The server rejects the push when LFS objects are missing (the lfs pre-push hook did not run): upload them and retry once.
  // Only on that error, because `lfs push --all` scans the whole history and is slow on big repos.
  if (!r.ok && /git lfs push/i.test(r.err || r.out)) {
    step($, 'Uploading LFS objects (can take several minutes)')
    const lfs = await gitRoot($, ['lfs', 'push', '--all', target.split('/')[0], repo.branch], { timeoutMs: 600000 })
    step($, 'Pushing ' + repo.branch + ' again')
    r = lfs.ok ? await gitRoot($, args, { timeoutMs: 180000 }) : lfs
  }
  if (!r.ok) {
    setNotice($, 'error', 'Push failed:\n' + lastLines(r.err || r.out, 6))
    return
  }
  setNotice($, 'ok', 'Pushed ' + repo.branch + ' → ' + target)
}

// Fast-forward only: never creates a merge commit or rewrites local commits
// Pull for diverged branches. A conflict is undone at once so the repository is never left half-merged.
async function pullWith($, mode) {
  divergeAsk = false
  const rebase = mode === 'rebase'
  const r = await gitRoot($, rebase ? ['pull', '--rebase'] : ['pull', '--no-rebase', '--no-edit'], { timeoutMs: 180000 })
  if (!r.ok) {
    await gitRoot($, rebase ? ['rebase', '--abort'] : ['merge', '--abort'])
    setNotice($, 'error', (rebase ? 'Rebase' : 'Merge') + ' pull failed and was undone:\n' + lastLines(r.err || r.out, 6) + '\nResolve it in your terminal.')
    return
  }
  setNotice($, 'ok', 'Pulled with ' + (rebase ? 'rebase' : 'merge') + ' from ' + repo.upstream)
}

async function pull($) {
  divergeAsk = false
  if (repo.isDetached) {
    setNotice($, 'error', 'HEAD is detached. Check out a branch before pulling.')
    return
  }
  if (!repo.upstream) {
    setNotice($, 'error', repo.branch + ' has no upstream yet. Push it first, or run: git branch -u origin/' + repo.branch)
    return
  }
  const before = (await gitRoot($, ['rev-parse', 'HEAD'])).out.trim()
  const r = await gitRoot($, ['pull', '--ff-only'], { timeoutMs: 180000 })
  if (!r.ok) {
    const text = r.err || r.out
    const hint = /not possible to fast-forward|diverg/i.test(text)
      ? '\nThe branches have diverged: choose how to combine them.'
      : ''
    divergeAsk = hint !== ''
    setNotice($, 'error', 'Pull failed:\n' + lastLines(text, 6) + hint)
    return
  }
  const after = (await gitRoot($, ['rev-parse', 'HEAD'])).out.trim()
  if (before === after) {
    setNotice($, 'ok', repo.branch + ' is already up to date with ' + repo.upstream)
    return
  }
  const count = Number((await gitRoot($, ['rev-list', '--count', before + '..' + after])).out.trim()) || 0
  setNotice($, 'ok', 'Pulled ' + count + ' commit' + (count === 1 ? '' : 's') + ' from ' + repo.upstream + ' into ' + repo.branch)
}

export function cleanTitle(text) {
  const words = String(text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)[0]
  if (!words) return ''
  return words
    .replace(/^["'`*]+|["'`*.]+$/g, '')
    .split(/\s+/)
    .slice(0, 6)
    .join(' ')
    .slice(0, 60)
}

function autoTitle(list) {
  const names = list.map((f) => f.path.split('/').pop())
  if (!names.length) return 'Work in progress'
  return names.length <= 2 ? 'Changes in ' + names.join(', ') : 'Changes in ' + names.slice(0, 2).join(', ') + ' +' + (names.length - 2)
}

async function stash($) {
  if (!files.length) {
    setNotice($, 'info', 'Nothing to stash: the working tree is clean.')
    return
  }
  if (repo.isUnborn) {
    setNotice($, 'error', 'Make a first commit before stashing.')
    return
  }
  const stat = await gitRoot($, ['diff', 'HEAD', '--stat'])
  const diff = await gitRoot($, ['diff', 'HEAD', '--no-ext-diff'])
  const untracked = files.filter((f) => f.isUntracked).map((f) => f.path)
  let title = ''
  try {
    const r = await $.model.complete({
      model: MODEL,
      maxTokens: 40,
      timeoutMs: 30000,
      system: 'Summarize these uncommitted changes as a stash title of at most 6 words. Output only the title: no quotes, no trailing period.',
      prompt:
        'Changed files:\n' + (stat.out.trim() || '(none)') + '\n\nNew files:\n' + (untracked.join('\n') || '(none)') +
        '\n\nDiff:\n' + diff.out.slice(0, 12000),
    })
    if (r.isAnswered) title = cleanTitle(r.text)
  } catch {
    // fall back to a title from the file names
  }
  if (!title) title = autoTitle(files)
  const r = await gitRoot($, ['stash', 'push', '-u', '-m', title], { timeoutMs: 60000 })
  if (!r.ok) {
    setNotice($, 'error', 'Stash failed:\n' + lastLines(r.err || r.out, 6))
    return
  }
  const hash = (await gitRoot($, ['rev-parse', 'stash@{0}'])).out.trim()
  draft = null
  stashesOpen = true
  setNotice($, 'ok', 'Stashed "' + title + '" as ' + hash.slice(0, 10), hash)
}

async function restore($, s) {
  // Find the stash by hash: its stash@{n} index shifts when others are added
  const sl = await gitRoot($, ['stash', 'list', '--format=%gd%x1f%h%x1f%gs%x1f%cr%x1e'])
  const current = parseStashes(sl.out).find((x) => x.hash === s.hash)
  if (!current) {
    setNotice($, 'error', 'That stash no longer exists.')
    return
  }
  const r = await gitRoot($, ['stash', 'apply', current.ref], { timeoutMs: 60000 })
  if (!r.ok) {
    setNotice($, 'error', 'Restore of "' + s.title + '" stopped:\n' + lastLines(r.err || r.out, 6))
    return
  }
  setNotice($, 'ok', 'Restored "' + s.title + '" (the stash is kept).')
}

async function drop($, s) {
  confirmDrop = ''
  const sl = await gitRoot($, ['stash', 'list', '--format=%gd%x1f%h%x1f%gs%x1f%cr%x1e'])
  const current = parseStashes(sl.out).find((x) => x.hash === s.hash)
  if (!current) {
    setNotice($, 'error', 'That stash no longer exists.')
    return
  }
  // Keep the full hash: `git stash store -m <title> <hash>` brings a dropped stash back
  const hash = (await gitRoot($, ['rev-parse', current.ref])).out.trim()
  const r = await gitRoot($, ['stash', 'drop', current.ref])
  if (!r.ok) {
    setNotice($, 'error', 'Remove of "' + s.title + '" failed:\n' + lastLines(r.err || r.out, 6))
    return
  }
  setNotice($, 'ok', 'Removed "' + s.title + '" (' + hash.slice(0, 10) + '). To undo: git stash store ' + hash.slice(0, 10), hash)
}

// ---------- branch search ----------

// Local and remote branches from `for-each-ref` lines (`<refname>\0<date>`), in
// the order given. A remote branch with a local branch of the same name is left
// out: checking out the local one is what's wanted. `remotes` picks the remote's
// part of `refs/remotes/<remote>/<branch>` when a remote's name has a slash.
export function parseBranches(out, remotes) {
  const list = []
  const locals = new Set()
  const add = (name, ref, local, remote, when) => {
    const full = name.toLowerCase()
    const key = local.toLowerCase()
    list.push({ name, ref, local, remote, when: when.trim(), order: list.length, key, full, base: key.slice(key.lastIndexOf('/') + 1) })
  }
  for (const line of out.split('\n')) {
    const [ref = '', when = ''] = line.split('\0')
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice(11)
      locals.add(name)
      add(name, ref, name, '', when)
    } else if (ref.startsWith('refs/remotes/')) {
      const rest = ref.slice(13)
      const remote = remotes.filter((r) => rest.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0] ?? rest.split('/')[0]
      const local = rest.slice(remote.length + 1)
      if (local && local !== 'HEAD') add(rest, ref, local, remote, when)
    }
  }
  return list.filter((b) => !b.remote || !locals.has(b.local))
}

// How well one lowercase token matches a branch; -1 when it doesn't. Whole
// name, then the last part's start, the name's start, a word start, anywhere,
// and last the token's letters in order (`flf` finds feature/login-form).
function tokenScore(b, t) {
  if (b.key === t || b.base === t) return 1000
  if (b.base.startsWith(t)) return 800
  if (b.key.startsWith(t)) return 700
  const i = b.full.indexOf(t)
  if (i >= 0) return i === 0 || '/-_.'.includes(b.full[i - 1]) ? 500 : 300 - Math.min(i, 100)
  let j = 0
  let gaps = 0
  let last = -1
  for (let k = 0; k < b.full.length && j < t.length; k++) {
    if (b.full[k] !== t[j]) continue
    if (last >= 0) gaps += k - last - 1
    last = k
    j++
  }
  return j === t.length ? Math.max(1, 100 - gaps) : -1
}

// The branches that match every word of the query, best first; ties go to
// local branches, then to the newest commit. An empty query matches all.
export function matchBranches(list, query) {
  const tokens = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const scored = []
  for (const b of list) {
    let score = 0
    for (const t of tokens) {
      const s = tokenScore(b, t)
      if (s < 0) {
        score = -1
        break
      }
      score += s
    }
    if (score >= 0) scored.push({ b, score })
  }
  scored.sort((x, y) => y.score - x.score || (x.b.remote ? 1 : 0) - (y.b.remote ? 1 : 0) || x.b.order - y.b.order)
  return scored.map((x) => x.b)
}

// Matches for the open search, minus the branch already checked out. A query
// that extends the last one only searches the last one's matches.
function searchMatches() {
  const query = (branchSearch?.query ?? '').trim().toLowerCase()
  const isNarrowing = matchCache.list === branches && matchCache.query && query.startsWith(matchCache.query)
  const pool = matchBranches(isNarrowing ? matchCache.pool : branches, query)
  matchCache = { list: branches, query, pool }
  return pool.filter((b) => b.remote || repo.isDetached || b.local !== repo.branch)
}

// One `for-each-ref` for every branch; typing then filters this list in memory
async function fetchBranches($) {
  const [refs, rem] = await Promise.all([
    gitRoot($, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(committerdate:relative)', 'refs/heads', 'refs/remotes']),
    gitRoot($, ['remote']),
  ])
  if (!refs.ok) {
    branchesError = lastLines(refs.err, 3) || 'Could not list the branches.'
  } else {
    branches = parseBranches(refs.out, rem.out.split('\n').map((s) => s.trim()).filter(Boolean))
    branchesError = ''
  }
  if (branchSearch) $.ui.invalidate('ui.render')
}

function loadBranches($) {
  if (!repo || repo.error) return Promise.resolve()
  if (!branchesLoading) branchesLoading = fetchBranches($).finally(() => { branchesLoading = null })
  return branchesLoading
}

function toggleBranchSearch($) {
  if (branchSearch) {
    branchSearch = null
  } else {
    branchSearch = { query: '' }
    // Draw the list already held at once; the reload swaps in any new branches
    loadBranches($).catch(() => {})
  }
  $.ui.invalidate('ui.render')
}

// Puts the cursor in the search field. The ring sits on the Checkout button
// the person just pressed, so autoFocus alone would not move it. Called from
// the ui.press hook: a render's $, kept by an onPress closure, can't move it.
async function focusBranchQuery($) {
  try {
    const r = await $.ui.focus({ requestId: PANE, key: 'branch-query' })
    if (!r?.deny) return
    // The pane does not hold the keyboard (the press came from elsewhere): take it
    await $.ui.open({ id: PANE, title: '📂 Git', focus: true, closeOnEscape: true, columns: await paneColumns($) })
    await $.ui.focus({ requestId: PANE, key: 'branch-query' })
  } catch (err) {
    $.ui.log('git-mod: could not focus the branch search: ' + (err?.message ?? err), { to: 'debug' })
  }
}

// A local branch: `git checkout <name>`. A remote one: `git checkout --track`,
// which makes the local branch and sets its upstream.
export function checkoutArgs(b) {
  return b.remote ? ['checkout', '--track', b.name, '--'] : ['checkout', b.name, '--']
}

async function checkoutBranch($, b) {
  const r = await gitRoot($, checkoutArgs(b), { timeoutMs: 60000 })
  if (!r.ok) {
    setNotice($, 'error', 'Checkout of ' + b.name + ' failed:\n' + lastLines(r.err || r.out, 6))
    return
  }
  branchSearch = null
  setNotice($, 'ok', b.remote ? 'Checked out ' + b.local + ', tracking ' + b.name : 'Checked out ' + b.name)
  // A remote branch now has a local one: list it as local next time
  loadBranches($).catch(() => {})
}

// A name git accepts as a branch (no spaces, no "..", not ending in .lock, and so on)
async function validBranchName($, name) {
  return name !== '' && (await gitRoot($, ['check-ref-format', '--branch', name])).ok
}

async function createBranch($, name) {
  if (!(await validBranchName($, name))) return setNotice($, 'error', '"' + name + '" is not a valid branch name.')
  const r = await gitRoot($, ['checkout', '-b', name], { timeoutMs: 60000 })
  if (!r.ok) return setNotice($, 'error', 'Could not create ' + name + ':\n' + lastLines(r.err || r.out, 6))
  branchSearch = null
  setNotice($, 'ok', 'Created and checked out ' + name)
  loadBranches($).catch(() => {})
}

async function renameBranch($, name) {
  if (repo.isDetached) return setNotice($, 'error', 'HEAD is detached: there is no branch to rename.')
  if (!(await validBranchName($, name))) return setNotice($, 'error', '"' + name + '" is not a valid branch name.')
  const r = await gitRoot($, ['branch', '-m', name], { timeoutMs: 60000 })
  if (!r.ok) return setNotice($, 'error', 'Could not rename to ' + name + ':\n' + lastLines(r.err || r.out, 6))
  branchSearch = null
  setNotice($, 'ok', 'Renamed to ' + name + '. Its upstream, if any, still has the old name.')
  loadBranches($).catch(() => {})
}

// `-d` only deletes a branch that is fully merged: git refuses otherwise and nothing is lost
async function deleteBranch($, b) {
  confirmBranchDel = ''
  const r = await gitRoot($, ['branch', '-d', b.name], { timeoutMs: 60000 })
  if (!r.ok) return setNotice($, 'error', b.name + ' was not deleted:\n' + lastLines(r.err || r.out, 6) + '\nIf you are sure, run git branch -D ' + b.name + ' yourself.')
  setNotice($, 'ok', 'Deleted ' + b.name)
  loadBranches($).catch(() => {})
}

// ---------- open a file ----------

// The new-side line of the first hunk in `git diff -U0` output; 1 when there is none
export function firstChangedLine(diff) {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m.exec(String(diff ?? ''))
  return m ? Math.max(1, Number(m[1])) : 1
}

// The editor that can jump to a line, from the default app's path or id
export function editorFor(app) {
  const name = String(app ?? '').replace(/[\\/]+$/, '')
  return name ? EDITORS.find((ed) => ed.match.test(name)) ?? null : null
}

// `<scheme>://file/<path>:<line>:1`, each path segment encoded (the drive's colon kept)
export function editorUrl(scheme, absPath, line) {
  const path = absPath.replace(/\\/g, '/')
  const encoded = path
    .split('/')
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/')
  return scheme + '://file' + (encoded.startsWith('/') ? '' : '/') + encoded + ':' + line + ':1'
}

async function run($, argv, init) {
  try {
    const r = await $.process.run(argv, { timeoutMs: 15000, ...(init ?? {}) })
    return { ok: r.exitCode === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() }
  } catch (err) {
    return { ok: false, out: '', err: String(err?.message ?? err) }
  }
}

async function detectPlatform($) {
  if (platform) return platform
  if (/^[A-Za-z]:[\\/]/.test(repo?.root ?? '')) platform = 'windows'
  else platform = (await run($, ['uname', '-s'])).out === 'Darwin' ? 'mac' : 'linux'
  return platform
}

// The app the OS opens this file with: a path (Windows, macOS) or a .desktop id (Linux)
async function defaultApp($, os, absPath) {
  const ext = /(\.[^./\\]+)$/.exec(absPath)?.[1]?.toLowerCase() ?? ''
  if (!ext) return ''
  if (openers.has(ext)) return openers.get(ext)
  let app = ''
  if (os === 'windows') {
    app = (await run($, ['powershell', '-NoProfile', '-NonInteractive', '-Command', PS_ASSOC], { env: { GITMOD_EXT: ext } })).out
  } else if (os === 'mac') {
    app = (await run($, ['osascript', '-l', 'JavaScript', '-e', JXA_APP, absPath])).out
  } else {
    const mime = (await run($, ['xdg-mime', 'query', 'filetype', absPath])).out
    if (mime) app = (await run($, ['xdg-mime', 'query', 'default', mime])).out
  }
  openers.set(ext, app)
  return app
}

// Opens a file or URL with the OS's default handler
async function osOpen($, os, target) {
  if (os === 'windows') {
    return run($, ['powershell', '-NoProfile', '-NonInteractive', '-Command', PS_START], { env: { GITMOD_TARGET: target, GITMOD_ARGS: '' } })
  }
  return run($, [os === 'mac' ? 'open' : 'xdg-open', target])
}

// Starts an editor's own executable with arguments, without waiting for it to exit
async function startEditor($, os, app, args) {
  if (os === 'windows') {
    const line = args.map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '') + '"' : a)).join(' ')
    return run($, ['powershell', '-NoProfile', '-NonInteractive', '-Command', PS_START], { env: { GITMOD_TARGET: app, GITMOD_ARGS: line } })
  }
  if (os === 'mac') {
    // Sublime Text's command-line tool sits inside the app bundle
    if (/sublime/i.test(app)) return run($, [app.replace(/\/+$/, '') + '/Contents/SharedSupport/bin/subl', ...args])
    return { ok: false, out: '', err: '' }
  }
  return run($, [/sublime/i.test(app) ? 'subl' : app.replace(/\.desktop$/, ''), ...args])
}

// Opens a changed file with the machine's default app; an editor that can jump
// to a line opens it at the first change.
async function openFile($, f, isStagedList) {
  // Not in the working tree: deleted there, or a staged delete
  if (f.y === 'D' || (f.x === 'D' && f.y === '.')) {
    setNotice($, 'info', f.path + ' is deleted, so there is nothing to open.')
    return
  }
  const os = await detectPlatform($)
  const absPath = os === 'windows' ? (repo.root + '/' + f.path).replace(/\//g, '\\') : repo.root + '/' + f.path
  const app = await defaultApp($, os, absPath)
  const editor = editorFor(app)
  if (editor) {
    const diff = f.isUntracked
      ? { out: '' }
      : await gitRoot($, ['diff', ...(isStagedList ? ['--cached'] : []), '--no-ext-diff', '-U0', '--', f.path])
    const line = firstChangedLine(diff.out)
    const r = editor.scheme
      ? await osOpen($, os, editorUrl(editor.scheme, absPath, line))
      : await startEditor($, os, app, editor.args(absPath, line))
    if (r.ok) {
      $.ui.toast('Opened ' + f.path + ':' + line + ' in ' + editor.name)
      return
    }
  }
  const r = await osOpen($, os, absPath)
  if (!r.ok) setNotice($, 'error', 'Could not open ' + f.path + (r.err ? ':\n' + lastLines(r.err, 4) : '.'))
}

// A double click, or Enter on the focused name, opens the file. A single click
// only moves the focus; the click that follows it within DOUBLE_PRESS_MS opens.
async function pressFile($, key, f, isStagedList) {
  const now = await $.clock.now()
  const isRepeat = lastPress.key === key && now - lastPress.at < DOUBLE_PRESS_MS
  if (isRepeat && lastPress.opened) {
    lastPress = { key: '', at: 0, opened: false } // the second click of a double click on an opened file
    return
  }
  const isKeyboard = focused.key === key && now - focused.at >= FOCUS_SETTLE_MS
  if (!isRepeat && !isKeyboard) {
    lastPress = { key, at: now, opened: false }
    return
  }
  lastPress = { key, at: now, opened: true }
  await runAction($, 'Opening ' + f.path, () => openFile($, f, isStagedList))
}

// ---------- drawing helpers (no $) ----------

function splitPath(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)]
}

// ---------- desktop view: pure helpers (no $) ----------

const LANE_COLORS = ['#4C8DF6', '#E5534B', '#3FB950', '#D29922', '#A371F7', '#DB61A2', '#39C5CF', '#F0883E']
const LANE_W = 14
const GRAPH_PAD = 10
const ROW_H = 28
const MAX_LANES = 8
const BADGES = {
  added: { letter: 'A', fill: '#2EA043' },
  untracked: { letter: '?', fill: '#6E7781' },
  modified: { letter: 'M', fill: '#BF8700' },
  deleted: { letter: 'D', fill: '#D1242F' },
  renamed: { letter: 'R', fill: '#4C8DF6' },
  conflict: { letter: '!', fill: '#A371F7' },
}
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"'
const BRANCH_SVG =
  '<svg ' + SVG_NS + ' width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#4C8DF6" stroke-width="1.5" stroke-linecap="round">' +
  '<circle cx="4.5" cy="3.5" r="1.7"/><circle cx="4.5" cy="12.5" r="1.7"/><circle cx="11.5" cy="5.5" r="1.7"/><path d="M4.5 5.2v5.6M11.5 7.2c0 3-7 1.6-7 3.6"/></svg>'

function cut(s, n) {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s
}

// A 16px rounded badge with the status letter, as Fork draws a file's state
export function badgeSvg(kind) {
  const b = BADGES[kind] ?? BADGES.modified
  return (
    '<svg ' + SVG_NS + ' width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3" fill="' + b.fill + '"/>' +
    '<text x="8" y="11.5" font-family="-apple-system,Segoe UI,sans-serif" font-size="10" font-weight="700" text-anchor="middle" fill="#fff">' + b.letter + '</text></svg>'
  )
}

// `%D` with --decorate=full: "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1"
export function parseRefs(text) {
  const refs = []
  for (const raw of String(text ?? '').split(', ')) {
    let s = raw.trim()
    if (!s || s === 'refs/stash') continue
    let isHead = false
    if (s.startsWith('HEAD -> ')) {
      isHead = true
      s = s.slice(8)
    } else if (s === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'detached' })
      continue
    }
    if (s.startsWith('tag: ')) refs.push({ name: s.slice(5).replace(/^refs\/tags\//, ''), kind: 'tag' })
    else if (s.startsWith('refs/remotes/')) {
      if (!s.endsWith('/HEAD')) refs.push({ name: s.slice(13), kind: 'remote' })
    } else refs.push({ name: s.replace(/^refs\/heads\//, ''), kind: isHead ? 'head' : 'local' })
  }
  return refs
}

// `git log --format=%H %x1f %P %x1f %an %x1f %ar %x1f %D %x1f %s %x1f %b %x1e`
export function parseLog(out) {
  return String(out ?? '')
    .split('\x1e')
    .map((rec) => rec.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [hash = '', parents = '', author = '', when = '', refs = '', subject = '', body = ''] = rec.split('\x1f')
      return { hash, short: hash.slice(0, 7), parents: parents.split(' ').filter(Boolean), author, when, refs: parseRefs(refs), subject, body: body.trim() }
    })
}

// Lanes for the commit graph, newest commit first. Each row: the commit's lane
// (`col`), the lanes waiting before and after it (`before`, `after`: the hash
// each one expects next) and the lane each parent continues in (`parentLanes`).
export function layoutGraph(commits) {
  let lanes = []
  const rows = []
  let max = 1
  for (const c of commits) {
    const before = lanes.slice()
    let col = lanes.indexOf(c.hash)
    if (col < 0) {
      col = lanes.indexOf(null)
      if (col < 0) col = lanes.length
    }
    lanes[col] = null
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) lanes[i] = null
    const parentLanes = []
    c.parents.forEach((p, k) => {
      let j = lanes.indexOf(p)
      if (j < 0) {
        j = k === 0 ? col : lanes.indexOf(null)
        if (j < 0) j = lanes.length
        lanes[j] = p
      }
      parentLanes.push(j)
    })
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop()
    max = Math.max(max, before.length, lanes.length, col + 1)
    rows.push({ hash: c.hash, col, before, after: lanes.slice(), parentLanes })
  }
  return { rows, lanes: max }
}

// One row of the graph as an SVG: lines through the row, joins into the dot,
// the dot, and the lines out to each parent. Same width for every row.
export function graphSvg(row, lanes, isHead) {
  const n = Math.min(lanes, MAX_LANES)
  const width = GRAPH_PAD * 2 + (n - 1) * LANE_W
  const x = (i) => GRAPH_PAD + Math.min(i, MAX_LANES - 1) * LANE_W
  const color = (i) => LANE_COLORS[i % LANE_COLORS.length]
  const mid = ROW_H / 2
  const link = (x1, y1, x2, y2, c) =>
    x1 === x2
      ? '<path d="M' + x1 + ' ' + y1 + 'V' + y2 + '" stroke="' + c + '"/>'
      : '<path d="M' + x1 + ' ' + y1 + 'C' + x1 + ' ' + (y1 + y2) / 2 + ' ' + x2 + ' ' + (y1 + y2) / 2 + ' ' + x2 + ' ' + y2 + '" stroke="' + c + '"/>'
  let s = ''
  row.before.forEach((h, i) => {
    if (!h) return
    s += h === row.hash ? link(x(i), 0, x(row.col), mid, color(i)) : link(x(i), 0, x(i), ROW_H, color(i))
  })
  for (const j of row.parentLanes) s += link(x(row.col), mid, x(j), ROW_H, color(j))
  const cx = x(row.col)
  const dot = isHead
    ? '<circle class="live" cx="' + cx + '" cy="' + mid + '" r="5.5" fill="none" stroke="' + color(row.col) + '" stroke-width="2"/><circle cx="' + cx + '" cy="' + mid + '" r="2.5" fill="' + color(row.col) + '"/>'
    : '<circle cx="' + cx + '" cy="' + mid + '" r="4.5" fill="' + color(row.col) + '"/>'
  return '<svg ' + SVG_NS + ' width="' + width + '" height="' + ROW_H + '" viewBox="0 0 ' + width + ' ' + ROW_H + '">' + (isHead ? fxCss() : '') + '<g fill="none" stroke-width="2" stroke-linecap="round">' + s + '</g>' + dot + '</svg>'
}


// Effects shared with the agent monitor: CSS pulse and spin (off under reduced motion) and a glow filter.
const FX_CSS =
  '<style>.t{fill:#1f1f1f}.s{fill:#6b6b68}.tile{fill:#f4f3f0}.rk{stroke:#e4e3df;fill:none}' +
  '@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.tile{fill:#262625}.rk{stroke:#3a3a38}}' +
  '.live{animation:p 1.2s ease-in-out infinite}@keyframes p{50%{opacity:.3}}' +
  '.spin{transform-box:fill-box;transform-origin:center;animation:r 1s linear infinite}@keyframes r{to{transform:rotate(360deg)}}' +
  '@media (prefers-reduced-motion: reduce){.live,.spin{animation:none}}</style>' +
  '<defs><filter id="g" x="-50%" y="-80%" width="200%" height="260%"><feGaussianBlur stdDeviation="2.5"/></filter></defs>'
const fxCss = () =>
  FX_CSS + (cfg.pulseEffect === false ? '<style>.live{animation:none}</style>' : '') + (cfg.glowEffect === false ? '<style>[filter]{display:none}</style>' : '')
const FX_FONT = "font-family=\"-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif\""
const fxEsc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// Status band: an orb (green clean, amber dirty, red behind, blue spinning ring while busy) and four tiles.
export function statusSvg(W, st) {
  const color = st.busy ? '#4C8DF6' : st.behind ? '#F03E3E' : st.changes || st.staged ? '#F0B429' : '#40C057'
  const orb = st.busy
    ? '<circle cx="20" cy="23" r="9" class="rk" stroke-width="3"/><circle class="spin" cx="20" cy="23" r="9" fill="none" stroke="' + color + '" stroke-width="3" stroke-linecap="round" stroke-dasharray="14 43"/>'
    : '<circle class="live" cx="20" cy="23" r="8" fill="' + color + '" filter="url(#g)"/><circle cx="20" cy="23" r="6" fill="' + color + '"/>'
  const tiles = [
    { k: 'Staged', v: st.staged, c: '#40C057' },
    { k: 'Changes', v: st.changes, c: '#F0B429' },
    { k: 'Ahead', v: st.ahead, c: '#4C8DF6' },
    { k: 'Behind', v: st.behind, c: '#F03E3E' },
  ]
  const x0 = 40
  const gap = 6
  const tw = (W - x0 - 3 - gap * (tiles.length - 1)) / tiles.length
  const body = tiles
    .map((t, n) => {
      const x = x0 + n * (tw + gap)
      const on = t.v > 0
      const halo = on ? '<rect class="live" x="' + x + '" y="3" width="' + tw + '" height="40" rx="8" fill="none" stroke="' + t.c + '" stroke-width="2" filter="url(#g)"/><rect x="' + x + '" y="3" width="' + tw + '" height="40" rx="8" fill="none" stroke="' + t.c + '" stroke-width="1.5"/>' : ''
      return '<rect class="tile" x="' + x + '" y="3" width="' + tw + '" height="40" rx="8"/>' + halo +
        '<text class="s" x="' + (x + 9) + '" y="18" ' + FX_FONT + ' font-size="11">' + fxEsc(t.k) + '</text>' +
        '<text ' + (on ? 'fill="' + t.c + '"' : 'class="s"') + ' x="' + (x + 9) + '" y="35" ' + FX_FONT + ' font-size="15" font-weight="600">' + t.v + '</text>'
    })
    .join('')
  return '<svg ' + SVG_NS + ' width="' + W + '" height="46" viewBox="0 0 ' + W + ' 46">' + FX_CSS + orb + body + '</svg>'
}

export const statusColor = (st) => (st.busy ? '#4C8DF6' : st.behind ? '#F03E3E' : st.changes || st.staged ? '#F0B429' : '#40C057')
export function orbSvg(color, busy) {
  const o = busy
    ? '<circle cx="10" cy="10" r="7" class="rk" stroke-width="2.5"/><circle class="spin" cx="10" cy="10" r="7" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="11 33"/>'
    : '<circle class="live" cx="10" cy="10" r="6" fill="' + color + '" filter="url(#g)"/><circle cx="10" cy="10" r="4.5" fill="' + color + '"/>'
  return '<svg ' + SVG_NS + ' width="20" height="20" viewBox="0 0 20 20">' + fxCss() + o + '</svg>'
}

// Empty state: breathing rings around a check.
export function cleanSvg() {
  return '<svg ' + SVG_NS + ' width="120" height="90" viewBox="0 0 120 90">' + fxCss() +
    '<circle class="live" cx="60" cy="45" r="30" fill="none" stroke="#40C057" stroke-width="2" filter="url(#g)"/>' +
    '<circle class="live" cx="60" cy="45" r="22" fill="none" stroke="#40C057" stroke-width="2" style="animation-delay:-.6s"/>' +
    '<path d="M50 46l7 7 13-15" fill="none" stroke="#40C057" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
}

// Splits `git diff` / `git show` output into files: { path, old, hunks, isBinary, add, del }
export function splitDiff(text) {
  const out = []
  for (const part of String(text ?? '').split(/^diff --git /m)) {
    if (!part.trim()) continue
    const lines = part.split('\n')
    const at = lines.findIndex((l) => l.startsWith('@@'))
    const head = at < 0 ? lines : lines.slice(0, at)
    const hunks = at < 0 ? '' : lines.slice(at).join('\n')
    const plus = head.find((l) => l.startsWith('+++ '))
    const minus = head.find((l) => l.startsWith('--- '))
    const clean = (l, prefix) => l.slice(4).replace(/\t.*$/, '').replace(prefix, '')
    let path = ''
    if (plus && plus !== '+++ /dev/null') path = clean(plus, /^b\//)
    else if (minus && minus !== '--- /dev/null') path = clean(minus, /^a\//)
    else {
      const m = /^a\/(.+) b\/(.+)$/.exec(lines[0])
      path = m ? m[2] : lines[0]
    }
    const rename = head.find((l) => l.startsWith('rename from '))
    let add = 0
    let del = 0
    for (const l of hunks.split('\n')) {
      if (l[0] === '+') add++
      else if (l[0] === '-') del++
    }
    out.push({ path, old: rename ? rename.slice(12) : '', hunks, isBinary: at < 0 && /^(Binary files |GIT binary patch)/m.test(part), add, del })
  }
  return out
}

// Whole hunks up to `max` characters: the Code diff view needs each hunk intact
export function trimHunks(hunks, max) {
  const chunks = String(hunks ?? '').split(/^(?=@@ )/m).filter(Boolean)
  let text = ''
  let shown = 0
  for (const c of chunks) {
    if (text.length + c.length > max) break
    text += c
    shown++
  }
  return { text, hidden: chunks.length - shown }
}

// What to draw for one file's diff (a list of elements)
function diffElements(ui, f) {
  const { Text, Code } = ui
  if (f.isBinary) return [Text({ dimColor: true, children: ['Binary file'] })]
  if (!f.hunks.trim()) return [Text({ dimColor: true, children: ['No content changes (mode or rename only).'] })]
  const t = trimHunks(f.hunks, cfg.diffMaxChars)
  const out = []
  if (t.text) out.push(Code({ source: t.text, format: 'diff', path: f.path, wrap: 'wrap' }))
  if (t.hidden) {
    out.push(Text({ dimColor: true, wrap: 'wrap', children: [t.hidden + ' more hunk' + (t.hidden === 1 ? '' : 's') + ' not shown: too large to draw here. Use Open to see the whole file.'] }))
  }
  return out
}

// `git submodule status`: "<state><sha> <path> (<describe>)", state ' ' ok,
// '+' another commit is checked out, '-' not initialized, 'U' conflict
export function parseSubmodules(out) {
  const list = []
  for (const line of String(out ?? '').split('\n')) {
    const m = /^([ +\-U])([0-9a-f]+) (.+?)(?: \((.*)\))?$/.exec(line)
    if (m) list.push({ state: m[1], sha: m[2], path: m[3], describe: m[4] ?? '' })
  }
  return list
}

// ---------- desktop view: git calls ----------

// What belongs to one repository goes when the view moves to another
function resetRepoView() {
  diffSel = null
  commitSel = null
  history = { key: '', commits: [], rows: [], lanes: 1, limit: cfg.historyPageSize, loading: false, error: '' }
  branches = []
  branchSearch = null
  matchCache = { list: null, query: '', pool: [] }
  parentOf = { branch: '', parent: '' }
  draft = null
  dmsg = { subject: '', body: '' }
  confirmDiscard = ''
  confirmDrop = ''
  confirmBranchDel = ''
  divergeAsk = false
  histQuery = ''
  notice = null
  view = { tab: 'changes' }
  lastSig = ''
}

// Moves the whole panel into a submodule (depth > 0 of the stack) or back out
const drafts = {} // commit message typed per repository path, kept while navigating and across restarts
const draftsAtom = atom({ plugin: 'fork-git-pane', key: 'drafts' }, {}, { shape: 'drafts-1' })
let savedDrafts = ''
const currentRoot = () => navStack[navStack.length - 1] ?? topRoot

async function saveDrafts($) {
  drafts[currentRoot()] = dmsg
  const live = Object.fromEntries(Object.entries(drafts).filter(([, d]) => d.subject || d.body))
  const sig = JSON.stringify(live)
  if (sig === savedDrafts) return
  savedDrafts = sig
  await update($, draftsAtom, () => live)
}

async function navigate($, stack) {
  drafts[currentRoot()] = dmsg
  navStack = stack
  resetRepoView()
  dmsg = drafts[currentRoot()] ?? dmsg
  await refresh($)
  $.ui.invalidate('ui.render')
}

function historyKey() {
  return repo && !repo.error ? repo.oid + '|' + repo.branch + '|' + history.limit + '|' + histScope : ''
}

async function loadHistory($) {
  if (history.loading || !repo || repo.error) return
  if (repo.isUnborn) {
    history = { ...history, key: historyKey(), commits: [], rows: [], lanes: 1, error: '' }
    return
  }
  history.loading = true
  $.ui.invalidate('ui.render')
  try {
    const key = historyKey()
    const r = await gitRoot($, [
      'log', ...(histScope === 'all' ? ['--branches', '--remotes', '--tags'] : []), 'HEAD', '--date-order', '--decorate=full', '-n', String(history.limit),
      '--format=%H%x1f%P%x1f%an%x1f%ar%x1f%D%x1f%s%x1f%b%x1e',
    ], { timeoutMs: 30000 })
    if (!r.ok) {
      history = { ...history, key, error: lastLines(r.err, 3) || 'Could not read the history.' }
      return
    }
    const commits = parseLog(r.out)
    const { rows, lanes } = layoutGraph(commits)
    history = { ...history, key, commits, rows, lanes, error: '' }
  } finally {
    history.loading = false
    $.ui.invalidate('ui.render')
  }
}

// The diff text of the file whose diff is open; redraws only when it changed
async function fetchSelDiff($) {
  const s = diffSel
  if (!s || !repo || repo.error) return
  let text = ''
  if (s.isConflict || s.path.endsWith('/')) {
    text = ''
  } else if (s.isUntracked) {
    // exit code 1 means "differences found" for --no-index
    text = (await gitRoot($, ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', s.path])).out
  } else if (s.isStaged) {
    text = (await gitRoot($, ['diff', '--cached', '--no-ext-diff', '-M', '--', ...(s.orig ? [s.path, s.orig] : [s.path])])).out
  } else {
    text = (await gitRoot($, ['diff', '--no-ext-diff', '--', s.path])).out
  }
  if (diffSel === s && s.text !== text) {
    s.text = text
    $.ui.invalidate('ui.render')
  }
}

async function showFileDiff($, f, isStagedList) {
  const key = (isStagedList ? 's-' : 'u-') + f.path
  if (diffSel?.key === key) {
    diffSel = null
    $.ui.invalidate('ui.render')
    return
  }
  diffSel = { key, path: f.path, orig: f.orig, isStaged: isStagedList, isUntracked: f.isUntracked && !isStagedList, isConflict: f.isConflict, text: null }
  $.ui.invalidate('ui.render')
  await fetchSelDiff($)
  if (diffSel && diffSel.text === null) {
    diffSel.text = ''
    $.ui.invalidate('ui.render')
  }
}

async function selectCommit($, c) {
  if (commitSel?.hash === c.hash) {
    commitSel = null
    $.ui.invalidate('ui.render')
    return
  }
  const sel = { hash: c.hash, files: [], fileOpen: '', isLoading: true, error: '' }
  commitSel = sel
  $.ui.invalidate('ui.render')
  // -m --first-parent: a merge shows what it brought in, not a combined diff
  const r = await gitRoot($, ['show', '--format=', '--no-ext-diff', '-M', '-m', '--first-parent', c.hash], { timeoutMs: 30000 })
  sel.isLoading = false
  if (r.ok) sel.files = splitDiff(r.out)
  else sel.error = lastLines(r.err, 3) || 'Could not read the commit.'
  $.ui.invalidate('ui.render')
}

async function fetchRemote($) {
  const r = await gitRoot($, ['fetch', '--all', '--prune'], { timeoutMs: 180000 })
  if (!r.ok) {
    setNotice($, 'error', 'Fetch failed:\n' + lastLines(r.err || r.out, 6))
    return
  }
  history.key = ''
  setNotice($, 'ok', 'Fetched all remotes.')
}

async function generateForDesktop($) {
  await generateCommitMessage($)
  if (draft) {
    dmsg = { subject: draft.subject, body: draft.body }
    draft = null
  }
}

async function commitFromDesktop($) {
  draft = { subject: dmsg.subject, body: dmsg.body, isEditing: false }
  await commitDraft($)
  if (!draft) dmsg = { subject: '', body: '' } // committed
  else draft = null // failed: keep what was typed
}

// A request, not a grant: a width the person dragged the dock to wins
async function paneColumns($) {
  try {
    return (await $.session.surfaces()).includes('desktop') ? COLS_DESKTOP : COLS_TERMINAL
  } catch {
    return COLS_TERMINAL
  }
}

function setTab($, tab) {
  view = { tab }
  if (tab === 'history' && history.key !== historyKey()) loadHistory($).catch(() => {})
  $.ui.invalidate('ui.render')
}

// ---------- desktop view: drawing ----------

function drawDesktop($, e, ui) {
  const { Box, Text, Button, Input, Svg } = ui
  const cols = e.props.bodyColumns ?? 60
  const redraw = () => $.ui.invalidate('ui.render')
  const staged = stagedFiles()
  const unstaged = unstagedFiles()
  const branchName = repo.isDetached ? 'detached at ' + repo.oid.slice(0, 7) : repo.branch
  const icon = (source, alt) => Svg({ source, alt, width: 16, height: 16 })

  if (e.props.placement === 'widget') {
    return Box({
      flexDirection: 'row',
      alignItems: 'center',
      gap: 'sm',
      children: [
        icon(BRANCH_SVG, 'Branch'),
        Text({ weight: 'semibold', wrap: 'truncate-end', children: [branchName] }),
        Text({ dimColor: true, children: [(repo.ahead ? '↑' + repo.ahead + ' ' : '') + (repo.behind ? '↓' + repo.behind + ' ' : '') + files.length + ' changed'] }),
      ],
    })
  }

  // --- header: branch, where it came from, sync state ---
  const slash = repo.branch.lastIndexOf('/')
  const meta = []
  if (slash > 0 && !repo.isDetached) {
    meta.push(
      Text({ color: 'inverseText', backgroundColor: 'suggestion', children: [' ' + repo.branch.slice(0, slash) + ' '] }),
      Text({ dimColor: true, children: ['from'] }),
      Text({ color: 'suggestion', weight: 'semibold', wrap: 'truncate-end', children: [parentOf.parent || 'unknown base'] }),
    )
  }
  if (!repo.isDetached) {
    if (repo.upstream) {
      meta.push(
        Text({ color: repo.ahead ? 'success' : undefined, dimColor: !repo.ahead, children: ['↑' + repo.ahead] }),
        Text({ color: repo.behind ? 'error' : undefined, dimColor: !repo.behind, children: ['↓' + repo.behind] }),
        Text({ dimColor: true, wrap: 'truncate-end', children: [repo.upstream] }),
      )
    } else {
      meta.push(Text({ color: 'warning', wrap: 'truncate-end', children: [repo.isUnborn ? 'no commits yet' : 'not pushed yet · push sets upstream'] }))
    }
  }
  const baseName = (path) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  const crumbs = navStack.length
    ? [
        Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'sm',
          children: [topRoot, ...navStack].flatMap((path, i, all) => {
            const isLast = i === all.length - 1
            const label = baseName(path)
            return [
              isLast
                ? Text({ dimColor: true, children: [label] })
                : Button({ key: 'crumb-' + i, label: '‹ ' + label, plain: true, onPress: () => navigate($, navStack.slice(0, i)) }),
              ...(isLast ? [] : [Text({ dimColor: true, children: ['›'] })]),
            ]
          }),
        }),
      ]
    : []
  const header = Box({
    flexDirection: 'column',
    gap: 'xs',
    children: [
      ...crumbs,
      Box({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 'sm',
        children: [...(cfg.showOrb ? [Svg({ source: orbSvg(statusColor({ staged: staged.length, changes: unstaged.length, behind: repo.behind, busy: !!busy }), !!busy), alt: 'Status', width: 20, height: 20, isInteractive: true })] : []), icon(BRANCH_SVG, 'Branch'), Text({ weight: 'semibold', size: 'heading', wrap: 'truncate-end', children: [branchName] })],
      }),
      Box({ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 'sm', children: meta }),
      ...(!cfg.showTiles ? [] : [Box({
        flexDirection: 'row',
        gap: 'sm',
        children: [['Staged', staged.length, 'success'], ['Changes', unstaged.length, 'warning'], ['Ahead', repo.ahead, 'suggestion'], ['Behind', repo.behind, 'error']].map(([k, v, c]) =>
          Box({ flexGrow: 1, flexDirection: 'column', paddingX: 'sm', borderStyle: 'round', borderColor: v ? c : 'subtle', children: [Text({ dimColor: true, children: [k] }), Text({ weight: 'semibold', color: v ? c : undefined, dimColor: !v, children: [String(v)] })] }),
        ),
      })]),
    ],
  })

  // --- toolbar ---
  const toolbar = Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 'sm',
    children: [
      Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 'sm',
        children: [
          Button({ key: 'fetch', label: '⟳ Fetch', onPress: () => runAction($, 'Fetching', () => fetchRemote($)) }),
          Button({
            key: 'pull',
            label: '↓ Pull' + (repo.behind ? ' ' + repo.behind : ''),
            dimColor: !repo.upstream,
            ...(repo.behind && !staged.length ? { variant: 'primary' } : {}),
            onPress: () => runAction($, 'Pulling', () => pull($)),
          }),
          Button({
            key: 'push',
            label: '↑ Push' + (repo.ahead ? ' ' + repo.ahead : ''),
            ...(repo.ahead && !repo.behind && !staged.length ? { variant: 'primary' } : {}),
            onPress: () => runAction($, 'Pushing', () => push($)),
          }),
          Button({ key: 'checkout', label: (branchSearch ? '▾ ' : '⎇ ') + 'Branch', onPress: () => toggleBranchSearch($) }),
          Button({ key: 'stash', label: '⤓ Stash', dimColor: !files.length, onPress: () => runAction($, 'Stashing (writing a title)', () => stash($)) }),
          Button({ key: 'refresh', label: '↻', dimColor: true, onPress: () => runAction($, 'Refreshing', async () => {}) }),
          Button({ key: 'settings', label: '⚙', dimColor: true, onPress: () => $.ui.open({ id: SETTINGS_PANE, title: '⚙ Git settings', focus: true, closeOnEscape: true }) }),
          Button({ key: 'close', label: '✕', dimColor: true, onPress: () => closePane($) }),
        ],
      }),
    ],
  })

  // --- tabs ---
  const tab = (id, label) =>
    Button({ key: 'tab-' + id, label, variant: view.tab === id ? 'primary' : 'secondary', onPress: () => setTab($, id) })
  const tabs = Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 'sm',
    children: [tab('changes', '✎ Changes' + (files.length ? ' (' + files.length + ')' : '')), tab('history', '◷ History'), ...(subs.length ? [tab('submodules', '⧉ Submodules (' + subs.length + ')')] : []), tab('stashes', '⤓ Stashes' + (stashes.length ? ' (' + stashes.length + ')' : ''))],
  })

  const out = [header, toolbar]

  // --- branch search (opened by Branch) ---
  if (branchSearch) {
    const bs = branchSearch
    const matches = searchMatches()
    const shown = matches.slice(0, MAX_MATCHES)
    const checkout = (b) => runAction($, 'Checking out ' + b.name, () => checkoutBranch($, b))
    const typed = bs.query.trim()
    const newName = typed && !branches.some((b) => !b.remote && b.name === typed) && typed !== repo.branch ? typed : ''
    const status = branchesError
      ? Text({ color: 'error', wrap: 'wrap', children: [branchesError] })
      : !branches.length && branchesLoading
        ? Text({ dimColor: true, children: ['Reading branches…'] })
        : !matches.length
          ? Text({ dimColor: true, children: [bs.query.trim() ? 'No branch matches "' + bs.query.trim() + '"' : 'No other branches'] })
          : matches.length > shown.length
            ? Text({ dimColor: true, children: ['+' + (matches.length - shown.length) + ' more · keep typing to narrow'] })
            : null
    out.push(
      Box({
        flexDirection: 'column',
        gap: 'xs',
        borderStyle: 'round',
        borderColor: 'suggestion',
        paddingX: 'sm',
        children: [
          Input({
            key: 'branch-query',
            label: 'Branch ',
            value: bs.query,
            placeholder: 'Type to search ' + (branches.length || '') + ' branches',
            submitLabel: 'checkout',
            autoFocus: true,
            onInput: (v) => { bs.query = v; redraw() },
            onSubmit: (v) => {
              bs.query = v
              const best = searchMatches()[0]
              if (best) checkout(best)
              else setNotice($, 'info', 'No branch matches "' + v.trim() + '".')
            },
          }),
          ...shown.map((b) =>
            Box({
              key: 'brow-' + b.ref,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 'sm',
              children: [
                Button({ key: 'co-' + b.ref, label: cut(b.name, Math.max(12, cols - 24)), plain: true, hover: { color: 'suggestion' }, onPress: () => checkout(b) }),
                Text({ dimColor: true, wrap: 'truncate-end', children: [(b.remote ? 'remote · ' : '') + b.when] }),
                ...(b.remote
                  ? []
                  : confirmBranchDel === b.ref
                    ? [Button({ key: 'del-ok-' + b.ref, label: 'Confirm delete', onPress: () => runAction($, 'Deleting ' + b.name, () => deleteBranch($, b)) }), Button({ key: 'del-no-' + b.ref, label: 'Keep', dimColor: true, onPress: () => { confirmBranchDel = ''; redraw() } })]
                    : [Button({ key: 'del-' + b.ref, label: '🗑', dimColor: true, onPress: () => { confirmBranchDel = b.ref; redraw() } })]),
              ],
            }),
          ),
          ...(status ? [status] : []),
          ...(newName
            ? [Box({
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 'sm',
                children: [
                  Button({ key: 'branch-create', label: '＋ Create ' + cut(newName, 30), onPress: () => runAction($, 'Creating ' + newName, () => createBranch($, newName)) }),
                  ...(repo.isDetached ? [] : [Button({ key: 'branch-rename', label: '✎ Rename current to ' + cut(newName, 24), onPress: () => runAction($, 'Renaming ' + repo.branch, () => renameBranch($, newName)) })]),
                ],
              })]
            : []),
          Button({ key: 'close-search', label: 'Close', plain: true, dimColor: true, onPress: () => toggleBranchSearch($) }),
        ],
      }),
    )
  }

  if (busy) out.push(Text({ color: 'warning', children: ['… ' + busy] }))

  // --- notice ---
  if (notice) {
    const color = notice.tone === 'ok' ? 'success' : notice.tone === 'error' ? 'error' : 'suggestion'
    const mark = notice.tone === 'ok' ? '✓ ' : notice.tone === 'error' ? '✕ ' : '● '
    out.push(
      Box({
        flexDirection: 'column',
        gap: 'xs',
        borderStyle: 'round',
        borderColor: color,
        paddingX: 'sm',
        children: [
          Text({ color, wrap: 'wrap', children: [mark + notice.text] }),
          Box({
            flexDirection: 'row',
            gap: 'sm',
            children: [
              ...(divergeAsk && repo.ahead && repo.behind
                ? [
                    Button({ key: 'pull-merge', label: '⑂ Pull with merge', onPress: () => runAction($, 'Pulling with merge', () => pullWith($, 'merge')) }),
                    Button({ key: 'pull-rebase', label: '⤒ Pull with rebase', onPress: () => runAction($, 'Pulling with rebase', () => pullWith($, 'rebase')) }),
                  ]
                : []),
              ...(notice.hash
                ? [Button({ key: 'copy-hash', label: 'Copy hash', plain: true, onPress: (p) => { $.ui.copy({ text: notice.hash, surface: p.surface }); $.ui.toast('Copied ' + notice.hash.slice(0, 10)) } })]
                : []),
              Button({ key: 'dismiss', label: 'Dismiss', plain: true, dimColor: true, onPress: () => { notice = null; redraw() } }),
            ],
          }),
        ],
      }),
    )
  }

  out.push(tabs)

  // --- Changes tab ---
  const subPath = (path) => path.replace(/\/$/, '')
  const isSub = (path) => subs.some((m) => m.path === subPath(path) && m.state !== '-')
  const enterSub = (path) => navigate($, [...navStack, repo.root + '/' + subPath(path)])
  const fileRow = (f, isStagedList, hideDir = false) => {
    const code = isStagedList ? f.x : f.isUntracked ? '?' : f.isConflict ? 'U' : f.y
    const kind = f.isUntracked && !isStagedList ? 'untracked' : kindOf(code)
    const [dir, base] = splitPath(f.path.replace(/\/$/, ''))
    const rowKey = (isStagedList ? 's-' : 'u-') + f.path
    const openKey = (isStagedList ? 'sopen-' : 'uopen-') + f.path
    const isOpen = diffSel?.key === rowKey
    const isConfirming = confirmDiscard === rowKey
    const name = (f.orig && isStagedList ? splitPath(f.orig)[1] + ' → ' : '') + base + (f.path.endsWith('/') ? '/' : '')
    const room = Math.max(10, cols - 28)
    let diffBody = []
    if (isOpen) {
      const s = diffSel
      if (s.text === null) diffBody = [Text({ dimColor: true, children: ['Loading diff…'] })]
      else if (s.isConflict) diffBody = [Text({ color: 'warning', wrap: 'wrap', children: ['Merge conflict: resolve it in your editor (Open).'] })]
      else if (s.path.endsWith('/')) diffBody = [Text({ dimColor: true, wrap: 'wrap', children: ['Untracked folder: stage it to include everything inside.'] })]
      else {
        const parsed = splitDiff(s.text)
        diffBody = parsed.length ? diffElements(ui, parsed[0]) : [Text({ dimColor: true, children: ['No textual changes.'] })]
      }
    }
    // The diff block scrolls on its own, so Close sits at both ends of it
    const closeBtn = (at) => Button({ key: 'close-diff-' + at + '-' + rowKey, label: '✕ Close diff', plain: true, dimColor: true, onPress: () => showFileDiff($, f, isStagedList) })
    return Box({
      key: (isStagedList ? 'srow-' : 'urow-') + f.path,
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 'sm',
          children: [
            icon(badgeSvg(kind), kind),
            Box({
              flexDirection: 'row',
              gap: 'sm',
              flexGrow: 1,
              flexShrink: 1,
              children: [
                Button({ key: openKey, label: cut(name, room), plain: true, hover: { color: 'suggestion' }, onPress: () => showFileDiff($, f, isStagedList) }),
                ...(hideDir ? [] : [Text({ dimColor: true, wrap: 'truncate-start', children: [dir.replace(/\/$/, '')] })]),
              ],
            }),
            ...(isConfirming
              ? [
                  Button({ key: 'confirm-discard-' + rowKey, label: 'Confirm discard', onPress: () => runAction($, 'Discarding', () => discardFile($, f, isStagedList)) }),
                  Button({ key: 'keep-' + rowKey, label: 'Keep', dimColor: true, onPress: () => { confirmDiscard = ''; redraw() } }),
                ]
              : [
                  Button({ key: 'discard-' + rowKey, label: '🗑', dimColor: true, onPress: () => { confirmDiscard = rowKey; redraw() } }),
                  isSub(f.path)
                    ? Button({ key: 'enter-' + rowKey, label: '›', dimColor: true, onPress: () => enterSub(f.path) })
                    : Button({ key: 'edit-' + rowKey, label: '↗', dimColor: true, onPress: () => runAction($, 'Opening ' + f.path, () => openFile($, f, isStagedList)) }),
                  isStagedList
                    ? Button({ key: 'unstage-' + f.path, label: 'Unstage', onPress: () => runAction($, 'Unstaging', () => unstageFile($, f)) })
                    : Button({ key: 'stage-' + f.path, label: 'Stage', onPress: () => runAction($, 'Staging', () => stageFile($, f)) }),
                ]),
          ],
        }),
        ...(isOpen
          ? [Box({ flexDirection: 'column', gap: 'xs', borderStyle: 'round', borderColor: 'subtle', paddingX: 'sm', marginLeft: 2, children: [closeBtn('top'), ...diffBody, closeBtn('end')] })]
          : []),
      ],
    })
  }

  // Folder tree: one dim line per folder, its files indented under it
  const fileRows = (list, isStagedList) => {
    if (!cfg.fileTree) return list.map((f) => fileRow(f, isStagedList))
    const groups = new Map()
    for (const f of list) {
      const dir = splitPath(f.path.replace(/\/$/, ''))[0].replace(/\/$/, '')
      if (!groups.has(dir)) groups.set(dir, [])
      groups.get(dir).push(f)
    }
    return [...groups].flatMap(([dir, fs]) => [
      Text({ key: 'dir-' + (isStagedList ? 's-' : 'u-') + dir, dimColor: true, wrap: 'truncate-start', children: ['📁 ' + (dir || '(root)')] }),
      ...fs.map((f) => Box({ key: 'ind-' + (isStagedList ? 's-' : 'u-') + f.path, marginLeft: 2, flexDirection: 'column', children: [fileRow(f, isStagedList, true)] })),
    ])
  }
  const section = (title, list, isStagedList) =>
    Box({
      flexDirection: 'column',
      gap: 'xs',
      children: [
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingX: 'sm',
          borderStyle: 'round',
          borderColor: isStagedList ? 'success' : 'warning',
          children: [
            Box({
              flexDirection: 'row',
              gap: 'sm',
              children: [
                Button({ key: 'fold-' + title, label: folded.has(title) ? '▸' : '▾', plain: true, dimColor: true, onPress: () => { folded.has(title) ? folded.delete(title) : folded.add(title); redraw() } }),
                Text({ weight: 'semibold', color: isStagedList ? 'success' : 'warning', children: [title] }),
                Text({ dimColor: true, children: ['(' + list.length + ')'] }),
              ],
            }),
            list.length
              ? isStagedList
                ? Button({ key: 'unstage-all', label: 'Unstage all', plain: true, dimColor: true, onPress: () => runAction($, 'Unstaging all', () => unstageAll($)) })
                : Button({ key: 'stage-all', label: 'Stage all', plain: true, dimColor: true, onPress: () => runAction($, 'Staging all', () => stageAll($)) })
              : Text({ children: [''] }),
          ],
        }),
        ...(folded.has(title) ? [] : list.length ? fileRows(list, isStagedList) : [Text({ dimColor: true, children: [isStagedList ? 'Nothing staged' : 'No unstaged changes'] })]),
      ],
    })

  const changesTab = () => {
    if (!files.length) return [Box({ flexDirection: 'column', alignItems: 'center', gap: 'xs', children: [Svg({ source: cleanSvg(), alt: 'Working tree clean', width: 120, height: 90, isInteractive: true }), Text({ color: 'success', children: ['✓ Working tree clean'] })] })]
    const parts = [section('Staged', staged, true), section('Changes', unstaged, false)]
    const canCommit = staged.length > 0 && dmsg.subject.trim().length > 0
    parts.push(
      Box({
        flexDirection: 'column',
        gap: 'xs',
        borderStyle: 'round',
        borderColor: 'subtle',
        paddingX: 'sm',
        children: [
          Text({ weight: 'semibold', children: ['Commit' + (staged.length ? ' · ' + staged.length + ' staged file' + (staged.length === 1 ? '' : 's') : '')] }),
          Input({
            key: 'commit-subject',
            label: 'Summary ',
            rows: cfg.summaryRows,
            value: dmsg.subject,
            placeholder: 'Short imperative summary',
            onInput: (v) => {
              const was = lenBand(dmsg.subject.length)
              dmsg.subject = v
              if (cfg.summaryCounter && lenBand(v.length) !== was) redraw() // the counter changes color only when the band does
            },
            onSubmit: (v) => {
              dmsg.subject = v
              if (!staged.length) return setNotice($, 'info', 'Nothing is staged. Stage the files to commit.')
              return runAction($, 'Committing', () => commitFromDesktop($))
            },
          }),
          ...(cfg.summaryCounter && dmsg.subject
            ? [Text({ color: ['', 'success', 'warning', 'error'][lenBand(dmsg.subject.length)] || undefined, dimColor: lenBand(dmsg.subject.length) === 1, children: [['', 'Good length', 'Long: past 50 characters', 'Too long: past 72 characters'][lenBand(dmsg.subject.length)]] })]
            : []),
          Input({
            key: 'commit-body',
            label: 'Body    ',
            rows: cfg.bodyRows,
            value: dmsg.body,
            placeholder: 'Optional · a newline is typed as in the prompt box',
            onInput: (v) => { dmsg.body = v },
            onSubmit: (v) => { dmsg.body = v; redraw() },
          }),
          Box({
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 'sm',
            children: [
              Button({
                key: 'generate',
                label: '✦ Write message',
                dimColor: !staged.length,
                onPress: () => {
                  if (!staged.length) return setNotice($, 'info', 'Nothing is staged. Stage the files to commit.')
                  return runAction($, 'Writing commit message', () => generateForDesktop($))
                },
              }),
              Button({
                key: 'commit',
                label: 'Commit',
                ...(canCommit ? { variant: 'primary' } : { dimColor: true }),
                onPress: () => {
                  if (!staged.length) return setNotice($, 'info', 'Nothing is staged. Stage the files to commit.')
                  if (!dmsg.subject.trim()) return setNotice($, 'info', 'Write a summary first, or press Write message.')
                  return runAction($, 'Committing', () => commitFromDesktop($))
                },
              }),
            ],
          }),
        ],
      }),
    )
    return parts
  }

  // --- History tab ---
  const historyTab = () => {
    if (history.error) return [Text({ color: 'error', wrap: 'wrap', children: [history.error] })]
    if (!history.commits.length) return [Text({ dimColor: true, children: [history.loading || history.key !== historyKey() ? 'Reading history…' : 'No commits yet'] })]
    const searchBar = Box({
      flexDirection: 'row',
      alignItems: 'center',
      gap: 'sm',
      children: [
        Box({ flexGrow: 1, flexShrink: 1, children: [Input({ key: 'history-query', label: '🔍', value: histQuery, placeholder: 'Search subject, author, hash or ref', onInput: (v) => { histQuery = v; redraw() }, onSubmit: (v) => { histQuery = v; redraw() } })] }),
        Button({ key: 'history-scope', label: histScope === 'all' ? '⑂ All branches' : '↳ This branch', onPress: () => { histScope = histScope === 'all' ? 'head' : 'all'; history.key = ''; loadHistory($).catch(() => {}); redraw() } }),
      ],
    })
    const graphCells = Math.ceil((GRAPH_PAD * 2 + (Math.min(history.lanes, MAX_LANES) - 1) * LANE_W) / 8)
    const refColor = { head: 'suggestion', local: 'success', remote: 'merged', tag: 'warning', detached: 'suggestion' }
    const q = histQuery.trim().toLowerCase()
    const hit = (c) => !q || (c.subject + ' ' + c.author + ' ' + c.hash + ' ' + c.refs.map((r) => r.name).join(' ')).toLowerCase().includes(q)
    const rows = history.commits.map((c, i) => {
      if (!hit(c)) return null
      const isSel = commitSel?.hash === c.hash
      // One short chip per row (head and local first): a row with many refs would wrap. All refs show in the commit detail.
      const rank = { head: 0, detached: 0, local: 1, tag: 2, remote: 3 }
      const sorted = [...c.refs].sort((a, b) => (rank[a.kind] ?? 4) - (rank[b.kind] ?? 4))
      const chips = sorted.slice(0, 1).map((r) => ({ ...r, name: cut(r.name, 18) }))
      const extra = c.refs.length - chips.length
      const chipCells = chips.reduce((n, r) => n + r.name.length + 3, 0) + (extra > 0 ? 4 : 0)
      const room = Math.max(12, cols - graphCells - chipCells - 26)
      const line = Box({
        key: 'crow-' + c.hash,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 'sm',
        ...(isSel ? { backgroundColor: '#4C8DF622' } : {}),
        children: [
          ...(q ? [] : [Svg({ source: graphSvg(history.rows[i], history.lanes, c.hash === repo.oid), alt: 'Graph lane for ' + c.short, width: GRAPH_PAD * 2 + (Math.min(history.lanes, MAX_LANES) - 1) * LANE_W, height: ROW_H })]),
          ...chips.map((r) => Text({ color: 'inverseText', backgroundColor: refColor[r.kind] ?? 'subtle', wrap: 'truncate-end', children: [' ' + r.name + ' '] })),
          ...(extra > 0 ? [Text({ dimColor: true, children: ['+' + extra] })] : []),
          Box({
            flexDirection: 'row',
            flexGrow: 1,
            flexShrink: 1,
            gap: 'sm',
            children: [
              Button({ key: 'commit-' + c.hash, label: cut(c.subject || '(no subject)', room), plain: true, hover: { color: 'suggestion' }, onPress: () => selectCommit($, c) }),
              Text({ dimColor: true, wrap: 'truncate-end', children: [c.author + ' · ' + c.when] }),
            ],
          }),
        ],
      })
      if (!isSel) return line
      const d = commitSel
      let detail
      if (d.isLoading) detail = [Text({ dimColor: true, children: ['Loading commit…'] })]
      else if (d.error) detail = [Text({ color: 'error', wrap: 'wrap', children: [d.error] })]
      else {
        const opened = d.files.find((f) => f.path === d.fileOpen)
        detail = [
          Text({ dimColor: true, wrap: 'wrap', children: [c.author + ' · ' + c.when + ' · ' + c.short + (c.parents.length > 1 ? ' · merge' : '')] }),
          ...(c.refs.length ? [Box({ flexDirection: 'row', flexWrap: 'wrap', gap: 'sm', children: c.refs.map((r) => Text({ color: 'inverseText', backgroundColor: refColor[r.kind] ?? 'subtle', children: [' ' + r.name + ' '] })) })] : []),
          ...(c.body ? [Text({ wrap: 'wrap', children: [c.body] })] : []),
          Button({ key: 'copy-commit-' + c.hash, label: 'Copy hash', plain: true, onPress: (p) => { $.ui.copy({ text: c.hash, surface: p.surface }); $.ui.toast('Copied ' + c.short) } }),
          Text({ weight: 'semibold', children: [d.files.length + ' file' + (d.files.length === 1 ? '' : 's') + ' changed'] }),
          ...d.files.map((f) =>
            Box({
              key: 'cfile-row-' + f.path,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 'sm',
              children: [
                icon(badgeSvg(f.old ? 'renamed' : f.add && !f.del ? 'added' : f.del && !f.add ? 'deleted' : 'modified'), 'file'),
                Button({ key: 'cfile-' + f.path, label: cut(f.path, Math.max(10, cols - 24)), plain: true, hover: { color: 'suggestion' }, onPress: () => { d.fileOpen = d.fileOpen === f.path ? '' : f.path; redraw() } }),
                Text({ color: 'success', children: ['+' + f.add] }),
                Text({ color: 'error', children: ['−' + f.del] }),
              ],
            }),
          ),
          ...(opened ? [Box({ flexDirection: 'column', gap: 'xs', borderStyle: 'round', borderColor: 'subtle', paddingX: 'sm', children: [Button({ key: 'close-cdiff-top', label: '✕ Close diff', plain: true, dimColor: true, onPress: () => { d.fileOpen = ''; redraw() } }), ...diffElements(ui, opened), Button({ key: 'close-cdiff-end', label: '✕ Close diff', plain: true, dimColor: true, onPress: () => { d.fileOpen = ''; redraw() } })] })] : []),
        ]
      }
      return Box({
        key: 'cdetail-' + c.hash,
        flexDirection: 'column',
        children: [line, Box({ flexDirection: 'column', gap: 'xs', borderStyle: 'round', borderColor: 'subtle', paddingX: 'sm', marginLeft: 2, children: detail })],
      })
    })
    const found = rows.filter(Boolean)
    if (q && !found.length) return [searchBar, Text({ dimColor: true, children: ['No loaded commit matches "' + histQuery.trim() + '". Load more commits to search further back.'] })]
    rows.splice(0, rows.length, ...found)
    if (history.commits.length >= history.limit) {
      rows.push(Button({ key: 'history-more', label: 'Load ' + cfg.historyPageSize + ' more', plain: true, dimColor: true, onPress: () => { history.limit += cfg.historyPageSize; history.key = ''; loadHistory($).catch(() => {}) } }))
    }
    // No gap between rows: the graph lines then meet from one row to the next
    return [searchBar, Box({ flexDirection: 'column', children: rows })]
  }

  // --- Stashes tab ---
  const stashesTab = () => {
    if (!stashes.length) return [Text({ dimColor: true, children: ['No stashes'] })]
    return stashes.map((s) =>
      Box({
        key: 'stash-' + s.hash,
        flexDirection: 'column',
        gap: 'xs',
        borderStyle: 'round',
        borderColor: 'subtle',
        paddingX: 'sm',
        children: [
          Box({
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'sm',
            children: [
              Box({ flexShrink: 1, flexGrow: 1, children: [Text({ weight: 'semibold', color: 'merged', wrap: 'wrap', children: [s.title || '(no title)'] })] }),
              ...(confirmDrop === s.hash
                ? [
                    Button({ key: 'confirm-drop-' + s.hash, label: 'Confirm remove', onPress: () => runAction($, 'Removing stash', () => drop($, s)) }),
                    Button({ key: 'keep-' + s.hash, label: 'Keep', dimColor: true, onPress: () => { confirmDrop = ''; redraw() } }),
                  ]
                : [
                    Button({ key: 'restore-' + s.hash, label: 'Restore', onPress: () => runAction($, 'Restoring stash', () => restore($, s)) }),
                    Button({ key: 'drop-' + s.hash, label: 'Remove', dimColor: true, onPress: () => { confirmDrop = s.hash; redraw() } }),
                  ]),
            ],
          }),
          Text({ dimColor: true, wrap: 'truncate-end', children: [s.ref + ' · ' + s.hash + ' · ' + s.when + (s.branch ? ' · ' + s.branch : '')] }),
        ],
      }),
    )
  }

  // --- Submodules tab ---
  const submodulesTab = () =>
    subs.map((m) => {
      const isDirty = files.some((f) => subPath(f.path) === m.path)
      const label = m.state === '-' ? 'not initialized' : m.state === 'U' ? 'conflict' : isDirty ? 'changed' : m.state === '+' ? 'other commit checked out' : 'up to date'
      const color = m.state === 'U' ? 'error' : m.state === '-' ? undefined : isDirty || m.state === '+' ? 'warning' : 'success'
      const base = m.path.split('/').pop()
      return Box({
        key: 'sub-' + m.path,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 'sm',
        children: [
          Box({
            flexDirection: 'column',
            flexGrow: 1,
            flexShrink: 1,
            children: [
              Text({ weight: 'semibold', wrap: 'truncate-end', children: [base] }),
              Box({
                flexDirection: 'row',
                gap: 'sm',
                children: [
                  Text({ color, dimColor: !color, children: ['●'] }),
                  Text({ color, dimColor: !color, children: [label] }),
                  Text({ dimColor: true, wrap: 'truncate-end', children: [m.sha.slice(0, 7) + (m.describe ? ' · ' + m.describe : '')] }),
                ],
              }),
            ],
          }),
          ...(m.state === '-' ? [] : [Button({ key: 'enter-sub-' + m.path, label: '›', onPress: () => enterSub(m.path) })]),
        ],
      })
    })

  out.push(...(view.tab === 'history' ? historyTab() : view.tab === 'stashes' ? stashesTab() : view.tab === 'submodules' ? submodulesTab() : changesTab()))
  return Box({ flexDirection: 'column', gap: 'sm', children: out })
}

// Band of a summary's length: 0 empty, 1 up to 50, 2 up to 72, 3 over
export const lenBand = (n) => (n === 0 ? 0 : n <= 50 ? 1 : n <= 72 ? 2 : 3)

function closePane($) {
  paneOpen = false
  return $.ui.close({ id: PANE })
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'git', description: 'Open the git panel (changes, commit, pull, push, stashes)', immediate: true })
    } catch (err) {
      $.ui.log('git-mod: could not register /git: ' + err.message, { to: 'debug' })
    }
    try {
      await $.command.register({ name: 'git-close', description: 'Close the git panel', immediate: true })
    } catch (err) {
      $.ui.log('git-mod: could not register /git-close: ' + err.message, { to: 'debug' })
    }
    await loadCfg($)
    view = { tab: cfg.defaultTab === 1 ? 'history' : 'changes' }
    history.limit = cfg.historyPageSize
    try {
      await $.command.register({ name: 'git-settings', description: 'Open the git panel settings', immediate: true })
    } catch (err) {
      $.ui.log('git-mod: could not register /git-settings: ' + err.message, { to: 'debug' })
    }
    startPoll($)
    // Always on: open the panel by itself when the session is in a git repo.
    // A pane the mod opens waits for a wide enough terminal (144+ columns).
    try {
      await refresh($)
      try {
        Object.assign(drafts, await read($, draftsAtom))
        dmsg = drafts[currentRoot()] ?? dmsg
      } catch {}
      if (repo && !repo.error && cfg.autoOpenPane) {
        paneOpen = true
        loadBranches($).catch(() => {}) // ready before the first search
        await $.ui.open({ id: PANE, title: '📂 Git', columns: await paneColumns($) })
      }
    } catch (err) {
      $.ui.log('git-mod: could not open the panel: ' + (err?.message ?? err), { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'git' }, async ($) => {
    paneOpen = true
    lastSig = ''
    await refresh($)
    if (!branches.length) loadBranches($).catch(() => {})
    await $.ui.open({ id: PANE, title: '📂 Git', focus: true, closeOnEscape: true, columns: await paneColumns($) })
    return {}
  })

  on('command.run', { command: 'git-settings' }, async ($) => {
    await $.ui.open({ id: SETTINGS_PANE, title: '⚙ Git settings', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== SETTINGS_PANE) return next(e)
    return drawSettings($, e)
  })

  on('command.run', { command: 'git-close' }, async ($) => {
    await closePane($)
    return {}
  })

  // Remember which file name holds the focus ring: Enter on it opens the file
  on('ui.focus', async ($, e, next) => {
    if (e.requestId === PANE) {
      try {
        focused = { key: e.element ?? '', at: await $.clock.now() }
      } catch {
        focused = { key: '', at: 0 }
      }
    }
    return next(e)
  })

  // Checkout (b) opened the branch search: put the cursor in its field
  on('ui.press', async ($, e, next) => {
    const result = await next(e)
    if (e.requestId === PANE && e.element === 'checkout' && branchSearch) await focusBranchQuery($)
    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // Claude may have changed files or run git: refresh after the tool ran
  on('tool.call', { tool: WATCHED_TOOLS }, async ($, e, next) => {
    const result = await next(e)
    if (paneOpen && !busy) refresh($).catch(() => {})
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (paneOpen && !busy) refresh($).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    paneOpen = true
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const cols = e.props.bodyColumns ?? 60
    const narrow = cols < 44
    const redraw = () => $.ui.invalidate('ui.render')
    const rule = () => Text({ dimColor: true, children: ['─'.repeat(Math.max(10, Math.min(cols, 200)))] })

    if (!loaded) {
      refresh($).catch(() => {})
      return Box({ flexDirection: 'column', children: [Text({ dimColor: true, children: ['Reading repository…'] })] })
    }

    if (!repo || repo.error) {
      return Box({
        flexDirection: 'column',
        children: [
          Text({ color: 'yellow', children: [repo?.error ?? 'No repository.'] }),
          Text({ dimColor: true, wrap: 'wrap', children: ['Start Claude Code inside a git repository, then press r.'] }),
          Button({ key: 'refresh', label: 'Refresh (r)', hotkey: 'r', onPress: () => runAction($, 'Refreshing', async () => {}) }),
        ],
      })
    }

    if (e.surface === 'desktop') return drawDesktop($, e, $.ui.resolve(e))

    const out = []

    // --- branch header ---
    const branchName = repo.isDetached ? 'detached at ' + repo.oid.slice(0, 7) : repo.branch
    out.push(
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ color: 'cyan', children: ['●'] }),
          Text({ bold: true, color: 'cyan', wrap: 'truncate-middle', children: [branchName] }),
        ],
      }),
    )
    const slash = repo.branch.lastIndexOf('/')
    if (slash > 0 && !repo.isDetached) {
      const group = repo.branch.slice(0, slash)
      out.push(
        Box({
          flexDirection: 'row',
          columnGap: 1,
          paddingLeft: 2,
          children: [
            Text({ color: 'black', backgroundColor: 'blue', children: [' ' + group + ' '] }),
            Text({ dimColor: true, children: ['↳ from'] }),
            Text({ color: 'blue', bold: true, wrap: 'truncate-middle', children: [parentOf.parent || 'unknown base'] }),
          ],
        }),
      )
    }
    if (!repo.isDetached) {
      const sync = repo.upstream
        ? [
            Text({ color: repo.ahead ? 'green' : undefined, dimColor: !repo.ahead, children: ['↑' + repo.ahead] }),
            Text({ color: repo.behind ? 'red' : undefined, dimColor: !repo.behind, children: ['↓' + repo.behind] }),
            Text({ dimColor: true, wrap: 'truncate-middle', children: [repo.upstream] }),
          ]
        : [Text({ color: 'yellow', dimColor: true, wrap: 'truncate-end', children: [repo.isUnborn ? 'no commits yet' : 'not pushed yet · push sets upstream'] })]
      out.push(Box({ flexDirection: 'row', columnGap: 1, paddingLeft: 2, children: sync }))
    }

    // --- action bar ---
    const staged = stagedFiles()
    const unstaged = unstagedFiles()
    out.push(
      Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 1,
        marginTop: 1,
        children: [
          Button({
            key: 'stash',
            label: 'Stash (s)',
            hotkey: 's',
            dimColor: !files.length,
            onPress: () => runAction($, 'Stashing (writing a title)', () => stash($)),
          }),
          Button({
            key: 'commit',
            label: 'Commit (c)',
            hotkey: 'c',
            dimColor: !staged.length,
            ...(staged.length && !draft ? { variant: 'primary' } : {}),
            onPress: () => {
              if (!staged.length) return setNotice($, 'info', 'Nothing is staged. Press Stage on the files to commit.')
              if (draft) return setNotice($, 'info', 'A message is already drafted below. Approve, edit or cancel it.')
              return runAction($, 'Writing commit message', () => generateCommitMessage($))
            },
          }),
          Button({
            key: 'pull',
            label: 'Pull (l)' + (repo.behind ? ' ↓' + repo.behind : ''),
            hotkey: 'l',
            dimColor: !repo.upstream,
            ...(repo.behind && !staged.length && !draft ? { variant: 'primary' } : {}),
            onPress: () => runAction($, 'Pulling', () => pull($)),
          }),
          Button({
            key: 'push',
            label: 'Push (p)' + (repo.ahead ? ' ↑' + repo.ahead : ''),
            hotkey: 'p',
            ...(repo.ahead && !repo.behind && !staged.length && !draft ? { variant: 'primary' } : {}),
            onPress: () => runAction($, 'Pushing', () => push($)),
          }),
          Button({ key: 'checkout', label: (branchSearch ? '▾ ' : '') + 'Checkout (b)', hotkey: 'b', onPress: () => toggleBranchSearch($) }),
          Button({ key: 'refresh', label: 'Refresh (r)', hotkey: 'r', onPress: () => runAction($, 'Refreshing', async () => {}) }),
        ],
      }),
    )

    // --- branch search ---
    if (branchSearch) {
      const bs = branchSearch
      const matches = searchMatches()
      const shown = matches.slice(0, MAX_MATCHES)
      const checkout = (b) => runAction($, 'Checking out ' + b.name, () => checkoutBranch($, b))
      const rows = shown.map((b, i) => {
        const meta = (b.remote ? 'remote · ' : '') + b.when
        const room = Math.max(8, cols - (narrow ? 8 : 8 + meta.length))
        return Box({
          key: 'brow-' + b.ref,
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Text({ color: 'cyan', children: [i === 0 && bs.query.trim() ? '↵' : ' '] }),
            Button({
              key: 'co-' + b.ref,
              label: b.name.length > room ? '…' + b.name.slice(-(room - 1)) : b.name,
              plain: true,
              hover: { color: 'cyan', underline: true },
              onPress: () => checkout(b),
            }),
            ...(narrow ? [] : [Text({ dimColor: true, wrap: 'truncate-end', children: [meta] })]),
          ],
        })
      })
      const status = branchesError
        ? Text({ color: 'red', wrap: 'wrap', children: [branchesError] })
        : !branches.length && branchesLoading
          ? Text({ dimColor: true, children: ['Reading branches…'] })
          : !matches.length
            ? Text({ dimColor: true, children: [bs.query.trim() ? 'No branch matches "' + bs.query.trim() + '"' : 'No other branches'] })
            : matches.length > shown.length
              ? Text({ dimColor: true, children: ['+' + (matches.length - shown.length) + ' more · keep typing to narrow'] })
              : null
      out.push(
        Box({
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'cyan',
          paddingX: 1,
          marginTop: 1,
          children: [
            Input({
              key: 'branch-query',
              label: 'Branch ',
              value: bs.query,
              placeholder: 'Type to search ' + (branches.length || '') + ' branches',
              submitLabel: 'checkout',
              autoFocus: true,
              onInput: (v) => { bs.query = v; redraw() },
              onSubmit: (v) => {
                bs.query = v
                const best = searchMatches()[0]
                if (best) checkout(best)
                else setNotice($, 'info', 'No branch matches "' + v.trim() + '".')
              },
            }),
            ...rows,
            ...(status ? [status] : []),
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                Text({ dimColor: true, wrap: 'truncate-end', children: [narrow ? 'Enter: top match' : 'Enter checks out the top match · click any row'] }),
                Button({ key: 'close-search', label: 'Close', plain: true, dimColor: true, onPress: () => toggleBranchSearch($) }),
              ],
            }),
          ],
        }),
      )
    }

    if (busy) out.push(Text({ color: 'yellow', children: ['… ' + busy] }))

    // --- notice banner ---
    if (notice) {
      const color = notice.tone === 'ok' ? 'green' : notice.tone === 'error' ? 'red' : 'blue'
      const mark = notice.tone === 'ok' ? '✓ ' : notice.tone === 'error' ? '✕ ' : '● '
      out.push(
        Box({
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: color,
          paddingX: 1,
          marginTop: 1,
          children: [
            Text({ color, wrap: 'wrap', children: [mark + notice.text] }),
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                ...(notice.hash
                  ? [Button({ key: 'copy-hash', label: 'Copy hash', plain: true, onPress: (p) => { $.ui.copy({ text: notice.hash, surface: p.surface }); $.ui.toast('Copied ' + notice.hash.slice(0, 10)) } })]
                  : []),
                Button({ key: 'dismiss', label: 'Dismiss', plain: true, dimColor: true, onPress: () => { notice = null; redraw() } }),
              ],
            }),
          ],
        }),
      )
    }

    // --- commit draft ---
    if (draft) {
      const d = draft
      const body = d.isEditing
        ? [
            Input({
              key: 'edit-subject',
              label: 'Subject ',
              value: d.subject,
              placeholder: 'Short imperative summary',
              submitLabel: 'save',
              autoFocus: true,
              onInput: (v) => { d.subject = v },
              onSubmit: (v) => { d.subject = v; redraw() },
            }),
            Input({
              key: 'edit-body',
              label: 'Body    ',
              value: d.body.split('\n').join(' | '),
              placeholder: 'Optional; separate lines with |',
              submitLabel: 'save',
              onInput: (v) => { d.body = v.split(/\s*\|\s*/).join('\n').trim() },
              onSubmit: (v) => { d.body = v.split(/\s*\|\s*/).join('\n').trim(); d.isEditing = false; redraw() },
            }),
          ]
        : [
            Text({ bold: true, wrap: 'wrap', children: [d.subject || '(empty subject)'] }),
            ...(d.body ? [Text({ dimColor: true, wrap: 'wrap', children: [d.body] })] : []),
          ]
      out.push(
        Box({
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'cyan',
          paddingX: 1,
          marginTop: 1,
          children: [
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                Text({ color: 'cyan', bold: true, children: ['Commit message'] }),
                Text({ dimColor: true, children: ['· ' + staged.length + ' staged file' + (staged.length === 1 ? '' : 's')] }),
              ],
            }),
            ...body,
            Box({
              flexDirection: 'row',
              flexWrap: 'wrap',
              columnGap: 1,
              marginTop: 1,
              children: [
                Button({
                  key: 'approve',
                  label: 'Approve & commit (a)',
                  hotkey: 'a',
                  variant: 'primary',
                  onPress: () => runAction($, 'Committing', () => commitDraft($)),
                }),
                d.isEditing
                  ? Button({ key: 'edit-done', label: 'Done editing', onPress: () => { d.isEditing = false; redraw() } })
                  : Button({ key: 'edit', label: 'Edit (e)', hotkey: 'e', onPress: () => { d.isEditing = true; redraw() } }),
                Button({
                  key: 'regenerate',
                  label: 'Regenerate (g)',
                  hotkey: 'g',
                  onPress: () => runAction($, 'Writing commit message', () => generateCommitMessage($)),
                }),
                Button({ key: 'cancel', label: 'Cancel (x)', hotkey: 'x', dimColor: true, onPress: () => { draft = null; redraw() } }),
              ],
            }),
          ],
        }),
      )
    }

    // --- file lists ---
    const fileRow = (f, isStagedList) => {
      const code = isStagedList ? f.x : f.isUntracked ? '?' : f.isConflict ? 'U' : f.y
      const kind = KIND[kindOf(code)]
      // An untracked folder comes as `dir/`: show its last part as the name
      const [dir, base] = splitPath(f.path.replace(/\/$/, ''))
      const shown = f.orig && isStagedList ? splitPath(f.orig)[1] + ' → ' : ''
      const openKey = (isStagedList ? 'sopen-' : 'uopen-') + f.path
      const rowKey = (isStagedList ? 's-' : 'u-') + f.path
      const isConfirming = confirmDiscard === rowKey
      const room = Math.max(8, cols - (isConfirming ? 30 : 26))
      const name = shown + base + (f.path.endsWith('/') ? '/' : '')
      return Box({
        key: (isStagedList ? 'srow-' : 'urow-') + f.path,
        flexDirection: 'row',
        justifyContent: 'space-between',
        columnGap: 1,
        paddingLeft: 1,
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            flexShrink: 1,
            flexGrow: 1,
            children: [
              Text({ color: kind.color, bold: true, children: [kind.glyph] }),
              Button({
                key: openKey,
                label: name.length > room ? '…' + name.slice(-(room - 1)) : name,
                plain: true,
                hover: { color: kind.color, underline: true },
                onPress: () => pressFile($, openKey, f, isStagedList),
              }),
              Text({
                dimColor: true,
                wrap: 'truncate-start',
                children: [(narrow ? '' : dir.replace(/\/$/, '')) + (f.isUntracked && !narrow ? ' new' : '')],
              }),
            ],
          }),
          ...(isConfirming
            ? [
                Button({ key: 'confirm-discard-' + rowKey, label: 'Confirm discard', onPress: () => runAction($, 'Discarding', () => discardFile($, f, isStagedList)) }),
                Button({ key: 'keep-' + rowKey, label: 'Keep', dimColor: true, onPress: () => { confirmDiscard = ''; redraw() } }),
              ]
            : [
                Button({ key: 'discard-' + rowKey, label: 'Discard', dimColor: true, onPress: () => { confirmDiscard = rowKey; redraw() } }),
                isStagedList
                  ? Button({ key: 'unstage-' + f.path, label: 'Unstage', dimColor: true, onPress: () => runAction($, 'Unstaging', () => unstageFile($, f)) })
                  : Button({ key: 'stage-' + f.path, label: 'Stage', onPress: () => runAction($, 'Staging', () => stageFile($, f)) }),
              ]),
        ],
      })
    }

    const section = (title, color, list, isStagedList) =>
      Box({
        flexDirection: 'column',
        marginTop: 1,
        children: [
          Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            children: [
              Box({
                flexDirection: 'row',
                columnGap: 1,
                children: [Text({ bold: true, color, children: [title] }), Text({ dimColor: true, children: ['(' + list.length + ')'] })],
              }),
              list.length
                ? isStagedList
                  ? Button({ key: 'unstage-all', label: 'Unstage all', plain: true, dimColor: true, onPress: () => runAction($, 'Unstaging all', () => unstageAll($)) })
                  : Button({ key: 'stage-all', label: 'Stage all', plain: true, dimColor: true, onPress: () => runAction($, 'Staging all', () => stageAll($)) })
                : Text({ children: [''] }),
            ],
          }),
          ...(list.length
            ? list.map((f) => fileRow(f, isStagedList))
            : [Text({ dimColor: true, children: [isStagedList ? '  Nothing staged' : '  No unstaged changes'] })]),
        ],
      })

    out.push(rule())
    if (!files.length) {
      out.push(Text({ color: 'green', children: ['✓ Working tree clean'] }))
    } else {
      out.push(section('STAGED', 'green', staged, true))
      out.push(section('CHANGES', 'yellow', unstaged, false))
    }

    // --- stashes ---
    out.push(rule())
    out.push(
      Button({
        key: 'toggle-stashes',
        label: (stashesOpen ? '▾ ' : '▸ ') + 'Stashes (' + stashes.length + ')',
        hotkey: 't',
        plain: true,
        onPress: () => { stashesOpen = !stashesOpen; redraw() },
      }),
    )
    if (stashesOpen) {
      if (!stashes.length) out.push(Text({ dimColor: true, children: ['  No stashes'] }))
      for (const s of stashes) {
        out.push(
          Box({
            key: 'stash-' + s.hash,
            flexDirection: 'column',
            paddingLeft: 2,
            marginTop: 1,
            children: [
              Box({
                flexDirection: 'row',
                justifyContent: 'space-between',
                columnGap: 1,
                children: [
                  Box({ flexShrink: 1, flexGrow: 1, children: [Text({ bold: true, color: 'magenta', wrap: 'wrap', children: [s.title || '(no title)'] })] }),
                  ...(confirmDrop === s.hash
                    ? [
                        Button({ key: 'confirm-drop-' + s.hash, label: 'Confirm remove', onPress: () => runAction($, 'Removing stash', () => drop($, s)) }),
                        Button({ key: 'keep-' + s.hash, label: 'Keep', dimColor: true, onPress: () => { confirmDrop = ''; redraw() } }),
                      ]
                    : [
                        Button({ key: 'restore-' + s.hash, label: 'Restore', onPress: () => runAction($, 'Restoring stash', () => restore($, s)) }),
                        Button({ key: 'drop-' + s.hash, label: 'Remove', dimColor: true, onPress: () => { confirmDrop = s.hash; redraw() } }),
                      ]),
                ],
              }),
              ...(narrow
                ? []
                : [Text({ dimColor: true, wrap: 'truncate-end', children: [s.ref + ' · ' + s.hash + ' · ' + s.when + (s.branch ? ' · ' + s.branch : '')] })]),
            ],
          }),
        )
      }
    }

    // --- legend ---
    if (!narrow) {
      out.push(rule())
      out.push(
        Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          columnGap: 2,
          children: ['added', 'modified', 'deleted', 'renamed', 'conflict'].map((k) =>
            Text({ children: [Text({ color: KIND[k].color, bold: true, children: [KIND[k].glyph + ' '] }), Text({ dimColor: true, children: [KIND[k].label] })] }),
          ),
        }),
      )
      if (files.length) out.push(Text({ dimColor: true, wrap: 'wrap', children: ['Double-click a file, or Enter on it, to open it'] }))
    }

    return Box({ flexDirection: 'column', children: out })
  })
}
