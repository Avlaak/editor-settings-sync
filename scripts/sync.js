#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SNAPSHOTS = path.join(ROOT, "snapshots");
const BACKUPS = path.join(ROOT, "backups");
const VSIX_CACHE = path.join(ROOT, "vsix_cache");
const SAFE_USER_ITEMS = ["settings.json", "keybindings.json", "extensions.json", "mcp.json", "chatLanguageModels.json", "snippets"];
const PROFILE_USER_ITEMS = SAFE_USER_ITEMS.filter((item) => item !== "extensions.json");
const REQUIRED_PROFILE_DIRS = ["globalStorage"];
const ANSI = {
  clearLine: "\x1b[2K",
  clearScreen: "\x1b[H\x1b[J",
  cursorColumnStart: "\x1b[1G",
  cursorHide: "\x1b[?25l",
  cursorShow: "\x1b[?25h",
  enterAlt: "\x1b[?1049h",
  exitAlt: "\x1b[?1049l",
  inverse: "\x1b[7m",
  red: "\x1b[31m",
  orange: "\x1b[33m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

const EDITOR_EXTENSION_IGNORE = {
  vscode: new Set(["ms-vscode.cpp-devtools", "ms-dotnettools.csdevkit"]),
};

// Per-editor extension IDs for the same logical extension. Use `default` when every
// target editor should install the same replacement ID (for example Antigravity IDE).
const EXTENSION_REPLACEMENTS = [
  { vscode: "ms-python.vscode-pylance", cursor: "anysphere.cursorpyright", devin: "codeium.windsurfpyright" },
  { vscode: "ms-vscode-remote.remote-containers", cursor: "anysphere.remote-containers" },
  { vscode: "ms-vscode-remote.remote-ssh", cursor: "anysphere.remote-ssh" },
  { vscode: "ms-dotnettools.csharp", default: "dotnetdev-kr-custom.csharp" },
];

const EXTENSION_PATCHES = [
  {
    requires: "ms-vscode.cpptools",
    patch: "embedd-team.cpptools-proxy-patcher",
  },
];

const EXTENSION_PATCH_BY_ID = new Map();
for (const rule of EXTENSION_PATCHES) {
  EXTENSION_PATCH_BY_ID.set(rule.patch.toLowerCase(), rule.requires.toLowerCase());
}

const EXTENSION_REPLACEMENT_BY_ID = new Map();
for (const group of EXTENSION_REPLACEMENTS) {
  for (const [key, extId] of Object.entries(group)) {
    if (key === "default" || !extId) continue;
    EXTENSION_REPLACEMENT_BY_ID.set(extId.toLowerCase(), group);
  }
  if (group.default) {
    EXTENSION_REPLACEMENT_BY_ID.set(group.default.toLowerCase(), group);
  }
}

const EDITORS = [
  {
    id: "vscode",
    name: "Visual Studio Code",
    supportsProfiles: true,
    cli: ["code"],
    dirs: {
      darwin: { user: "~/Library/Application Support/Code/User", extensions: "~/.vscode/extensions", app: "/Applications/Visual Studio Code.app" },
      linux: { user: "${XDG_CONFIG_HOME:-~/.config}/Code/User", extensions: "~/.vscode/extensions", app: "/usr/share/code" },
      win32: { user: "%APPDATA%\\Code\\User", extensions: "%USERPROFILE%\\.vscode\\extensions", app: ["%LOCALAPPDATA%\\Programs\\Microsoft VS Code", "%ProgramFiles%\\Microsoft VS Code", "%ProgramFiles(x86)%\\Microsoft VS Code"] },
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    supportsProfiles: true,
    cli: ["cursor"],
    dirs: {
      darwin: { user: "~/Library/Application Support/Cursor/User", extensions: "~/.cursor/extensions", app: "/Applications/Cursor.app" },
      linux: { user: "${XDG_CONFIG_HOME:-~/.config}/Cursor/User", extensions: "~/.cursor/extensions", app: ["/opt/Cursor", "/usr/share/cursor"] },
      win32: { user: "%APPDATA%\\Cursor\\User", extensions: "%USERPROFILE%\\.cursor\\extensions", app: ["%LOCALAPPDATA%\\Programs\\cursor", "%ProgramFiles%\\cursor"] },
    },
  },
  {
    id: "antigravity-ide",
    name: "Antigravity IDE",
    supportsProfiles: false,
    cli: ["antigravity-ide"],
    dirs: {
      darwin: { user: "~/Library/Application Support/Antigravity IDE/User", extensions: "~/.antigravity/extensions", app: "/Applications/Antigravity IDE.app" },
      linux: { user: "${XDG_CONFIG_HOME:-~/.config}/Antigravity IDE/User", extensions: "~/.antigravity/extensions", app: "/opt/Antigravity IDE" },
      win32: { user: "%APPDATA%\\Antigravity IDE\\User", extensions: "%USERPROFILE%\\.antigravity\\extensions", app: ["%LOCALAPPDATA%\\Programs\\Antigravity IDE", "%ProgramFiles%\\Antigravity IDE"] },
    },
  },
  {
    id: "devin",
    aliases: ["windsurf"],
    name: "Devin",
    supportsProfiles: false,
    cli: ["devin-desktop"],
    dirs: {
      darwin: {
        user: ["~/Library/Application Support/Devin/User", "~/Library/Application Support/Windsurf/User"],
        extensions: ["~/.devin/extensions", "~/.windsurf/extensions"],
        app: ["/Applications/Devin.app", "/Applications/Windsurf.app"],
      },
      linux: {
        user: ["${XDG_CONFIG_HOME:-~/.config}/Devin/User", "${XDG_CONFIG_HOME:-~/.config}/Windsurf/User"],
        extensions: ["~/.devin/extensions", "~/.windsurf/extensions"],
        app: ["/opt/Devin", "/opt/Windsurf"],
      },
      win32: {
        user: ["%APPDATA%\\Devin\\User", "%APPDATA%\\Windsurf\\User"],
        extensions: ["%USERPROFILE%\\.devin\\extensions", "%USERPROFILE%\\.windsurf\\extensions"],
        app: [
          "%LOCALAPPDATA%\\Programs\\Devin",
          "%LOCALAPPDATA%\\Programs\\Windsurf",
          "%ProgramFiles%\\Devin",
          "%ProgramFiles%\\Windsurf",
        ],
      },
    },
  },
  {
    id: "kiro",
    name: "Kiro",
    supportsProfiles: true,
    cli: ["kiro"],
    dirs: {
      darwin: { user: "~/Library/Application Support/Kiro/User", extensions: "~/.kiro/extensions", app: "/Applications/Kiro.app" },
      linux: { user: "${XDG_CONFIG_HOME:-~/.config}/Kiro/User", extensions: "~/.kiro/extensions", app: ["/opt/Kiro", "/usr/share/kiro"] },
      win32: { user: "%APPDATA%\\Kiro\\User", extensions: "%USERPROFILE%\\.kiro\\extensions", app: ["%LOCALAPPDATA%\\Programs\\Kiro", "%ProgramFiles%\\Kiro"] },
    },
  },
];

const FORK_EDITOR_IDS = new Set(EDITORS.map((editor) => editor.id).filter((id) => id !== "vscode"));

const argv = new Set(process.argv.slice(2));
const nonInteractive = argv.has("--yes") || argv.has("-y");
const fullscreen = !argv.has("--no-fullscreen") && process.stdin.isTTY && process.stdout.isTTY;
const useColor = !argv.has("--no-color") && process.stdout.isTTY;

function platformKey() {
  return process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
}

function expandPath(input) {
  if (!input) return "";
  let resolved = input
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/\$\{XDG_CONFIG_HOME:-~\/\.config\}/g, process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"))
    .replace(/%APPDATA%/gi, process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"))
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || os.homedir());

  if (process.platform === "win32") {
    resolved = resolved
      .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
      .replace(/%ProgramFiles%/gi, process.env.ProgramFiles || "C:\\Program Files")
      .replace(/%ProgramFiles\(x86\)%/gi, process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)");
  }
  return path.resolve(resolved);
}

function expandPaths(input) {
  return (Array.isArray(input) ? input : [input]).filter(Boolean).map(expandPath);
}

function firstExistingDir(input) {
  const paths = expandPaths(input);
  return paths.find(isDir) || paths[0] || "";
}

function firstExistingPath(input) {
  const paths = expandPaths(input);
  return paths.find(exists) || paths[0] || "";
}

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch { return false; }
}

function isDir(filePath) {
  try { return fs.statSync(filePath).isDirectory(); } catch { return false; }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function rmrf(filePath) {
  fs.rmSync(filePath, { recursive: true, force: true });
}

function copyRecursive(src, dst) {
  if (!exists(src)) return;
  ensureDir(path.dirname(dst));
  fs.cpSync(src, dst, { recursive: true, force: true });
}

function commandPath(names) {
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const name of names) {
    const candidates = process.platform === "win32" && path.extname(name)
      ? [name]
      : extensions.map((extension) => `${name}${extension}`);

    for (const dir of pathDirs) {
      for (const candidate of candidates) {
        const filePath = path.join(dir, candidate);
        try {
          fs.accessSync(filePath, fs.constants.X_OK);
          return { command: name, path: filePath };
        } catch {
          // Try the next PATH candidate.
        }
      }
    }
  }
  return { command: names[0], path: "" };
}

function detectEditors() {
  const platform = platformKey();
  return EDITORS.map((editor) => {
    const dirs = editor.dirs[platform] || editor.dirs.linux;
    const userDir = firstExistingDir(dirs.user);
    const extensionsDir = firstExistingDir(dirs.extensions);
    const cli = commandPath(editor.cli);
    const appPath = dirs.app ? firstExistingPath(dirs.app) : "";

    let cliPath = cli.path;
    let cliCommand = cli.command;

    if (!cliPath && appPath) {
      const candidates = [];
      if (platform === "darwin") {
        candidates.push(path.join(appPath, "Contents/Resources/app/bin"));
      } else if (platform === "win32") {
        candidates.push(path.join(appPath, "bin"));
        candidates.push(path.join(appPath, "resources/app/bin"));
        candidates.push(appPath);
      } else if (platform === "linux") {
        candidates.push(path.join(appPath, "bin"));
        candidates.push(appPath);
      }

      for (const candidateDir of candidates) {
        for (const name of editor.cli) {
          const filePath = path.join(candidateDir, name);
          if (exists(filePath)) {
            cliPath = filePath;
            cliCommand = filePath;
            break;
          }
        }
        if (cliPath) break;
      }
    }

    const signals = {
      userDir: isDir(userDir),
      extensionsDir: isDir(extensionsDir),
      cli: Boolean(cliPath),
      app: Boolean(appPath && exists(appPath)),
    };
    return {
      ...editor,
      userDir,
      extensionsDir,
      cliCommand,
      cliPath,
      appPath,
      signals,
      installed: Object.values(signals).some(Boolean),
    };
  }).filter((editor) => editor.installed);
}

function matchesEditorId(editor, id) {
  return editor.id === id || (editor.aliases || []).includes(id);
}

function findEditor(editors, id) {
  return editors.find((editor) => matchesEditorId(editor, id));
}

function copyIfExists(src, dst) {
  if (exists(src)) copyRecursive(src, dst);
}

function spawnEditorCli(cliPath, args) {
  const options = {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  };

  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cliPath)) {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cliPath, ...args], options);
  }

  return spawnSync(cliPath, args, options);
}

function supportsProfiles(editor) {
  return editor.supportsProfiles !== false;
}

function isBuiltinProfileLocation(location) {
  return location === "builtin" || (typeof location === "string" && location.startsWith("builtin/"));
}

function readProfileNamesFromUserDir(userDir) {
  const storageJson = readJson(path.join(userDir, "globalStorage", "storage.json"));
  const map = new Map();
  if (!storageJson) return map;
  for (const profile of storageJson.userDataProfiles || []) {
    if (profile.location && profile.name && !isBuiltinProfileLocation(profile.location)) {
      map.set(profile.location, profile.name);
    }
  }
  return map;
}

function registeredProfileLocations(snapshotOrUserDir) {
  const storagePath = path.join(snapshotOrUserDir, "user", "globalStorage", "storage.json");
  const userStoragePath = path.join(snapshotOrUserDir, "globalStorage", "storage.json");
  const storageJson = exists(storagePath) ? readJson(storagePath) : readJson(userStoragePath);
  const locations = new Set();
  if (!storageJson) return locations;
  for (const profile of storageJson.userDataProfiles || []) {
    if (profile.location && !isBuiltinProfileLocation(profile.location)) {
      locations.add(profile.location);
    }
  }
  return locations;
}

function registeredBuiltinProfileCount(userDir) {
  const storageJson = readJson(path.join(userDir, "globalStorage", "storage.json"));
  if (!storageJson) return 0;
  return (storageJson.userDataProfiles || []).filter((profile) => (
    profile.location && isBuiltinProfileLocation(profile.location)
  )).length;
}

function listProfilesMissingExtensions(userDir) {
  const profilesDir = path.join(userDir, "profiles");
  const registered = registeredProfileLocations(userDir);
  if (!isDir(profilesDir) || !registered.size) return [];
  const missing = [];
  for (const location of [...registered].sort((a, b) => a.localeCompare(b))) {
    const extFile = path.join(profilesDir, location, "extensions.json");
    if (!exists(extFile)) missing.push(location);
  }
  return missing;
}

function profileHealthSummaryLines(editor) {
  if (!supportsProfiles(editor)) return [];
  const missing = listProfilesMissingExtensions(editor.userDir);
  if (!missing.length) return [];
  const names = readProfileNamesFromUserDir(editor.userDir);
  return [
    `Warning: ${missing.length} profile(s) have no extensions.json in ${editor.id}.`,
    ...missing.map((location) => `  - ${names.get(location) || location}`),
    "Per-profile extensions may appear reset until restored from backups/.",
    "Close the editor before syncing settings or extensions.",
  ];
}

function listProfileDirs(profilesDir, registeredLocations = null) {
  if (!isDir(profilesDir)) return [];
  return fs.readdirSync(profilesDir)
    .filter((name) => name !== "builtin")
    .filter((name) => isDir(path.join(profilesDir, name)))
    .filter((name) => !registeredLocations || registeredLocations.size === 0 || registeredLocations.has(name))
    .sort((a, b) => a.localeCompare(b));
}

function copyProfileContents(srcProfileDir, dstProfileDir, items) {
  ensureDir(dstProfileDir);
  for (const dir of REQUIRED_PROFILE_DIRS) ensureDir(path.join(dstProfileDir, dir));
  for (const item of items) copyIfExists(path.join(srcProfileDir, item), path.join(dstProfileDir, item));

  const agentsDir = path.join(srcProfileDir, "agents");
  if (!isDir(agentsDir)) return;
  for (const agentName of fs.readdirSync(agentsDir)) {
    const agentDir = path.join(agentsDir, agentName);
    if (!isDir(agentDir)) continue;
    const agentOut = path.join(dstProfileDir, "agents", agentName);
    ensureDir(agentOut);
    for (const item of items) copyIfExists(path.join(agentDir, item), path.join(agentOut, item));
  }
}

function copyProfiles(src, dst, { includeExtensions = false, registeredLocations = null } = {}) {
  if (!isDir(src)) return;
  const items = includeExtensions ? SAFE_USER_ITEMS : PROFILE_USER_ITEMS;
  ensureDir(dst);
  for (const profileName of listProfileDirs(src, registeredLocations)) {
    copyProfileContents(path.join(src, profileName), path.join(dst, profileName), items);
  }
}

function syncProfilesByName(sourceProfilesDir, targetProfilesDir, sourceSnapshotDir, targetUserDir) {
  if (!isDir(sourceProfilesDir) || !isDir(targetUserDir)) return { copied: [], skipped: [] };

  const sourceNames = readProfileNames(sourceSnapshotDir);
  const sourceByName = new Map([...sourceNames.entries()].map(([location, name]) => [name, location]));
  const targetStorage = readJson(path.join(targetUserDir, "globalStorage", "storage.json"));
  const copied = [];
  const skipped = [];

  ensureDir(targetProfilesDir);
  for (const profile of (targetStorage && targetStorage.userDataProfiles) || []) {
    const targetLocation = profile.location;
    const profileName = profile.name;
    if (!targetLocation || !profileName || isBuiltinProfileLocation(targetLocation)) continue;

    const sourceLocation = sourceByName.get(profileName);
    if (!sourceLocation) {
      skipped.push(profileName);
      continue;
    }

    const sourceProfileDir = path.join(sourceProfilesDir, sourceLocation);
    if (!isDir(sourceProfileDir)) {
      skipped.push(profileName);
      continue;
    }

    copyProfileContents(sourceProfileDir, path.join(targetProfilesDir, targetLocation), PROFILE_USER_ITEMS);
    copied.push(profileName);
  }

  return { copied, skipped };
}

function listOrphanProfileDirs(editor) {
  if (!supportsProfiles(editor)) return [];
  const profilesDir = path.join(editor.userDir, "profiles");
  if (!isDir(profilesDir)) return [];
  const registered = registeredProfileLocations(editor.userDir);
  if (!registered.size) return [];
  return fs.readdirSync(profilesDir)
    .filter((name) => name !== "builtin")
    .filter((name) => isDir(path.join(profilesDir, name)))
    .filter((name) => !registered.has(name))
    .sort((a, b) => a.localeCompare(b));
}

function countOrphanProfileDirs(userDir) {
  const profilesDir = path.join(userDir, "profiles");
  if (!isDir(profilesDir)) return 0;
  const registered = registeredProfileLocations(userDir);
  if (!registered.size) return 0;
  return listOrphanProfileDirs({ userDir, supportsProfiles: true }).length;
}

function orphanProfilePlan(editor) {
  const orphans = listOrphanProfileDirs(editor);
  const registered = registeredProfileLocations(editor.userDir);
  return {
    editor,
    orphans,
    registeredCount: registered.size,
    profilesDir: path.join(editor.userDir, "profiles"),
  };
}

function pruneOrphanProfiles(editor) {
  const plan = orphanProfilePlan(editor);
  if (!supportsProfiles(editor)) {
    return { removed: [], backup: "", reason: "profiles_not_supported" };
  }
  if (!plan.registeredCount) {
    return { removed: [], backup: "", reason: "no_registered_profiles" };
  }
  if (!plan.orphans.length) {
    return { removed: [], backup: "", reason: "none_found" };
  }

  const backupDir = path.join(BACKUPS, `${editor.id}-orphan-profiles-${stamp()}`);
  ensureDir(backupDir);
  for (const location of plan.orphans) {
    const src = path.join(plan.profilesDir, location);
    copyRecursive(src, path.join(backupDir, location));
    rmrf(src);
  }

  return { removed: plan.orphans, backup: backupDir, reason: "removed" };
}

function bufferOrphanProfilePlan(editor) {
  const plan = orphanProfilePlan(editor);
  const buf = [
    `Editor: ${editor.name} (${editor.id})`,
    `Profiles dir: ${plan.profilesDir}`,
    `Registered profiles: ${plan.registeredCount}`,
    `Orphan profile dirs: ${plan.orphans.length}`,
  ];
  if (!supportsProfiles(editor)) {
    buf.push("This editor does not use VS Code-style profiles.");
    return buf;
  }
  if (!plan.registeredCount) {
    buf.push("No registered profiles found in storage.json. Nothing was removed.");
    return buf;
  }
  if (!plan.orphans.length) {
    buf.push("No orphan profile directories found.");
    return buf;
  }
  for (const location of plan.orphans) {
    buf.push(`  - ${location}`);
  }
  buf.push("Close the editor before removing orphan profile folders.");
  return buf;
}

function runEditorCli(editor, args, stdoutFile, stderrFile) {
  if (!editor.cliPath) return;
  const result = spawnEditorCli(editor.cliPath, args);
  fs.writeFileSync(stdoutFile, result.stdout || "");
  fs.writeFileSync(stderrFile, result.stderr || "");
}

function folderExtensionId(folderName) {
  return folderName.replace(/-[0-9].*$/, "").toLowerCase();
}

function parseFolderExtension(folderName) {
  const match = folderName.match(/^(.*?)-([0-9][0-9A-Za-z.-]*?)(?:-(?:darwin|linux|win32|alpine|web|universal).*)?$/);
  if (!match) return { id: folderExtensionId(folderName), version: "" };
  return { id: match[1].toLowerCase(), version: match[2] };
}

function collectEditor(editor) {
  const out = path.join(SNAPSHOTS, editor.id);
  rmrf(out);
  ensureDir(path.join(out, "user"));
  ensureDir(path.join(out, "extensions"));

  if (isDir(editor.userDir)) {
    for (const item of SAFE_USER_ITEMS.filter((item) => item !== "extensions.json")) {
      copyIfExists(path.join(editor.userDir, item), path.join(out, "user", item));
    }
    if (supportsProfiles(editor)) {
      const registered = registeredProfileLocations(editor.userDir);
      copyProfiles(
        path.join(editor.userDir, "profiles"),
        path.join(out, "user", "profiles"),
        { includeExtensions: true, registeredLocations: registered },
      );
      copyIfExists(path.join(editor.userDir, "globalStorage", "storage.json"), path.join(out, "user", "globalStorage", "storage.json"));
    }
  }

  runEditorCli(editor, ["--list-extensions", "--show-versions"], path.join(out, "extensions", "cli-list.txt"), path.join(out, "extensions", "cli-list.stderr"));
  runEditorCli(editor, ["--list-extensions"], path.join(out, "extensions", "cli-ids.txt"), path.join(out, "extensions", "cli-ids.stderr"));

  if (isDir(editor.extensionsDir)) {
    copyIfExists(path.join(editor.extensionsDir, "extensions.json"), path.join(out, "extensions", "extensions.json"));
    const folders = fs.readdirSync(editor.extensionsDir)
      .filter((name) => !name.startsWith("."))
      .filter((name) => isDir(path.join(editor.extensionsDir, name)))
      .sort((a, b) => a.localeCompare(b));
    fs.writeFileSync(path.join(out, "extensions", "folder-list.txt"), folders.join("\n") + (folders.length ? "\n" : ""));
    const ids = [...new Set(folders.map(folderExtensionId))].sort((a, b) => a.localeCompare(b));
    fs.writeFileSync(path.join(out, "extensions", "folder-ids.txt"), ids.join("\n") + (ids.length ? "\n" : ""));
  }

  fs.writeFileSync(path.join(out, "metadata.env"), [
    `editor=${editor.id}`,
    `displayName=${editor.name}`,
    `platform=${platformKey()}`,
    `userDir=${editor.userDir}`,
    `extensionsDir=${editor.extensionsDir}`,
    `cli=${editor.cliPath || ""}`,
    `collectedAt=${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    "",
  ].join("\n"));
}

function pruneSnapshots(editors) {
  if (!isDir(SNAPSHOTS)) return;
  const activeIds = new Set(editors.map((editor) => editor.id));
  for (const name of fs.readdirSync(SNAPSHOTS)) {
    const snapshotDir = path.join(SNAPSHOTS, name);
    if (isDir(snapshotDir) && !activeIds.has(name)) rmrf(snapshotDir);
  }
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

function readJson(filePath) {
  const raw = readText(filePath);
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(stripJsonc(raw));
    } catch {
      return null;
    }
  }
}

function stripJsonc(input) {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) inString = false;
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }

    out += char;
  }

  return out.replace(/,\s*([}\]])/g, "$1");
}

function listDirs(dirPath) {
  if (!isDir(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter((name) => name !== "builtin")
    .filter((name) => isDir(path.join(dirPath, name)))
    .sort((a, b) => a.localeCompare(b));
}

function readExtensionIds(snapshot) {
  const cliIds = readText(path.join(snapshot, "extensions", "cli-ids.txt"))
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (cliIds.length) return [...new Set(cliIds)].sort((a, b) => a.localeCompare(b));
  return [...readExtensionMap(snapshot).keys()].sort((a, b) => a.localeCompare(b));
}

function readExtensionMap(snapshot) {
  const map = new Map();
  const cliList = readText(path.join(snapshot, "extensions", "cli-list.txt"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const item of cliList) {
    const at = item.lastIndexOf("@");
    const id = (at === -1 ? item : item.slice(0, at)).toLowerCase();
    const version = at === -1 ? "" : item.slice(at + 1);
    if (id) map.set(id, version);
  }

  if (map.size) return map;

  const extJsonPath = path.join(snapshot, "extensions", "extensions.json");
  if (exists(extJsonPath)) {
    const data = readJson(extJsonPath);
    if (Array.isArray(data)) {
      for (const item of data) {
        const id = item && item.identifier && item.identifier.id;
        if (id) map.set(id.toLowerCase(), item.version || "");
      }
    }
  }

  if (map.size) return map;

  const folderList = readText(path.join(snapshot, "extensions", "folder-list.txt"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const folder of folderList) {
    const parsed = parseFolderExtension(folder);
    if (parsed.id) map.set(parsed.id, parsed.version);
  }

  const folderIds = readText(path.join(snapshot, "extensions", "folder-ids.txt"))
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);

  for (const id of folderIds) {
    if (!map.has(id)) map.set(id, "");
  }

  return map;
}

function extensionEntryId(entry) {
  const id = entry && entry.identifier && entry.identifier.id;
  return id ? id.toLowerCase() : "";
}

function extensionEntries(filePath) {
  const data = readJson(filePath);
  return Array.isArray(data) ? data : [];
}

function targetExtensionIdsFor(sourceExtensionId, targetEditorId) {
  const ids = canonicalExtensionIds(sourceExtensionId);
  ids.add(extensionInstallId(sourceExtensionId, targetEditorId));
  return ids;
}

function applicationScopedPlan(source, target) {
  const sourceEntries = extensionEntries(path.join(SNAPSHOTS, source.id, "extensions", "extensions.json"));
  const targetEntries = extensionEntries(path.join(target.extensionsDir, "extensions.json"));
  const targetById = new Map(targetEntries.map((entry) => [extensionEntryId(entry), entry]).filter(([id]) => id));
  const ids = [];
  const missing = [];

  for (const sourceEntry of sourceEntries) {
    if (!sourceEntry || !sourceEntry.metadata || sourceEntry.metadata.isApplicationScoped !== true) continue;
    const sourceId = extensionEntryId(sourceEntry);
    if (!sourceId) continue;

    const targetEntry = [...targetExtensionIdsFor(sourceId, target.id)]
      .map((id) => targetById.get(id))
      .find(Boolean);
    if (!targetEntry) {
      missing.push(sourceId);
      continue;
    }
    if (!targetEntry.metadata || targetEntry.metadata.isApplicationScoped !== true) {
      ids.push(extensionEntryId(targetEntry));
    }
  }

  return { ids: [...new Set(ids)].sort((a, b) => a.localeCompare(b)), missing };
}

const APPLICATION_SCOPED_WARNING = [
  "Writing extensions.json while the editor is open can reset profile extensions.",
  "Set Apply to all Profiles manually in the Extensions view instead.",
];

function syncApplicationScopedExtensions(source, target, opts = {}) {
  if (opts.dryRun) {
    return applicationScopedPlan(source, target);
  }

  const sourceEntries = extensionEntries(path.join(SNAPSHOTS, source.id, "extensions", "extensions.json"));
  const targetFile = path.join(target.extensionsDir, "extensions.json");
  const targetEntries = extensionEntries(targetFile);
  if (!sourceEntries.length || !targetEntries.length) {
    return { updated: 0, missing: [], backup: "", ids: [] };
  }

  const targetById = new Map(targetEntries.map((entry) => [extensionEntryId(entry), entry]).filter(([id]) => id));
  const missing = [];
  const updatedIds = [];

  for (const sourceEntry of sourceEntries) {
    if (!sourceEntry || !sourceEntry.metadata || sourceEntry.metadata.isApplicationScoped !== true) continue;
    const sourceId = extensionEntryId(sourceEntry);
    if (!sourceId) continue;

    const targetEntry = [...targetExtensionIdsFor(sourceId, target.id)]
      .map((id) => targetById.get(id))
      .find(Boolean);
    if (!targetEntry) {
      missing.push(sourceId);
      continue;
    }

    if (!targetEntry.metadata) targetEntry.metadata = {};
    if (targetEntry.metadata.isApplicationScoped !== true) {
      targetEntry.metadata.isApplicationScoped = true;
      updatedIds.push(extensionEntryId(targetEntry));
    }
  }

  if (!updatedIds.length) {
    return { updated: 0, missing, backup: "", ids: [] };
  }

  const backupDir = opts.backupDir || path.join(BACKUPS, `${target.id}-extensions-${stamp()}`);
  ensureDir(path.join(backupDir, "extensions"));
  copyRecursive(targetFile, path.join(backupDir, "extensions", "extensions.json"));
  fs.writeFileSync(targetFile, `${JSON.stringify(targetEntries, null, 2)}\n`);

  return {
    updated: updatedIds.length,
    missing,
    backup: backupDir,
    ids: updatedIds,
  };
}

function applicationScopedSummaryLines(plan) {
  if (!plan.ids.length && !plan.missing.length) return [];
  const lines = [`All-profile flag differences: ${plan.ids.length}`];
  if (plan.ids.length) {
    lines.push(`  Would mark in target: ${plan.ids.join(", ")}`);
  }
  if (plan.missing.length) {
    lines.push(`  Missing in target: ${plan.missing.join(", ")}`);
  }
  lines.push(...APPLICATION_SCOPED_WARNING);
  return lines;
}

function profileExtensionIds(profileDir) {
  return [...profileExtensionMap(profileDir).keys()].sort((a, b) => a.localeCompare(b));
}

function profileExtensionMap(profileDir) {
  const map = new Map();
  const data = readJson(path.join(profileDir, "extensions.json"));
  if (!Array.isArray(data)) return map;
  for (const item of data) {
    const id = item && item.identifier && item.identifier.id;
    if (id) map.set(id.toLowerCase(), item.version || "");
  }
  return map;
}

function flattenObject(value, prefix = "", out = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) out[prefix] = value;
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) flattenObject(child, next, out);
    else out[next] = child;
  }
  return out;
}

function settingsKeys(snapshot) {
  return Object.keys(flattenObject(readJson(path.join(snapshot, "user", "settings.json")) || {})).sort((a, b) => a.localeCompare(b));
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function isIgnoredExtension(editorId, extensionId) {
  return Boolean(EDITOR_EXTENSION_IGNORE[editorId] && EDITOR_EXTENSION_IGNORE[editorId].has(extensionId.toLowerCase()));
}

function isForkEditor(editorId) {
  return FORK_EDITOR_IDS.has(editorId);
}

function extensionPatchRequires(patchId) {
  return EXTENSION_PATCH_BY_ID.get(patchId.toLowerCase()) || null;
}

function isMissingPatchRow(row) {
  return row.status === "patch" && row.targetVersion === undefined;
}

function appendExtensionPatchRows(rows, target, sourceScope, sourceExts, targetExts) {
  if (!isForkEditor(target.id)) return;

  for (const rule of EXTENSION_PATCHES) {
    const requiresId = rule.requires.toLowerCase();
    const patchId = rule.patch.toLowerCase();
    const requiresPresent = targetExts.has(requiresId) || sourceExts.has(requiresId);
    if (!requiresPresent || targetExts.has(patchId)) continue;
    if (rows.some((row) => row.scope === sourceScope.name && row.id.toLowerCase() === patchId)) continue;

    rows.push({
      scope: sourceScope.name,
      scopeDisplayName: sourceScope.displayName || sourceScope.name,
      id: patchId,
      sourceVersion: undefined,
      targetVersion: undefined,
      patchFor: requiresId,
      status: "patch",
    });
  }
}

function patchInstallBlocked(row, analysis, mode) {
  if (!row.patchFor || mode !== "full_clean") return false;
  return analysis.extensionRows.some((candidate) => (
    candidate.scope === row.scope
    && candidate.id.toLowerCase() === row.patchFor.toLowerCase()
    && candidate.status === "extra"
  ));
}

function extensionReplacementGroup(extensionId) {
  return EXTENSION_REPLACEMENT_BY_ID.get(extensionId.toLowerCase()) || null;
}

function groupExtensionIds(group) {
  const ids = new Set();
  for (const extId of Object.values(group)) {
    if (typeof extId === "string" && extId) ids.add(extId.toLowerCase());
  }
  return ids;
}

function canonicalExtensionIds(extensionId) {
  const group = extensionReplacementGroup(extensionId);
  if (!group) return new Set([extensionId.toLowerCase()]);
  return groupExtensionIds(group);
}

function extensionReplacementForTarget(extensionId, targetEditorId) {
  const group = extensionReplacementGroup(extensionId);
  if (!group) return null;
  if (group.default) return group.default.toLowerCase();
  const targetId = group[targetEditorId];
  return targetId ? targetId.toLowerCase() : null;
}

function sourceHasExtensionEquivalent(sourceExts, extensionId) {
  for (const equivalentId of canonicalExtensionIds(extensionId)) {
    if (sourceExts.has(equivalentId)) return true;
  }
  return false;
}

function extensionInstallId(extensionId, targetEditorId) {
  const replacement = extensionReplacementForTarget(extensionId, targetEditorId);
  return replacement || extensionId.toLowerCase();
}

function compareVersions(left, right) {
  if (!left || !right || left === right) return 0;
  const leftParts = String(left).split(/[.-]/);
  const rightParts = String(right).split(/[.-]/);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i += 1) {
    const a = leftParts[i] || "0";
    const b = rightParts[i] || "0";
    const aNum = /^\d+$/.test(a) ? Number(a) : null;
    const bNum = /^\d+$/.test(b) ? Number(b) : null;
    if (aNum !== null && bNum !== null && aNum !== bNum) return aNum < bNum ? -1 : 1;
    if (a !== b) return a.localeCompare(b);
  }
  return 0;
}

function extensionMatch(sourceEditorId, targetEditorId, id, sourceVersion, targetExts) {
  const idLower = id.toLowerCase();
  const expected = extensionReplacementForTarget(idLower, targetEditorId);
  if (expected && targetExts.has(expected)) {
    return {
      status: "aliased",
      aliasId: expected,
      targetVersion: targetExts.get(expected),
    };
  }

  for (const counterpart of canonicalExtensionIds(idLower)) {
    if (counterpart !== idLower && targetExts.has(counterpart)) {
      return {
        status: "aliased",
        aliasId: counterpart,
        targetVersion: targetExts.get(counterpart),
      };
    }
  }

  if (isIgnoredExtension(sourceEditorId, id)) return { status: "ignored" };

  const targetVersion = targetExts.has(idLower) ? targetExts.get(idLower) : undefined;
  if (targetVersion === undefined) return { status: "missing" };
  if (sourceVersion && targetVersion && sourceVersion !== targetVersion) {
    return {
      status: compareVersions(targetVersion, sourceVersion) < 0 ? "older" : "different",
      targetVersion,
    };
  }
  return { status: "same", targetVersion };
}

function buildUnifiedRows(source, target, sourceScopes, targetScopes) {
  const targetGlobal = targetScopes.find((scope) => scope.name === "global") || targetScopes[0];
  const rows = [];

  for (const sourceScope of sourceScopes) {
    const targetScope =
      targetScopes.find((scope) => scope.name === sourceScope.name) ||
      (sourceScope.displayName && targetScopes.find((scope) => scope.displayName === sourceScope.displayName)) ||
      targetGlobal;
    const sourceExts = sourceScope.extensions;
    const targetExts = targetScope.extensions;

    // Source extensions → check against target
    for (const [id, sourceVersion] of [...sourceExts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const match = extensionMatch(source.id, target.id, id, sourceVersion, targetExts);
      if (match.status === "same") continue;
      rows.push({
        scope: sourceScope.name,
        scopeDisplayName: sourceScope.displayName || sourceScope.name,
        id,
        sourceVersion,
        targetVersion: match.targetVersion,
        aliasId: match.aliasId,
        status: match.status,
      });
    }

    // Target-only extensions → "extra"
    for (const [id, targetVersion] of [...targetExts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (sourceExts.has(id)) continue;
      if (sourceHasExtensionEquivalent(sourceExts, id, source.id, target.id)) continue;
      if (isIgnoredExtension(target.id, id)) {
        rows.push({
          scope: sourceScope.name,
          scopeDisplayName: sourceScope.displayName || sourceScope.name,
          id,
          sourceVersion: undefined,
          targetVersion,
          status: "ignored",
        });
        continue;
      }
      const patchFor = extensionPatchRequires(id);
      if (patchFor && isForkEditor(target.id)) {
        rows.push({
          scope: sourceScope.name,
          scopeDisplayName: sourceScope.displayName || sourceScope.name,
          id,
          sourceVersion: undefined,
          targetVersion,
          patchFor,
          status: "patch",
        });
        continue;
      }
      rows.push({
        scope: sourceScope.name,
        scopeDisplayName: sourceScope.displayName || sourceScope.name,
        id,
        sourceVersion: undefined,
        targetVersion,
        status: "extra",
      });
    }

    appendExtensionPatchRows(rows, target, sourceScope, sourceExts, targetExts);
  }

  return rows;
}

function readProfileNames(snapshot) {
  const map = readProfileNamesFromUserDir(path.join(snapshot, "user"));
  if (map.size) return map;

  const storageJson = readJson(path.join(snapshot, "user", "globalStorage", "storage.json"));
  if (!storageJson) return map;
  for (const profile of storageJson.userDataProfiles || []) {
    if (profile.location && profile.name && !isBuiltinProfileLocation(profile.location)) {
      map.set(profile.location, profile.name);
    }
  }
  return map;
}

function readExtensionScopes(snapshot, editor) {
  const profileNames = readProfileNames(snapshot);
  const scopes = [{ name: "global", displayName: "Default", extensions: readExtensionMap(snapshot) }];
  if (!supportsProfiles(editor)) return scopes;
  const profilesDir = path.join(snapshot, "user", "profiles");
  const registered = new Set(profileNames.keys());
  for (const profile of listProfileDirs(profilesDir, registered)) {
    const displayName = profileNames.get(profile) || profile;
    scopes.push({
      name: `profile:${profile}`,
      displayName,
      extensions: profileExtensionMap(path.join(profilesDir, profile)),
    });
  }
  return scopes;
}

function analyzePair(source, target) {
  const sourceSnap = path.join(SNAPSHOTS, source.id);
  const targetSnap = path.join(SNAPSHOTS, target.id);
  const sourceExt = readExtensionIds(sourceSnap);
  const targetExt = readExtensionIds(targetSnap);
  const sourceSettings = settingsKeys(sourceSnap);
  const targetSettings = settingsKeys(targetSnap);
  const sourceProfiles = supportsProfiles(source)
    ? listProfileDirs(path.join(sourceSnap, "user", "profiles"), new Set(readProfileNames(sourceSnap).keys()))
    : [];
  const targetProfiles = supportsProfiles(target)
    ? listProfileDirs(path.join(targetSnap, "user", "profiles"), new Set(readProfileNames(targetSnap).keys()))
    : [];
  let sourceScopes = readExtensionScopes(sourceSnap, source);
  let targetScopes = readExtensionScopes(targetSnap, target);

  if (!supportsProfiles(target)) {
    const unionMap = new Map();
    for (const scope of sourceScopes) {
      for (const [id, version] of scope.extensions) {
        if (!unionMap.has(id) || compareVersions(unionMap.get(id), version) < 0) {
          unionMap.set(id, version);
        }
      }
    }
    sourceScopes = [{ name: "global", displayName: "Default", extensions: unionMap }];
    targetScopes = targetScopes.filter((scope) => scope.name === "global");
  }

  const extensionRows = buildUnifiedRows(source, target, sourceScopes, targetScopes);

  return {
    onlySourceExt: difference(sourceExt, targetExt),
    onlyTargetExt: difference(targetExt, sourceExt),
    onlySourceSettings: difference(sourceSettings, targetSettings),
    onlyTargetSettings: difference(targetSettings, sourceSettings),
    sourceProfiles,
    targetProfiles,
    extensionRows,
  };
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function ensureVsixCache() {
  ensureDir(VSIX_CACHE);
  const gitignorePath = path.join(ROOT, ".gitignore");
  if (exists(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf8");
    if (!content.includes("vsix_cache/")) {
      fs.appendFileSync(gitignorePath, "\nvsix_cache/\n");
    }
  }
}

function marketplaceTargetPlatform() {
  const arch =
    process.arch === "x64" ? "x64" :
    process.arch === "arm64" ? "arm64" :
    process.arch === "ia32" ? "ia32" :
    process.arch === "arm" ? "armhf" :
    "";
  if (!arch) return "";
  if (process.platform === "win32") return `win32-${arch}`;
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "linux") return `linux-${arch}`;
  return "";
}

function zipEntryBuffer(zipBuffer, entryName) {
  const endSearchStart = Math.max(0, zipBuffer.length - 0xffff - 22);
  let eocd = -1;
  for (let pos = zipBuffer.length - 22; pos >= endSearchStart; pos -= 1) {
    if (zipBuffer.readUInt32LE(pos) === 0x06054b50) {
      eocd = pos;
      break;
    }
  }
  if (eocd === -1) return null;

  const centralDirSize = zipBuffer.readUInt32LE(eocd + 12);
  const centralDirOffset = zipBuffer.readUInt32LE(eocd + 16);
  let pos = centralDirOffset;
  const end = centralDirOffset + centralDirSize;

  while (pos < end && zipBuffer.readUInt32LE(pos) === 0x02014b50) {
    const method = zipBuffer.readUInt16LE(pos + 10);
    const compressedSize = zipBuffer.readUInt32LE(pos + 20);
    const nameLength = zipBuffer.readUInt16LE(pos + 28);
    const extraLength = zipBuffer.readUInt16LE(pos + 30);
    const commentLength = zipBuffer.readUInt16LE(pos + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(pos + 42);
    const name = zipBuffer.slice(pos + 46, pos + 46 + nameLength).toString("utf8");

    if (name === entryName) {
      if (zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) return null;
      const localNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const data = zipBuffer.slice(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }

    pos += 46 + nameLength + extraLength + commentLength;
  }

  return null;
}

function vsixTargetPlatform(vsixBuffer) {
  try {
    const manifest = zipEntryBuffer(vsixBuffer, "extension.vsixmanifest");
    if (!manifest) return "";
    const match = manifest.toString("utf8").match(/\bTargetPlatform="([^"]+)"/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function vsixMatchesTargetPlatform(vsixBuffer, targetPlatform) {
  const vsixPlatform = vsixTargetPlatform(vsixBuffer);
  return !targetPlatform || !vsixPlatform || vsixPlatform === targetPlatform;
}

async function downloadVsix(id, version) {
  ensureVsixCache();

  const targetPlatform = marketplaceTargetPlatform();
  const platformSuffix = targetPlatform ? `-${targetPlatform}` : "";
  const cacheName = version ? `${id}-${version}${platformSuffix}.vsix` : `${id}-latest${platformSuffix}.vsix`;
  const cachedPath = path.join(VSIX_CACHE, cacheName);

  if (exists(cachedPath)) {
    const cached = fs.readFileSync(cachedPath);
    if (vsixMatchesTargetPlatform(cached, targetPlatform)) {
      return { path: cachedPath, source: "cache" };
    }
    fs.unlinkSync(cachedPath);
  }

  const parts = id.split(".");
  const publisher = parts[0];
  const extensionName = parts.slice(1).join(".");

  const versionStr = version || "latest";
  const marketUrl = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${publisher}/vsextensions/${extensionName}/${versionStr}/vspackage`;
  const marketUrls = targetPlatform
    ? [`${marketUrl}?targetPlatform=${encodeURIComponent(targetPlatform)}`, marketUrl]
    : [marketUrl];

  for (const url of marketUrls) {
    try {
      const res = await fetch(url);
      if (res.status === 200) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (!vsixMatchesTargetPlatform(buf, targetPlatform)) continue;
        fs.writeFileSync(cachedPath, buf);
        return {
          path: cachedPath,
          source: targetPlatform && url.includes("targetPlatform=")
            ? `VS Code Marketplace (${targetPlatform})`
            : "VS Code Marketplace",
        };
      }
    } catch (e) {
      // try next
    }
  }

  // Try Open VSX as fallback
  try {
    const openVsxMetaUrl = version
      ? `https://open-vsx.org/api/${publisher}/${extensionName}/${version}`
      : `https://open-vsx.org/api/${publisher}/${extensionName}`;
    const res = await fetch(openVsxMetaUrl);
    if (res.ok) {
      const meta = await res.json();
      if (meta.files && meta.files.download) {
        const downloadRes = await fetch(meta.files.download);
        if (downloadRes.status === 200) {
          const buf = Buffer.from(await downloadRes.arrayBuffer());
          if (!vsixMatchesTargetPlatform(buf, targetPlatform)) {
            throw new Error(`Downloaded VSIX targets ${vsixTargetPlatform(buf)}, expected ${targetPlatform}.`);
          }
          fs.writeFileSync(cachedPath, buf);
          return { path: cachedPath, source: "Open VSX" };
        }
      }
    }
  } catch (e) {
    // try next
  }

  throw new Error(`Failed to download extension ${id} (version: ${versionStr}) from VS Code Marketplace or Open VSX.`);
}


function backupAndCopy(source, target, items) {
  const sourceUser = path.join(SNAPSHOTS, source.id, "user");
  const backupDir = path.join(BACKUPS, `${target.id}-${stamp()}`);
  ensureDir(backupDir);
  ensureDir(target.userDir);
  for (const item of items) {
    const targetItem = path.join(target.userDir, item);
    if (exists(targetItem)) copyRecursive(targetItem, path.join(backupDir, item));
  }
  for (const item of items) {
    const sourceItem = path.join(sourceUser, item);
    if (!exists(sourceItem)) continue;
    const targetItem = path.join(target.userDir, item);
    if (item === "profiles") {
      ensureDir(targetItem);
      if (source.id === target.id) {
        const registered = registeredProfileLocations(target.userDir);
        copyProfiles(sourceItem, targetItem, { registeredLocations: registered });
      } else {
        syncProfilesByName(sourceItem, targetItem, path.join(SNAPSHOTS, source.id), target.userDir);
      }
      continue;
    }
    rmrf(targetItem);
    copyRecursive(sourceItem, targetItem);
  }
  return backupDir;
}

async function syncExtensions(source, target, tasks) {
  if (!target.cliPath) {
    return {
      attempted: tasks.length,
      ok: 0,
      failed: tasks.map((t) => ({ id: t.id, stderr: "Target CLI not found" })),
    };
  }

  let ok = 0;
  const failed = [];

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    const indexStr = `[${i + 1}/${tasks.length}]`;
    const profileLabel = task.profileDisplayName || "Default";
    const actionLabel = task.action === "uninstall" ? "Uninstalling" : "Installing";
    const versionLabel = task.version ? ` (${task.version})` : "";

    const prefix = `${indexStr} [Profile: ${profileLabel}] ${actionLabel} ${task.id}${versionLabel}... `;
    process.stdout.write(prefix);

    const baseArgs = [];
    if (task.profileDisplayName && task.profileDisplayName !== "Default") {
      baseArgs.push("--profile", task.profileDisplayName);
    }

    if (task.action === "uninstall") {
      const args = [...baseArgs, "--uninstall-extension", task.id];
      const result = spawnEditorCli(target.cliPath, args);
      if (result.status === 0) {
        ok += 1;
        line("OK");
      } else {
        const err = (result.stderr || result.stdout || "").trim();
        failed.push({ id: task.id, action: "uninstall", stderr: err });
        line("FAILED");
      }
      continue;
    }

    // Action: install
    const installArgs = [...baseArgs, "--install-extension", task.id];
    const result = spawnEditorCli(target.cliPath, installArgs);

    if (result.status === 0) {
      ok += 1;
      line("OK (CLI)");
      continue;
    }

    // CLI installation failed, try downloading VSIX and installing from it
    process.stdout.write("CLI install failed. Downloading VSIX... ");
    try {
      const downloaded = await downloadVsix(task.id, task.version);
      process.stdout.write(`Downloaded from ${downloaded.source}. Installing... `);

      const vsixArgs = [...baseArgs, "--install-extension", downloaded.path];
      const vsixResult = spawnEditorCli(target.cliPath, vsixArgs);

      if (vsixResult.status === 0) {
        ok += 1;
        line("OK (VSIX)");
      } else {
        const err = (vsixResult.stderr || vsixResult.stdout || "").trim();
        failed.push({ id: task.id, action: "install", stderr: err });
        line("FAILED");
      }
    } catch (err) {
      failed.push({ id: task.id, action: "install", stderr: err.message });
      line(`FAILED (${err.message})`);
    }
  }

  const logDir = path.join(ROOT, "logs");
  ensureDir(logDir);
  fs.writeFileSync(
    path.join(logDir, `install-${source.id}-to-${target.id}-${stamp()}.log`),
    failed.map((item) => `# ${item.id} (${item.action || "install"})\n${item.stderr || "No stderr"}\n`).join("\n")
  );

  return { attempted: tasks.length, ok, failed };
}

const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(text) {
  return String(text).replace(ANSI_SGR_PATTERN, "");
}

function leadingAnsiCodes(text) {
  const match = String(text).match(/^(\x1b\[[0-9;]*m)+/);
  return match ? match[0] : "";
}

function visibleLength(text) {
  return stripAnsi(text).length;
}

function color(text, ansi) {
  return useColor && ansi ? `${ansi}${text}${ANSI.reset}` : text;
}

function terminalWidth() {
  return Math.max(54, Math.min(process.stdout.columns || 100, 140));
}

function terminalHeight() {
  return process.stdout.rows || 24;
}

function truncateText(text, maxWidth) {
  const value = String(text);
  if (visibleLength(value) <= maxWidth) return value;
  const prefix = leadingAnsiCodes(value);
  const plain = stripAnsi(value);
  if (maxWidth <= 1) return `${prefix}…${prefix ? ANSI.reset : ""}`;
  return `${prefix}${plain.slice(0, Math.max(0, maxWidth - 1))}…${prefix ? ANSI.reset : ""}`;
}

function wrapText(text, maxWidth) {
  const value = String(text);
  if (maxWidth <= 0) return [""];

  const prefix = leadingAnsiCodes(value);
  const close = prefix ? ANSI.reset : "";
  const lines = [];

  for (const rawLine of stripAnsi(value).split(/\r?\n/)) {
    let lineValue = rawLine;
    while (lineValue.length > maxWidth) {
      let cut = Math.min(lineValue.length, maxWidth);
      const space = lineValue.slice(0, cut + 1).lastIndexOf(" ");
      if (space > Math.floor(maxWidth * 0.55)) cut = space;
      lines.push(`${prefix}${lineValue.slice(0, cut).trimEnd()}${close}`);
      lineValue = lineValue.slice(cut).trimStart();
    }
    lines.push(lineValue ? `${prefix}${lineValue}${close}` : "");
  }
  return lines.length ? lines : [""];
}

function line(text = "") {
  process.stdout.write(`${text}\n`);
}

function bufferBox(title, rows) {
  const buf = [];
  const maxWidth = terminalWidth();
  const contentWidth = Math.max(42, maxWidth - 4);
  const wrappedRows = rows.flatMap((row) => wrapText(row, contentWidth));
  const width = Math.min(maxWidth - 2, Math.max(46, visibleLength(title) + 4, ...wrappedRows.map((row) => visibleLength(row) + 4)));
  const rowWidth = width - 3;
  const titleText = truncateText(title, Math.max(1, width - 4));
  buf.push(`╭─ ${titleText}${"─".repeat(Math.max(0, width - visibleLength(titleText) - 4))}╮`);
  for (const row of wrappedRows) buf.push(`│ ${row}${" ".repeat(Math.max(0, rowWidth - visibleLength(row)))}│`);
  buf.push(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
  return buf;
}

function bufferTable(headers, rows) {
  const buf = [];
  const columnCount = headers.length;
  const maxWidth = terminalWidth();
  const fixedChars = 1 + columnCount * 2 + (columnCount - 1) * 3 + 1;
  const available = Math.max(columnCount * 8, maxWidth - fixedChars);
  const minWidths = headers.map((header) => Math.min(Math.max(visibleLength(header), 4), 18));
  const widths = headers.map((header, i) => Math.max(
    visibleLength(header),
    ...rows.map((row) => visibleLength(row[i] || "")),
  ));
  while (widths.reduce((sum, width) => sum + width, 0) > available) {
    let shrinkIndex = -1;
    let shrinkValue = -1;
    for (let i = 0; i < widths.length; i += 1) {
      const shrinkable = widths[i] - minWidths[i];
      if (shrinkable > shrinkValue) {
        shrinkValue = shrinkable;
        shrinkIndex = i;
      }
    }
    if (shrinkIndex === -1 || shrinkValue <= 0) break;
    widths[shrinkIndex] -= 1;
  }

  const renderRow = (row) => {
    const wrapped = row.map((cell, i) => wrapText(cell || "", widths[i]));
    const height = Math.max(...wrapped.map((cellLines) => cellLines.length));
    const lines = [];
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      lines.push(`│ ${wrapped.map((cellLines, i) => {
        const cell = cellLines[lineIndex] || "";
        return `${cell}${" ".repeat(widths[i] - visibleLength(cell))}`;
      }).join(" │ ")} │`);
    }
    return lines;
  };
  buf.push(`╭${widths.map((width) => "─".repeat(width + 2)).join("┬")}╮`);
  buf.push(...renderRow(headers));
  buf.push(`├${widths.map((width) => "─".repeat(width + 2)).join("┼")}┤`);
  for (const row of rows) buf.push(...renderRow(row));
  buf.push(`╰${widths.map((width) => "─".repeat(width + 2)).join("┴")}╯`);
  return buf;
}

function clear() {
  if (process.stdout.isTTY) {
    process.stdout.write(ANSI.clearScreen);
    trackedScreenRows = [];
  }
}

let trackedScreenRows = [];

function captureOutput(fn) {
  const originalWrite = process.stdout.write;
  const chunks = [];
  process.stdout.write = function capturedWrite(chunk, encoding, callback) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === "string" ? encoding : "utf8") : String(chunk));
    const cb = typeof encoding === "function" ? encoding : callback;
    if (cb) cb();
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}

function outputRows(output) {
  const normalized = output.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalized ? normalized.split("\n") : [];
}

function box(title, rows) {
  const maxWidth = terminalWidth();
  const contentWidth = Math.max(42, maxWidth - 4);
  const wrappedRows = rows.flatMap((row) => wrapText(row, contentWidth));
  const width = Math.min(maxWidth - 2, Math.max(46, visibleLength(title) + 4, ...wrappedRows.map((row) => visibleLength(row) + 4)));
  const rowWidth = width - 3;
  const titleText = truncateText(title, Math.max(1, width - 4));
  line(`╭─ ${titleText}${"─".repeat(Math.max(0, width - visibleLength(titleText) - 4))}╮`);
  for (const row of wrappedRows) line(`│ ${row}${" ".repeat(Math.max(0, rowWidth - visibleLength(row)))}│`);
  line(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function table(headers, rows) {
  const columnCount = headers.length;
  const maxWidth = terminalWidth();
  const fixedChars = 1 + columnCount * 2 + (columnCount - 1) * 3 + 1;
  const available = Math.max(columnCount * 8, maxWidth - fixedChars);
  const minWidths = headers.map((header) => Math.min(Math.max(visibleLength(header), 4), 18));
  const widths = headers.map((header, i) => Math.max(
    visibleLength(header),
    ...rows.map((row) => visibleLength(row[i] || "")),
  ));
  while (widths.reduce((sum, width) => sum + width, 0) > available) {
    let shrinkIndex = -1;
    let shrinkValue = -1;
    for (let i = 0; i < widths.length; i += 1) {
      const shrinkable = widths[i] - minWidths[i];
      if (shrinkable > shrinkValue) {
        shrinkValue = shrinkable;
        shrinkIndex = i;
      }
    }
    if (shrinkIndex === -1 || shrinkValue <= 0) break;
    widths[shrinkIndex] -= 1;
  }

  const renderRow = (row) => {
    const wrapped = row.map((cell, i) => wrapText(cell || "", widths[i]));
    const height = Math.max(...wrapped.map((cellLines) => cellLines.length));
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      line(`│ ${wrapped.map((cellLines, i) => {
        const cell = cellLines[lineIndex] || "";
        return `${cell}${" ".repeat(widths[i] - visibleLength(cell))}`;
      }).join(" │ ")} │`);
    }
  };
  line(`╭${widths.map((width) => "─".repeat(width + 2)).join("┬")}╮`);
  renderRow(headers);
  line(`├${widths.map((width) => "─".repeat(width + 2)).join("┼")}┤`);
  for (const row of rows) renderRow(row);
  line(`╰${widths.map((width) => "─".repeat(width + 2)).join("┴")}╯`);
}

function prompt(question) {
  if (nonInteractive) return Promise.resolve("");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

function moveCursorUp(lines) {
  if (lines > 0) process.stdout.write(`\x1b[${lines}A${ANSI.cursorColumnStart}`);
}

function interactiveLineWidth() {
  return Math.max(1, (process.stdout.columns || 100) - 1);
}

function interactiveLine(text) {
  return truncateText(text, interactiveLineWidth());
}

function renderInteractiveLines(rows, previousLines) {
  const rendered = rows.slice();
  while (rendered.length < previousLines) rendered.push("");
  process.stdout.write(rendered.map((row) => `${ANSI.cursorColumnStart}${ANSI.clearLine}${row}`).join("\n"));
  return rendered.length;
}

function renderScreenRows(rows, previousRows = null) {
  const tracked = previousRows === null;
  const baseRows = tracked ? trackedScreenRows : previousRows;
  const nextRows = rows.slice();
  const count = Math.max(nextRows.length, baseRows.length);
  const writes = [];
  if (!baseRows.length) writes.push(ANSI.clearScreen);
  for (let i = 0; i < count; i += 1) {
    const row = nextRows[i] || "";
    if (baseRows[i] === row) continue;
    writes.push(`\x1b[${i + 1};1H${ANSI.clearLine}${row}`);
  }
  if (writes.length) process.stdout.write(writes.join(""));
  if (tracked) trackedScreenRows = nextRows;
  return nextRows;
}

function sliceAroundIndex(rows, selectedRow, maxRows) {
  if (maxRows <= 0 || rows.length <= maxRows) return rows;
  const offset = Math.max(0, Math.min(selectedRow - Math.floor(maxRows / 2), rows.length - maxRows));
  const sliced = rows.slice(offset, offset + maxRows);
  if (offset > 0) sliced[0] = color("  ↑ more", ANSI.dim);
  if (offset + maxRows < rows.length) sliced[sliced.length - 1] = color("  ↓ more", ANSI.dim);
  return sliced;
}

function fitMenuRows(frameRows, menuRows, selectedMenuRow) {
  const height = terminalHeight();
  if (!frameRows.length) {
    return sliceAroundIndex(menuRows, selectedMenuRow, height);
  }

  const minMenuRows = Math.min(menuRows.length, Math.max(5, Math.min(height, 10)));
  const maxFrameRows = Math.max(0, height - minMenuRows - 1);
  const visibleFrame = frameRows.length > maxFrameRows
    ? [...frameRows.slice(0, Math.max(0, maxFrameRows - 1)), color("  …", ANSI.dim)]
    : frameRows;
  const menuHeight = Math.max(1, height - visibleFrame.length - 1);
  return [...visibleFrame, "", ...sliceAroundIndex(menuRows, selectedMenuRow, menuHeight)];
}

async function selectMenu(title, options, opts = {}) {
  const fallback = opts.fallback || "";
  if (nonInteractive || !process.stdin.isTTY || !process.stdout.isTTY) {
    if (fallback) {
      const answer = await prompt(fallback);
      if (answer) {
        const byValue = options.find((option) => option.value === answer || option.key === answer);
        if (byValue) return byValue.value;
        const byIndex = Number(answer) - 1;
        if (byIndex >= 0 && byIndex < options.length) return options[byIndex].value;
      }
    }
    return options[opts.defaultIndex || 0].value;
  }

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdout.write(ANSI.cursorHide);

  let selected = opts.defaultIndex || 0;
  let renderedLines = 0;
  let frameRendered = false;
  let frameColumns = 0;
  let frameRows = 0;
  let frameBuffer = [];

  const render = () => {
    const columns = process.stdout.columns || 0;
    const rowsCount = process.stdout.rows || 0;
    const shouldRenderFrame = opts.renderFrame && (
      !frameRendered || columns !== frameColumns || rowsCount !== frameRows
    );

    if (shouldRenderFrame) {
      frameBuffer = outputRows(captureOutput(opts.renderFrame));
      frameRendered = true;
      frameColumns = columns;
      frameRows = rowsCount;
    } else if (!opts.renderFrame && renderedLines) {
      moveCursorUp(renderedLines - 1);
    }

    const rows = [
      interactiveLine(title),
      interactiveLine("↑/↓ move, Enter select, q quit"),
      "",
    ];
    let selectedMenuRow = rows.length;
    for (let i = 0; i < options.length; i += 1) {
      const option = options[i];
      const prefix = i === selected ? "❯" : " ";
      const key = option.key ? `${option.key}. ` : "";
      const label = interactiveLine(`${prefix} ${key}${option.label}`);
      if (i === selected) selectedMenuRow = rows.length;
      rows.push(i === selected ? `${ANSI.inverse}${label}${ANSI.reset}` : label);
      if (option.description) rows.push(interactiveLine(`    ${option.description}`));
    }
    if (opts.renderFrame) {
      renderScreenRows(fitMenuRows(frameBuffer, rows, selectedMenuRow));
      return;
    }
    renderedLines = renderInteractiveLines(rows, renderedLines);
  };

  return new Promise((resolve) => {
    const cleanup = (value) => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      if (!wasRaw && !fullscreen) process.stdin.pause();
      process.stdout.write(ANSI.reset);
      if (!fullscreen) process.stdout.write(`${ANSI.cursorShow}\n`);
      resolve(value);
    };

    const onKeypress = (str, key = {}) => {
      if (key.name === "up") {
        selected = (selected - 1 + options.length) % options.length;
        render();
      } else if (key.name === "down") {
        selected = (selected + 1) % options.length;
        render();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup(options[selected].value);
      } else if (key.name === "c" && key.ctrl) {
        cleanup("q");
      } else {
        const keyedIndex = options.findIndex((option) => option.key === str || option.value === str);
        if (keyedIndex !== -1) cleanup(options[keyedIndex].value);
        else if (str === "q" || key.name === "escape") cleanup("q");
      }
    };

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

async function confirmMenu(question, defaultValue = false) {
  const value = await selectMenu(question, [
    { key: "y", label: "Yes", value: "yes" },
    { key: "n", label: "No", value: "no" },
  ], {
    defaultIndex: defaultValue ? 0 : 1,
    fallback: `${question} ${defaultValue ? "[Y/n]" : "[y/N]"} `,
  });
  return value === "yes";
}

async function pauseScreen(renderFrame, title = "Done") {
  return selectMenu(title, [
    { key: "b", label: "Back", value: "back" },
  ], {
    renderFrame,
    fallback: "Press Enter to continue...",
  });
}

async function scrollableView(buildBuffer) {
  const buffer = buildBuffer();
  const height = terminalHeight();

  if (!process.stdin.isTTY || !process.stdout.isTTY || nonInteractive) {
    for (const l of buffer) line(l);
    line("");
    await prompt("Press Enter to continue...");
    return;
  }

  let scrollOffset = 0;
  const footerLines = 2;
  const viewportHeight = Math.max(3, height - footerLines);
  const maxOffset = Math.max(0, buffer.length - viewportHeight);
  const needsScroll = buffer.length > viewportHeight;

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdout.write(ANSI.cursorHide);

  const render = () => {
    const rows = [];
    const visible = buffer.slice(scrollOffset, scrollOffset + viewportHeight);
    rows.push(...visible);
    const remaining = height - visible.length - footerLines;
    for (let i = 0; i < remaining; i += 1) rows.push("");
    if (needsScroll) {
      const pct = maxOffset > 0 ? Math.round((scrollOffset / maxOffset) * 100) : 100;
      rows.push(color(`  ↑/↓/PgUp/PgDn scroll  (${pct}%)  lines ${scrollOffset + 1}-${Math.min(scrollOffset + viewportHeight, buffer.length)} of ${buffer.length}`, ANSI.dim));
    } else {
      rows.push("");
    }
    rows.push(color("  b/q/Enter — back", ANSI.dim));
    renderScreenRows(rows);
  };

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      if (!wasRaw && !fullscreen) process.stdin.pause();
      process.stdout.write(ANSI.reset);
      if (!fullscreen) process.stdout.write(`${ANSI.cursorShow}\n`);
      resolve("back");
    };

    const onKeypress = (str, key = {}) => {
      if (key.name === "up") {
        if (scrollOffset > 0) { scrollOffset -= 1; render(); }
      } else if (key.name === "down") {
        if (scrollOffset < maxOffset) { scrollOffset += 1; render(); }
      } else if (key.name === "pageup" || (key.name === "b" && key.ctrl)) {
        scrollOffset = Math.max(0, scrollOffset - (viewportHeight - 2));
        render();
      } else if (key.name === "pagedown" || (key.name === "f" && key.ctrl)) {
        scrollOffset = Math.min(maxOffset, scrollOffset + (viewportHeight - 2));
        render();
      } else if (key.name === "home") {
        scrollOffset = 0;
        render();
      } else if (key.name === "end") {
        scrollOffset = maxOffset;
        render();
      } else if (key.name === "return" || key.name === "enter" || str === "b" || str === "q" || key.name === "escape") {
        cleanup();
      } else if (key.name === "c" && key.ctrl) {
        cleanup();
      }
    };

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

function renderDetected(editors) {
  box("Editor Settings Sync", [
    "Cross-platform sync wizard for VS Code-like editors",
    `OS: ${platformKey()}  Home: ${os.homedir()}`,
    "Detect editors, collect snapshots, compare, then sync.",
  ]);
  table(["#", "Editor", "User", "Ext", "CLI"], editors.map((editor, index) => [
    String(index + 1),
    editor.name,
    editor.signals.userDir ? "yes" : "no",
    editor.signals.extensionsDir ? "yes" : "no",
    editor.signals.cli ? "yes" : "no",
  ]));
}

function snapshotProfileCount(snapshot, editor) {
  if (!supportsProfiles(editor)) return "0";
  const registered = new Set(readProfileNames(snapshot).keys());
  return String(listProfileDirs(path.join(snapshot, "user", "profiles"), registered).length);
}

function liveProfileLabel(editor) {
  if (!supportsProfiles(editor)) return "0";
  const registered = registeredProfileLocations(editor.userDir).size;
  const builtin = registeredBuiltinProfileCount(editor.userDir);
  const orphans = countOrphanProfileDirs(editor.userDir);
  let label = String(registered);
  if (builtin) label += ` (+${builtin} builtin)`;
  if (orphans) label += ` (+${orphans} orphan)`;
  return label;
}

function renderSummary(editors) {
  table(["Editor", "Settings", "Extensions", "Profiles"], editors.map((editor) => {
    const snapshot = path.join(SNAPSHOTS, editor.id);
    return [editor.name, String(settingsKeys(snapshot).length), String(readExtensionIds(snapshot).length), snapshotProfileCount(snapshot, editor)];
  }));
}

function renderDashboard(editors) {
  line("Editor Settings Sync");
  table(["Editor", "User", "Ext", "CLI", "Settings", "Profiles"], editors.map((editor) => {
    const snapshot = path.join(SNAPSHOTS, editor.id);
    return [
      editor.name,
      editor.signals.userDir ? "yes" : "no",
      editor.signals.extensionsDir ? "yes" : "no",
      editor.signals.cli ? "yes" : "no",
      String(settingsKeys(snapshot).length),
      liveProfileLabel(editor),
    ];
  }));
}

function collectSnapshots(editors) {
  pruneSnapshots(editors);
  const collected = [];
  for (const editor of editors) {
    clear();
    renderDetected(editors);
    line("");
    box("Collecting", [
      ...collected.map((name) => `done: ${name}`),
      `now: ${editor.name}`,
    ]);
    collectEditor(editor);
    collected.push(editor.name);
  }
}

function groupRowsByScope(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.scope;
    if (!groups.has(key)) groups.set(key, { scope: key, displayName: row.scopeDisplayName || key, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

function scopeHeader(displayName, scopeKey) {
  const label = scopeKey === "global" ? displayName : `${displayName} (${scopeKey.replace(/^profile:/, "")})`;
  return `── ${label} `;
}

function bufferEditorExtensions(editor) {
  const snapshot = path.join(SNAPSHOTS, editor.id);
  const buf = [];

  if (!exists(snapshot)) {
    buf.push(...bufferBox("Installed Extensions", [
      `Editor: ${editor.name} (${editor.id})`,
      "No snapshot found. Collect snapshots first.",
    ]));
    return buf;
  }

  const scopes = readExtensionScopes(snapshot, editor);
  const installed = readExtensionIds(snapshot).length;
  buf.push(...bufferBox("Installed Extensions", [
    `Editor: ${editor.name} (${editor.id})`,
    `Installed (global): ${installed}`,
    `Scopes: ${scopes.length}`,
  ]));

  for (const scope of scopes) {
    const entries = [...scope.extensions.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    buf.push("");
    const header = scopeHeader(scope.displayName, scope.name);
    const pad = Math.max(0, terminalWidth() - visibleLength(header) - 1);
    buf.push(color(`${header}${"─".repeat(pad)}`, ANSI.dim));
    if (!entries.length) {
      buf.push(color("  (none)", ANSI.dim));
      continue;
    }
    const tableRows = entries.map(([id, version]) => [id, version || "-"]);
    buf.push(...bufferTable(["Extension", "Version"], tableRows));
  }

  return buf;
}

function renderPair(source, target, analysis) {
  renderPairSummary(source, target, analysis);
  if (analysis.extensionRows.length) {
    renderExtensionRows(analysis.extensionRows, source.id, target.id);
  }
}

function bufferPair(source, target, analysis) {
  const buf = bufferPairSummary(source, target, analysis);
  if (analysis.extensionRows.length) {
    buf.push(...bufferExtensionRows(analysis.extensionRows, source.id, target.id));
  }
  return buf;
}

function pairSummaryLines(source, target, analysis) {
  const counts = analysis.extensionRows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  return [
    `Source: ${source.name}  (${source.id})`,
    `Target: ${target.name}  (${target.id})`,
    "",
    `Missing in target: ${counts.missing || 0}`,
    `Older in target:   ${counts.older || 0}`,
    `Different version: ${counts.different || 0}`,
    `Required patches:  ${counts.patch || 0}`,
    `Extra in target:   ${counts.extra || 0}`,
    `Replaced (alias):  ${counts.aliased || 0}`,
    `Ignored:           ${counts.ignored || 0}`,
    "",
    `Settings only in source: ${analysis.onlySourceSettings.length}`,
    `Settings only in target: ${analysis.onlyTargetSettings.length}`,
    `Source profiles: ${analysis.sourceProfiles.length}  Target profiles: ${analysis.targetProfiles.length}`,
  ];
}

function renderPairSummary(source, target, analysis) {
  box("Extension Comparison", pairSummaryLines(source, target, analysis));
}

function bufferPairSummary(source, target, analysis) {
  return bufferBox("Extension Comparison", pairSummaryLines(source, target, analysis));
}

function renderExtensionRows(rows, sourceId, targetId) {
  if (!rows.length) return;
  const groups = groupRowsByScope(rows);
  for (const group of groups) {
    line("");
    const header = scopeHeader(group.displayName, group.scope);
    const pad = Math.max(0, terminalWidth() - visibleLength(header) - 1);
    line(color(`${header}${"─".repeat(pad)}`, ANSI.dim));
    const tableRows = group.rows.map((row) => [
      row.id,
      row.sourceVersion !== undefined ? (row.sourceVersion || "-") : "—",
      row.targetVersion !== undefined ? (row.targetVersion || "-") : "—",
      statusLabel(row),
    ]);
    table(["Extension", sourceId, targetId, "Status"], tableRows);
  }
}

function bufferExtensionRows(rows, sourceId, targetId) {
  if (!rows.length) return [];
  const buf = [];
  const groups = groupRowsByScope(rows);
  for (const group of groups) {
    buf.push("");
    const header = scopeHeader(group.displayName, group.scope);
    const pad = Math.max(0, terminalWidth() - visibleLength(header) - 1);
    buf.push(color(`${header}${"─".repeat(pad)}`, ANSI.dim));
    const tableRows = group.rows.map((row) => [
      row.id,
      row.sourceVersion !== undefined ? (row.sourceVersion || "-") : "—",
      row.targetVersion !== undefined ? (row.targetVersion || "-") : "—",
      statusLabel(row),
    ]);
    buf.push(...bufferTable(["Extension", sourceId, targetId, "Status"], tableRows));
  }
  return buf;
}

function statusLabel(row) {
  const status = typeof row === "string" ? row : row.status;
  if (status === "patch") {
    return color(`patch for ${row.patchFor}`, ANSI.green);
  }
  if (status === "missing") return color("missing", ANSI.red);
  if (status === "extra") return color("extra", ANSI.dim);
  if (status === "older") return color("older", ANSI.orange);
  if (status === "different") return color("different", ANSI.magenta);
  if (status === "aliased") return color(`replaced by ${row.aliasId}`, ANSI.cyan);
  if (status === "ignored") return color("ignored", ANSI.blue);
  return status;
}

async function chooseEditor(editors, label, allEditors = editors) {
  const options = editors.map((editor, index) => ({
    key: String(index + 1),
    label: editor.name,
    value: editor.id,
    description: `${editor.id}${editor.aliases ? ` (${editor.aliases.join(", ")})` : ""}  user:${editor.signals.userDir ? "yes" : "no"}  ext:${editor.signals.extensionsDir ? "yes" : "no"}  cli:${editor.signals.cli ? "yes" : "no"}`,
  }));
  options.push({ key: "b", label: "Back", value: "back" });

  const value = await selectMenu(label, options, {
    fallback: `${label} [1-${editors.length}, b]: `,
    renderFrame: () => renderDashboard(allEditors),
  });
  if (value === "back" || value === "q") return null;
  return editors.find((editor) => editor.id === value) || null;
}

async function runInteractive() {
  if (fullscreen) process.stdout.write(`${ANSI.enterAlt}${ANSI.cursorHide}`);

  try {
    clear();
    const editors = detectEditors();
    if (!editors.length) {
      box("No Editors Found", ["No supported editor was found.", "Check VS Code, Cursor, Antigravity IDE, or Devin installation."]);
      process.exitCode = 1;
      return;
    }

    if (!fullscreen) {
      renderDetected(editors);
      line("");
    }
    const shouldCollect = await selectMenu("Collect fresh snapshots now?", [
      { key: "y", label: "Yes", value: "yes" },
      { key: "n", label: "No", value: "no" },
    ], {
      defaultIndex: 0,
      fallback: "Collect fresh snapshots now? [Y/n] ",
      renderFrame: () => renderDetected(editors),
    });

    if (shouldCollect === "q") return;
    if (shouldCollect === "yes") {
      collectSnapshots(editors);
    }

    if (editors.length < 2) {
      clear();
      renderDashboard(editors);
      return;
    }

    while (true) {
      const action = await selectMenu("Actions", [
        { key: "1", label: "Collect/update snapshots", value: "collect" },
        { key: "2", label: "List extensions for one editor", value: "list_extensions" },
        { key: "3", label: "Analyze an editor pair", value: "analyze" },
        { key: "4", label: "Sync settings/profiles", value: "sync" },
        { key: "5", label: "Sync extensions via CLI", value: "extensions" },
        { key: "6", label: "Remove orphan profile folders", value: "prune_orphans" },
        { key: "q", label: "Quit", value: "q" },
      ], {
        fallback: "Choice: ",
        renderFrame: () => renderDashboard(editors),
      });
      if (action === "q") break;

      if (action === "collect") {
        collectSnapshots(editors);
        await pauseScreen(() => renderDashboard(editors), "Snapshots Updated");
      } else if (action === "list_extensions") {
        const editor = await chooseEditor(editors, "List extensions for", editors);
        if (!editor) continue;
        const snapshot = path.join(SNAPSHOTS, editor.id);
        if (!exists(snapshot)) {
          const collectNow = await selectMenu(`No snapshot for ${editor.name}. Collect now?`, [
            { key: "y", label: "Yes", value: "yes" },
            { key: "n", label: "No", value: "no" },
          ], {
            defaultIndex: 0,
            fallback: `Collect snapshot for ${editor.name} now? [Y/n] `,
            renderFrame: () => renderDashboard(editors),
          });
          if (collectNow !== "yes") continue;
          collectEditor(editor);
        }
        await scrollableView(() => bufferEditorExtensions(editor));
      } else if (action === "analyze") {
        const source = await chooseEditor(editors.filter((e) => e.id === "vscode" || e.id === "cursor"), "Source (baseline)", editors);
        if (!source) continue;
        const target = await chooseEditor(editors.filter((e) => e.id !== source.id), "Compare with", editors);
        if (!target) continue;
        const analysis = analyzePair(source, target);
        await scrollableView(() => bufferPair(source, target, analysis));
      } else if (action === "sync") {
        const source = await chooseEditor(editors.filter((e) => e.id === "vscode" || e.id === "cursor"), "Source", editors);
        if (!source) continue;
        const target = await chooseEditor(editors.filter((e) => e.id !== source.id), "Target", editors);
        if (!target) continue;
        const analysis = analyzePair(source, target);
        const syncLabel = `Copy settings/snippets/profiles/MCP ${source.id} -> ${target.id}?`;
        const confirmed = await selectMenu(syncLabel, [
          { key: "y", label: "Yes", value: "yes" },
          { key: "n", label: "No", value: "no" },
        ], {
          defaultIndex: 1,
          fallback: `${syncLabel} [y/N] `,
          renderFrame: () => renderPair(source, target, analysis),
        });
        if (confirmed !== "yes") continue;
        const itemsToCopy = ["settings.json", "keybindings.json", "snippets", "mcp.json", "chatLanguageModels.json"];
        if (supportsProfiles(target)) {
          itemsToCopy.push("profiles");
        }
        const backup = backupAndCopy(source, target, itemsToCopy);
        const appScopePlan = applicationScopedPlan(source, target);
        await pauseScreen(() => box("Sync Complete", [
          `Backup: ${backup}`,
          "Profile settings were merged in place; extensions.json in each profile was left untouched.",
          ...profileHealthSummaryLines(target),
          ...applicationScopedSummaryLines(appScopePlan),
        ]), "Continue");
      } else if (action === "extensions") {
        const source = await chooseEditor(editors.filter((e) => e.id === "vscode" || e.id === "cursor"), "Extension source", editors);
        if (!source) continue;
        const target = await chooseEditor(editors.filter((e) => e.id !== source.id), "Install target", editors);
        if (!target) continue;
        const analysis = analyzePair(source, target);
        const appScopePlan = applicationScopedPlan(source, target);

        const mode = await selectMenu("Choose extension sync mode", [
          { key: "1", label: "Install missing only", value: "missing" },
          { key: "2", label: "Install missing and update older versions", value: "missing_update" },
          { key: "3", label: "Full sync: install/update, keep target-only extensions", value: "full_keep" },
          { key: "4", label: "Full sync: install/update and remove target-only extensions", value: "full_clean" },
          { key: "b", label: "Back", value: "back" },
        ], {
          fallback: "Mode: ",
          renderFrame: () => renderPair(source, target, analysis),
        });
        if (mode === "back" || mode === "q") continue;

        // Build list of tasks based on selected mode
        const tasks = [];
        for (const row of analysis.extensionRows) {
          if (row.status === "ignored" || row.status === "aliased") continue;
          if (patchInstallBlocked(row, analysis, mode)) continue;

          if (mode === "missing") {
            if (row.status === "missing" || isMissingPatchRow(row)) {
              tasks.push({
                id: extensionInstallId(row.id, target.id),
                sourceId: row.id,
                profileDisplayName: row.scopeDisplayName,
                version: row.sourceVersion,
                action: "install",
              });
            }
          } else if (mode === "missing_update") {
            if (row.status === "missing" || row.status === "older" || isMissingPatchRow(row)) {
              tasks.push({
                id: extensionInstallId(row.id, target.id),
                sourceId: row.id,
                profileDisplayName: row.scopeDisplayName,
                version: row.sourceVersion,
                action: "install",
              });
            }
          } else if (mode === "full_keep") {
            if (row.status === "missing" || row.status === "older" || row.status === "different" || isMissingPatchRow(row)) {
              tasks.push({
                id: extensionInstallId(row.id, target.id),
                sourceId: row.id,
                profileDisplayName: row.scopeDisplayName,
                version: row.sourceVersion,
                action: "install",
              });
            }
          } else if (mode === "full_clean") {
            if (row.status === "missing" || row.status === "older" || row.status === "different" || isMissingPatchRow(row)) {
              tasks.push({
                id: extensionInstallId(row.id, target.id),
                sourceId: row.id,
                profileDisplayName: row.scopeDisplayName,
                version: row.sourceVersion,
                action: "install",
              });
            } else if (row.status === "extra") {
              tasks.push({
                id: row.id,
                profileDisplayName: row.scopeDisplayName,
                version: row.targetVersion,
                action: "uninstall",
              });
            }
          }
        }

        const modeLabel = (m) => {
          if (m === "missing") return "Install missing";
          if (m === "missing_update") return "Install missing and update older";
          if (m === "full_keep") return "Full sync (keep target-only)";
          if (m === "full_clean") return "Full sync (remove target-only)";
          return m;
        };

        const uninstalls = tasks.filter((t) => t.action === "uninstall");

        const ignoredCount = analysis.extensionRows.filter((row) => row.status === "ignored").length;
        const aliasedCount = analysis.extensionRows.filter((row) => row.status === "aliased").length;

        const renderInstall = () => {
          const installsAfterPatches = tasks.filter((t) => t.action === "install");
          box("Extension Sync", [
            `Mode: ${modeLabel(mode)}`,
            `Planned actions: ${tasks.length}`,
            `  - Install/update: ${installsAfterPatches.length}`,
            `  - Uninstall: ${uninstalls.length}`,
            `All-profile flag differences: ${appScopePlan.ids.length}`,
            `Replaced (alias): ${aliasedCount}`,
            `Ignored: ${ignoredCount}`,
            `Target CLI: ${target.cliPath || "not found"}`,
          ]);

          // Show only rows that correspond to our tasks
          const tasksKeys = new Set(tasks.map((t) => `${t.profileDisplayName || "Default"}:${t.sourceId || t.id}`));
          const filteredRows = analysis.extensionRows.filter((row) => tasksKeys.has(`${row.scopeDisplayName || "Default"}:${row.id}`));
          if (filteredRows.length) {
            renderExtensionRows(filteredRows, source.id, target.id);
          }
        };

        if (!tasks.length) {
          await pauseScreen(() => {
            box("Extension Sync", [
              `Mode: ${modeLabel(mode)}`,
              "No actions needed. Extensions already match the selected mode.",
              ...applicationScopedSummaryLines(appScopePlan),
            ]);
          }, "Continue");
          continue;
        }

        const confirmed = await selectMenu(`Run ${tasks.length} actions in ${target.id}?`, [
          { key: "y", label: "Yes", value: "yes" },
          { key: "n", label: "No", value: "no" },
        ], {
          defaultIndex: 1,
          fallback: `Run actions? [y/N] `,
          renderFrame: renderInstall,
        });
        if (confirmed !== "yes") continue;

        const profileHealth = profileHealthSummaryLines(target);
        if (profileHealth.length) {
          await pauseScreen(() => box("Profile Extension Warning", profileHealth), "Continue anyway");
        }

        clear();
        line("Starting extension sync...");
        line("Close the target editor first to avoid extension state corruption.");
        line("");
        const result = await syncExtensions(source, target, tasks);
        line("");
        await pauseScreen(() => box("Sync Complete", [
          `Succeeded: ${result.ok}/${result.attempted}`,
          `Failed: ${result.failed.length}`,
          ...applicationScopedSummaryLines(appScopePlan),
          result.failed.length ? "Failure details were saved to logs/" : "No failures.",
        ]), "Continue");
      } else if (action === "prune_orphans") {
        const candidates = editors.filter((editor) => supportsProfiles(editor));
        if (!candidates.length) {
          await pauseScreen(() => box("Orphan Profiles", ["No profile-aware editors were found."]), "Continue");
          continue;
        }
        const editor = await chooseEditor(candidates, "Remove orphan profiles for", editors);
        if (!editor) continue;
        const plan = orphanProfilePlan(editor);
        if (!plan.orphans.length) {
          await pauseScreen(() => box("Orphan Profiles", bufferOrphanProfilePlan(editor)), "Continue");
          continue;
        }
        const confirmed = await selectMenu(`Remove ${plan.orphans.length} orphan profile folders from ${editor.id}?`, [
          { key: "y", label: "Yes", value: "yes" },
          { key: "n", label: "No", value: "no" },
        ], {
          defaultIndex: 1,
          fallback: `Remove orphan profile folders? [y/N] `,
          renderFrame: () => box("Orphan Profiles", bufferOrphanProfilePlan(editor)),
        });
        if (confirmed !== "yes") continue;
        const result = pruneOrphanProfiles(editor);
        await pauseScreen(() => box("Orphan Profiles Removed", [
          `Removed: ${result.removed.length}`,
          ...result.removed.map((location) => `  - ${location}`),
          result.backup ? `Backup: ${result.backup}` : "",
        ].filter(Boolean)), "Continue");
      }
    }
  } finally {
    if (fullscreen) {
      process.stdin.pause();
      process.stdout.write(`${ANSI.clearScreen}${ANSI.reset}${ANSI.cursorShow}${ANSI.exitAlt}`);
    }
  }
}

function printHelp() {
  line("Usage:");
  line("  ./sync.sh | sync.bat           # interactive TUI");
  line("  ./sync.sh --detect             # print detected editors");
  line("  ./sync.sh --collect            # collect all detected editors");
  line("  ./sync.sh --analyze A B");
  line("  ./sync.sh --prune-orphan-profiles [editor] [-y]");
  line("  node scripts/sync.js ...       # direct launch on any OS");
}

function runPruneOrphanProfiles(editors, args) {
  const pruneAt = args.indexOf("--prune-orphan-profiles");
  const editorArg = args[pruneAt + 1];
  const hasEditorArg = editorArg && !editorArg.startsWith("-");
  const targets = hasEditorArg
    ? [findEditor(editors, editorArg)].filter(Boolean)
    : editors.filter((editor) => supportsProfiles(editor));

  if (hasEditorArg && !targets.length) {
    line("Unknown editor id. Run --detect first.");
    process.exitCode = 2;
    return;
  }
  if (!targets.length) {
    line("No profile-aware editors were found.");
    return;
  }

  const autoConfirm = args.includes("--yes") || args.includes("-y");
  let removedTotal = 0;

  for (const editor of targets) {
    const plan = orphanProfilePlan(editor);
    for (const row of bufferOrphanProfilePlan(editor)) line(row);
    if (!plan.orphans.length) {
      line("");
      continue;
    }
    if (!autoConfirm) {
      line("Re-run with --yes to remove these orphan profile folders.");
      process.exitCode = 2;
      return;
    }
    const result = pruneOrphanProfiles(editor);
    removedTotal += result.removed.length;
    line(`Removed: ${result.removed.length}`);
    if (result.backup) line(`Backup: ${result.backup}`);
    line("");
  }

  if (!removedTotal) {
    line("No orphan profile folders were removed.");
  }
}

function runCli() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return printHelp();
  const editors = detectEditors();
  if (args.includes("--detect")) return renderDetected(editors);
  if (args.includes("--collect")) {
    pruneSnapshots(editors);
    for (const editor of editors) {
      line(`collecting ${editor.id}`);
      collectEditor(editor);
    }
    return renderSummary(editors);
  }
  const analyzeAt = args.indexOf("--analyze");
  if (analyzeAt !== -1) {
    const source = findEditor(editors, args[analyzeAt + 1]);
    const target = findEditor(editors, args[analyzeAt + 2]);
    if (!source || !target) {
      line("Unknown editor id. Run --detect first.");
      process.exitCode = 2;
      return;
    }
    return renderPair(source, target, analyzePair(source, target));
  }
  if (args.includes("--prune-orphan-profiles")) {
    return runPruneOrphanProfiles(editors, args);
  }
  return runInteractive();
}

runCli();
