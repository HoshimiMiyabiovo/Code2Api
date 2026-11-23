import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * 本地密钥加密。
 *
 * - Windows 默认使用 DPAPI（当前用户作用域）：配置文件/备份泄露无法直接读出密钥。
 * - 设置 CODE2API_MASTER_KEY 时使用 AES-256-GCM（跨平台，测试也走这条）。
 * - 两者都不可用时拒绝写入：面板只能选择 key_env，绝不回落明文。
 *
 * 说明：DPAPI/AES 防的是“配置文件被拷走”，不是同用户恶意进程；本项目定位是
 * 本机网关，这个边界与 AGENTS.md 一致。
 */

const DPAPI_PREFIX = 'dpapi:';
const AES_PREFIX = 'aes1:';
const AES_AAD = Buffer.from('code2api-secrets-v1');
const MIN_MASTER_KEY_LENGTH = 16;

export type SecretBackend = 'aes' | 'dpapi' | 'none';

export function secretBackend(): SecretBackend {
  if (process.env.CODE2API_MASTER_KEY) return 'aes';
  if (process.platform === 'win32') return 'dpapi';
  return 'none';
}

export function secretBackendLabel(): string {
  switch (secretBackend()) {
    case 'aes':
      return 'AES-256-GCM（CODE2API_MASTER_KEY）';
    case 'dpapi':
      return 'Windows DPAPI（当前用户）';
    default:
      return '不可用（请改用 key_env）';
  }
}

export function isSecretEncryptionAvailable(): boolean {
  return secretBackend() !== 'none';
}

const decryptCache = new Map<string, string>();

export function encryptSecret(plain: string): string {
  if (!plain) throw new Error('密钥为空，无法加密');
  const backend = secretBackend();
  if (backend === 'aes') return aesEncrypt(plain);
  if (backend === 'dpapi') return dpapiEncrypt(plain);
  throw new Error(
    '当前环境不支持加密保存密钥（非 Windows 且未设置 CODE2API_MASTER_KEY），请改用 key_env 环境变量',
  );
}

export function decryptSecret(encoded: string): string {
  const cached = decryptCache.get(encoded);
  if (cached !== undefined) return cached;
  let value: string;
  if (encoded.startsWith(AES_PREFIX)) {
    value = aesDecrypt(encoded);
  } else if (encoded.startsWith(DPAPI_PREFIX)) {
    value = dpapiDecrypt(encoded);
  } else {
    throw new Error('未知的密钥密文格式');
  }
  decryptCache.set(encoded, value);
  return value;
}

export interface SecretDecryptResult {
  value?: string;
  error?: string;
}

/** 配置加载用：解密失败不让整个网关起不来，只把该密钥标记为不可用。 */
export function tryDecryptSecret(encoded: string): SecretDecryptResult {
  try {
    return { value: decryptSecret(encoded) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function masterKey(): Buffer {
  const raw = process.env.CODE2API_MASTER_KEY ?? '';
  if (raw.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(
      `CODE2API_MASTER_KEY 至少需要 ${MIN_MASTER_KEY_LENGTH} 个字符`,
    );
  }
  return scryptSync(raw, 'code2api-secrets-v1', 32);
}

function aesEncrypt(plain: string): string {
  const key = masterKey();
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const derived = deriveAesKey(key, salt);
  const cipher = createCipheriv('aes-256-gcm', derived, iv);
  cipher.setAAD(AES_AAD);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${AES_PREFIX}${salt.toString('base64url')}:${iv.toString('base64url')}:${tag.toString(
    'base64url',
  )}:${data.toString('base64url')}`;
}

function deriveAesKey(master: Buffer, salt: Buffer): Buffer {
  // master 已经是 scrypt 产物；再按每条密文随机盐派生子密钥，避免同 key 复用。
  return scryptSync(master, salt, 32);
}

function aesDecrypt(encoded: string): string {
  const parts = encoded.slice(AES_PREFIX.length).split(':');
  if (parts.length !== 4) throw new Error('AES 密钥密文格式不正确');
  const [saltPart, ivPart, tagPart, dataPart] = parts;
  const salt = Buffer.from(saltPart, 'base64url');
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const data = Buffer.from(dataPart, 'base64url');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) {
    throw new Error('AES 密钥密文参数不正确');
  }
  const key = deriveAesKey(masterKey(), salt);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AES_AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('密钥解密失败：CODE2API_MASTER_KEY 不匹配或密文已损坏');
  }
}

const PS_ENCRYPT = [
  "$ErrorActionPreference='Stop'",
  '$secure = ConvertTo-SecureString -String $env:CODE2API_SECRET_IN -AsPlainText -Force',
  'ConvertFrom-SecureString -SecureString $secure',
].join('; ');

const PS_DECRYPT = [
  "$ErrorActionPreference='Stop'",
  '$secure = ConvertTo-SecureString $env:CODE2API_SECRET_BLOB',
  '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
  'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
].join('; ');

function runPowerShell(script: string, env: Record<string, string>): string {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        windowsHide: true,
        timeout: 15000,
      },
    ).trim();
  } catch (error) {
    const detail = (error as Error).message.split('\n')[0]?.trim() || '未知错误';
    throw new Error(`Windows DPAPI 调用失败：${detail}`);
  }
}

function dpapiEncrypt(plain: string): string {
  const blob = runPowerShell(PS_ENCRYPT, { CODE2API_SECRET_IN: plain });
  if (!/^[0-9a-f]+$/i.test(blob) || blob.length < 64) {
    throw new Error('Windows DPAPI 返回的密文格式不正确');
  }
  return `${DPAPI_PREFIX}${blob.toLowerCase()}`;
}

function dpapiDecrypt(encoded: string): string {
  if (process.platform !== 'win32') {
    throw new Error('该密钥由 Windows DPAPI 加密，只能在原 Windows 用户的机器上解密');
  }
  const blob = encoded.slice(DPAPI_PREFIX.length);
  if (!/^[0-9a-f]+$/i.test(blob)) throw new Error('DPAPI 密钥密文格式不正确');
  try {
    return runPowerShell(PS_DECRYPT, { CODE2API_SECRET_BLOB: blob });
  } catch {
    throw new Error('密钥解密失败：DPAPI 密文不属于当前 Windows 用户或已损坏');
  }
}
