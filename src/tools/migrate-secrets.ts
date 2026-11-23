import { copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { parseConfig } from '../config.js';
import {
  encryptSecret,
  isSecretEncryptionAvailable,
  secretBackendLabel,
} from '../core/secrets.js';

/**
 * 把 config.yaml 里历史遗留的明文 key / admin.token 迁移为 key_enc / token_enc。
 * - 先备份为 config.yaml.bak-<时间戳>；
 * - 只改写密钥字段，保留其余 YAML 注释与结构；
 * - 找不到明文时不做任何写入。
 */

interface Migration {
  channel: string;
  label: string;
}

function main(): void {
  if (!isSecretEncryptionAvailable()) {
    console.error(
      '当前环境没有可用的密钥加密后端。Windows 会自动使用 DPAPI；其他平台请设置 CODE2API_MASTER_KEY（至少 16 字符）。',
    );
    process.exitCode = 1;
    return;
  }

  const configPath = resolve(
    process.cwd(),
    process.argv[2] ?? process.env.CODE2API_CONFIG ?? 'config/config.yaml',
  );
  const text = readFileSync(configPath, 'utf8');
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) {
    console.error(`配置文件 YAML 解析失败：${doc.errors[0]?.message ?? '未知错误'}`);
    process.exitCode = 1;
    return;
  }

  const migrated: Migration[] = [];
  const providers = doc.get('providers');
  if (YAML.isSeq(providers)) {
    providers.items.forEach((providerNode, index) => {
      if (!YAML.isMap(providerNode)) return;
      if (providerNode.get('type') !== 'openai-compatible') return;
      const channel = String(providerNode.get('id') ?? `providers[${index}]`);
      const keys = providerNode.get('keys');
      if (!YAML.isSeq(keys)) return;
      keys.items.forEach((keyNode, keyIndex) => {
        if (!YAML.isMap(keyNode)) return;
        if (keyNode.has('key_env') || keyNode.has('key_enc')) return;
        const plain = keyNode.get('key');
        if (typeof plain !== 'string' || plain.length === 0) return;
        const label = String(keyNode.get('label') ?? `k${keyIndex + 1}`);
        keyNode.set('key_enc', encryptSecret(plain));
        keyNode.delete('key');
        migrated.push({ channel, label });
      });
    });
  }

  const admin = doc.get('admin');
  let adminMigrated = false;
  if (YAML.isMap(admin) && !admin.has('token_env') && !admin.has('token_enc')) {
    const token = admin.get('token');
    if (typeof token === 'string' && token.length > 0) {
      admin.set('token_enc', encryptSecret(token));
      admin.delete('token');
      adminMigrated = true;
    }
  }

  if (migrated.length === 0 && !adminMigrated) {
    console.log('没有需要迁移的明文密钥。');
    return;
  }

  const output = doc.toString({ lineWidth: 0 });
  try {
    parseConfig(YAML.parse(output));
  } catch (error) {
    console.error(`迁移后配置校验失败，未写入：${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${configPath}.bak-${stamp}`;
  copyFileSync(configPath, backupPath);
  const tempPath = `${configPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, output, 'utf8');
    renameSync(tempPath, configPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    console.error(`写入配置文件失败：${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`密钥加密后端：${secretBackendLabel()}`);
  for (const item of migrated) {
    console.log(`已迁移渠道 ${item.channel} 的密钥 ${item.label}`);
  }
  if (adminMigrated) console.log('已迁移 admin.token');
  console.log(`原文件备份：${backupPath}`);
}

main();
