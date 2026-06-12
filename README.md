# Editor Settings Sync

Interactive synchronization wizard for VS Code-like editors.

It detects installed editors, collects local snapshots, compares settings/extensions/profiles, and lets you choose sync actions from a terminal UI.

## Supported Editors

- Visual Studio Code
- Cursor
- Antigravity IDE
- Devin, formerly Windsurf

`windsurf` is still accepted as a compatibility alias for `devin`, but new runtime snapshots are written under `snapshots/devin`.

## Requirements

- Node.js 18 or newer
- macOS, Linux, or Windows
- Optional editor CLI commands for extension install/uninstall actions

The project has no npm dependencies.

## Quick Start

macOS / Linux:

```sh
./sync.sh
```

Windows (Command Prompt or PowerShell):

```bat
sync.bat
```

You can also run `node scripts/sync.js` directly on any platform.

The interactive UI supports:

- `Up` / `Down` to move through menus
- `Enter` to select
- `q` to exit the current menu

In a real terminal, the wizard uses an alternate fullscreen buffer and redraws the current screen, so old menus and prompts do not stay in the terminal output. Use `--no-fullscreen` for append-only debug output.

## Commands

macOS / Linux:

```sh
./sync.sh --detect
./sync.sh --collect
./sync.sh --analyze vscode cursor
./sync.sh --analyze vscode devin
./sync.sh --prune-orphan-profiles cursor --yes
```

Windows:

```bat
sync.bat --detect
sync.bat --collect
sync.bat --analyze vscode cursor
sync.bat --analyze vscode devin
sync.bat --prune-orphan-profiles cursor --yes
```

`--collect` creates local runtime snapshots under `snapshots/`. These files are ignored by git because they may contain local paths and private settings.

## What It Syncs

The collector copies only safe VS Code-style user data into ignored snapshots:

- `settings.json`
- `keybindings.json`
- `snippets/`
- `mcp.json`
- `chatLanguageModels.json`
- supported profile settings and extension manifests

It skips volatile state databases, history, workspace storage, caches, logs, and session data.

Profiles are collected and copied only for editors that support VS Code-style user profiles. Antigravity IDE and Devin are treated as profile-less editors, so `User/profiles` is ignored for them and will not be recreated during sync.

## Extension Diff

Extension differences are shown by scope:

- `Default` for global extensions
- named profiles for editors that support profiles

Status colors in an interactive terminal:

- red: extension is missing in the target editor
- green: required fork patch (`patch for ...`; not counted as extra)
- orange: target has a different or older version
- cyan: extension is replaced by an editor alias (`replaced by ...`)
- blue: extension is ignored because it is native to a specific editor

VS Code ↔ Cursor ↔ Devin aliases (shown as `replaced by ...` with both versions; not reinstalled):

- `ms-python.vscode-pylance` ↔ `anysphere.cursorpyright` ↔ `codeium.windsurfpyright`
- `ms-vscode-remote.remote-containers` ↔ `anysphere.remote-containers`
- `ms-vscode-remote.remote-ssh` ↔ `anysphere.remote-ssh`

When installing aliases on Cursor, the wizard uses the VS Code extension ID and Cursor maps it to its replacement.

Fork-only extension patches (shown in green as `patch for ...`; installed with missing extensions in fork targets, never in VS Code):

- `embedd-team.cpptools-proxy-patcher` when `ms-vscode.cpptools` is present

For profile-aware editors, the wizard only **reports** differences in VS Code's `Apply Extension to all Profiles`
flag (`isApplicationScoped`). It does not write `extensions.json` automatically: doing that while the editor is
open can leave only global extensions visible and wipe per-profile extension lists. Set the flag manually in the
Extensions view instead.

Cross-editor profile sync matches profiles **by name**, not by internal profile folder id. VS Code and Cursor
assign different ids to the same named profile; copying profile folders blindly creates orphan directories under
`User/profiles/`. The dashboard shows them as `+N orphan`.

Settings/profile sync copies only `settings.json`, `keybindings.json`, snippets, MCP, and related profile files.
It never overwrites per-profile `extensions.json`. Profile folders are merged in place instead of being deleted
first.

VS Code may show one more registered profile than Cursor when it has the built-in **Agents** profile
(`builtin/agents`). The dashboard counts user profiles separately and shows built-in profiles as `(+N builtin)`.

Close the editor before syncing settings or extensions. Installing extensions via CLI while the editor is open can
still corrupt per-profile extension state.

Remove orphan profile folders with the interactive menu action **Remove orphan profile folders** or:

```sh
./sync.sh --prune-orphan-profiles cursor
./sync.sh --prune-orphan-profiles cursor --yes
```

Omit the editor id to scan all profile-aware editors. The command only deletes profile directories that are absent
from `globalStorage/storage.json`, backs them up under `backups/`, and should be run with the editor closed.

Built-in editor-native ignore list:

- Visual Studio Code: `ms-vscode.cpp-devtools`, `ms-dotnettools.csdevkit`, `ms-dotnettools.csharp`

## Extension Sync Modes

The wizard supports several extension sync modes:

- install missing extensions only
- install missing extensions and update older target versions
- full sync while keeping target-only extensions
- full sync and remove target-only extensions

If an editor CLI cannot install an extension directly, the wizard can try a VSIX download fallback. Downloaded VSIX files are cached under `vsix_cache/`, which is ignored by git.

## Generated Files

Generated files are ignored by git:

- `snapshots/`
- `backups/`
- `logs/`
- `vsix_cache/`
- `*.log`

When applying settings from one editor to another, the wizard creates a timestamped backup under `backups/` before writing to the target editor.

## Project Layout

- `scripts/sync.js` - main cross-platform sync wizard
- `sync.sh` - launcher for macOS and Linux
- `sync.bat` - launcher for Windows

There is intentionally no user-maintained editor config in the repository. Discovery uses built-in platform path candidates and CLI lookup. That discovery layer can grow into a maintained path database for VS Code-like editors.
