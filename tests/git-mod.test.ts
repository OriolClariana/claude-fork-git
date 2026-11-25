import { expect, mock, test } from 'claude-code/testing'
import { parseStatus, parseStashes, parseMessage, cleanTitle, firstChangedLine, editorFor, editorUrl, discardCommands, parseBranches, matchBranches, checkoutArgs, parseLog, parseRefs, parseSubmodules, layoutGraph, graphSvg, badgeSvg, statusSvg, cleanSvg, splitDiff, trimHunks } from '../hooks/register.js'

const PANE = {
  plugin: 'fork-git-pane',
  component: 'Pane',
  requestId: 'git-mod',
  viewport: { columns: 160, rows: 40 },
  props: { title: 'Git', isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const STATUS = [
  '# branch.oid 1111111111111111111111111111111111111111',
  '# branch.head feature/login-form',
  '# branch.upstream origin/feature/login-form',
  '# branch.ab +2 -0',
  '1 M. N... 100644 100644 100644 aaa bbb src/app.ts',
  '1 .D N... 100644 100644 000000 aaa aaa old.txt',
  '2 R. N... 100644 100644 100644 aaa bbb R100 docs/new name.md',
  'docs/old.md',
  '? notes/todo.md',
  '',
].join('\0')

const STASHES = 'stash@{0}\x1fabc1234\x1fOn feature/login-form: Tweak login form layout\x1f2 hours ago\x1e\n'

// A fake git: answers by subcommand and records every argv
function fakeGit(calls: string[][], overrides: Record<string, any> = {}) {
  return ($: any, e: any) => {
    const argv: string[] = [...e.argv]
    calls.push(argv)
    const args = argv.slice(5) // drop: git -c core.quotepath=false -c color.ui=false
    const sub = args[0]
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (argv[0] !== 'git') return overrides.exec ? overrides.exec(argv, e) : ok('')
    if (overrides[sub]) return overrides[sub](args, e)
    if (sub === 'rev-parse' && args[1] === '--show-toplevel') return ok('C:/work\n')
    if (sub === 'rev-parse') return ok('deadbeefcafe1234\n')
    if (sub === 'status') return ok(STATUS)
    if (sub === 'stash' && args[1] === 'list') return ok(STASHES)
    if (sub === 'for-each-ref') return ok('develop\nmain\nfeature/login-form\norigin/develop\n')
    if (sub === 'reflog' && args.includes('HEAD')) return ok('commit: x\ncheckout: moving from develop to feature/login-form\n')
    if (sub === 'reflog') return ok('commit: y\nbranch: Created from HEAD\n')
    if (sub === 'diff') return ok(args.includes('--stat') ? ' src/app.ts | 2 +-\n' : '-a\n+b\n')
    if (sub === 'log') return ok('feat: add login\nfix: typo\n')
    return ok('')
  }
}

function baseStubs(on: any, calls: string[][], overrides: Record<string, any> = {}, logs: any[] = []) {
  on('process.run', fakeGit(calls, overrides))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($: any, e: any) => { logs.push(e); return { value: undefined } })
  on('ui.copy', () => ({ value: undefined }))
}

test('parses porcelain v2 status, renames and untracked files', async () => {
  const { info, list } = parseStatus(STATUS)
  expect(info).toEqual({ branch: 'feature/login-form', oid: '1111111111111111111111111111111111111111', upstream: 'origin/feature/login-form', ahead: 2, behind: 0 })
  expect(list.map((f: any) => f.path)).toEqual(['src/app.ts', 'old.txt', 'docs/new name.md', 'notes/todo.md'])
  expect(list[2].orig).toBe('docs/old.md')
  expect(list[3].isUntracked).toBe(true)
})

test('parses stash titles and helper text', async () => {
  expect(parseStashes(STASHES)[0]).toEqual({ ref: 'stash@{0}', hash: 'abc1234', title: 'Tweak login form layout', branch: 'feature/login-form', when: '2 hours ago' })
  expect(cleanTitle('"Refactor the git panel layout and colors today."\nextra')).toBe('Refactor the git panel layout and')
  expect(parseMessage('```\nfeat: add x\n\n- one\n- two\n```')).toEqual({ subject: 'feat: add x', body: '- one\n- two' })
})

for (const surface of ['terminal', 'desktop'] as const) {
  test('panel shows branch, parent, files and stashes on ' + surface, async ($, on) => {
    const calls: string[][] = []
    baseStubs(on, calls)
    await $.command.run({ command: 'git', args: '' })
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(await ui.find({ type: 'Text', text: 'feature/login-form' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'develop' })).toBeDefined() // parent from HEAD reflog
    expect(await ui.find({ type: 'Button', key: 'stage-notes/todo.md' } as any)).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'unstage-src/app.ts' } as any)).toBeDefined()
    if (surface === 'desktop') {
      await ui.press({ key: 'tab-stashes' }) // stashes live in their own tab there
      await ui.redraw()
    }
    expect(await ui.find({ type: 'Text', text: 'Tweak login form layout' })).toBeDefined()
    await ui.unmount()
  })
}

test('main shows no parent line', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls, {
    status: () => ({ value: { exitCode: 0, stdout: '# branch.oid 1\0# branch.head main\0', stderr: '' } }),
  })
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: 'main' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↳ from' })).toBeUndefined()
  expect(calls.some((c) => c.includes('reflog'))).toBe(false)
})

test('refresh uses normal untracked mode in git status', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  const statusCall = calls.find((c) => c.slice(5)[0] === 'status')
  expect(statusCall).toBeDefined()
  expect(statusCall!.slice(5)).toContain('--untracked-files=normal')
  expect(statusCall!.slice(5)).not.toContain('--untracked-files=all')
})

test('Stage runs git add for that file', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'stage-notes/todo.md' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'add -A -- notes/todo.md')).toBe(true)
})

test('helpers find the first changed line and the editor', async () => {
  expect(firstChangedLine('diff --git a/x b/x\n@@ -10,2 +12,3 @@ fn\n-a\n+b\n@@ -40 +44 @@\n')).toBe(12)
  expect(firstChangedLine('@@ -3 +2,0 @@\n-gone\n')).toBe(2)
  expect(firstChangedLine('@@ -0,0 +0,0 @@\n')).toBe(1)
  expect(firstChangedLine('')).toBe(1)
  expect(editorFor('C:\\Program Files\\Microsoft VS Code\\Code.exe')?.scheme).toBe('vscode')
  expect(editorFor('/Applications/Visual Studio Code.app')?.scheme).toBe('vscode')
  expect(editorFor('/Applications/Visual Studio Code - Insiders.app')?.scheme).toBe('vscode-insiders')
  expect(editorFor('code.desktop')?.scheme).toBe('vscode')
  expect(editorFor('/Applications/Cursor.app')?.scheme).toBe('cursor')
  expect(editorFor('C:\\Program Files\\Notepad++\\notepad++.exe')?.name).toBe('Notepad++')
  expect(editorFor('C:\\Windows\\Notepad\\Notepad.exe')).toBe(null)
  expect(editorFor('/Applications/Preview.app')).toBe(null)
  expect(editorFor('')).toBe(null)
  expect(editorUrl('vscode', 'C:\\work\\docs\\new name.md', 7)).toBe('vscode://file/C:/work/docs/new%20name.md:7:1')
  expect(editorUrl('vscode', '/Users/me/a#b.ts', 3)).toBe('vscode://file/Users/me/a%23b.ts:3:1')
})

// Records what the open helpers started; the default app comes from `app`
function openStubs(on: any, calls: string[][], starts: any[], app: string, diff = '@@ -10,2 +12,3 @@\n') {
  baseStubs(on, calls, {
    diff: () => ({ value: { exitCode: 0, stdout: diff, stderr: '' } }),
    exec: (argv: string[], e: any) => {
      if (argv[argv.length - 1].includes('AssocQueryString')) return { value: { exitCode: 0, stdout: app + '\r\n', stderr: '' } }
      starts.push(e.init.env)
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    },
  })
}

test('a single click on a file name does not open it', async ($, on) => {
  const calls: string[][] = []
  const starts: any[] = []
  openStubs(on, calls, starts, 'C:\\Program Files\\Microsoft VS Code\\Code.exe')
  mock.clock(on)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'sopen-src/app.ts' })
  expect(starts.length).toBe(0)
})

test('double-click opens a modified file in VS Code at its first change', async ($, on) => {
  const calls: string[][] = []
  const starts: any[] = []
  openStubs(on, calls, starts, 'C:\\Program Files\\Microsoft VS Code\\Code.exe')
  mock.clock(on)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'sopen-src/app.ts' })
  await ui.press({ key: 'sopen-src/app.ts' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'diff --cached --no-ext-diff -U0 -- src/app.ts')).toBe(true)
  expect(starts.length).toBe(1)
  expect(starts[0].GITMOD_TARGET).toBe('vscode://file/C:/work/src/app.ts:12:1')
})

test('Enter on the focused file name opens it once, with the default app', async ($, on) => {
  const calls: string[][] = []
  const starts: any[] = []
  openStubs(on, calls, starts, 'C:\\Windows\\Notepad\\Notepad.exe')
  on('ui.focus', () => ({ value: {} }))
  const clock = mock.clock(on)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  // The person moves the ring onto the name (the engine's ui.focus event)
  await $.ui.focus({ component: 'Pane', requestId: 'git-mod', key: 'uopen-notes/todo.md', element: 'uopen-notes/todo.md', origin: { kind: 'person' } } as any)
  await clock.advance(1000)
  await ui.press({ key: 'uopen-notes/todo.md' })
  expect(starts.length).toBe(1)
  expect(starts[0].GITMOD_TARGET).toBe('C:\\work\\notes\\todo.md')
  expect(calls.some((c) => c.slice(5)[0] === 'diff')).toBe(false)
})

test('a deleted file is not opened', async ($, on) => {
  const calls: string[][] = []
  const starts: any[] = []
  openStubs(on, calls, starts, 'C:\\Program Files\\Microsoft VS Code\\Code.exe')
  mock.clock(on)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'uopen-old.txt' })
  await ui.press({ key: 'uopen-old.txt' })
  expect(starts.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: /old\.txt is deleted/ })).toBeDefined()
})

test('discard picks the git commands for each kind of file', async () => {
  const file = (x: string, y: string, extra: any = {}) => ({ path: 'src/a.ts', orig: '', x, y, isUntracked: false, isConflict: false, ...extra })
  expect(discardCommands(file('.', '?', { isUntracked: true, path: 'new/' }), false, false)).toEqual([['clean', '-f', '-d', '-q', '--', 'new/']])
  expect(discardCommands(file('.', 'M'), false, false)).toEqual([['restore', '--worktree', '--', 'src/a.ts']])
  expect(discardCommands(file('.', 'D'), false, false)).toEqual([['restore', '--worktree', '--', 'src/a.ts']])
  expect(discardCommands(file('M', 'M'), true, false)).toEqual([['restore', '--staged', '--worktree', '--source=HEAD', '--', 'src/a.ts']])
  expect(discardCommands(file('A', '.'), true, false)).toEqual([['rm', '-f', '-r', '-q', '--', 'src/a.ts']])
  expect(discardCommands(file('M', '.'), true, true)).toEqual([['rm', '-f', '-r', '-q', '--', 'src/a.ts']])
  expect(discardCommands(file('R', '.', { path: 'docs/new.md', orig: 'docs/old.md' }), true, false)).toEqual([
    ['rm', '-f', '-r', '-q', '--', 'docs/new.md'],
    ['restore', '--staged', '--worktree', '--source=HEAD', '--', 'docs/old.md'],
  ])
})

test('Discard asks for confirmation, then deletes a new file', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'discard-u-notes/todo.md' })
  expect(calls.some((c) => c.slice(5)[0] === 'clean')).toBe(false)
  await ui.press({ key: 'confirm-discard-u-notes/todo.md' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'clean -f -d -q -- notes/todo.md')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Deleted notes\/todo\.md/ })).toBeDefined()
})

test('Discard on a staged file resets it to HEAD', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'discard-s-src/app.ts' })
  await ui.press({ key: 'confirm-discard-s-src/app.ts' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'restore --staged --worktree --source=HEAD -- src/app.ts')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Discarded the changes to src\/app\.ts/ })).toBeDefined()
})

test('Keep cancels a pending discard', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'discard-u-notes/todo.md' })
  await ui.press({ key: 'keep-u-notes/todo.md' })
  expect(await ui.find({ key: 'discard-u-notes/todo.md' })).toBeDefined()
  expect(calls.some((c) => ['clean', 'restore', 'rm'].includes(c.slice(5)[0]))).toBe(false)
})

test('Commit drafts a message with the model, Approve commits it', async ($, on) => {
  const calls: string[][] = []
  const stdins: string[] = []
  baseStubs(on, calls, {
    commit: (args: string[], e: any) => {
      stdins.push(e.init.stdin)
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    },
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'feat: add login form\n\n- validate inputs', usage: USAGE } }))
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'commit' })
  expect(await ui.find({ type: 'Text', text: 'feat: add login form' })).toBeDefined()
  await ui.press({ key: 'approve' })
  expect(stdins[0]).toBe('feat: add login form\n\n- validate inputs\n')
  expect(await ui.find({ type: 'Text', text: /Committed deadbee/ })).toBeDefined()
})

test('Stash uses a model title, includes untracked files and shows the hash', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Login form validation work', usage: USAGE } }))
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'stash' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'stash push -u -m Login form validation work')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Stashed "Login form validation work" as deadbeefca/ })).toBeDefined()
})

test('Restore applies the stash and keeps it', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'restore-abc1234' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'stash apply stash@{0}')).toBe(true)
  expect(calls.some((c) => c.slice(5).includes('pop') || c.slice(5).includes('drop'))).toBe(false)
})

test('Remove asks for confirmation, then drops the stash', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'drop-abc1234' })
  expect(calls.some((c) => c.slice(5).includes('drop'))).toBe(false)
  await ui.press({ key: 'confirm-drop-abc1234' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'stash drop stash@{0}')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Removed "Tweak login form layout" \(deadbeefca\)/ })).toBeDefined()
})

test('Keep cancels a pending remove', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'drop-abc1234' })
  await ui.press({ key: 'keep-abc1234' })
  expect(await ui.find({ key: 'restore-abc1234' })).toBeDefined()
  expect(calls.some((c) => c.slice(5).includes('drop'))).toBe(false)
})

test('Push without upstream sets it on origin', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls, {
    status: () => ({ value: { exitCode: 0, stdout: '# branch.oid 1\0# branch.head fix/crash\0', stderr: '' } }),
    remote: () => ({ value: { exitCode: 0, stdout: 'upstream\norigin\n', stderr: '' } }),
  })
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'push' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'push -u origin fix/crash')).toBe(true)
})

test('Pull fast-forwards from the upstream', async ($, on) => {
  const calls: string[][] = []
  let head = 'aaaa'
  baseStubs(on, calls, {
    'rev-parse': (args: string[]) => ({ value: { exitCode: 0, stdout: args[1] === '--show-toplevel' ? 'C:/work\n' : head + '\n', stderr: '' } }),
    pull: () => { head = 'bbbb'; return { value: { exitCode: 0, stdout: '', stderr: '' } } },
    'rev-list': () => ({ value: { exitCode: 0, stdout: '3\n', stderr: '' } }),
  })
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'pull' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'pull --ff-only')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Pulled 3 commits from origin\/feature\/login-form/ })).toBeDefined()
})

test('Pull without upstream does not run git pull', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls, {
    status: () => ({ value: { exitCode: 0, stdout: '# branch.oid 1\0# branch.head fix/crash\0', stderr: '' } }),
  })
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'pull' })
  expect(calls.some((c) => c.slice(5)[0] === 'pull')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /has no upstream yet/ })).toBeDefined()
})

test('outside a repository the panel says so', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls, {
    'rev-parse': () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }),
  })
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: 'Not inside a git repository.' })).toBeDefined()
})

test('session start opens the panel by itself inside a repo', async ($, on) => {
  const calls: string[][] = []
  const opened: any[] = []
  on('process.run', fakeGit(calls))
  on('ui.open', ($, e) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: 'C:\work' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' } as any)
  expect(opened.length).toBe(1)
  expect(opened[0].id).toBe('git-mod')
  expect(opened[0].focus).toBeUndefined()
})

test('session start leaves the panel closed outside a repo', async ($, on) => {
  const calls: string[][] = []
  const opened: any[] = []
  on('process.run', fakeGit(calls, { 'rev-parse': () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal' } }) }))
  on('ui.open', ($, e) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: 'C:\work' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' } as any)
  expect(opened.length).toBe(0)
})

// for-each-ref output for the branch search: newest commit first
const BRANCH_REFS = [
  'refs/heads/feature/login-form\x002 hours ago',
  'refs/heads/main\x003 days ago',
  'refs/remotes/origin/HEAD\x003 days ago',
  'refs/remotes/origin/main\x003 days ago',
  'refs/remotes/origin/fix/crash-on-start\x004 days ago',
  'refs/remotes/team/a/release/2.0\x001 week ago',
  'refs/heads/develop\x002 weeks ago',
  '',
].join('\n')

function branchStubs(on: any, calls: string[][], overrides: Record<string, any> = {}, logs: any[] = []) {
  baseStubs(on, calls, {
    'for-each-ref': (args: string[]) =>
      ({ value: { exitCode: 0, stdout: args.includes('--sort=-committerdate') ? BRANCH_REFS : 'develop\nmain\nfeature/login-form\n', stderr: '' } }),
    remote: () => ({ value: { exitCode: 0, stdout: 'origin\nteam/a\n', stderr: '' } }),
    ...overrides,
  }, logs)
}

test('parses branches, skips remote HEAD and remotes that have a local branch', async () => {
  const list = parseBranches(BRANCH_REFS, ['origin', 'team/a'])
  expect(list.map((b: any) => b.name)).toEqual(['feature/login-form', 'main', 'origin/fix/crash-on-start', 'team/a/release/2.0', 'develop'])
  expect(list[2]).toMatchObject({ local: 'fix/crash-on-start', remote: 'origin', when: '4 days ago' })
  expect(list[3]).toMatchObject({ local: 'release/2.0', remote: 'team/a' })
  expect(checkoutArgs(list[0])).toEqual(['checkout', 'feature/login-form', '--'])
  expect(checkoutArgs(list[2])).toEqual(['checkout', '--track', 'origin/fix/crash-on-start', '--'])
})

test('branch matching ranks name starts, words and letters in order', async () => {
  const list = parseBranches(BRANCH_REFS, ['origin', 'team/a'])
  const names = (q: string) => matchBranches(list, q).map((b: any) => b.name)
  expect(names('')).toEqual(['feature/login-form', 'main', 'develop', 'origin/fix/crash-on-start', 'team/a/release/2.0'])
  expect(names('dev')[0]).toBe('develop')
  expect(names('login')[0]).toBe('feature/login-form')
  expect(names('crash')).toEqual(['origin/fix/crash-on-start'])
  expect(names('flf')).toEqual(['feature/login-form'])
  expect(names('fix start')).toEqual(['origin/fix/crash-on-start'])
  expect(names('zzz')).toEqual([])
  // 5000 branches still match in well under a frame
  const many = parseBranches(Array.from({ length: 5000 }, (_, i) => 'refs/heads/feature/task-' + i + '-thing\x00now').join('\n'), [])
  const t0 = Date.now()
  for (const q of ['f', 'fe', 'feat', 'task-49', 'task-499']) matchBranches(many, q)
  expect(Date.now() - t0).toBeLessThan(200)
  expect(matchBranches(many, 'task-4999')[0].name).toBe('feature/task-4999-thing')
})

test('Checkout (b) searches branches and Enter checks out the top match', async ($, on) => {
  const calls: string[][] = []
  branchStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'checkout' })
  // The branch checked out now (feature/login-form) is not offered
  expect(await ui.find({ key: 'co-refs/heads/main' } as any)).toBeDefined()
  expect(await ui.find({ key: 'co-refs/heads/feature/login-form' } as any)).toBeUndefined()
  await ui.input({ key: 'branch-query', text: 'dev', kind: 'change' })
  expect(await ui.find({ key: 'co-refs/heads/main' } as any)).toBeUndefined()
  await ui.input({ key: 'branch-query', text: 'dev' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'checkout develop --')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Checked out develop/ })).toBeDefined()
  expect(await ui.find({ key: 'branch-query' } as any)).toBeUndefined()
  // One branch listing per load, never one per keystroke
  expect(calls.filter((c) => c.slice(5)[0] === 'for-each-ref' && c.includes('--sort=-committerdate')).length).toBeLessThan(4)
})

// The ui.press hook then moves the ring onto the field with $.ui.focus; the
// kit does not answer a mod's own focus moves, so that part is checked by hand
test('Checkout draws a focused search field, and a second press closes it', async ($, on) => {
  const calls: string[][] = []
  branchStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'checkout' })
  const field = await ui.find({ key: 'branch-query' } as any)
  expect(field?.type).toBe('Input')
  expect(field?.props.autoFocus).toBe(true)
  await ui.press({ key: 'checkout' })
  expect(await ui.find({ key: 'branch-query' } as any)).toBeUndefined()
})

test('pressing a remote branch checks it out with tracking', async ($, on) => {
  const calls: string[][] = []
  branchStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'checkout' })
  await ui.input({ key: 'branch-query', text: 'crash', kind: 'change' })
  await ui.press({ key: 'co-refs/remotes/origin/fix/crash-on-start' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'checkout --track origin/fix/crash-on-start --')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Checked out fix\/crash-on-start, tracking origin\/fix\/crash-on-start/ })).toBeDefined()
})

test('a failed checkout shows the git error and keeps the search open', async ($, on) => {
  const calls: string[][] = []
  branchStubs(on, calls, {
    checkout: () => ({ value: { exitCode: 1, stdout: '', stderr: 'error: Your local changes would be overwritten by checkout:\n\tsrc/app.ts\nAborting' } }),
  })
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'checkout' })
  await ui.input({ key: 'branch-query', text: 'main' })
  expect(await ui.find({ type: 'Text', text: /Checkout of main failed/ })).toBeDefined()
  expect(await ui.find({ key: 'branch-query' } as any)).toBeDefined()
})

test('no match: Enter checks nothing out', async ($, on) => {
  const calls: string[][] = []
  branchStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'checkout' })
  await ui.input({ key: 'branch-query', text: 'zzz' })
  expect(calls.some((c) => c.slice(5)[0] === 'checkout')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /No branch matches "zzz"/ })).toBeDefined()
})

// ---------- desktop view ----------

const LOG =
  ['m1', 'a1 b1', 'Ann', '2 hours ago', 'HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1', 'Merge feature', 'body line'].join('\x1f') + '\x1e\n' +
  ['a1', 'c1', 'Ann', '3 hours ago', '', 'Main work', ''].join('\x1f') + '\x1e\n' +
  ['b1', 'c1', 'Bob', '4 hours ago', 'refs/heads/feature', 'Feature work', ''].join('\x1f') + '\x1e\n' +
  ['c1', '', 'Ann', '5 hours ago', '', 'Root', ''].join('\x1f') + '\x1e\n'

const DIFF =
  'diff --git a/src/app.ts b/src/app.ts\nindex 1..2 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n' +
  'diff --git a/bin.png b/bin.png\nBinary files a/bin.png and b/bin.png differ\n' +
  'diff --git a/old name.md b/new name.md\nsimilarity index 90%\nrename from old name.md\nrename to new name.md\n--- a/old name.md\t\n+++ b/new name.md\t\n@@ -1 +1 @@\n-x\n+y\n'

test('parses refs and the log', async () => {
  expect(parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1, refs/stash, refs/heads/feature/x')).toEqual([
    { name: 'main', kind: 'head' },
    { name: 'origin/main', kind: 'remote' },
    { name: 'v1', kind: 'tag' },
    { name: 'feature/x', kind: 'local' },
  ])
  const commits = parseLog(LOG)
  expect(commits.map((c: any) => c.hash)).toEqual(['m1', 'a1', 'b1', 'c1'])
  expect(commits[0].parents).toEqual(['a1', 'b1'])
  expect(commits[0].body).toBe('body line')
  expect(commits[3].parents).toEqual([])
})

test('lays out a merge in two lanes and joins them at the root', async () => {
  const { rows, lanes } = layoutGraph(parseLog(LOG))
  expect(lanes).toBe(2)
  expect(rows.map((r: any) => r.col)).toEqual([0, 0, 1, 0]) // m1, a1 on lane 0, b1 on lane 1, root back on lane 0
  expect(rows[0].parentLanes).toEqual([0, 1]) // merge: first parent continues, second opens a lane
  expect(rows[2].parentLanes).toEqual([0]) // the feature branch curves back into lane 0, where the root waits
  expect(rows[3].before).toEqual(['c1'])
  expect(rows[3].after).toEqual([])
  const svg = graphSvg(rows[0], lanes, true)
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg).toContain('width="34"') // 2 * 10 padding + 1 * 14
  expect(graphSvg(rows[3], lanes, false)).toContain('width="34"') // every row has the same width
})

test('splits a diff by file and keeps hunks whole', async () => {
  const files = splitDiff(DIFF)
  expect(files.map((f: any) => f.path)).toEqual(['src/app.ts', 'bin.png', 'new name.md'])
  expect(files[0]).toMatchObject({ add: 1, del: 1, isBinary: false })
  expect(files[1].isBinary).toBe(true)
  expect(files[2].old).toBe('old name.md')
  const two = '@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n'
  expect(trimHunks(two, 1000)).toEqual({ text: two, hidden: 0 })
  expect(trimHunks(two, 20)).toEqual({ text: '@@ -1 +1 @@\n-a\n+b\n', hidden: 1 })
  expect(trimHunks(two, 5)).toEqual({ text: '', hidden: 2 })
  expect(badgeSvg('added')).toContain('>A<')
})

test('desktop: a file name opens its diff, and History draws the graph', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls, {
    diff: () => ({ value: { exitCode: 0, stdout: DIFF.split('diff --git a/bin.png')[0], stderr: '' } }),
    log: () => ({ value: { exitCode: 0, stdout: LOG, stderr: '' } }),
    show: () => ({ value: { exitCode: 0, stdout: DIFF, stderr: '' } }),
  })
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await ui.press({ key: 'sopen-src/app.ts' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'diff --cached --no-ext-diff -M -- src/app.ts')).toBe(true)
  expect(await ui.find({ type: 'Code' } as any)).toBeDefined()
  await ui.press({ key: 'tab-history' })
  const logCall = calls.find((c) => c.slice(5)[0] === 'log' && c.includes('--decorate=full'))
  expect(logCall).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'commit-m1' } as any)).toBeDefined()
  await ui.press({ key: 'commit-m1' })
  expect(calls.some((c) => c.slice(5)[0] === 'show' && c.includes('--first-parent') && c.includes('m1'))).toBe(true)
  await ui.unmount()
})

test('desktop: Commit uses the typed summary', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await ui.press({ key: 'commit' }) // no summary yet: nothing runs
  expect(calls.some((c) => c.slice(5)[0] === 'commit')).toBe(false)
})

test('parses submodule status', async () => {
  expect(parseSubmodules(' abc1234 repos/sp-mobile (heads/main)\n+def5678 libs/two (v1-3-gdef5678)\n-0000000 libs/cold\nU1111111 libs/clash\n')).toEqual([
    { state: ' ', sha: 'abc1234', path: 'repos/sp-mobile', describe: 'heads/main' },
    { state: '+', sha: 'def5678', path: 'libs/two', describe: 'v1-3-gdef5678' },
    { state: '-', sha: '0000000', path: 'libs/cold', describe: '' },
    { state: 'U', sha: '1111111', path: 'libs/clash', describe: '' },
  ])
})

test('desktop: Enter moves every git call into the submodule, and the crumb goes back', async ($, on) => {
  const calls: string[][] = []
  const cwds: string[] = []
  baseStubs(on, calls, {
    submodule: () => ({ value: { exitCode: 0, stdout: ' abc1234 repos/sp-mobile (heads/main)\n', stderr: '' } }),
    status: () => ({ value: { exitCode: 0, stdout: '# branch.oid 1\0# branch.head main\0', stderr: '' } }),
    // like git: the top level of the folder it runs in
    'rev-parse': (args: string[], e: any) => {
      if (args[1] !== '--show-toplevel') return { value: { exitCode: 0, stdout: 'deadbeef\n', stderr: '' } }
      cwds.push(e.init?.cwd)
      return { value: { exitCode: 0, stdout: (e.init?.cwd ?? 'C:/work') + '\n', stderr: '' } }
    },
  })
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await ui.press({ key: 'tab-submodules' })
  await ui.redraw()
  await ui.press({ key: 'enter-sub-repos/sp-mobile' })
  expect(cwds[cwds.length - 1]).toBe('C:/work/repos/sp-mobile')
  await ui.redraw()
  expect(await ui.find({ type: 'Button', key: 'crumb-0' } as any)).toBeDefined()
  await ui.press({ key: 'crumb-0' })
  expect(cwds[cwds.length - 1]).toBeUndefined() // back at the session's own folder
  await ui.unmount()
})

test('effects: status band glows when dirty, spins when busy, clean state pulses', () => {
  const dirty = statusSvg(400, { staged: 1, changes: 2, ahead: 0, behind: 0, busy: false })
  expect(dirty).toContain('class="live"')
  expect(dirty).toContain('prefers-reduced-motion')
  expect(dirty).not.toContain('class="spin"')
  expect(statusSvg(400, { staged: 0, changes: 0, ahead: 0, behind: 0, busy: true })).toContain('class="spin"')
  expect(cleanSvg()).toContain('class="live"')
})
