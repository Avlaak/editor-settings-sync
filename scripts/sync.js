#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SNAPSHOTS = path.join(ROOT, "snapshots");
const BACKUPS = path.join(ROOT, "backups");
const VSIX_CACHE = path.join(ROOT, "vsix_cache");
const SAFE_USER_ITEMS = ["settings.json", "keybindings.json", "extensions.json", "mcp.json", "chatLanguageModels.json", "snippets"];
const PROFILE_USER_ITEMS = SAFE_USER_ITEMS.filter((item) => item !== "extensions.json");
const ANSI = {
  clearLine: "\x1b[2K",
  clearScreen: "\x1b[2J\x1b[H",
  cursorHide: "\x1b[?25l",
  cursorShow: "\x1b[?25h",
  enterAlt: "\x1b[?1049h",
  exitAlt: "\x1b[?1049l",
  inverse: "\x1b[7m",
  red: "\x1b[31m",
  orange: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

const EDITOR_EXTENSION_IGNORE = {
  cursor: new Set(["anysphere.cursorpyright", "anysphere.remote-ssh"]),
  devin: new Set(["codeium.windsurfpyright"]),
  vscode: new Set(["ms-vscode.cpp-devtools", "ms-dotnettools.csdevkit", "ms-dotnettools.csharp", "ms-python.vscode-pylance"]),
};

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
];

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

function copyProfiles(src, dst, { includeExtensions = false } = {}) {
  if (!isDir(src)) return;
  const items = includeExtensions ? SAFE_USER_ITEMS : PROFILE_USER_ITEMS;
  ensureDir(dst);
  for (const profileName of fs.readdirSync(src)) {
    if (profileName === "builtin") continue;
    const profileDir = path.join(src, profileName);
    if (!isDir(profileDir)) continue;
    const profileOut = path.join(dst, profileName);
    ensureDir(profileOut);
    for (const item of items) copyIfExists(path.join(profileDir, item), path.join(profileOut, item));

    const agentsDir = path.join(profileDir, "agents");
    if (!isDir(agentsDir)) continue;
    for (const agentName of fs.readdirSync(agentsDir)) {
      const agentDir = path.join(agentsDir, agentName);
      if (!isDir(agentDir)) continue;
      const agentOut = path.join(profileOut, "agents", agentName);
      ensureDir(agentOut);
      for (const item of items) copyIfExists(path.join(agentDir, item), path.join(agentOut, item));
    }
  }
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
      copyProfiles(path.join(editor.userDir, "profiles"), path.join(out, "user", "profiles"), { includeExtensions: true });
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

function extensionStatus(sourceEditorId, id, sourceVersion, targetVersion) {
  if (isIgnoredExtension(sourceEditorId, id)) return "ignored";
  if (targetVersion === undefined) return "missing";
  if (sourceVersion && targetVersion && sourceVersion !== targetVersion) {
    return compareVersions(targetVersion, sourceVersion) < 0 ? "older" : "different";
  }
  return "same";
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
      const targetVersion = targetExts.has(id) ? targetExts.get(id) : undefined;
      const status = extensionStatus(source.id, id, sourceVersion, targetVersion);
      if (status === "same") continue;
      rows.push({
        scope: sourceScope.name,
        scopeDisplayName: sourceScope.displayName || sourceScope.name,
        id,
        sourceVersion,
        targetVersion,
        status,
      });
    }

    // Target-only extensions → "extra"
    for (const [id, targetVersion] of [...targetExts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (sourceExts.has(id)) continue;
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
      rows.push({
        scope: sourceScope.name,
        scopeDisplayName: sourceScope.displayName || sourceScope.name,
        id,
        sourceVersion: undefined,
        targetVersion,
        status: "extra",
      });
    }
  }

  return rows;
}

function readProfileNames(snapshot) {
  const storageJson = readJson(path.join(snapshot, "user", "globalStorage", "storage.json"));
  const map = new Map();
  if (!storageJson) return map;
  const profiles = storageJson.userDataProfiles || [];
  for (const profile of profiles) {
    if (profile.location && profile.name) {
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
  for (const profile of listDirs(profilesDir)) {
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
  const sourceProfiles = supportsProfiles(source) ? listDirs(path.join(sourceSnap, "user", "profiles")) : [];
  const targetProfiles = supportsProfiles(target) ? listDirs(path.join(targetSnap, "user", "profiles")) : [];
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

async function downloadVsix(id, version) {
  ensureVsixCache();

  const cacheName = version ? `${id}-${version}.vsix` : `${id}-latest.vsix`;
  const cachedPath = path.join(VSIX_CACHE, cacheName);

  if (exists(cachedPath)) {
    return { path: cachedPath, source: "cache" };
  }

  const parts = id.split(".");
  const publisher = parts[0];
  const extensionName = parts.slice(1).join(".");

  const versionStr = version || "latest";
  const marketUrl = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${publisher}/vsextensions/${extensionName}/${versionStr}/vspackage`;

  try {
    const res = await fetch(marketUrl);
    if (res.status === 200) {
      const buf = await res.arrayBuffer();
      fs.writeFileSync(cachedPath, Buffer.from(buf));
      return { path: cachedPath, source: "VS Code Marketplace" };
    }
  } catch (e) {
    // try next
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
          const buf = await downloadRes.arrayBuffer();
          fs.writeFileSync(cachedPath, Buffer.from(buf));
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
    rmrf(targetItem);
    if (item === "profiles") {
      copyProfiles(sourceItem, targetItem);
    } else {
      copyRecursive(sourceItem, targetItem);
    }
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

    // Prepare CLI args
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

function visibleLength(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "").length;
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
  if (maxWidth <= 1) return "…";
  return `${value.slice(0, Math.max(0, maxWidth - 1))}…`;
}

function wrapText(text, maxWidth) {
  const value = String(text);
  if (maxWidth <= 0) return [""];
  const lines = [];
  for (const rawLine of value.split(/\r?\n/)) {
    let lineValue = rawLine;
    while (visibleLength(lineValue) > maxWidth) {
      let cut = Math.min(lineValue.length, maxWidth);
      const space = lineValue.slice(0, cut + 1).lastIndexOf(" ");
      if (space > Math.floor(maxWidth * 0.55)) cut = space;
      lines.push(lineValue.slice(0, cut).trimEnd());
      lineValue = lineValue.slice(cut).trimStart();
    }
    lines.push(lineValue);
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
  if (process.stdout.isTTY) process.stdout.write(ANSI.clearScreen);
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
  if (lines > 0) process.stdout.write(`\x1b[${lines}A`);
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

  const render = () => {
    if (opts.renderFrame) {
      clear();
      opts.renderFrame();
      line("");
      renderedLines = 0;
    } else if (renderedLines) {
      moveCursorUp(renderedLines);
    }

    const rows = [];
    rows.push(title);
    rows.push("↑/↓ move, Enter select, q quit");
    rows.push("");
    for (let i = 0; i < options.length; i += 1) {
      const option = options[i];
      const prefix = i === selected ? "❯" : " ";
      const key = option.key ? `${option.key}. ` : "";
      const label = `${prefix} ${key}${option.label}`;
      rows.push(i === selected ? `${ANSI.inverse}${label}${ANSI.reset}` : label);
      if (option.description) rows.push(`    ${option.description}`);
    }
    renderedLines = rows.length;
    process.stdout.write(rows.map((row) => `${ANSI.clearLine}${row}`).join("\n"));
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
    clear();
    const visible = buffer.slice(scrollOffset, scrollOffset + viewportHeight);
    for (const l of visible) line(l);
    const remaining = height - visible.length - footerLines;
    for (let i = 0; i < remaining; i += 1) line("");
    if (needsScroll) {
      const pct = maxOffset > 0 ? Math.round((scrollOffset / maxOffset) * 100) : 100;
      line(color(`  ↑/↓/PgUp/PgDn scroll  (${pct}%)  lines ${scrollOffset + 1}-${Math.min(scrollOffset + viewportHeight, buffer.length)} of ${buffer.length}`, ANSI.dim));
    } else {
      line("");
    }
    line(color("  b/q/Enter — back", ANSI.dim));
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

function renderSummary(editors) {
  table(["Editor", "Settings", "Extensions", "Profiles"], editors.map((editor) => {
    const snapshot = path.join(SNAPSHOTS, editor.id);
    const profiles = supportsProfiles(editor) ? listDirs(path.join(snapshot, "user", "profiles")).length : 0;
    return [editor.name, String(settingsKeys(snapshot).length), String(readExtensionIds(snapshot).length), String(profiles)];
  }));
}

function renderDashboard(editors) {
  renderDetected(editors);
  line("");
  renderSummary(editors);
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
    `Extra in target:   ${counts.extra || 0}`,
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
      statusLabel(row.status),
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
      statusLabel(row.status),
    ]);
    buf.push(...bufferTable(["Extension", sourceId, targetId, "Status"], tableRows));
  }
  return buf;
}

function statusLabel(status) {
  if (status === "missing") return color("missing", ANSI.red);
  if (status === "extra") return color("extra", ANSI.dim);
  if (status === "older") return color("older", ANSI.orange);
  if (status === "different") return color("different", ANSI.magenta);
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

    clear();
    renderDashboard(editors);
    if (editors.length < 2) return;

    while (true) {
      const action = await selectMenu("Actions", [
        { key: "1", label: "Collect/update snapshots", value: "collect" },
        { key: "2", label: "Analyze an editor pair", value: "analyze" },
        { key: "3", label: "Sync settings/profiles", value: "sync" },
        { key: "4", label: "Sync extensions via CLI", value: "extensions" },
        { key: "q", label: "Quit", value: "q" },
      ], {
        fallback: "Choice: ",
        renderFrame: () => renderDashboard(editors),
      });
      if (action === "q") break;

      if (action === "collect") {
        collectSnapshots(editors);
        await pauseScreen(() => renderDashboard(editors), "Snapshots Updated");
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
        const confirmed = await selectMenu(`Copy settings/snippets/profiles/MCP ${source.id} -> ${target.id}?`, [
          { key: "y", label: "Yes", value: "yes" },
          { key: "n", label: "No", value: "no" },
        ], {
          defaultIndex: 1,
          fallback: `Copy settings/snippets/profiles/MCP ${source.id} -> ${target.id}? [y/N] `,
          renderFrame: () => renderPair(source, target, analysis),
        });
        if (confirmed !== "yes") continue;
        const itemsToCopy = ["settings.json", "keybindings.json", "snippets", "mcp.json", "chatLanguageModels.json"];
        if (supportsProfiles(target)) {
          itemsToCopy.push("profiles");
        }
        const backup = backupAndCopy(source, target, itemsToCopy);
        await pauseScreen(() => box("Sync Complete", [`Backup: ${backup}`]), "Continue");
      } else if (action === "extensions") {
        const source = await chooseEditor(editors.filter((e) => e.id === "vscode" || e.id === "cursor"), "Extension source", editors);
        if (!source) continue;
        const target = await chooseEditor(editors.filter((e) => e.id !== source.id), "Install target", editors);
        if (!target) continue;
        const analysis = analyzePair(source, target);

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
          if (row.status === "ignored") continue;

          if (mode === "missing") {
            if (row.status === "missing") {
              tasks.push({
                id: row.id,
                profileDisplayName: row.scopeDisplayName,
                version: row.sourceVersion,
                action: "install",
              });
            }
          } else if (mode === "missing_update") {
            if (row.status === "missing" || row.status === "older") {
              tasks.push({
                id: row.id,
                profileDisplayName: row.scopeDisplayName,
                version: row.sourceVersion,
                action: "install",
              });
            }
          } else if (mode === "full_keep") {
            if (row.status === "missing" || row.status === "older" || row.status === "different") {
              tasks.push({
                id: row.id,
                profileDisplayName: row.scopeDisplayName,
                version: row.sourceVersion,
                action: "install",
              });
            }
          } else if (mode === "full_clean") {
            if (row.status === "missing" || row.status === "older" || row.status === "different") {
              tasks.push({
                id: row.id,
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

        const installs = tasks.filter((t) => t.action === "install");
        const uninstalls = tasks.filter((t) => t.action === "uninstall");
        const ignoredCount = analysis.extensionRows.filter((row) => row.status === "ignored").length;

        const renderInstall = () => {
          box("Extension Sync", [
            `Mode: ${modeLabel(mode)}`,
            `Planned actions: ${tasks.length}`,
            `  - Install/update: ${installs.length}`,
            `  - Uninstall: ${uninstalls.length}`,
            `Ignored: ${ignoredCount}`,
            `Target CLI: ${target.cliPath || "not found"}`,
          ]);

          // Show only rows that correspond to our tasks
          const tasksKeys = new Set(tasks.map((t) => `${t.profileDisplayName || "Default"}:${t.id}`));
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

        clear();
        line("Starting extension sync...");
        line("");
        const result = await syncExtensions(source, target, tasks);
        line("");
        await pauseScreen(() => box("Sync Complete", [
          `Succeeded: ${result.ok}/${result.attempted}`,
          `Failed: ${result.failed.length}`,
          result.failed.length ? "Failure details were saved to logs/" : "No failures."
        ]), "Continue");
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
  line("  ./scripts/sync.sh              # interactive TUI");
  line("  ./scripts/sync.sh --detect     # print detected editors");
  line("  ./scripts/sync.sh --collect    # collect all detected editors");
  line("  ./scripts/sync.sh --analyze A B");
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
  return runInteractive();
}

runCli();
