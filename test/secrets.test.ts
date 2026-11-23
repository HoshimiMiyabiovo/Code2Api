import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadConfig, parseConfig } from '../src/config.js';
import { upsertChannel } from '../src/core/config-editor.js';
import {
  decryptSecret,
  encryptSecret,
  secretBackend,
  tryDecryptSecret,
} from '../src/core/secrets.js';

const BASE_CONFIG = `server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: mock
    type: mock
    models:
      - id: mock-chat
`;

function tempConfig(text: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-secrets-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, text, 'utf8');
  return { dir, path };
}

test('AES 加密往返且每次密文不同', () => {
  assert.equal(secretBackend(), 'aes');
  const first = encryptSecret('sk-test-secret-123');
  const second = encryptSecret('sk-test-secret-123');
  assert.match(first, /^aes1:/);
  assert.notEqual(first, second);
  assert.equal(decryptSecret(first), 'sk-test-secret-123');
  assert.equal(decryptSecret(second), 'sk-test-secret-123');
});

test('密文被篡改时解密失败且不返回半截明文', () => {
  const encoded = encryptSecret('sk-tamper-check');
  const last = encoded.slice(-2);
  const tampered = `${encoded.slice(0, -2)}${last === 'aa' ? 'bb' : 'aa'}`;
  assert.throws(() => decryptSecret(tampered), /解密失败|格式|参数/);
  const result = tryDecryptSecret(tampered);
  assert.equal(result.value, undefined);
  assert.ok(result.error);
});

test('主密钥不匹配时给出可操作的错误', () => {
  const encoded = encryptSecret('sk-wrong-master');
  const previous = process.env.CODE2API_MASTER_KEY;
  process.env.CODE2API_MASTER_KEY = 'another-master-key-0123456789';
  try {
    assert.throws(() => decryptSecret(encoded), /CODE2API_MASTER_KEY|解密失败/);
  } finally {
    process.env.CODE2API_MASTER_KEY = previous;
  }
});

test('parseConfig 解密 key_enc / token_enc，并保留密文用于原样写回', () => {
  const keyEnc = encryptSecret('sk-config-secret');
  const tokenEnc = encryptSecret('admin-secret');
  const config = parseConfig({
    admin: { token_enc: tokenEnc },
    storage: { path: '__DB__' },
    providers: [
      {
        id: 'station',
        type: 'openai-compatible',
        base_url: 'https://api.example.com/v1',
        keys: [{ label: 'main', key_enc: keyEnc }],
        models: [{ id: 'm1' }],
      },
    ],
  });
  assert.equal(config.admin.token, 'admin-secret');
  const provider = config.providers[0];
  assert.equal(provider.type, 'openai-compatible');
  if (provider.type === 'openai-compatible') {
    assert.equal(provider.keys[0]?.key, 'sk-config-secret');
    assert.equal(provider.keys[0]?.keyEnc, keyEnc);
  }
});

test('key_enc 解密失败时渠道仍可加载，只标记该密钥不可用', () => {
  const config = parseConfig({
    storage: { path: '__DB__' },
    providers: [
      {
        id: 'station',
        type: 'openai-compatible',
        base_url: 'https://api.example.com/v1',
        keys: [{ label: 'main', key_enc: 'aes1:bad:bad:bad:bad' }],
        models: [{ id: 'm1' }],
      },
    ],
  });
  const provider = config.providers[0];
  if (provider.type !== 'openai-compatible') throw new Error('unexpected type');
  assert.equal(provider.keys[0]?.key, null);
  assert.ok(provider.keys[0]?.keyError);
});

test('面板保存密钥只写 key_enc，不落明文', async () => {
  const { dir, path } = tempConfig(BASE_CONFIG);
  try {
    const result = await upsertChannel(
      path,
      {
        id: 'panel-station',
        type: 'openai-compatible',
        priority: 5,
        enabled: true,
        baseUrl: 'https://api.example.com/v1',
        authHeader: 'bearer',
        tokenLimitField: 'max_tokens',
        sendStreamOptions: true,
        syncModels: true,
        keys: [
          { action: 'new', label: 'main', mode: 'key', key: 'sk-never-plaintext' },
        ],
        models: [{ id: 'm1', capabilities: { tools: true, vision: false, reasoning: false } }],
      },
      'create',
    );
    const text = readFileSync(path, 'utf8');
    assert.ok(!text.includes('sk-never-plaintext'));
    assert.match(text, /key_enc: aes1:/);
    assert.equal(result.warnings.length, 0);
    const saved = loadConfig(path);
    const provider = saved.providers.find((item) => item.id === 'panel-station');
    if (provider?.type !== 'openai-compatible') throw new Error('provider missing');
    assert.equal(provider.keys[0]?.key, 'sk-never-plaintext');
    assert.ok(provider.keys[0]?.keyEnc);

    // 历史明文在 keep 时自动迁移，不允许再次写回明文。
    const legacy = YAML.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    const legacyProvider = (legacy.providers as Array<Record<string, any>>).find(
      (item) => item.id === 'panel-station',
    );
    legacyProvider.keys = [{ label: 'main', key: 'sk-legacy-plaintext' }];
    writeFileSync(path, YAML.stringify(legacy), 'utf8');
    await upsertChannel(
      path,
      {
        id: 'panel-station',
        type: 'openai-compatible',
        priority: 5,
        enabled: true,
        baseUrl: 'https://api.example.com/v1',
        authHeader: 'bearer',
        tokenLimitField: 'max_tokens',
        sendStreamOptions: true,
        syncModels: true,
        keys: [{ action: 'keep', label: 'main' }],
        models: [{ id: 'm1', capabilities: { tools: true, vision: false, reasoning: false } }],
      },
      'update',
    );
    const migrated = readFileSync(path, 'utf8');
    assert.ok(!migrated.includes('sk-legacy-plaintext'));
    assert.match(migrated, /key_enc: aes1:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
