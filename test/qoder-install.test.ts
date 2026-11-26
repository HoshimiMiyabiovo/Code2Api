import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectQoderInstall,
  qoderCliCredentialPaths,
  qoderCliLoginHint,
} from '../src/core/qoder-install.js';

const RUNTIME =
  'resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs';

function makeInstall(root: string, version: string): string {
  const versionRoot = join(root, '.qoder-versions', version);
  mkdirSync(join(versionRoot, 'resources', 'app.asar.unpacked', 'node_modules'), { recursive: true });
  writeFileSync(join(versionRoot, 'Qoder.exe'), '');
  mkdirSync(join(versionRoot, 'resources', 'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist', '_worker'), { recursive: true });
  writeFileSync(join(versionRoot, RUNTIME), '');
  return versionRoot;
}

test('qoder 安装检测选择最高版本并给出 runtime 参数', () => {
  const root = mkdtempSync(join(tmpdir(), 'code2api-qoder-install-'));
  try {
    makeInstall(root, '0.5.9');
    const latest = makeInstall(root, '0.5.18');
    const found = detectQoderInstall([root]);
    assert.ok(found);
    assert.equal(found.version, '0.5.18');
    assert.equal(found.command, join(latest, 'Qoder.exe'));
    assert.deepEqual(found.args, [join(latest, RUNTIME)]);
    assert.deepEqual(found.env, { ELECTRON_RUN_AS_NODE: '1' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('qoder 安装检测兼容 runtime 留在安装根目录的布局', () => {
  const root = mkdtempSync(join(tmpdir(), 'code2api-qoder-install-'));
  try {
    mkdirSync(join(root, 'resources', 'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist', '_worker'), { recursive: true });
    writeFileSync(join(root, 'Qoder.exe'), '');
    writeFileSync(join(root, RUNTIME), '');
    const found = detectQoderInstall([root]);
    assert.ok(found);
    assert.equal(found.version, 'installed');
    assert.equal(found.command, join(root, 'Qoder.exe'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('qoder CLI 凭据提示区分 IDE 登录与 CLI 登录', () => {
  const root = mkdtempSync(join(tmpdir(), 'code2api-qoder-auth-'));
  const env = {
    QODER_CONFIG_DIR: root,
    QODER_HOME: root,
    USERPROFILE: root,
  } as NodeJS.ProcessEnv;
  try {
    const paths = qoderCliCredentialPaths(env);
    assert.ok(paths.includes(join(root, 'qoder-cli-credentials.json')));
    assert.ok(paths.includes(join(root, 'qoder-cli-cn-credentials.json')));
    const hint = qoderCliLoginHint(env);
    assert.ok(hint);
    assert.match(hint, /IDE 登录不等于 CLI 登录/);
    assert.match(hint, /QODER_PERSONAL_ACCESS_TOKEN/);

    writeFileSync(paths[0]!, '');
    assert.equal(qoderCliLoginHint(env), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('qoder 安装检测找不到时返回 null', () => {
  const root = mkdtempSync(join(tmpdir(), 'code2api-qoder-install-'));
  try {
    assert.equal(detectQoderInstall([root]), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
