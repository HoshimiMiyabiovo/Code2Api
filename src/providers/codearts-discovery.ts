import { createDecipheriv, scryptSync } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * CodeArts Agent IDE 内核服务发现（v126.11.1 实测）：
 * - IDE 扩展把内核端口/PID 写在 <dataDir 上级>/CodeArts_Agent/ 下各 Vscode_* 目录的 server_config.properties；
 * - 服务口令 AES-256-GCM 加密存于数据目录：4/data 是 base64 包裹的 scrypt secret，
 *   custom-dir/data 是 {authTag,ciphertext}，2/data 是 salt，3/data 是 iv（均 base64 JSON 字符串）；
 *   scrypt 参数 N=65536,r=8,p=1（逆向自 vscode-codebot extension.js）。
 * - Basic 认证用户名是 codearts（不是 opencode）。
 * 口令只在内存中使用，不落盘、不打印。
 */

export interface CodeArtsEndpoint {
  baseUrl: string;
  password: string;
  pid: number | null;
}

export function defaultCodeArtsDataDir(): string {
  return join(homedir(), '.codeartsdoer', 'codearts-data');
}

function readJsonFile(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 解密 IDE 内核服务口令；文件缺失/损坏时返回 null（IDE 未运行或尚未生成）。 */
export function decryptCodeArtsPassword(dataDir: string): string | null {
  try {
    const secret = Buffer.from(
      readFileSync(join(dataDir, '4', 'data'), 'utf8').trim(),
      'base64',
    ).toString('utf8');
    const cipher = readJsonFile(join(dataDir, 'custom-dir', 'data'));
    const salt = readJsonFile(join(dataDir, '2', 'data'));
    const iv = readJsonFile(join(dataDir, '3', 'data'));
    const key = scryptSync(secret, Buffer.from(salt, 'base64'), 32, {
      N: 65536,
      r: 8,
      p: 1,
      maxmem: 128 * 1024 * 1024,
    });
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(cipher.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(cipher.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** 从 server_config.properties 发现内核端口；取最新修改的一份。 */
export function discoverCodeArtsPort(dataDir: string): { port: number; pid: number | null } | null {
  try {
    // 数据目录默认 ~/.codeartsdoer/codearts-data，配置目录在其上级的 CodeArts_Agent 下。
    const agentDir = join(dataDir, '..', 'CodeArts_Agent');
    const candidates: Array<{ path: string; mtime: number }> = [];
    for (const entry of readdirSync(agentDir)) {
      const propsPath = join(agentDir, entry, 'server_config.properties');
      try {
        const stat = statSync(propsPath);
        if (stat.isFile()) candidates.push({ path: propsPath, mtime: stat.mtimeMs });
      } catch {
        // 该版本目录没有配置文件
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const candidate of candidates) {
      const text = readFileSync(candidate.path, 'utf8');
      const fields = new Map<string, string>();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const index = trimmed.indexOf('=');
        if (index <= 0) continue;
        fields.set(trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim());
      }
      const port = Number(fields.get('port'));
      if (Number.isInteger(port) && port > 0) {
        const pid = Number(fields.get('pid'));
        return { port, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 发现并解密 CodeArts IDE 内核端点；任一环节缺失返回 null。 */
export function resolveCodeArtsEndpoint(dataDir: string): CodeArtsEndpoint | null {
  const discovered = discoverCodeArtsPort(dataDir);
  if (!discovered) return null;
  const password = decryptCodeArtsPassword(dataDir);
  if (!password) return null;
  return {
    baseUrl: `http://127.0.0.1:${discovered.port}`,
    password,
    pid: discovered.pid,
  };
}