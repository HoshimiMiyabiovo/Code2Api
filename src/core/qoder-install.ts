import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface QoderInstallInfo {
  /** 安装版本目录名（如 0.5.17）；根目录回退时为 installed。 */
  version: string;
  /** Qoder.exe（IDE 同款 Electron 主程序）。 */
  command: string;
  /** 传给 Qoder.exe 的参数（worker runtime 入口）。 */
  args: string[];
  /** 拉起内嵌 runtime 必需的环境变量。 */
  env: Record<string, string>;
}

const RUNTIME_REL =
  'resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs';

/** 面板「检测本机 Qoder」的候选安装根目录；按优先级去重。 */
export function qoderInstallRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value && value.trim()) roots.add(value);
  };
  add(env.QODER_HOME);
  add(env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'Qoder') : undefined);
  add(env.ProgramFiles ? join(env.ProgramFiles, 'Qoder') : undefined);
  add(env['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'Qoder') : undefined);
  add(env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local', 'Programs', 'Qoder') : undefined);
  if (process.platform === 'win32') {
    // Qoder 允许装到非系统盘（本机就是 E:）；只扫常见盘符，避免碰断开的网络盘。
    for (const letter of 'CDEFGH') {
      roots.add(`${letter}:\\Program Files\\Qoder`);
      roots.add(`${letter}:\\Program Files (x86)\\Qoder`);
    }
  }
  return [...roots];
}

const CLI_CREDENTIAL_FILES = [
  'qoder-cli-credentials.json',
  'qoder-cli-cn-credentials.json',
  join('.auth', 'user'),
];

/** Qoder CLI 的 scrypt 登录凭据位置；IDE 登录态不在这里，两者互不通用。 */
export function qoderCliCredentialPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const root =
    env.QODER_CONFIG_DIR?.trim() ||
    env.QODER_HOME?.trim() ||
    (env.USERPROFILE?.trim()
      ? join(env.USERPROFILE.trim(), '.qoder')
      : join(homedir(), '.qoder'));
  return CLI_CREDENTIAL_FILES.map((file) => join(root, file));
}

export function qoderCliLoginHint(env: NodeJS.ProcessEnv = process.env): string | null {
  const paths = qoderCliCredentialPaths(env);
  if (paths.some((path) => existsSync(path))) return null;
  return `未找到 CLI 登录态（${paths[0] ?? 'qoder-cli-credentials.json'} / .auth/user）；IDE 登录不等于 CLI 登录，请安装 Qoder CLI 并执行 qodercli login；或为网关进程设置 QODER_PERSONAL_ACCESS_TOKEN / QODERCN_PERSONAL_ACCESS_TOKEN 环境变量（勿在面板填写明文）`;
}

function versionScore(version: string): number[] {
  return version
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((part) => Number(part) || 0);
}

function compareVersions(a: string, b: string): number {
  const left = versionScore(a);
  const right = versionScore(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function inspectRoot(root: string): QoderInstallInfo[] {
  const found: QoderInstallInfo[] = [];
  const versionsDir = join(root, '.qoder-versions');
  if (existsSync(versionsDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(versionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[0-9]/.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      entries = [];
    }
    for (const version of entries) {
      const versionRoot = join(versionsDir, version);
      const command = join(versionRoot, 'Qoder.exe');
      const runtime = join(versionRoot, RUNTIME_REL);
      try {
        if (statSync(command).isFile() && statSync(runtime).isFile()) {
          found.push({
            version,
            command,
            args: [runtime],
            env: { ELECTRON_RUN_AS_NODE: '1' },
          });
        }
      } catch {
        // 版本目录不完整：跳过，继续找其它版本。
      }
    }
  }
  // 兜底：部分安装把 runtime 留在安装根目录（不带版本目录）。
  const rootCommand = join(root, 'Qoder.exe');
  const rootRuntime = join(root, RUNTIME_REL);
  try {
    if (statSync(rootCommand).isFile() && statSync(rootRuntime).isFile()) {
      found.push({
        version: 'installed',
        command: rootCommand,
        args: [rootRuntime],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      });
    }
  } catch {
    // ignore
  }
  return found;
}

/** 扫描候选目录，返回版本最高的可用 Qoder 安装；找不到返回 null。 */
export function detectQoderInstall(
  roots: string[] = qoderInstallRoots(),
): QoderInstallInfo | null {
  const candidates: QoderInstallInfo[] = [];
  for (const root of roots) {
    try {
      if (!existsSync(root)) continue;
      candidates.push(...inspectRoot(root));
    } catch {
      // 权限/竞态：跳过该根目录。
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0] ?? null;
}
