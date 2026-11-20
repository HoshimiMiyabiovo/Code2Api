import { resolve } from 'node:path';
import { APP_VERSION, loadConfig } from './config.js';
import { createGateway } from './http/app.js';
import { log } from './logger.js';

async function main(): Promise<void> {
  const configArg = process.argv[2] ?? process.env.CODE2API_CONFIG ?? 'config/config.yaml';
  const configPath = resolve(process.cwd(), configArg);
  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    log.error((error as Error).message);
    process.exitCode = 1;
    return;
  }

  const gateway = await createGateway(config, { configPath });
  const { app, ctx, shutdown } = gateway;

  try {
    const address = await app.listen({
      host: config.server.host,
      port: config.server.port,
    });
    log.info(`Code2Api v${APP_VERSION} 已启动: ${address}`);
    log.info(`管理面板: ${address}/admin`);
    if (!config.admin.token) {
      log.warn(`未配置 admin.token，本次临时口令: ${ctx.adminToken}`);
      log.warn('如需固定口令，请填写 config/config.yaml 的 admin.token 后重启。');
    }
    for (const provider of ctx.registry.providers) {
      const models = provider.models.map((model) => model.id).join(', ');
      if (!provider.enabled) {
        log.info(`渠道 ${provider.id} [${provider.type}] 已禁用`);
      } else if (provider.disabledReason) {
        log.warn(`渠道 ${provider.id} [${provider.type}] 不可用: ${provider.disabledReason}`);
      } else {
        log.info(`渠道 ${provider.id} [${provider.type}] 模型: ${models}`);
      }
    }
    const ready = ctx.registry.providers.filter(
      (provider) => provider.enabled && provider.keys.hasUsableKey(),
    ).length;
    if (ready === 0) {
      log.warn('当前没有可用渠道，请在配置中补充密钥。');
    }
  } catch (error) {
    log.error(`启动失败: ${(error as Error).message}`);
    await shutdown();
    process.exitCode = 1;
    return;
  }

  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info(`收到 ${signal}，正在关闭...`);
    await shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));
}

void main();
