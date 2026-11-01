// 麦当劳中国 MCP（Streamable HTTP）零依赖客户端
// 只依赖 Node 18+ 内置的 fetch / fs，不引入任何第三方包。
// 协议要点见 references/protocol.md。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';

export const DEFAULT_BASE_URL = 'https://mcp.mcd.cn';
export const CLIENT_INFO = { name: 'mcd-mcp-skill', version: '1.0.0' };

/** 配置文件路径：环境变量 > 平台默认目录 */
export function configPath() {
  if (process.env.MCD_CONFIG) return process.env.MCD_CONFIG;
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'mcd-mcp', 'config.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'mcd-mcp', 'config.json');
}

/** 读取本地配置（不存在则返回空对象） */
export function loadConfig() {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON：${p}\n${e.message}`);
  }
}

/** 写入本地配置（自动建目录，权限 600，仅本人可读） */
export function saveConfig(cfg) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return p;
}

/**
 * Token 解析顺序：环境变量 MCD_MCP_TOKEN > 配置文件 token
 * 注意：绝不把 token 打进日志或错误信息。
 */
export function resolveToken(explicit) {
  const t = explicit || process.env.MCD_MCP_TOKEN || loadConfig().token;
  if (!t || !String(t).trim()) {
    throw new Error(
      '缺少 MCP Token。\n' +
        '  1) 打开 https://open.mcd.cn/mcp 用手机号登录\n' +
        '  2) 右上角「控制台」→「激活」→ 复制 Token\n' +
        '  3) 运行：node scripts/mcd.mjs login <token>\n' +
        '  （或用环境变量 MCD_MCP_TOKEN 提供）',
    );
  }
  return String(t).trim();
}

/** 打码显示，用于 status 输出 */
export function maskToken(t) {
  if (!t) return '(未配置)';
  const s = String(t);
  if (s.length <= 10) return s.slice(0, 2) + '***';
  return `${s.slice(0, 6)}…${s.slice(-4)}（${s.length} 字符）`;
}

export class McpError extends Error {
  constructor(message, { status, code, data, body } = {}) {
    super(message);
    this.name = 'McpError';
    this.status = status;
    this.code = code;
    this.data = data;
    this.body = body;
  }
}

/**
 * 最小的 MCP Streamable HTTP 客户端。
 * 只实现 tools 能力：initialize / tools/list / tools/call。
 */
export class McpClient {
  constructor({ url, token, timeoutMs = 60000, protocolVersion = '2025-06-18' } = {}) {
    this.url = url || DEFAULT_BASE_URL;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.protocolVersion = protocolVersion;
    this.sessionId = null;
    this.negotiatedVersion = null;
    this.ready = false;
    this._id = 0;
    this._connecting = null;
  }

  get endpoint() {
    return this.url.replace(/\/+$/, '');
  }

  _headers() {
    const h = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': `${CLIENT_INFO.name}/${CLIENT_INFO.version}`,
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.negotiatedVersion) h['mcp-protocol-version'] = this.negotiatedVersion;
    return h;
  }

  /** 发一条 JSON-RPC，返回 result（通知则返回 null） */
  async _rpc(method, params, { notification = false } = {}) {
    const payload = { jsonrpc: '2.0', method };
    if (!notification) payload.id = ++this._id;
    if (params !== undefined) payload.params = params;

    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const reason = e?.name === 'TimeoutError' ? `超时（${this.timeoutMs}ms）` : e?.message || String(e);
      throw new McpError(`无法连接 ${this.endpoint}：${reason}`);
    }

    // 会话号只在 initialize 的响应里出现
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 401) {
      throw new McpError('Token 无效或已过期（HTTP 401）。重新去 https://open.mcd.cn/mcp 控制台复制新 Token。', {
        status: 401,
      });
    }
    if (res.status === 429) {
      throw new McpError('触发限流（HTTP 429，上限 600 次/分钟）。等一会儿再试。', { status: 429 });
    }
    if (notification) {
      // 通知的响应体可以忽略
      if (!res.ok && res.status !== 202) {
        throw new McpError(`通知 ${method} 失败：HTTP ${res.status}`, { status: res.status });
      }
      return null;
    }
    if (!res.ok) {
      const body = await safeText(res);
      throw new McpError(`HTTP ${res.status}（${method}）：${body.slice(0, 400)}`, { status: res.status, body });
    }

    const message = await readJsonRpcResult(res, payload.id);
    if (!message) {
      throw new McpError(`${method}：服务端没有返回匹配 id=${payload.id} 的响应`);
    }
    if (message.error) {
      throw new McpError(`${method} 出错：${message.error.message || JSON.stringify(message.error)}`, {
        code: message.error.code,
        data: message.error.data,
      });
    }
    return message.result ?? null;
  }

  /** 握手。协议版本不支持时自动降级重试。并发调用共享同一次握手。 */
  async connect() {
    if (this.ready) return this;
    if (this._connecting) return this._connecting;
    this._connecting = this._doConnect().finally(() => {
      this._connecting = null;
    });
    return this._connecting;
  }

  async _doConnect() {
    const candidates = [...new Set([this.protocolVersion, '2025-06-18', '2025-03-26', '2024-11-05'])];
    let lastErr;
    for (const version of candidates) {
      try {
        this.sessionId = null;
        this.negotiatedVersion = null;
        const result = await this._rpc('initialize', {
          protocolVersion: version,
          capabilities: { tools: {} },
          clientInfo: CLIENT_INFO,
        });
        this.negotiatedVersion = result?.protocolVersion || version;
        // 握手后补一条 initialized 通知
        await this._rpc('notifications/initialized', undefined, { notification: true });
        this.ready = true;
        return this;
      } catch (e) {
        lastErr = e;
        // 401/429 没必要换版本重试
        if (e.status === 401 || e.status === 429) throw e;
      }
    }
    throw lastErr;
  }

  async listTools() {
    await this.connect();
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await this._rpc('tools/list', cursor ? { cursor } : {});
      const batch = result?.tools || [];
      tools.push(...batch);
      cursor = result?.nextCursor;
      if (!cursor || batch.length === 0) break;
    }
    return tools;
  }

  /** 调用工具。返回 { text, isError, raw } */
  async callTool(name, args = {}) {
    await this.connect();
    const result = await this._rpc('tools/call', { name, arguments: args ?? {} });
    const content = result?.content ?? [];
    const texts = content.filter((c) => c?.type === 'text').map((c) => c.text);
    return {
      isError: Boolean(result?.isError),
      text: texts.join('\n'),
      content,
      structured: result?.structuredContent ?? null,
      raw: result,
    };
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * 从响应里取 JSON-RPC 消息。
 * 服务端可能返回 application/json（单条），也可能返回 text/event-stream（若干条 data: {...}）。
 */
async function readJsonRpcResult(res, wantId) {
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  const body = await safeText(res);

  if (ctype.includes('text/event-stream')) {
    const messages = parseSse(body);
    // 优先返回 id 匹配的那条；其次返回第一条带 result/error 的
    const hit = messages.find((m) => m && m.id === wantId);
    if (hit) return hit;
    return messages.find((m) => m && (m.result !== undefined || m.error !== undefined)) || null;
  }

  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) return parsed.find((m) => m.id === wantId) || parsed[0] || null;
    return parsed;
  } catch {
    // 有些网关会给 SSE 但 content-type 标错，兜底再试一次
    const messages = parseSse(body);
    const hit = messages.find((m) => m && m.id === wantId);
    if (hit) return hit;
    return messages.find((m) => m && (m.result !== undefined || m.error !== undefined)) || null;
  }
}

function parseSse(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n');
    if (!payload || payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      /* 忽略解析不了的事件 */
    }
  }
  return out;
}

/** 把工具定义转成 JSON Schema（MCP 的 inputSchema 就是 JSON Schema） */
export function summarizeTool(tool) {
  const props = tool?.inputSchema?.properties || {};
  return {
    name: tool?.name,
    title: tool?.title || tool?.annotations?.title || '',
    description: (tool?.description || '').replace(/\s+/g, ' ').trim(),
    required: tool?.inputSchema?.required || [],
    properties: Object.keys(props),
  };
}
