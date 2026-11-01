#!/usr/bin/env node
// 通用通知分发器 —— 把 mcd watch 的状态变化发到任何地方。
//
// 它自己不绑定任何 IM：目标全写在配置里（config.json 的 notify.targets），
// 目前支持三种：
//   webhook   —— 任意 HTTP 接口（QQ 机器人 / 飞书 / 钉钉 / Slack / Bark / 自建服务都行）
//   telegram  —— Telegram Bot API
//   command   —— 交给任意命令行程序（需要的话连脚本都不用写）
//
// 用法：
//   node scripts/notify.mjs                    # 由 mcd watch 自动调用，读环境变量
//   node scripts/notify.mjs --text "测试"      # 手工发一条
//   node scripts/notify.mjs --dry              # 只打印不发送
//
// 可读的环境变量（由 mcd watch 注入）：
//   MCD_STATUS / MCD_ORDER_ID / MCD_CODE / MCD_AMOUNT

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/* ───────────── 配置 ───────────── */

function configPath() {
  if (process.env.MCD_CONFIG) return process.env.MCD_CONFIG;
  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'mcd-mcp', 'config.json');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'mcd-mcp', 'config.json');
}

function loadNotifyConfig() {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'))?.notify || {};
  } catch {
    return {};
  }
}

/* ───────────── 参数 ───────────── */

const argv = process.argv.slice(2);
const args = { _: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[k] = next;
      i++;
    } else args[k] = true;
  } else args._.push(a);
}

const DRY = Boolean(args.dry);
const cfg = loadNotifyConfig();

const vars = {
  status: process.env.MCD_STATUS || '',
  orderId: process.env.MCD_ORDER_ID || '',
  code: process.env.MCD_CODE || '',
  amount: process.env.MCD_AMOUNT || '',
};

/** 默认文案；可以在配置里写 notify.text 覆盖 */
const DEFAULT_TEXT = '麦当劳｜{status}\n订单 {orderId}\n取餐码 {code}\n金额 ¥{amount}';

function render(template) {
  const raw = String(template ?? '');
  const filled = raw
    .replace(/\{status\}/g, vars.status)
    .replace(/\{orderId\}/g, vars.orderId)
    .replace(/\{code\}/g, vars.code)
    .replace(/\{amount\}/g, vars.amount)
    .replace(/\{\{text\}\}/g, ''); // 先占位，稍后整体替换
  // 不要让空字段留下「取餐码 」这种尾巴
  return filled
    .split('\n')
    .filter((line) => !/^(订单|取餐码|金额 ¥)$/.test(line.trim()))
    .join('\n')
    .trim();
}

const text = args.text ? String(args.text) : render(cfg.text || DEFAULT_TEXT);
const jsonText = JSON.stringify(text);

/** 把 {{text}} 换成 JSON 安全的字符串；没有用它就把 text 拼在末尾 */
function fillBody(body) {
  if (body == null) return JSON.stringify({ text });
  const s = String(body);
  if (s.includes('{{text}}')) return s.replace(/\{\{text\}\}/g, jsonText.slice(1, -1));
  return s
    .replace(/\{status\}/g, vars.status)
    .replace(/\{orderId\}/g, vars.orderId)
    .replace(/\{code\}/g, vars.code)
    .replace(/\{amount\}/g, vars.amount);
}

/* ───────────── 三种出口 ───────────── */

async function sendWebhook(t) {
  const url = String(t.url || '').replace(/\{status\}/g, encodeURIComponent(vars.status));
  if (!url) throw new Error('webhook 缺少 url');
  const method = String(t.method || 'POST').toUpperCase();
  const headers = { 'content-type': 'application/json', ...(t.headers || {}) };
  const body = method === 'GET' ? undefined : fillBody(t.body);

  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(Number(t.timeoutMs || 10000)),
  });
  const resp = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status} ${resp.slice(0, 200)}`);
  return `HTTP ${res.status}`;
}

async function sendTelegram(t) {
  if (!t.token || !t.chatId) throw new Error('telegram 需要 token 和 chatId');
  const url = `https://api.telegram.org/bot${t.token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: t.chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(Number(t.timeoutMs || 10000)),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(`telegram: ${j.description || res.status}`);
  return 'telegram ok';
}

function sendCommand(t) {
  const cmd = String(t.cmd || '');
  if (!cmd) throw new Error('command 缺少 cmd');
  const r = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      MCD_STATUS: vars.status,
      MCD_ORDER_ID: vars.orderId,
      MCD_CODE: vars.code,
      MCD_AMOUNT: vars.amount,
      MCD_TEXT: text,
    },
    timeout: Number(t.timeoutMs || 30000),
  });
  if (r.status !== 0) throw new Error(`command 退出码 ${r.status}：${(r.stderr || '').slice(0, 200)}`);
  return 'command ok';
}

const SENDERS = { webhook: sendWebhook, telegram: sendTelegram, command: sendCommand };

/* ───────────── 主流程 ───────────── */

async function main() {
  const targets = Array.isArray(cfg.targets) ? cfg.targets : [];

  if (!targets.length) {
    console.error(
      '没有配置通知目标。\n' +
        '  加一个 webhook：  node scripts/mcd.mjs notify add --type webhook --url "https://..."\n' +
        '  加一个 tg：       node scripts/mcd.mjs notify add --type telegram --token "..." --chat-id "..."\n' +
        '  加一个命令：      node scripts/mcd.mjs notify add --type command --cmd "你的程序"\n' +
        '  看当前配置：      node scripts/mcd.mjs notify list',
    );
    process.exit(2);
  }

  if (DRY) {
    console.log(`[dry] 文案：\n${text}\n`);
    console.log(`[dry] 目标 ${targets.length} 个：`);
    targets.forEach((t, i) => console.log(`  ${i + 1}. ${t.type} ${t.url || t.chatId || t.cmd || ''}`));
    return;
  }

  let ok = 0;
  for (const [i, t] of targets.entries()) {
    const fn = SENDERS[t.type];
    try {
      if (!fn) throw new Error(`不认识的目标类型：${t.type}`);
      const r = await fn(t);
      ok++;
      console.log(`  [${i + 1}] ${t.type} ✓ ${r}`);
    } catch (e) {
      console.log(`  [${i + 1}] ${t.type} ✗ ${e.message}`);
    }
  }

  console.log(`发送完成：${ok}/${targets.length} 成功`);
  process.exit(ok > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('notify 出错：' + (e?.message || e));
  process.exit(1);
});
