'use strict';

(() => {
  const TOKEN_KEY = 'code2api.token';
  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || '',
    range: '24h',
    loading: false,
    channels: [],
    channelsEditable: false,
    secretStorage: { available: false, backend: '' },
    editingChannelId: null,
    editingModels: [],
    selectedModelIndex: 0,
    probedModels: [],
    probeBusy: false,
    models: [],
    modelFilter: '',
    collapsedModelGroups: new Set(),
    retryDirty: false,
    retryEditable: false,
    privacyDirty: false,
    privacyEditable: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const loginEl = $('#login');
  const appEl = $('#app');
  const tokenInput = $('#token');
  const loginError = $('#login-error');
  const loginBtn = $('#login-btn');
  const providersBody = $('#providers-body');
  const requestsBody = $('#requests-body');
  const modelsBody = $('#models-body');
  const modelFilter = $('#model-filter');
  const kpisEl = $('#kpis');
  const connStatus = $('#conn-status');
  const serverMeta = $('#server-meta');
  const updatedAt = $('#updated-at');
  const toastEl = $('#toast');
  const channelsBody = $('#channels-body');
  const channelsNote = $('#channels-note');
  const addChannelBtn = $('#add-channel-btn');
  const channelDialog = $('#channel-dialog');
  const keysEditor = $('#keys-editor');
  const modelsEditor = $('#models-editor');
  const modelPicker = $('#model-picker');
  const modelCount = $('#model-count');
  const modelRemoveBtn = $('#model-remove-btn');
  const probeModelsBtn = $('#probe-models-btn');
  const probeStatus = $('#probe-status');
  const probeResults = $('#probe-results');
  const upstreamOptions = $('#upstream-options');
  const modelPrefixesRow = $('#ch-model-prefixes-row');
  const modelPrefixesInput = $('#ch-model-prefixes');
  const questionsPanel = $('#questions-panel');
  const questionsList = $('#questions-list');
  const retryNote = $('#retry-note');
  const retrySaveBtn = $('#retry-save');
  const retryEnabled = $('#retry-enabled');
  const retryRespect = $('#retry-respect');
  const retryMax = $('#retry-max');
  const retryInitial = $('#retry-initial');
  const retryMaxDelay = $('#retry-max-delay');
  const retryJitter = $('#retry-jitter');
  const retryTotal = $('#retry-total');
  const retryCategoriesEl = $('#retry-categories');
  const privacyNote = $('#privacy-note');
  const privacySaveBtn = $('#privacy-save');
  const privacyMode = $('#privacy-mode');
  const privacyIdentity = $('#privacy-identity');
  const privacyConfigSecrets = $('#privacy-config-secrets');
  const privacyInclude = $('#privacy-include');
  const privacyExclude = $('#privacy-exclude');
  const privacyRetention = $('#privacy-retention');
  const privacyMaxVault = $('#privacy-max-vault');
  const privacyStatus = $('#privacy-status');
  const privacyEventsBody = $('#privacy-events-body');
  const privacyVaultBody = $('#privacy-vault-body');
  const privacyVaultNote = $('#privacy-vault-note');

  const intFmt = new Intl.NumberFormat('zh-CN');
  const compactFmt = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function td(text, className) {
    return el('td', className, text);
  }

  function chip(text, tone) {
    return el('span', `chip ${tone}`, text);
  }

  function fmtInt(value) {
    return intFmt.format(Number(value) || 0);
  }

  function fmtTokens(value) {
    const n = Number(value) || 0;
    return n >= 10000 ? compactFmt.format(n) : intFmt.format(n);
  }

  function fmtCost(value) {
    if (value === null || value === undefined) return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n === 0) return '$0';
    const digits = n < 0.01 ? 6 : 4;
    return '$' + n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  }

  function fmtMs(value) {
    if (value === null || value === undefined) return '—';
    const ms = Number(value);
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  function fmtTime(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  function fmtDuration(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  function fmtCooldown(ms) {
    const s = Math.max(0, Math.ceil(Number(ms) / 1000));
    return fmtDuration(s);
  }

  function fmtContext(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  }

  function setConn(online) {
    connStatus.textContent = online ? '在线' : '离线';
    connStatus.className = online ? 'conn on' : 'conn off';
  }

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toastEl.hidden = true;
    }, 3200);
  }

  function setLoggedIn(loggedIn) {
    loginEl.hidden = loggedIn;
    appEl.hidden = !loggedIn;
    if (!loggedIn) {
      tokenInput.value = '';
      setConn(false);
      if (channelDialog.open) channelDialog.close();
    }
  }

  class AuthError extends Error {}

  async function api(path) {
    const response = await fetch(path, {
      headers: { authorization: `Bearer ${state.token}` },
      cache: 'no-store',
    });
    if (response.status === 401) throw new AuthError('unauthorized');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function kpi(label, value, sub) {
    const card = el('div', 'kpi');
    card.append(el('div', 'kpi-label', label), el('div', 'kpi-value', value));
    if (sub) card.append(el('div', 'kpi-sub', sub));
    return card;
  }

  function renderOverview(overview) {
    const { server, totals } = overview;
    serverMeta.textContent = `v${server.version} · 运行 ${fmtDuration(server.uptimeSec)} · ${server.host}:${server.port} · 客户端鉴权：${server.clientAuth ? '开' : '关'}`;

    // 计费视角三桶：未缓存输入（贵）/ 缓存读取（便宜）/ 输出+推理（生成侧）。
    // 旧版网关没有拆分字段时回退为近似值。
    const cacheRead = totals.cacheReadTokens ?? 0;
    const cacheWrite = totals.cacheWriteTokens ?? 0;
    const uncachedInput =
      totals.uncachedInputTokens ?? Math.max(0, (totals.inputTokens ?? 0) - cacheRead);
    const generated =
      totals.generatedTokens ?? ((totals.outputTokens ?? 0) + (totals.reasoningTokens ?? 0));
    const inputTotal = uncachedInput + cacheRead;
    const cacheShare = inputTotal > 0 ? Math.round((cacheRead / inputTotal) * 100) : null;
    kpisEl.replaceChildren(
      kpi('请求数', fmtInt(totals.requests), `${fmtInt(totals.ok)} 成功 · ${fmtInt(totals.errors)} 失败 · ${fmtInt(totals.cancelled)} 取消`),
      kpi('成功率', totals.successRate === null ? '—' : `${(totals.successRate * 100).toFixed(1)}%`, `${fmtInt(totals.ok)} / ${fmtInt(totals.requests)}`),
      kpi('未缓存输入', fmtTokens(uncachedInput), cacheWrite > 0 ? `另有缓存写入 ${fmtInt(cacheWrite)}` : '上游重放中未命中缓存的部分'),
      kpi('缓存读取', fmtTokens(cacheRead), cacheShare === null ? '' : `占输入 ${cacheShare}%`),
      kpi('输出 + 推理', fmtTokens(generated), totals.reasoningTokens ? `其中推理 ${fmtInt(totals.reasoningTokens)}` : '生成侧合计'),
      kpi('估算费用', fmtCost(totals.costUsd), '按模型单价折算'),
      kpi('平均延迟', fmtMs(totals.avgLatencyMs), '成功请求'),
      kpi('平均首字节', fmtMs(totals.avgTtfbMs), '流式请求'),
    );

    providersBody.replaceChildren();
    if (!overview.providers.length) {
      const tr = el('tr');
      const cell = td('暂无渠道', 'empty');
      cell.colSpan = 9;
      tr.append(cell);
      providersBody.append(tr);
      return;
    }

    for (const provider of overview.providers) {
      const tr = el('tr', provider.enabled ? '' : 'dim');

      const nameCell = el('td');
      nameCell.append(el('div', 'key-name', provider.id));
      nameCell.append(el('div', 'muted', `${provider.models.length} 个模型 · 优先级 ${provider.priority}`));
      tr.append(nameCell);

      const runtimeTypeCell = td(
        provider.type === 'openai-compatible' ? 'openai' : provider.type,
      );
      runtimeTypeCell.title = provider.type;
      tr.append(runtimeTypeCell);

      const statusCell = el('td');
      const cooling = provider.keys.some((key) => key.status === 'cooling');
      if (!provider.enabled) statusCell.append(chip('已禁用', 'idle'));
      else if (provider.disabledReason) statusCell.append(chip(provider.disabledReason, 'warn'));
      else if (cooling) statusCell.append(chip('冷却中', 'warn'));
      else statusCell.append(chip('可用', 'good'));
      tr.append(statusCell);

      const keysCell = el('td');
      if (!provider.keys.length) {
        keysCell.textContent = '—';
      } else {
        const list = el('div', 'key-list');
        for (const key of provider.keys) {
          const line = el('div', 'key-line');
          line.append(el('span', 'key-name', key.label));
          line.append(el('span', 'key-secret', key.masked));
          if (key.status === 'ready') line.append(chip('就绪', 'good'));
          else if (key.status === 'cooling') {
            line.append(chip(`冷却 ${fmtCooldown(key.cooldownRemainingMs)}`, 'warn'));
          } else {
            line.append(chip('缺环境变量', 'bad'));
          }
          line.append(
            el('span', 'key-stats', `完成 ${key.stats.requests} · 失败 ${key.stats.errors}`),
          );
          list.append(line);
        }
        keysCell.append(list);
      }
      tr.append(keysCell);

      tr.append(td(fmtInt(provider.stats.requests), 'num'));
      tr.append(td(fmtInt(provider.stats.errors), 'num'));
      tr.append(td(fmtTokens(provider.stats.inputTokens), 'num'));
      tr.append(td(fmtTokens(provider.stats.outputTokens), 'num'));
      tr.append(td(fmtCost(provider.stats.costUsd), 'num'));
      providersBody.append(tr);
    }
  }

  const STATUS_LABELS = { ok: '成功', error: '失败', cancelled: '取消' };
  const STATUS_TONES = { ok: 'good', error: 'bad', cancelled: 'idle' };

  function renderRequests(requests) {
    requestsBody.replaceChildren();
    if (!requests.length) {
      const tr = el('tr');
      const cell = td('该区间暂无请求', 'empty');
      cell.colSpan = 9;
      tr.append(cell);
      requestsBody.append(tr);
      return;
    }
    for (const item of requests) {
      const tr = el('tr');
      tr.append(td(fmtTime(item.ts)));

      const endpointCell = td(item.endpoint);
      if (item.stream) endpointCell.append(el('span', 'muted', ' · 流式'));
      tr.append(endpointCell);

      const modelCell = el('td');
      modelCell.append(el('span', 'key-name', item.requestedModel));
      if (item.upstreamModel && item.upstreamModel !== item.requestedModel) {
        modelCell.append(el('span', 'muted', ` → ${item.upstreamModel}`));
      }
      tr.append(modelCell);

      tr.append(td(`${item.provider || '—'} / ${item.keyLabel || '—'}`));

      const statusCell = el('td');
      statusCell.append(
        chip(STATUS_LABELS[item.status] || item.status, STATUS_TONES[item.status] || 'idle'),
      );
      tr.append(statusCell);

      const tokenCell = td(`${fmtTokens(item.inputTokens)} / ${fmtTokens(item.outputTokens)}`, 'num');
      tokenCell.title = `输入 ${item.inputTokens} / 输出 ${item.outputTokens}${item.reasoningTokens ? ` / 推理 ${item.reasoningTokens}` : ''}${item.estimated ? '（估算）' : ''}`;
      tr.append(tokenCell);

      tr.append(td(fmtMs(item.latencyMs), 'num'));
      tr.append(td(fmtMs(item.ttfbMs), 'num'));

      const errorCell = td(item.error || '', 'err');
      if (item.error) errorCell.title = item.error;
      tr.append(errorCell);

      requestsBody.append(tr);
    }
  }

  function buildModelRow(model) {
    const tr = el('tr', model.enabled ? '' : 'dim');
    tr.append(td(model.id));
    tr.append(td(model.provider));
    tr.append(td(model.upstream));
    tr.append(td(fmtContext(model.contextWindow), 'num'));

    const capsCell = el('td');
    const caps = el('div', 'caps');
    const labels = [];
    if (model.capabilities.tools) labels.push('工具');
    if (model.capabilities.vision) labels.push('视觉');
    if (model.capabilities.reasoning) labels.push('推理');
    if (!labels.length) caps.append(el('span', 'muted', '—'));
    else labels.forEach((label) => caps.append(el('span', 'cap', label)));
    capsCell.append(caps);
    tr.append(capsCell);

    const pricing = model.pricing;
    const priceText =
      pricing && (pricing.inputPerMtok !== undefined || pricing.outputPerMtok !== undefined)
        ? `${pricing.inputPerMtok !== undefined ? '$' + pricing.inputPerMtok : '—'} / ${pricing.outputPerMtok !== undefined ? '$' + pricing.outputPerMtok : '—'}`
        : '—';
    tr.append(td(priceText, 'num'));
    return tr;
  }

  function renderModels(models) {
    state.models = models || [];
    modelsBody.replaceChildren();
    const keyword = state.modelFilter;
    const groups = [];
    for (const model of state.models) {
      const haystack = `${model.id} ${model.upstream} ${model.provider}`.toLowerCase();
      if (keyword && !haystack.includes(keyword)) continue;
      let group = groups.find((item) => item.provider === model.provider);
      if (!group) {
        group = { provider: model.provider, providerType: model.providerType, models: [] };
        groups.push(group);
      }
      group.models.push(model);
    }
    if (!groups.length) {
      const tr = el('tr');
      const cell = td(state.models.length ? '暂无匹配模型' : '暂无模型', 'empty');
      cell.colSpan = 6;
      tr.append(cell);
      modelsBody.append(tr);
      return;
    }
    for (const group of groups) {
      const collapsed = state.collapsedModelGroups.has(group.provider);
      const headTr = el('tr', 'group-row');
      const headCell = td('');
      headCell.colSpan = 6;
      const toggle = el('button', 'group-toggle');
      toggle.type = 'button';
      toggle.textContent = `${collapsed ? '▸' : '▾'} ${group.provider} · ${group.providerType} · ${group.models.length} 个模型`;
      toggle.addEventListener('click', () => {
        if (state.collapsedModelGroups.has(group.provider)) {
          state.collapsedModelGroups.delete(group.provider);
        } else {
          state.collapsedModelGroups.add(group.provider);
        }
        renderModels(state.models);
      });
      headCell.append(toggle);
      headTr.append(headCell);
      modelsBody.append(headTr);
      if (!collapsed) {
        for (const model of group.models) modelsBody.append(buildModelRow(model));
      }
    }
  }

  function keyStatusChip(key) {
    if (key.status === 'ready') return chip('就绪', 'good');
    if (key.status === 'cooling') return chip(`冷却 ${fmtCooldown(key.cooldownRemainingMs)}`, 'warn');
    if (key.status === 'error') return chip('解密失败', 'bad');
    return chip('缺环境变量', 'bad');
  }

  function renderChannels(data) {
    state.channels = data.channels || [];
    state.channelsEditable = Boolean(data.editable);
    state.secretStorage = data.secretStorage || { available: false, backend: '' };
    channelsNote.textContent = state.channelsEditable
      ? `修改写入 config.yaml 并立即生效；密钥保存方式：${state.secretStorage.backend || '未知'}`
      : '当前服务未加载配置文件路径，渠道只读';
    addChannelBtn.disabled = !state.channelsEditable;

    channelsBody.replaceChildren();
    if (!state.channels.length) {
      const tr = el('tr');
      const cell = td('暂无渠道', 'empty');
      cell.colSpan = 7;
      tr.append(cell);
      channelsBody.append(tr);
      return;
    }

    for (const provider of state.channels) {
      const tr = el('tr', provider.enabled ? '' : 'dim');

      const nameCell = el('td');
      nameCell.append(el('div', 'key-name', provider.id));
      nameCell.append(el('div', 'muted', `优先级 ${provider.priority}`));
      tr.append(nameCell);

      const typeCell = td(provider.type === 'openai-compatible' ? 'openai' : provider.type);
      typeCell.title = provider.type;
      tr.append(typeCell);

      const statusCell = el('td');
      const bridgeInfo = provider.opencode ?? provider.zcode ?? provider.qoder ?? null;
      const worker = bridgeInfo?.worker;
      if (!provider.enabled) statusCell.append(chip('已禁用', 'idle'));
      else if (provider.disabledReason) statusCell.append(chip(provider.disabledReason, 'warn'));
      else if (bridgeInfo) {
        const state = worker?.state;
        if (!worker || state === 'idle') statusCell.append(chip('待启动', 'idle'));
        else if (state === 'ready') statusCell.append(chip('运行中', 'good'));
        else if (state === 'starting') statusCell.append(chip('启动中', 'warn'));
        else if (state === 'restarting') statusCell.append(chip('重启中', 'warn'));
        else if (state === 'error') statusCell.append(chip('进程错误', 'bad'));
        else statusCell.append(chip('已停止', 'idle'));
        if (worker) {
          const logTail = Array.isArray(worker.logTail) ? worker.logTail.slice(-5) : [];
          const auth = worker.auth;
          statusCell.title = [
            worker.mode === 'external' ? '外部服务' : '本地进程',
            worker.pid ? `PID ${worker.pid}` : '',
            worker.baseUrl ?? worker.workspace ?? '',
            auth?.method
              ? `认证: ${auth.authenticated === true ? 'OK' : auth.authenticated === false ? '失败' : '未知'} (${auth.method})`
              : '',
            auth?.error ?? '',
            worker.lastError ?? '',
            logTail.length ? `stderr: ${logTail.join(' | ').slice(0, 300)}` : '',
          ]
            .filter(Boolean)
            .join(' · ');
        }
      } else statusCell.append(chip('可用', 'good'));

      const monitoring = provider.monitoring;
      if (monitoring) {
        const health = monitoring.health;
        const healthLabel =
          health.status === 'healthy'
            ? '探活正常'
            : health.status === 'unhealthy'
              ? '探活失败'
              : health.status === 'skipped'
                ? '探活跳过'
                : '探活未知';
        const healthTone =
          health.status === 'healthy'
            ? 'good'
            : health.status === 'unhealthy'
              ? 'bad'
              : 'idle';
        const extras = el('div', 'muted');
        extras.append(chip(healthLabel, healthTone));
        if (monitoring.quota?.remainingPercent !== undefined) {
          extras.append(
            el(
              'span',
              'key-stats',
              ` 额度 ${Math.round(monitoring.quota.remainingPercent)}%`,
            ),
          );
        }
        if (monitoring.keepalive) {
          extras.append(
            el(
              'span',
              'key-stats',
              monitoring.keepalive.ok ? ' 保活正常' : ' 保活失败',
            ),
          );
        }
        if (bridgeInfo?.pool) {
          const pool = bridgeInfo.pool;
          extras.append(
            el(
              'span',
              'key-stats',
              ` workers ${pool.workers.length} · 会话 ${pool.activeSessions}/${pool.maxSessions}` +
                (pool.totalRssMb ? ` · ${Math.round(pool.totalRssMb)}MB` : ''),
            ),
          );
        }
        statusCell.append(extras);
        if (health.error) {
          statusCell.title = health.error;
        }
      }
      tr.append(statusCell);

      const baseUrl =
        provider.baseUrl ||
        provider.opencode?.baseUrl ||
        provider.opencode?.worker?.baseUrl ||
        (provider.opencode ? '自动拉起' : '') ||
        (provider.zcode ? provider.zcode.command : '') ||
        '—';
      const baseCell = td(baseUrl, 'cell-clip');
      if (baseUrl) baseCell.title = baseUrl;
      tr.append(baseCell);

      const keyCell = el('td');
      if (!provider.keys.length) keyCell.textContent = '—';
      else {
        const list = el('div', 'key-list');
        for (const key of provider.keys) {
          const line = el('div', 'key-line');
          line.append(el('span', 'key-name', key.label));
          line.append(el('span', 'key-secret', key.hasKey ? key.masked : '未设置'));
          if (key.keyEnv) line.append(el('span', 'key-stats', `env: ${key.keyEnv}`));
          else if (key.encrypted) line.append(el('span', 'key-stats', '已加密'));
          else if (key.hasKey) line.append(chip('明文', 'bad'));
          line.append(keyStatusChip(key));
          list.append(line);
        }
        keyCell.append(list);
      }
      tr.append(keyCell);

      const modelCell = el('td');
      const modelDetails = el('details', 'model-details');
      const modelSummary = el('summary', '', `${provider.models.length} 个模型`);
      modelSummary.title = '点击展开 / 收起模型列表';
      modelDetails.append(modelSummary);
      const modelList = el('div', 'key-list model-details-list');
      for (const model of provider.models) {
        modelList.append(el('div', 'model-line', model.id));
      }
      modelDetails.append(modelList);
      modelCell.append(modelDetails);
      tr.append(modelCell);

      const actionsCell = el('td');
      const actions = el('div', 'channel-actions');
      const editButton = el('button', 'mini', '编辑');
      editButton.type = 'button';
      editButton.dataset.channelAction = 'edit';
      editButton.dataset.channelId = provider.id;
      editButton.disabled = !state.channelsEditable;
      const deleteButton = el('button', 'mini danger', '删除');
      deleteButton.type = 'button';
      deleteButton.dataset.channelAction = 'delete';
      deleteButton.dataset.channelId = provider.id;
      deleteButton.disabled = !state.channelsEditable;
      actions.append(editButton, deleteButton);
      actionsCell.append(actions);
      tr.append(actionsCell);

      channelsBody.append(tr);
    }
  }

  function buildQuestionField(field) {
    const key = String(field.key ?? '');
    const title = String(field.title ?? key);
    const type = String(field.type ?? 'string');
    if (type === 'boolean') {
      const label = el('label', 'check-row');
      label.dataset.fieldKey = key;
      const input = el('input', 'q-value');
      input.type = 'checkbox';
      input.checked = Boolean(field.default);
      label.append(input, document.createTextNode(title));
      return label;
    }

    const label = el('label');
    label.dataset.fieldKey = key;
    label.append(el('span', 'question-meta', title));
    if (field.description) label.append(el('span', 'muted', String(field.description)));

    if (type === 'multiselect') {
      const wrap = el('div', 'caps-row');
      const defaults = Array.isArray(field.default) ? field.default : [];
      for (const option of Array.isArray(field.options) ? field.options : []) {
        const optionLabel = el('label');
        const input = el('input', 'q-multi');
        input.type = 'checkbox';
        input.value = String(option.value);
        input.checked = defaults.includes(option.value);
        optionLabel.append(input, document.createTextNode(String(option.label ?? option.value)));
        wrap.append(optionLabel);
      }
      label.append(wrap);
      return label;
    }

    if (type === 'string' && Array.isArray(field.options) && field.options.length > 0) {
      const select = el('select', 'q-value');
      for (const option of field.options) {
        const node = el('option', '', String(option.label ?? option.value));
        node.value = String(option.value);
        select.append(node);
      }
      if (field.default !== undefined) select.value = String(field.default);
      label.append(select);
      if (field.custom) {
        const input = el('input', 'q-custom');
        input.placeholder = '或直接输入';
        label.append(input);
      }
      return label;
    }

    const input = el('input', 'q-value');
    if (type === 'number' || type === 'integer') {
      input.type = 'number';
      if (type === 'integer') input.step = '1';
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
    } else {
      input.type = 'text';
      if (field.format === 'email') input.type = 'email';
    }
    if (field.default !== undefined && field.default !== null) {
      input.value = String(field.default);
    }
    if (field.placeholder) input.placeholder = String(field.placeholder);
    label.append(input);
    return label;
  }

  function collectQuestionAnswer(fields, container) {
    const answer = {};
    for (const label of container.querySelectorAll('label[data-field-key]')) {
      const key = label.dataset.fieldKey;
      const field = fields.find((item) => String(item.key) === key) || { key, type: 'string' };
      const type = String(field.type ?? 'string');
      let value;
      if (type === 'boolean') {
        value = label.querySelector('.q-value')?.checked === true;
      } else if (type === 'multiselect') {
        value = [...label.querySelectorAll('.q-multi:checked')].map((input) => input.value);
      } else if (type === 'string' && Array.isArray(field.options) && field.options.length > 0) {
        const custom = label.querySelector('.q-custom')?.value.trim();
        value = custom || label.querySelector('.q-value')?.value || '';
      } else {
        const raw = label.querySelector('.q-value')?.value ?? '';
        if (type === 'number' || type === 'integer') {
          if (raw.trim() === '') {
            value = undefined;
          } else {
            const number = Number(raw);
            if (!Number.isFinite(number) || (type === 'integer' && !Number.isInteger(number))) {
              throw new Error(`${field.title || key} 必须是${type === 'integer' ? '整数' : '数字'}`);
            }
            value = number;
          }
        } else {
          value = raw;
        }
      }
      if (
        field.required &&
        (value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
      ) {
        throw new Error(`请填写：${field.title || key}`);
      }
      if (value !== undefined && value !== '') answer[key] = value;
    }
    return answer;
  }

  function renderQuestions(data) {
    const questions = data?.questions || [];
    questionsPanel.hidden = questions.length === 0;
    questionsList.replaceChildren();
    for (const question of questions) {
      const card = el('div', 'question-card');
      const head = el('div', 'question-head');
      const info = el('div');
      const title =
        question.kind === 'form'
          ? String(question.payload?.title || '需要确认')
          : question.kind === 'question'
            ? `模型提问：${String(question.payload?.questions?.[0]?.header || '需要回答')}`
            : `审批：${String(question.payload?.action || '工具调用')}`;
      info.append(el('div', 'question-title', title));
      const kindLabel =
        question.kind === 'form'
          ? '确认'
          : question.kind === 'question'
            ? '提问'
            : '审批';
      info.append(
        el(
          'div',
          'question-meta',
          `${question.providerId} · ${question.gatewaySessionId} · ${kindLabel}`,
        ),
      );
      head.append(info, chip(
        question.kind === 'form'
          ? '等待回答'
          : question.kind === 'question'
            ? '等待回答'
            : '等待审批',
        'warn',
      ));
      card.append(head);

      if (question.kind === 'permission') {
        const resources = Array.isArray(question.payload?.resources)
          ? question.payload.resources.join(', ')
          : '';
        if (resources) {
          card.append(el('div', 'question-meta', `资源：${resources}`));
        }
        const actions = el('div', 'question-actions');
        for (const [decision, label, danger] of [
          ['once', '允许一次', false],
          ['always', '始终允许', false],
          ['reject', '拒绝', true],
        ]) {
          const button = el('button', danger ? 'mini danger' : 'mini', label);
          button.type = 'button';
          button.addEventListener('click', () =>
            void answerQuestion(question.id, { decision }, button),
          );
          actions.append(button);
        }
        card.append(actions);
      } else if (question.kind === 'question') {
        // kilo question 工具：payload.questions 为问题数组，回答按顺序提交
        // { answers: string[][] }（每项是该问题的选中标签数组）。
        const items = Array.isArray(question.payload?.questions)
          ? question.payload.questions
          : [];
        const container = el('div', 'question-fields');
        for (const [index, item] of items.entries()) {
          container.append(buildQuestionItem(index, item, items.length));
        }
        card.append(container);
        const actions = el('div', 'question-actions');
        const submit = el('button', 'primary mini', '提交回答');
        submit.type = 'button';
        submit.addEventListener('click', () => {
          try {
            const answers = collectQuestionAnswers(items, container);
            void answerQuestion(question.id, { answers }, submit);
          } catch (error) {
            showToast(error.message);
          }
        });
        actions.append(submit);
        const reject = el('button', 'mini danger', '拒绝回答');
        reject.type = 'button';
        reject.addEventListener('click', () =>
          void answerQuestion(question.id, { reject: true }, reject),
        );
        actions.append(reject);
        card.append(actions);
      } else {
        const fields = Array.isArray(question.payload?.fields) ? question.payload.fields : [];
        const container = el('div', 'question-fields');
        for (const field of fields) container.append(buildQuestionField(field));
        card.append(container);
        const actions = el('div', 'question-actions');
        const submit = el('button', 'primary mini', '提交回答');
        submit.type = 'button';
        submit.addEventListener('click', () => {
          try {
            const answer = collectQuestionAnswer(fields, container);
            void answerQuestion(question.id, { answer }, submit);
          } catch (error) {
            showToast(error.message);
          }
        });
        actions.append(submit);
        card.append(actions);
      }
      questionsList.append(card);
    }
  }

  function buildQuestionItem(index, item, total) {
    const block = el('div', 'question-item');
    block.dataset.questionIndex = String(index);
    const heading = el('div', 'question-title', String(item?.header || `问题 ${index + 1}`));
    if (total > 1) {
      heading.append(el('span', 'question-meta', `（${index + 1}/${total}）`));
    }
    block.append(heading);
    if (item?.question) {
      block.append(el('div', 'question-meta', String(item.question)));
    }
    const options = Array.isArray(item?.options) ? item.options : [];
    if (options.length > 0) {
      const wrap = el('div', 'caps-row');
      for (const option of options) {
        const optionLabel = el('label');
        const input = el('input', 'q-choice');
        input.type = item?.multiple ? 'checkbox' : 'radio';
        input.name = `q-${index}`;
        input.value = String(option.label ?? '');
        optionLabel.append(input, document.createTextNode(String(option.label ?? '')));
        if (option.description) {
          optionLabel.title = String(option.description);
        }
        wrap.append(optionLabel);
      }
      block.append(wrap);
    }
    if (item?.custom) {
      const input = el('input', 'q-custom-text');
      input.type = 'text';
      input.placeholder = '自定义回答…';
      block.append(input);
    }
    return block;
  }

  function collectQuestionAnswers(items, container) {
    const answers = [];
    for (const [index] of items.entries()) {
      const block = container.querySelector(`[data-question-index="${index}"]`);
      if (!block) {
        answers.push([]);
        continue;
      }
      const picked = [...block.querySelectorAll('.q-choice:checked')].map(
        (input) => input.value,
      );
      const custom = block.querySelector('.q-custom-text')?.value.trim();
      if (custom) picked.push(custom);
      answers.push(picked);
    }
    if (answers.every((picked) => picked.length === 0)) {
      throw new Error('请至少回答一个问题');
    }
    return answers;
  }

  async function answerQuestion(id, payload, button) {
    if (button) button.disabled = true;
    try {
      const response = await fetch(
        `/admin/api/questions/${encodeURIComponent(id)}/answer`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${state.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setLoggedIn(false);
        return;
      }
      if (!response.ok) {
        throw new Error(body?.error?.message || `提交失败（HTTP ${response.status}）`);
      }
      showToast('回答已提交，任务继续执行');
      await refresh();
    } catch (error) {
      showToast(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function labeled(text, control, className) {
    const label = el('label', className);
    label.append(document.createTextNode(text), control);
    return label;
  }

  function readOptionalInteger(value, name, min) {
    const trimmed = String(value).trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
      throw new Error(`${name} 必须是 >= ${min} 的整数`);
    }
    return n;
  }

  function readOptionalNumber(value, name, min) {
    const trimmed = String(value).trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < min) {
      throw new Error(`${name} 必须是 >= ${min} 的数字`);
    }
    return n;
  }

  function addExistingKeyRow(key) {
    const row = el('div', 'editor-row key-editor-row');
    row.dataset.mode = 'existing';
    row.dataset.label = key.label;
    row.append(el('span', 'row-title', key.label));

    const sub = el('div', 'row-sub');
    sub.append(el('span', 'key-secret', key.hasKey ? key.masked : '未设置'));
    if (key.keyEnv) sub.append(el('span', 'key-stats', `env: ${key.keyEnv}`));
    else if (key.encrypted) sub.append(el('span', 'key-stats', '已加密'));
    else if (key.hasKey) sub.append(chip('明文', 'bad'));
    sub.append(keyStatusChip(key));
    row.append(sub);

    const action = el('select', 'key-action-select');
    for (const [value, text] of [
      ['keep', '保留密钥'],
      ['set_env', '改用环境变量'],
      ['set_key', '更换密钥（加密保存）'],
      ['remove', '删除密钥'],
    ]) {
      const option = el('option', '', text);
      option.value = value;
      action.append(option);
    }
    action.value = 'keep';
    row.append(action);

    const field = el('div', 'row-field');
    const renderField = () => {
      field.replaceChildren();
      if (action.value === 'set_env') {
        const input = el('input', 'env-input');
        input.placeholder = '环境变量名，例如 STATION_A_KEY';
        input.autocomplete = 'off';
        if (key.keyEnv) input.value = key.keyEnv;
        field.append(input);
      } else if (action.value === 'set_key') {
        const input = el('input', 'key-input');
        input.type = 'password';
        input.autocomplete = 'off';
        input.placeholder = '新的密钥值';
        field.append(input);
      }
    };
    action.addEventListener('change', renderField);
    renderField();
    row.append(field);

    keysEditor.append(row);
  }

  function addNewKeyRow() {
    const row = el('div', 'editor-row key-editor-row');
    row.dataset.mode = 'new';

    const label = el('input', 'key-label-input');
    label.placeholder = 'label（如 main）';
    label.autocomplete = 'off';
    row.append(label);

    const mode = el('select', 'key-mode');
    const modes = state.secretStorage.available
      ? [
          ['key', '加密保存（推荐）'],
          ['env', '环境变量'],
        ]
      : [['env', '环境变量']];
    for (const [value, text] of modes) {
      const option = el('option', '', text);
      option.value = value;
      mode.append(option);
    }
    row.append(mode);

    const field = el('div', 'row-field');
    const renderField = () => {
      field.replaceChildren();
      if (mode.value === 'env') {
        const input = el('input', 'env-input');
        input.placeholder = '环境变量名，例如 STATION_A_KEY';
        input.autocomplete = 'off';
        field.append(input);
      } else {
        const input = el('input', 'key-input');
        input.type = 'password';
        input.autocomplete = 'off';
        input.placeholder = '密钥值（保存时加密，不落明文）';
        field.append(input);
      }
    };
    mode.addEventListener('change', renderField);
    renderField();
    row.append(field);

    const remove = el('button', 'mini danger model-remove', '移除');
    remove.type = 'button';
    remove.addEventListener('click', () => row.remove());
    row.append(remove);

    keysEditor.append(row);
  }

  function emptyModel() {
    return {
      id: '',
      upstream: undefined,
      contextWindow: undefined,
      maxOutputTokens: undefined,
      capabilities: { tools: true, vision: false, reasoning: false },
      pricing: undefined,
      reasoningEffort: undefined,
      source: 'config',
    };
  }

  function normalizeModel(model) {
    return {
      id: model?.id ?? '',
      upstream:
        model?.upstream && model.upstream !== model.id ? model.upstream : undefined,
      contextWindow: model?.contextWindow ?? undefined,
      maxOutputTokens: model?.maxOutputTokens ?? undefined,
      capabilities: {
        tools: model?.capabilities?.tools !== false,
        vision: Boolean(model?.capabilities?.vision),
        reasoning: Boolean(model?.capabilities?.reasoning),
      },
      pricing: model?.pricing ?? undefined,
      reasoningEffort: model?.reasoningEffort ?? undefined,
      source: model?.source ?? 'config',
    };
  }

  function buildModelCard(model) {
    const card = el('div', 'editor-row model-editor-row');
    const head = el('div', 'model-head');
    head.append(el('span', 'row-title', model.id || '新模型'));
    if (model.source === 'upstream') head.append(el('span', 'muted', '上游同步'));
    card.append(head);

    const idInput = el('input', 'm-id');
    idInput.placeholder = '对外模型名，例如 gpt-4o-mini';
    idInput.value = model.id ?? '';
    idInput.autocomplete = 'off';
    idInput.addEventListener('input', () => {
      const current = state.editingModels[state.selectedModelIndex];
      const typed = idInput.value.trim();
      if (current) current.id = typed || current.id;
      const title = idInput.closest('.model-editor-row')?.querySelector('.model-head .row-title');
      if (title) title.textContent = typed || '新模型';
      refreshSelectedOptionText();
    });
    const upstreamInput = el('input', 'm-upstream');
    upstreamInput.placeholder = '上游名；opencode 填 providerID/modelID，qoder 填模型 key（留空=同模型 ID）';
    upstreamInput.value = model.upstream ?? '';
    upstreamInput.autocomplete = 'off';
    upstreamInput.setAttribute('list', 'upstream-options');
    upstreamInput.addEventListener('input', () => {
      const current = state.editingModels[state.selectedModelIndex];
      if (current) current.upstream = upstreamInput.value.trim() || undefined;
      refreshSelectedOptionText();
    });
    // 输入值命中探测候选（datalist 选择或手输）时，自动回填其余留空字段。
    upstreamInput.addEventListener('change', () => {
      const candidate = findProbedCandidate(upstreamInput.value);
      if (candidate) applyProbedModel(candidate);
    });

    const contextInput = el('input', 'm-context');
    contextInput.type = 'number';
    contextInput.min = '1';
    contextInput.placeholder = '留空=自动取上游目录最大值';
    contextInput.title = '留空时自动采用上游目录声明的上下文窗口（多次同步取最大值）；填写后以手工值为准';
    contextInput.value = model.contextWindow ? String(model.contextWindow) : '';

    const outputInput = el('input', 'm-output');
    outputInput.type = 'number';
    outputInput.min = '1';
    outputInput.placeholder = '留空=自动取上游目录最大值';
    outputInput.title = '留空时自动采用上游目录声明的最大输出（多次同步取最大值）；填写后以手工值为准';
    outputInput.value = model.maxOutputTokens ? String(model.maxOutputTokens) : '';

    const priceIn = el('input', 'm-price-in');
    priceIn.type = 'number';
    priceIn.min = '0';
    priceIn.step = '0.001';
    priceIn.placeholder = '如 0.15';
    priceIn.value =
      model.pricing?.inputPerMtok !== undefined ? String(model.pricing.inputPerMtok) : '';

    const priceOut = el('input', 'm-price-out');
    priceOut.type = 'number';
    priceOut.min = '0';
    priceOut.step = '0.001';
    priceOut.placeholder = '如 0.6';
    priceOut.value =
      model.pricing?.outputPerMtok !== undefined ? String(model.pricing.outputPerMtok) : '';

    const effortInput = el('input', 'm-effort');
    effortInput.setAttribute('list', 'effort-options');
    effortInput.placeholder = '默认（low/medium/high/xhigh/max…）';
    effortInput.value = model.reasoningEffort ?? '';
    effortInput.autocomplete = 'off';

    const grid = el('div', 'model-grid');
    grid.append(
      labeled('模型 ID', idInput),
      labeled('上游模型名', upstreamInput),
      labeled('上下文窗口', contextInput),
      labeled('最大输出 tokens', outputInput),
      labeled('输入价格 / Mtok ($)', priceIn),
      labeled('输出价格 / Mtok ($)', priceOut),
      labeled('推理强度', effortInput),
    );
    card.append(grid);

    const caps = el('div', 'caps-row');
    const makeCheck = (className, text, checked) => {
      const input = el('input', className);
      input.type = 'checkbox';
      input.checked = checked;
      const label = el('label');
      label.append(input, document.createTextNode(text));
      return label;
    };
    caps.append(
      makeCheck('m-tools', '工具调用', model.capabilities.tools),
      makeCheck('m-vision', '视觉', model.capabilities.vision),
      makeCheck('m-reasoning', '推理', model.capabilities.reasoning),
    );
    card.append(caps);

    return card;
  }

  function readPositiveInteger(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
  }

  function readNonNegativeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  function syncFormToSelectedModel() {
    const card = modelsEditor.querySelector('.model-editor-row');
    const model = state.editingModels[state.selectedModelIndex];
    if (!card || !model) return;
    model.id = card.querySelector('.m-id').value.trim() || model.id;
    model.upstream = card.querySelector('.m-upstream').value.trim() || undefined;
    model.contextWindow = readPositiveInteger(card.querySelector('.m-context').value);
    model.maxOutputTokens = readPositiveInteger(card.querySelector('.m-output').value);
    const inputPerMtok = readNonNegativeNumber(card.querySelector('.m-price-in').value);
    const outputPerMtok = readNonNegativeNumber(card.querySelector('.m-price-out').value);
    model.pricing =
      inputPerMtok !== undefined || outputPerMtok !== undefined
        ? { inputPerMtok, outputPerMtok }
        : undefined;
    model.capabilities = {
      tools: card.querySelector('.m-tools').checked,
      vision: card.querySelector('.m-vision').checked,
      reasoning: card.querySelector('.m-reasoning').checked,
    };
    const effort = card.querySelector('.m-effort')?.value.trim();
    model.reasoningEffort = effort || undefined;
  }

  function refreshSelectedOptionText() {
    const model = state.editingModels[state.selectedModelIndex];
    const option = modelPicker.querySelector(`option[value="${state.selectedModelIndex}"]`);
    if (!model || !option) return;
    option.textContent = modelOptionLabel(model);
  }

  /** 模型下拉的显示文本：未起名的模型显示占位，避免下拉框一片空白像坏掉了。 */
  function modelOptionLabel(model) {
    if (!model) return '';
    const name = String(model.id ?? '').trim() || '（未命名模型）';
    return model.upstream && model.upstream !== model.id ? `${name} → ${model.upstream}` : name;
  }

  function renderModelPicker() {
    modelPicker.replaceChildren();
    const groups = [
      ['手工配置', state.editingModels.filter((model) => model.source !== 'upstream')],
      ['上游同步', state.editingModels.filter((model) => model.source === 'upstream')],
    ];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      const group = el('optgroup');
      group.label = `${label}（${list.length}）`;
      for (const model of list) {
        const option = el('option');
        option.value = String(state.editingModels.indexOf(model));
        option.textContent = modelOptionLabel(model);
        group.append(option);
      }
      modelPicker.append(group);
    }
    modelPicker.value = String(state.selectedModelIndex);
    modelCount.textContent = `${state.editingModels.length} 个`;
    modelRemoveBtn.disabled = state.editingModels.length <= 1;
    modelRemoveBtn.title =
      state.editingModels.length <= 1
        ? '至少保留一个模型；要换模型请直接改当前卡片，或先「添加模型」再移除旧的'
        : '移除当前选中的模型';
  }

  function renderModelForm() {
    modelsEditor.replaceChildren();
    const model = state.editingModels[state.selectedModelIndex];
    if (model) modelsEditor.append(buildModelCard(model));
  }

  function updateChannelTypeVisibility() {
    const type = $('#ch-type').value;
    const isOpenAI = type === 'openai-compatible';
    const isOpenCode = type === 'opencode';
    const isZcode = type === 'zcode';
    const isQoder = type === 'qoder';
    for (const node of document.querySelectorAll('#channel-dialog .openai-only')) {
      node.hidden = !isOpenAI;
    }
    for (const node of document.querySelectorAll('#channel-dialog .opencode-only')) {
      node.hidden = !isOpenCode;
    }
    for (const node of document.querySelectorAll('#channel-dialog .zcode-only')) {
      node.hidden = !isZcode;
    }
    for (const node of document.querySelectorAll('#channel-dialog .qoder-only')) {
      node.hidden = !isQoder;
    }
    for (const node of document.querySelectorAll('#channel-dialog .cli-only')) {
      node.hidden = !(isOpenCode || isZcode || isQoder);
    }
    // openai-compatible / opencode / qoder 都能探测模型目录（qoder 走 daemon.get_models）；
    // zcode 没有目录可探测，按手填处理。前缀规则只对能自动发现模型的 openai/opencode 生效。
    const probeSupported = isOpenAI || isOpenCode || isQoder;
    probeModelsBtn.hidden = !probeSupported;
    modelPrefixesRow.hidden = !(isOpenAI || isOpenCode);
    if (!probeSupported) {
      resetProbeState();
    }
  }

  function openChannelDialog(channel) {
    state.editingChannelId = channel ? channel.id : null;
    $('#channel-dialog-title').textContent = channel ? `编辑渠道 · ${channel.id}` : '新增渠道';
    $('#channel-form-error').hidden = true;

    const idInput = $('#ch-id');
    idInput.value = channel?.id ?? '';
    idInput.disabled = Boolean(channel);

    const typeSelect = $('#ch-type');
    typeSelect.value = channel?.type ?? 'openai-compatible';
    typeSelect.disabled = Boolean(channel);

    $('#ch-priority').value = String(channel?.priority ?? 100);
    $('#ch-enabled').checked = channel ? channel.enabled : true;
    const prefixRules = channel?.opencode?.modelPrefixes ?? channel?.modelPrefixes ?? {};
    modelPrefixesInput.value = Object.entries(prefixRules)
      .map(([pattern, prefix]) => `${pattern}=${prefix}`)
      .join('\n');
    $('#ch-base-url').value = channel?.baseUrl ?? '';
    $('#ch-auth-header').value = channel?.authHeader ?? 'bearer';
    $('#ch-token-field').value = channel?.tokenLimitField ?? 'max_tokens';
    $('#ch-stream-options').checked = channel ? channel.sendStreamOptions !== false : true;
    $('#ch-free-only').checked = channel?.freeOnly === true;
    $('#ch-reasoning-field').value = channel?.reasoningField ?? '';
    $('#ch-reasoning-off-field').value = channel?.reasoningOffField ?? '';
    $('#ch-models-url').value = channel?.modelsUrl ?? '';
    $('#ch-user-agent').value = channel?.userAgent ?? '';
    $('#ch-session-header').value = channel?.sessionHeader ?? '';
    const bridge = channel?.opencode ?? channel?.zcode ?? channel?.qoder ?? null;
    $('#ch-command').value =
      bridge?.command ??
      (channel?.type === 'zcode' ? 'node' : channel?.type === 'qoder' ? 'qodercli' : 'opencode');
    $('#ch-workspace').value = bridge?.workspace ?? './workspace';
    $('#ch-workspace-roots').value = (bridge?.workspaceRoots ?? []).join('\n');
    $('#ch-flavor').value = channel?.opencode?.flavor ?? 'opencode';
    $('#ch-codearts-data-dir').value = channel?.opencode?.codeartsDataDir ?? '';
    $('#ch-model-filter').value = (channel?.opencode?.modelFilter ?? []).join('\n');
    $('#ch-agent').value = channel?.opencode?.agent ?? 'build';
    $('#ch-permission-mode').value = channel?.opencode?.permissionMode ?? 'ask';
    $('#ch-auto-models').checked = channel?.opencode?.autoModels !== false;
    $('#ch-max-workers').value = String(bridge?.maxWorkers ?? 1);
    $('#ch-max-sessions').value = String(bridge?.maxConcurrentSessions ?? 4);
    $('#ch-idle-ttl-min').value = String(Math.round((bridge?.idleTtlMs ?? 900000) / 60000));
    $('#ch-first-byte-sec').value = String(
      Math.round((channel?.opencode?.firstByteTimeoutMs ?? 120000) / 1000),
    );
    $('#ch-stream-heartbeat-sec').value = String(
      Math.round((channel?.opencode?.streamHeartbeatMs ?? 10000) / 1000),
    );
    $('#ch-event-debug-frames').value = String(channel?.opencode?.eventDebugFrames ?? 20);
    $('#ch-memory-mb').value = String(channel?.opencode?.memoryBudgetMb ?? 0);
    $('#ch-oc-base-url').value = channel?.opencode?.baseUrl ?? '';
    $('#ch-args').value = (channel?.zcode?.args ?? []).join('\n');
    $('#ch-zcode-env').value = Object.entries(channel?.zcode?.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    $('#ch-mode').value = channel?.zcode?.mode ?? 'build';
    $('#ch-qoder-args').value = (channel?.qoder?.args ?? []).join('\n');
    $('#ch-qoder-env').value = Object.entries(channel?.qoder?.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    $('#ch-qoder-mode').value = channel?.qoder?.mode ?? 'auto';

    keysEditor.replaceChildren();
    if (channel) {
      for (const key of channel.keys) addExistingKeyRow(key);
    } else {
      addNewKeyRow();
    }

    state.editingModels = channel
      ? channel.models.map(normalizeModel)
      : [emptyModel()];
    state.selectedModelIndex = 0;
    renderModelPicker();
    renderModelForm();

    resetProbeState();
    updateChannelTypeVisibility();
    channelDialog.showModal();
    if (!channel) idInput.focus();
  }

  function collectKeys() {
    const rows = Array.from(keysEditor.querySelectorAll('.key-editor-row'));
    const labels = new Set();
    return rows.map((row) => {
      const existing = row.dataset.mode === 'existing';
      const label = existing
        ? row.dataset.label
        : row.querySelector('.key-label-input').value.trim();
      if (!label) throw new Error('新密钥需要填写 label');
      if (labels.has(label)) throw new Error(`密钥 label 重复：${label}`);
      labels.add(label);

      if (existing) {
        const action = row.querySelector('.key-action-select').value;
        if (action === 'keep' || action === 'remove') return { action, label };
        if (action === 'set_env') {
          const keyEnv = row.querySelector('.env-input')?.value.trim();
          if (!keyEnv) throw new Error(`密钥 ${label} 请填写环境变量名`);
          return { action, label, keyEnv };
        }
        const key = row.querySelector('.key-input')?.value.trim();
        if (!key) throw new Error(`密钥 ${label} 请填写新密钥`);
        return { action: 'set_key', label, key };
      }

      const mode = row.querySelector('.key-mode').value;
      if (mode === 'env') {
        const keyEnv = row.querySelector('.env-input')?.value.trim();
        if (!keyEnv) throw new Error(`密钥 ${label} 请填写环境变量名`);
        return { action: 'new', label, mode: 'env', keyEnv };
      }
      const key = row.querySelector('.key-input')?.value.trim();
      if (!key) throw new Error(`密钥 ${label} 请填写密钥值`);
      return { action: 'new', label, mode: 'key', key };
    });
  }

  function collectModels(allowEmpty = false) {
    syncFormToSelectedModel();
    const models = state.editingModels.slice();
    if (!models.length) {
      if (allowEmpty) return [];
      throw new Error('至少添加一个模型');
    }
    const seen = new Set();
    return models.map((model) => {
      const id = String(model.id ?? '').trim();
      if (!id) throw new Error('模型 ID 不能为空');
      if (seen.has(id)) throw new Error(`模型 ID 重复：${id}`);
      seen.add(id);
      const upstream = String(model.upstream ?? '').trim();
      const contextWindow = model.contextWindow;
      if (
        contextWindow !== undefined &&
        !(Number.isInteger(contextWindow) && contextWindow > 0)
      ) {
        throw new Error(`模型 ${id} 的上下文窗口必须为正整数`);
      }
      const maxOutputTokens = model.maxOutputTokens;
      if (
        maxOutputTokens !== undefined &&
        !(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0)
      ) {
        throw new Error(`模型 ${id} 的最大输出必须为正整数`);
      }
      const pricing = model.pricing;
      if (pricing) {
        for (const [name, value] of [
          ['输入', pricing.inputPerMtok],
          ['输出', pricing.outputPerMtok],
        ]) {
          if (value !== undefined && !(Number.isFinite(value) && value >= 0)) {
            throw new Error(`模型 ${id} 的${name}价格必须为非负数`);
          }
        }
      }
      return {
        id,
        upstream: upstream || undefined,
        contextWindow,
        maxOutputTokens,
        capabilities: {
          tools: Boolean(model.capabilities?.tools),
          vision: Boolean(model.capabilities?.vision),
          reasoning: Boolean(model.capabilities?.reasoning),
        },
        pricing:
          pricing &&
          (pricing.inputPerMtok !== undefined || pricing.outputPerMtok !== undefined)
            ? { inputPerMtok: pricing.inputPerMtok, outputPerMtok: pricing.outputPerMtok }
            : undefined,
        reasoningEffort: model.reasoningEffort,
      };
    });
  }

  /** 解析“模型名前缀规则”文本域：每行 模式=前缀，空行忽略。 */
  function parseModelPrefixRules(text) {
    const rules = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) throw new Error(`前缀规则行格式错误（应为 模式=前缀）：${trimmed}`);
      const pattern = trimmed.slice(0, eq).trim();
      const prefix = trimmed.slice(eq + 1).trim();
      if (!pattern || !prefix || /\s/.test(prefix) || /\s/.test(pattern)) {
        throw new Error(`前缀规则行不合法（模式与前缀不能含空白）：${trimmed}`);
      }
      if (rules[pattern] !== undefined) throw new Error(`前缀规则模式重复：${pattern}`);
      rules[pattern] = prefix;
    }
    return rules;
  }

  function buildChannelPayload(forProbe = false) {
    const id = $('#ch-id').value.trim();
    if (!id) throw new Error('请填写渠道 ID');
    const type = $('#ch-type').value;
    const priority = readOptionalInteger($('#ch-priority').value, '优先级', -1000000);
    const autoModels = type === 'opencode' && $('#ch-auto-models').checked;
    // 探测只关心渠道连接字段；跳过模型卡片校验，未填完的“新模型”卡片不应阻塞探测。
    const models = forProbe ? [] : collectModels(autoModels);
    const payload = {
      id,
      type,
      priority: priority ?? 100,
      enabled: $('#ch-enabled').checked,
      models,
      keys: [],
      modelPrefixes: parseModelPrefixRules(modelPrefixesInput.value),
    };
    if (type === 'openai-compatible') {
      const baseUrl = $('#ch-base-url').value.trim();
      if (!baseUrl) throw new Error('请填写 Base URL');
      payload.baseUrl = baseUrl;
      payload.authHeader = $('#ch-auth-header').value;
      payload.tokenLimitField = $('#ch-token-field').value;
      payload.sendStreamOptions = $('#ch-stream-options').checked;
      payload.freeOnly = $('#ch-free-only').checked;
      payload.reasoningField = $('#ch-reasoning-field').value.trim();
      payload.reasoningOffField = $('#ch-reasoning-off-field').value.trim();
      payload.modelsUrl = $('#ch-models-url').value.trim();
      payload.userAgent = $('#ch-user-agent').value.trim();
      payload.sessionHeader = $('#ch-session-header').value.trim();
      payload.keys = collectKeys();
    } else if (type === 'opencode') {
      payload.flavor = $('#ch-flavor').value;
      const codeartsDataDir = $('#ch-codearts-data-dir').value.trim();
      if (codeartsDataDir) payload.codeartsDataDir = codeartsDataDir;
      payload.modelFilter = $('#ch-model-filter')
        .value.split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      payload.command = $('#ch-command').value.trim() || undefined;
      payload.workspace = $('#ch-workspace').value.trim() || undefined;
      payload.workspaceRoots = $('#ch-workspace-roots')
        .value.split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      payload.agent = $('#ch-agent').value.trim() || undefined;
      payload.permissionMode = $('#ch-permission-mode').value;
      payload.autoModels = $('#ch-auto-models').checked;
      const maxWorkers = readOptionalInteger($('#ch-max-workers').value, '最大 worker 数', 1);
      const maxSessions = readOptionalInteger(
        $('#ch-max-sessions').value,
        '每 worker 并发会话',
        1,
      );
      const idleMinutes = readOptionalInteger(
        $('#ch-idle-ttl-min').value,
        '空闲回收分钟',
        1,
      );
      const memoryMb = readOptionalInteger($('#ch-memory-mb').value, '内存预算 MB', 0);
      const firstByteSeconds = readOptionalInteger(
        $('#ch-first-byte-sec').value,
        '首包超时秒',
        0,
      );
      const heartbeatSeconds = readOptionalInteger(
        $('#ch-stream-heartbeat-sec').value,
        '静默 SSE 心跳秒',
        0,
      );
      const eventDebugFrames = readOptionalInteger(
        $('#ch-event-debug-frames').value,
        '/event 调试帧数',
        0,
      );
      payload.maxWorkers = maxWorkers;
      payload.maxConcurrentSessions = maxSessions;
      payload.idleTtlMs = idleMinutes !== undefined ? idleMinutes * 60000 : undefined;
      payload.memoryBudgetMb = memoryMb;
      payload.firstByteTimeoutMs =
        firstByteSeconds !== undefined ? firstByteSeconds * 1000 : undefined;
      payload.streamHeartbeatMs =
        heartbeatSeconds !== undefined ? heartbeatSeconds * 1000 : undefined;
      payload.eventDebugFrames = eventDebugFrames;
      const baseUrl = $('#ch-oc-base-url').value.trim();
      if (baseUrl) payload.baseUrl = baseUrl;
      payload.keys = [];
    } else if (type === 'zcode') {
      payload.command = $('#ch-command').value.trim() || undefined;
      payload.args = $('#ch-args')
        .value.split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      const zcodeEnv = {};
      for (const line of $('#ch-zcode-env').value.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) throw new Error(`CLI 环境变量行格式错误（应为 KEY=VALUE）：${trimmed}`);
        zcodeEnv[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
      payload.env = zcodeEnv;
      payload.workspace = $('#ch-workspace').value.trim() || undefined;
      payload.workspaceRoots = $('#ch-workspace-roots')
        .value.split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      payload.mode = $('#ch-mode').value;
      const maxWorkers = readOptionalInteger($('#ch-max-workers').value, '最大 worker 数', 1);
      const maxSessions = readOptionalInteger(
        $('#ch-max-sessions').value,
        '每 worker 并发会话',
        1,
      );
      const idleMinutes = readOptionalInteger(
        $('#ch-idle-ttl-min').value,
        '空闲回收分钟',
        1,
      );
      payload.maxWorkers = maxWorkers;
      payload.maxConcurrentSessions = maxSessions;
      payload.idleTtlMs = idleMinutes !== undefined ? idleMinutes * 60000 : undefined;
      payload.keys = [];
    } else if (type === 'qoder') {
      payload.command = $('#ch-command').value.trim() || undefined;
      payload.args = $('#ch-qoder-args')
        .value.split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      const qoderEnv = {};
      for (const line of $('#ch-qoder-env').value.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) throw new Error(`CLI 环境变量行格式错误（应为 KEY=VALUE）：${trimmed}`);
        qoderEnv[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
      payload.env = qoderEnv;
      payload.workspace = $('#ch-workspace').value.trim() || undefined;
      payload.workspaceRoots = $('#ch-workspace-roots')
        .value.split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      payload.mode = $('#ch-qoder-mode').value;
      const maxWorkers = readOptionalInteger($('#ch-max-workers').value, '最大 worker 数', 1);
      const maxSessions = readOptionalInteger(
        $('#ch-max-sessions').value,
        '每 worker 并发会话',
        1,
      );
      const idleMinutes = readOptionalInteger(
        $('#ch-idle-ttl-min').value,
        '空闲回收分钟',
        1,
      );
      payload.maxWorkers = maxWorkers;
      payload.maxConcurrentSessions = maxSessions;
      payload.idleTtlMs = idleMinutes !== undefined ? idleMinutes * 60000 : undefined;
      payload.keys = [];
    }
    return payload;
  }

  function setProbeStatus(text) {
    probeStatus.textContent = text;
    probeStatus.hidden = !text;
  }

  function resetProbeState() {
    state.probedModels = [];
    upstreamOptions.replaceChildren();
    probeResults.replaceChildren();
    probeResults.hidden = true;
    setProbeStatus('');
  }

  function probedModelMeta(candidate) {
    const parts = [];
    if (candidate.label && candidate.id) parts.push(candidate.id);
    if (candidate.contextWindow) parts.push(`上下文 ${compactFmt.format(candidate.contextWindow)}`);
    if (candidate.maxOutputTokens) parts.push(`输出 ${compactFmt.format(candidate.maxOutputTokens)}`);
    const caps = candidate.capabilities ?? {};
    const capText = [caps.tools && '工具', caps.vision && '视觉', caps.reasoning && '推理']
      .filter(Boolean)
      .join('/');
    if (capText) parts.push(capText);
    const pricing = candidate.pricing;
    if (
      pricing &&
      (pricing.inputPerMtok !== undefined || pricing.outputPerMtok !== undefined)
    ) {
      parts.push(`$${pricing.inputPerMtok ?? '?'}/$${pricing.outputPerMtok ?? '?'} /Mtok`);
    }
    return parts.join(' · ');
  }

  function renderProbeResults() {
    probeResults.replaceChildren();
    if (!state.probedModels.length) {
      probeResults.hidden = true;
      return;
    }
    const details = el('details', 'probe-details');
    details.open = true;
    details.append(
      el('summary', null, `候选列表（${state.probedModels.length}）— 点击填入当前模型`),
    );
    for (const candidate of state.probedModels) {
      const row = el('div', 'probe-row');
      const pick = el('button', 'mini probe-pick');
      pick.type = 'button';
      pick.textContent =
        candidate.label ||
        (candidate.upstream && candidate.upstream !== candidate.id
          ? `${candidate.id} → ${candidate.upstream}`
          : candidate.id);
      const meta = el('span', 'muted probe-meta', probedModelMeta(candidate));
      pick.title = meta.textContent || pick.textContent;
      pick.addEventListener('click', () => applyProbedModel(candidate));
      row.append(pick, meta);
      details.append(row);
    }
    probeResults.append(details);
    probeResults.hidden = false;
  }

  function populateUpstreamDatalist() {
    upstreamOptions.replaceChildren();
    for (const candidate of state.probedModels) {
      const option = el('option');
      option.value = candidate.upstream || candidate.id;
      if (candidate.upstream && candidate.upstream !== candidate.id) option.label = candidate.id;
      upstreamOptions.append(option);
    }
  }

  function findProbedCandidate(value) {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return state.probedModels.find((m) => m.upstream === trimmed || m.id === trimmed) ?? null;
  }

  /** 把探测候选回填到当前模型卡片：upstream 必填，其余仅在留空时采用，能力勾选只做升级。 */
  function applyProbedModel(candidate) {
    syncFormToSelectedModel();
    const model = state.editingModels[state.selectedModelIndex];
    if (!model || !candidate) return;
    model.upstream = candidate.upstream || candidate.id || model.upstream;
    if (!model.id) model.id = candidate.id;
    if (!model.contextWindow && candidate.contextWindow) {
      model.contextWindow = candidate.contextWindow;
    }
    if (!model.maxOutputTokens && candidate.maxOutputTokens) {
      model.maxOutputTokens = candidate.maxOutputTokens;
    }
    if (candidate.pricing) {
      const inputPerMtok = model.pricing?.inputPerMtok ?? candidate.pricing.inputPerMtok;
      const outputPerMtok = model.pricing?.outputPerMtok ?? candidate.pricing.outputPerMtok;
      if (inputPerMtok !== undefined || outputPerMtok !== undefined) {
        model.pricing = { inputPerMtok, outputPerMtok };
      }
    }
    model.capabilities = {
      tools: model.capabilities.tools || Boolean(candidate.capabilities?.tools),
      vision: model.capabilities.vision || Boolean(candidate.capabilities?.vision),
      reasoning: model.capabilities.reasoning || Boolean(candidate.capabilities?.reasoning),
    };
    renderModelPicker();
    renderModelForm();
  }

  async function probeUpstreamModels() {
    if (state.probeBusy) return;
    const type = $('#ch-type').value;
    $('#channel-form-error').hidden = true;
    state.probeBusy = true;
    probeModelsBtn.disabled = true;
    setProbeStatus(
      type === 'opencode'
        ? '探测中…（opencode 需要拉起 CLI，可能需要几十秒）'
        : type === 'qoder'
          ? '探测中…（qoder 需要拉起 CLI 读取模型目录，可能需要十几秒）'
          : '探测中…',
    );
    try {
      const payload = buildChannelPayload(true);
      const response = await fetch('/admin/api/channels/probe-models', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${state.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setLoggedIn(false);
        throw new Error('登录已失效，请重新登录');
      }
      if (!response.ok) {
        throw new Error(body?.error?.message || `探测失败（HTTP ${response.status}）`);
      }
      state.probedModels = Array.isArray(body.models) ? body.models : [];
      populateUpstreamDatalist();
      renderProbeResults();
      if (!state.probedModels.length) {
        const hint =
          type === 'opencode' && $('#ch-model-filter').value.trim()
            ? '；检查“模型过滤”白名单是否放行'
            : type === 'openai-compatible' && $('#ch-free-only').checked
              ? '；只保留上游显式标记 isFree:true 的模型'
              : type === 'qoder'
                ? '；检查 Qoder 是否已登录（daemon.authenticate 失败会写在渠道 worker 状态里）'
                : '';
        setProbeStatus(`上游没有返回可用模型${hint}`);
      } else {
        setProbeStatus(
          `探测到 ${state.probedModels.length} 个上游模型：点击候选填入当前模型，或在“上游模型名”输入框下拉选择`,
        );
      }
    } catch (error) {
      resetProbeState();
      setProbeStatus(`探测失败：${error.message}`);
    } finally {
      state.probeBusy = false;
      probeModelsBtn.disabled = false;
    }
  }

  async function saveChannel() {
    const errorEl = $('#channel-form-error');
    const saveButton = $('#channel-save');
    errorEl.hidden = true;
    saveButton.disabled = true;
    try {
      const payload = buildChannelPayload();
      const editing = Boolean(state.editingChannelId);
      const response = await fetch(
        editing
          ? `/admin/api/channels/${encodeURIComponent(state.editingChannelId)}`
          : '/admin/api/channels',
        {
          method: editing ? 'PUT' : 'POST',
          headers: {
            authorization: `Bearer ${state.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setLoggedIn(false);
        throw new Error('登录已失效，请重新登录');
      }
      if (!response.ok) {
        throw new Error(body?.error?.message || `保存失败（HTTP ${response.status}）`);
      }
      channelDialog.close();
      const warnings = Array.isArray(body.warnings) ? body.warnings : [];
      showToast([editing ? '渠道已更新' : '渠道已创建', ...warnings].join('；'));
      await refresh();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
      // 同一校验错误重复触发时 DOM 不会有任何变化，补一条 toast，避免“点了没反应”。
      showToast(error.message);
      highlightInvalidField(error.message);
    } finally {
      saveButton.disabled = false;
    }
  }

  /** 把校验错误落到具体输入框：聚焦 + 红框 + 滚入可视区，而不是只在底部写一行字。 */
  function highlightInvalidField(message) {
    const card = modelsEditor.querySelector('.model-editor-row');
    let target = null;
    if (/模型 ID/.test(message)) target = card?.querySelector('.m-id') ?? null;
    else if (/上下文窗口/.test(message)) target = card?.querySelector('.m-context') ?? null;
    else if (/最大输出/.test(message)) target = card?.querySelector('.m-output') ?? null;
    else if (/价格/.test(message)) target = card?.querySelector('.m-price-in') ?? null;
    else if (/上游/.test(message)) target = card?.querySelector('.m-upstream') ?? null;
    else if (/渠道 ID/.test(message)) target = $('#ch-id');
    if (!target) return;
    target.focus({ preventScroll: true });
    target.classList.add('input-invalid');
    window.setTimeout(() => target.classList.remove('input-invalid'), 2000);
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  async function deleteChannelById(id) {
    if (!window.confirm(`删除渠道 ${id}？该操作会写入配置文件。`)) return;
    try {
      const response = await fetch(`/admin/api/channels/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${state.token}` },
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setLoggedIn(false);
        return;
      }
      if (!response.ok) {
        throw new Error(body?.error?.message || `删除失败（HTTP ${response.status}）`);
      }
      showToast(`渠道 ${id} 已删除`);
      await refresh();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function runMaintenance(path, successText) {
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}` },
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setLoggedIn(false);
        return;
      }
      if (!response.ok) {
        throw new Error(body?.error?.message || `操作失败（HTTP ${response.status}）`);
      }
      showToast(successText);
      await refresh();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function exportData() {
    try {
      const response = await fetch('/admin/api/export', {
        headers: { authorization: `Bearer ${state.token}` },
      });
      if (response.status === 401) {
        setLoggedIn(false);
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error?.message || `导出失败（HTTP ${response.status}）`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `code2api-backup-${new Date().toISOString().slice(0, 10)}.db`;
      anchor.click();
      URL.revokeObjectURL(url);
      showToast('数据库备份已导出');
    } catch (error) {
      showToast(error.message);
    }
  }

  const RETRY_CATEGORY_OPTIONS = [
    ['rate_limit', '限流 429'],
    ['server', '服务端 5xx'],
    ['timeout', '超时'],
    ['network', '网络错误'],
    ['empty_stream', '空首包'],
  ];

  function renderRetry(data) {
    state.retryEditable = data.editable !== false;
    retryNote.textContent = state.retryEditable ? '' : '当前配置只读';
    retrySaveBtn.disabled = !state.retryEditable;
    if (state.retryDirty) return;
    const retry = data.retry || {};
    retryEnabled.checked = retry.enabled !== false;
    retryRespect.checked = retry.respectRetryAfter !== false;
    retryMax.value = String(retry.maxRetries ?? 5);
    retryInitial.value = String(retry.initialDelayMs ?? 500);
    retryMaxDelay.value = String(retry.maxDelayMs ?? 10000);
    retryJitter.value = String(retry.jitterRatio ?? 0.1);
    retryTotal.value = String(retry.maxTotalWaitMs ?? 120000);
    const selected = new Set(
      Array.isArray(retry.retryOn)
        ? retry.retryOn
        : RETRY_CATEGORY_OPTIONS.map(([value]) => value),
    );
    retryCategoriesEl.replaceChildren();
    for (const [value, label] of RETRY_CATEGORY_OPTIONS) {
      const option = el('label', 'check-row');
      const input = el('input');
      input.type = 'checkbox';
      input.value = value;
      input.checked = selected.has(value);
      option.append(input, document.createTextNode(label));
      retryCategoriesEl.append(option);
    }
  }

  function markRetryDirty() {
    state.retryDirty = true;
    retryNote.textContent = '有未保存的修改';
  }

  function retryInt(value, name, min, max) {
    const n = Number(String(value).trim());
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
    }
    return n;
  }

  async function saveRetry() {
    try {
      const enabled = retryEnabled.checked;
      const retryOn = [...retryCategoriesEl.querySelectorAll('input[type="checkbox"]:checked')]
        .map((input) => input.value);
      if (enabled && retryOn.length === 0) {
        throw new Error('启用自动重试时至少选择一个重试类别');
      }
      const initialDelayMs = retryInt(retryInitial.value, '初始退避', 1, 3600000);
      const maxDelayMs = retryInt(retryMaxDelay.value, '最大退避', 1, 3600000);
      if (maxDelayMs < initialDelayMs) {
        throw new Error('最大退避不能小于初始退避');
      }
      const jitterRatio = Number(retryJitter.value);
      if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
        throw new Error('抖动比例必须在 0–1 之间');
      }
      const payload = {
        enabled,
        maxRetries: retryInt(retryMax.value, '最大重试次数', 0, 20),
        initialDelayMs,
        maxDelayMs,
        jitterRatio,
        retryOn,
        respectRetryAfter: retryRespect.checked,
        maxTotalWaitMs: retryInt(retryTotal.value, '总等待上限', 1, 3600000),
      };
      retrySaveBtn.disabled = true;
      const response = await fetch('/admin/api/retry', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${state.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setLoggedIn(false);
        return;
      }
      if (!response.ok) {
        throw new Error(body?.error?.message || `保存失败（HTTP ${response.status}）`);
      }
      state.retryDirty = false;
      showToast('重试设置已保存并热加载');
      await refresh();
    } catch (error) {
      showToast(error.message);
    } finally {
      retrySaveBtn.disabled = !state.retryEditable;
    }
  }

  const PRIVACY_CATEGORY_LABELS = {
    config_secret: '配置密钥',
    api_key: 'API Key',
    jwt: 'JWT',
    assignment: '口令赋值',
    private_key: '私钥块',
    connection: '连接串',
    bearer: 'Bearer',
    identity_path: '用户目录',
    email: '邮箱',
    uid: '用户名/UID',
    restore: '还原',
  };
  const PRIVACY_ACTION_LABELS = { detected: '检出', tokenized: '已替换', restored: '已还原' };
  const PRIVACY_ACTION_TONES = { detected: 'warn', tokenized: 'good', restored: 'idle' };

  function renderPrivacy(data) {
    state.privacyEditable = data.editable !== false;
    privacyNote.textContent = state.privacyEditable ? '' : '当前配置只读';
    privacySaveBtn.disabled = !state.privacyEditable;
    const status = data.status || {};
    const modeLabel = { off: '关闭', audit: '仅审计', token: '令牌化' }[status.mode] || status.mode;
    const parts = [`当前生效：${modeLabel}`];
    if (status.degraded) parts.push('⚠ 加密不可用，token 已降级为 audit');
    parts.push(`精确保护 ${status.configSecrets ?? 0} 个配置密钥`);
    parts.push(`保管库 ${status.vaultEntries ?? 0} 条`);
    if (status.secretStorage) parts.push(`加密后端：${status.secretStorage.backend}`);
    const totals = data.totals || {};
    parts.push(`区间内检出 ${totals.detected ?? 0} / 替换 ${totals.tokenized ?? 0} / 还原 ${totals.restored ?? 0}`);
    privacyStatus.textContent = parts.join(' · ');

    if (!state.privacyDirty) {
      const cfg = data.config || {};
      privacyMode.value = cfg.mode || 'off';
      privacyIdentity.checked = Boolean(cfg.identity);
      privacyConfigSecrets.checked = cfg.protectConfigSecrets !== false;
      privacyInclude.value = (cfg.providers?.include || []).join(', ');
      privacyExclude.value = (cfg.providers?.exclude || []).join(', ');
      privacyRetention.value = String(cfg.tokenRetentionDays ?? 30);
      privacyMaxVault.value = String(cfg.maxVaultEntries ?? 5000);
    }

    privacyEventsBody.replaceChildren();
    const events = data.events || [];
    if (!events.length) {
      const tr = el('tr');
      const cell = td('该区间暂无隐私事件', 'empty');
      cell.colSpan = 7;
      tr.append(cell);
      privacyEventsBody.append(tr);
    }
    for (const item of events) {
      const tr = el('tr');
      tr.append(td(fmtTime(item.ts)));
      tr.append(td(item.provider));
      tr.append(td(item.direction === 'outbound' ? '出站' : '入站'));
      tr.append(td(PRIVACY_CATEGORY_LABELS[item.category] || item.category));
      const actionCell = el('td');
      actionCell.append(
        chip(PRIVACY_ACTION_LABELS[item.action] || item.action, PRIVACY_ACTION_TONES[item.action] || 'idle'),
      );
      tr.append(actionCell);
      tr.append(td(fmtInt(item.count), 'num'));
      tr.append(td(item.masked || '—'));
      privacyEventsBody.append(tr);
    }

    privacyVaultBody.replaceChildren();
    const vault = data.vault || [];
    privacyVaultNote.textContent = `占位符 → 加密真值，明文不出本机（共 ${status.vaultEntries ?? vault.length} 条，显示最近 ${vault.length} 条）`;
    if (!vault.length) {
      const tr = el('tr');
      const cell = td('保管库为空', 'empty');
      cell.colSpan = 5;
      tr.append(cell);
      privacyVaultBody.append(tr);
    }
    for (const row of vault) {
      const tr = el('tr');
      tr.append(td(row.placeholder));
      tr.append(td(PRIVACY_CATEGORY_LABELS[row.category] || row.category));
      tr.append(td(row.masked));
      tr.append(td(fmtInt(row.hits), 'num'));
      tr.append(td(fmtTime(row.lastUsedAt)));
      privacyVaultBody.append(tr);
    }
  }

  function markPrivacyDirty() {
    state.privacyDirty = true;
    privacyNote.textContent = '有未保存的修改';
  }

  function privacyInt(value, name, min, max) {
    const n = Number(String(value).trim());
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
    }
    return n;
  }

  function splitIds(value) {
    return String(value)
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function savePrivacy() {
    try {
      const payload = {
        mode: privacyMode.value,
        identity: privacyIdentity.checked,
        protectConfigSecrets: privacyConfigSecrets.checked,
        providers: {
          include: splitIds(privacyInclude.value),
          exclude: splitIds(privacyExclude.value),
        },
        tokenRetentionDays: privacyInt(privacyRetention.value, '保留天数', 1, 3650),
        maxVaultEntries: privacyInt(privacyMaxVault.value, '保管库容量', 10, 100000),
      };
      privacySaveBtn.disabled = true;
      const response = await fetch('/admin/api/privacy', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${state.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setLoggedIn(false);
        return;
      }
      if (!response.ok) {
        throw new Error(body?.error?.message || `保存失败（HTTP ${response.status}）`);
      }
      state.privacyDirty = false;
      showToast('隐私守卫设置已保存并热加载');
      await refresh();
    } catch (error) {
      showToast(error.message);
    } finally {
      privacySaveBtn.disabled = !state.privacyEditable;
    }
  }

  async function refresh() {
    if (!state.token || state.loading) return;
    state.loading = true;
    const range = state.range;
    try {
      const retryRequest = api('/admin/api/retry').catch((error) => {
        if (error instanceof AuthError) throw error;
        return null;
      });
      const privacyRequest = api(`/admin/api/privacy?range=${encodeURIComponent(range)}`).catch((error) => {
        if (error instanceof AuthError) throw error;
        return null;
      });
      const [overview, requests, models, channelData, questionData, retryData, privacyData] =
        await Promise.all([
          api(`/admin/api/overview?range=${encodeURIComponent(range)}`),
          api(`/admin/api/requests?range=${encodeURIComponent(range)}&limit=100`),
          api('/admin/api/models'),
          api('/admin/api/channels'),
          api('/admin/api/questions'),
          retryRequest,
          privacyRequest,
        ]);
      renderOverview(overview);
      renderRequests(requests.requests || []);
      renderModels(models.models || []);
      renderChannels(channelData);
      renderQuestions(questionData);
      if (retryData) {
        renderRetry(retryData);
      } else {
        state.retryEditable = false;
        retrySaveBtn.disabled = true;
        retryNote.textContent = '当前运行版本不支持重试设置，重启网关后可用';
      }
      if (privacyData) {
        renderPrivacy(privacyData);
      } else {
        state.privacyEditable = false;
        privacySaveBtn.disabled = true;
        privacyNote.textContent = '当前运行版本不支持隐私守卫，重启网关后可用';
      }
      setConn(true);
      setLoggedIn(true);
      loginError.hidden = true;
      updatedAt.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    } catch (error) {
      if (error instanceof AuthError) {
        state.token = '';
        sessionStorage.removeItem(TOKEN_KEY);
        setLoggedIn(false);
        loginError.textContent = '口令无效或已更换，请重新输入。';
        loginError.hidden = false;
      } else {
        setConn(false);
        showToast(`刷新失败：${error.message}`);
      }
    } finally {
      state.loading = false;
    }
  }

  async function login() {
    const value = tokenInput.value.trim();
    if (!value) {
      loginError.textContent = '请输入管理口令。';
      loginError.hidden = false;
      return;
    }
    loginBtn.disabled = true;
    loginBtn.textContent = '连接中…';
    try {
      const response = await fetch(`/admin/api/overview?range=${encodeURIComponent(state.range)}`, {
        headers: { authorization: `Bearer ${value}` },
        cache: 'no-store',
      });
      if (response.status === 401) {
        loginError.textContent = '口令不正确，请检查启动日志或 config.yaml。';
        loginError.hidden = false;
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.token = value;
      sessionStorage.setItem(TOKEN_KEY, value);
      loginError.hidden = true;
      setLoggedIn(true);
      await refresh();
    } catch (error) {
      loginError.textContent = error instanceof AuthError ? '口令不正确。' : '无法连接网关，请确认服务已启动。';
      loginError.hidden = false;
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = '连接';
    }
  }

  loginBtn.addEventListener('click', login);
  tokenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') login();
  });

  for (const node of [
    retryEnabled,
    retryRespect,
    retryMax,
    retryInitial,
    retryMaxDelay,
    retryJitter,
    retryTotal,
  ]) {
    node.addEventListener('input', markRetryDirty);
    node.addEventListener('change', markRetryDirty);
  }
  retryCategoriesEl.addEventListener('change', markRetryDirty);
  retrySaveBtn.addEventListener('click', () => void saveRetry());

  for (const node of [
    privacyMode,
    privacyIdentity,
    privacyConfigSecrets,
    privacyInclude,
    privacyExclude,
    privacyRetention,
    privacyMaxVault,
  ]) {
    node.addEventListener('input', markPrivacyDirty);
    node.addEventListener('change', markPrivacyDirty);
  }
  privacySaveBtn.addEventListener('click', () => void savePrivacy());

  addChannelBtn.addEventListener('click', () => openChannelDialog(null));
  $('#probe-btn').addEventListener('click', () =>
    void runMaintenance('/admin/api/maintenance/probe', '探活完成'),
  );
  $('#keepalive-btn').addEventListener('click', () =>
    void runMaintenance('/admin/api/maintenance/keepalive', '保活已触发'),
  );
  $('#clear-cooldowns-btn').addEventListener('click', async () => {
    const button = $('#clear-cooldowns-btn');
    button.disabled = true;
    try {
      const response = await fetch('/admin/api/maintenance/clear-cooldowns', {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}` },
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setLoggedIn(false);
        return;
      }
      if (!response.ok) {
        throw new Error(body?.error?.message || `操作失败（HTTP ${response.status}）`);
      }
      showToast(`已清空 ${body.cleared ?? 0} 个密钥的冷却`);
      await refresh();
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });
  $('#export-btn').addEventListener('click', () => void exportData());
  $('#channel-close').addEventListener('click', () => channelDialog.close());
  $('#channel-cancel').addEventListener('click', () => channelDialog.close());
  $('#channel-save').addEventListener('click', () => void saveChannel());
  $('#add-key-btn').addEventListener('click', () => addNewKeyRow());
  $('#add-model-btn').addEventListener('click', () => {
    syncFormToSelectedModel();
    state.editingModels.push(emptyModel());
    state.selectedModelIndex = state.editingModels.length - 1;
    renderModelPicker();
    renderModelForm();
  });
  probeModelsBtn.addEventListener('click', () => void probeUpstreamModels());
  modelPicker.addEventListener('change', () => {
    syncFormToSelectedModel();
    state.selectedModelIndex = Number(modelPicker.value);
    renderModelForm();
  });
  modelFilter.addEventListener('input', () => {
    state.modelFilter = modelFilter.value.trim().toLowerCase();
    renderModels(state.models);
  });
  modelRemoveBtn.addEventListener('click', () => {
    syncFormToSelectedModel();
    state.editingModels.splice(state.selectedModelIndex, 1);
    state.selectedModelIndex = Math.max(
      0,
      Math.min(state.selectedModelIndex, state.editingModels.length - 1),
    );
    renderModelPicker();
    renderModelForm();
  });
  $('#ch-type').addEventListener('change', () => {
    // 换渠道类型后旧的探测候选不再适用，清掉避免误填到别的类型。
    resetProbeState();
    updateChannelTypeVisibility();
  });
  $('#ch-opencode-go-preset').addEventListener('click', () => {
    $('#ch-base-url').value = 'https://opencode.ai/inference/go/openai/v1';
    $('#ch-models-url').value = 'https://opencode.ai/inference/go/v1/models';
    $('#ch-session-header').value = 'x-opencode-session';
    $('#ch-auth-header').value = 'bearer';
    if (!$('#ch-user-agent').value.trim()) {
      $('#ch-user-agent').value = 'code2api-gateway/1.0';
    }
  });
  $('#ch-kilo-preset').addEventListener('click', () => {
    $('#ch-base-url').value = 'https://ai-gateway.kilo.ai/api/v1';
    $('#ch-models-url').value = '';
    $('#ch-session-header').value = '';
    $('#ch-free-only').checked = true;
    $('#ch-reasoning-field').value = 'reasoning.effort';
    $('#ch-reasoning-off-field').value = 'reasoning.enabled';
    if (!state.editingChannelId) keysEditor.replaceChildren();
  });
  /**
   * 检测到本机 Qoder 后自动读模型目录：用户不需要知道 upstream 叫什么。
   * 当前模型卡片还没起名时，把 daemon 的默认模型（没有则第一个）直接填进去。
   */
  async function autoFillQoderModels() {
    if (!$('#ch-id').value.trim()) {
      setProbeStatus('先填渠道 ID，再点「探测上游」即可自动读取 Qoder 模型目录');
      return;
    }
    await probeUpstreamModels();
    if (!state.probedModels.length) return;
    const current = state.editingModels[state.selectedModelIndex];
    if (!current || current.id) return;
    const preferred =
      state.probedModels.find((candidate) => candidate.default) ?? state.probedModels[0];
    applyProbedModel(preferred);
    showToast(`已探测到 ${state.probedModels.length} 个 Qoder 模型，已预填 ${preferred.id}`);
  }

  $('#ch-qoder-detect').addEventListener('click', async () => {
    const button = $('#ch-qoder-detect');
    button.disabled = true;
    try {
      const response = await fetch('/admin/api/qoder/detect', {
        headers: { authorization: `Bearer ${state.token}` },
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setLoggedIn(false);
        return;
      }
      if (!response.ok) {
        throw new Error(body?.error?.message || `检测失败（HTTP ${response.status}）`);
      }
      $('#ch-command').value = body.command ?? '';
      $('#ch-qoder-args').value = Array.isArray(body.args) ? body.args.join('\n') : '';
      $('#ch-qoder-env').value = Object.entries(body.env ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      $('#ch-qoder-mode').value = 'auto';
      if (body.cliLoginHint) {
        setProbeStatus(body.cliLoginHint);
        showToast('Qoder 运行时已填入，但 Qoder CLI 尚未登录');
      } else {
        showToast(`已填入 Qoder ${body.version ?? ''}，正在读取模型目录…`);
      }
      // 模型名不要求用户猜：检测完直接问 daemon（daemon.get_models）并预填。
      await autoFillQoderModels();
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  channelsBody.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-channel-action]');
    if (!button) return;
    const id = button.dataset.channelId;
    const action = button.dataset.channelAction;
    if (!id) return;
    if (action === 'edit') {
      const channel = state.channels.find((item) => item.id === id);
      if (channel) openChannelDialog(channel);
    } else if (action === 'delete') {
      void deleteChannelById(id);
    }
  });

  $('#logout-btn').addEventListener('click', () => {
    state.token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    setLoggedIn(false);
  });

  $('#refresh-btn').addEventListener('click', () => {
    void refresh();
  });

  $('#range').addEventListener('change', (event) => {
    state.range = event.target.value;
    void refresh();
  });

  window.setInterval(() => {
    if (!document.hidden) void refresh();
  }, 5000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });

  if (state.token) {
    setLoggedIn(true);
    void refresh();
  } else {
    setLoggedIn(false);
    tokenInput.focus();
  }
})();
