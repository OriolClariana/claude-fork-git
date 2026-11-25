# claude-fork-git-pane

A Fork-style git panel for Claude Code Desktop: changes, commit graph, submodules, stashes and AI commit messages, without leaving the app. The terminal keeps the original text view.

![Changes tab](docs/screenshots/01-changes.png)

Based on [netgfx/claude-git-mod](https://github.com/netgfx/claude-git-mod) (MIT). The git logic, the AI commit messages and the terminal view come from that project. This fork adds the Desktop view.

## Features

- **Header**: a glowing status orb (green clean, amber changes, red behind, spinning ring while busy), the branch, the branch it came from, upstream, and four tiles: Staged, Changes, Ahead, Behind.
- **Toolbar**: Fetch, Pull (fast-forward only), Push, Branch search and checkout, Stash, Refresh and Close, in one wrapping row.
- **Changes tab**: Staged and Changes lists with a status badge per file. Click a file to open its diff inline, with a Close diff button at both ends. Stage, Unstage, Discard (with confirmation) and Open in your editor.
- **Commit box**: a 3-line Summary, a 10-line Body and **Write message**, which asks a model to draft the message from the staged diff.
- **History tab**: commit graph drawn in SVG (lanes, merges, branch and tag labels, pulsing HEAD). Click a commit to see its message, files and the diff of each file. Loads 100 commits at a time.
- **Submodules tab**: list with state. Enter a submodule and every git call moves into it. A breadcrumb goes back.
- **Stashes tab**: list with Restore and Remove (with confirmation).
- **Clean state**: breathing rings when the working tree is clean. Animations stop when the system asks for reduced motion.
- A small widget form (branch and change count) when the pane is minimized.

The panel refreshes every 3 seconds while open, and after Claude runs a shell or edit tool.

## Install

```
/plugin marketplace add OriolClariana/claude-fork-git-pane
/plugin install fork-git-pane@fork-git-pane-mod
```

If your organization blocks marketplaces, clone the repo and add this to `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-fork-git-pane",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  }
}
```

## Usage

- `/git` opens the panel. It also opens by itself when the session folder is a git repository.
- `/git-close` closes it. The ✕ button in the toolbar does the same.

## Safety

- Every git call runs by argument list, with no shell, and with the repository's hooks turned off. `pre-commit` and `commit-msg` hooks do **not** run for commits made from the panel.
- Pull is `--ff-only`. There is no merge, rebase, reset or force push.
- Discard and Remove stash ask for a second press. Discard cannot be undone.
- `GIT_TERMINAL_PROMPT=0`: if git needs credentials, it fails at once instead of hanging. A credential manager or SSH agent still works.

## Known limits

- The pane width is a request (140 columns). A width you drag wins, and on a narrow pane the toolbar wraps.
- Buttons cannot hold SVG, so file and toolbar buttons use text and emoji icons.
- There is no floating window: the mod API only has dock, inline and widget panes.
- If Desktop does not let you close the last pane, `/git-close` and ✕ cannot either.
- Graph lanes past 8 are drawn on the last lane.

## Develop

```
claude plugin validate .
claude plugin test .
```

Pushing to `main` with a new `version` in `.claude-plugin/plugin.json` creates a GitHub release automatically.

## Author

Oriol Marc Clariana Justes, on top of the work of Michael Dobekidis.

## License

MIT, see [LICENSE](LICENSE).
