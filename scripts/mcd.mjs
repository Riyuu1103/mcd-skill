#!/usr/bin/env node
// mcd — 麦当劳中国 MCP 命令行客户端
// 用法见 README.md / SKILL.md。零依赖，Node 18+。

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  McpClient,
  McpError,
  DEFAULT_BASE_URL,
  configPath,
  loadConfig,
  saveConfig,
  resolveToken,
  maskToken,
} from './mcp-client.mjs';
import {
  MODES,
  getProfile,
  setProfilePath,
  unsetProfilePath,
  cacheGet,
  cacheSet,
  cacheClear,
  cacheDir,
} from './store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ─────────────────────────── 参数解析 ─────────────────────────── */

const argv = process.argv.slice(2);
const flags = { _: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') {
    flags._.push(...argv.slice(i + 1));
    break;
  }
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    let val = true;
    if (next !== undefined && !next.startsWith('--')) {
      val = next;
      i++;
    }
    if (key in flags) flags[key] = [].concat(flags[key], val);
    else flags[key] = val;
  } else {
    flags._.push(a);
  }
}

const command = flags._[0] || 'help';
const rest = flags._.slice(1);

function list(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function die(msg, code = 1) {
  console.error(String(msg).replace(/\s+$/, ''));
  process.exit(code);
}

function out(text) {
  process.stdout.write(String(text).replace(/\s+$/, '') + '\n');
}

const stamp = () => new Date().toTimeString().slice(0, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 状态变化时跑一条外部命令，占位符：
 *   {status} 中文状态  {orderId} 订单号  {code} 取餐码  {amount} 金额
 * 例：--on-change "notify.exe {status} {orderId}"
 */
function runHook(template, { status, orderId, order }) {
  const cmd = String(template)
    .replace(/\{status\}/g, status)
    .replace(/\{orderId\}/g, orderId)
    .replace(/\{code\}/g, order?.pickupCode || '')
    .replace(/\{amount\}/g, order?.realTotalAmount || '');
  try {
    const child = spawn(cmd, { shell: true, stdio: 'ignore', detached: true, windowsHide: true });
    child.unref();
  } catch (e) {
    out(`  （回调命令没跑起来：${e.message}）`);
  }
}

/* ─────────────────────────── 显示宽度 ─────────────────────────── */

/** 中日韩字符按 2 列算，保证表格在终端里对齐 */
function width(s) {
  let n = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    n += cp > 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)) ? 2 : 1;
  }
  return n;
}

function pad(s, n) {
  const str = String(s ?? '');
  return str + ' '.repeat(Math.max(0, n - width(str)));
}

const yuan = (fen) => (Number(fen) / 100).toFixed(2);

/* ─────────────────────────── 连接与调用 ─────────────────────────── */

/** 不可逆的写入类工具：必须显式 --confirm 才真的发出去 */
const WRITE_TOOLS = new Set([
  'create-order',
  'cancel-order',
  'mall-create-order',
  'mall-create-order-physical',
  'party-order-create',
  'draw-lottery',
  'auto-bind-coupons',
  'delivery-create-address',
]);

let _client = null;

function makeClient() {
  if (_client) return _client;
  const cfg = loadConfig();
  let token;
  try {
    token = resolveToken();
  } catch (e) {
    if (!flags.url && !process.env.MCD_MCP_URL) throw e;
    token = undefined;
  }
  _client = new McpClient({
    url: flags.url || process.env.MCD_MCP_URL || cfg.url || DEFAULT_BASE_URL,
    token,
    timeoutMs: Number(flags.timeout || cfg.timeoutMs || 60000),
  });
  return _client;
}

/**
 * 从工具返回的文本里抠出业务 JSON。
 * 麦当劳的 MCP 会在正文前后附一段给人看的说明文字，里面还有 `data[].storeName`
 * 这种方括号，所以不能随便挑第一个 { 或 [ —— 优先找带 success 的对象。
 */
function extractJson(text) {
  const s = String(text || '');
  const objects = [];
  const arrays = [];

  for (let i = 0; i < s.length; i++) {
    const openCh = s[i];
    if (openCh !== '{' && openCh !== '[') continue;
    const closeCh = openCh === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === openCh) depth++;
      else if (c === closeCh) {
        depth--;
        if (depth === 0) {
          try {
            const val = JSON.parse(s.slice(i, j + 1));
            (openCh === '{' ? objects : arrays).push(val);
          } catch {
            /* 不是合法 JSON，继续 */
          }
          break;
        }
      }
    }
  }

  // 业务包体一定带 success / data
  const business = objects.find((o) => o && typeof o === 'object' && ('success' in o || 'data' in o));
  if (business) return business;
  if (objects.length) return objects[0];
  if (arrays.length) return arrays.find((a) => a.length > 0) || arrays[0];
  return null;
}

/** 调工具并把麦当劳那层 { success, code, message, data } 拆出来 */
async function runTool(name, args) {
  const client = makeClient();
  const r = await client.callTool(name, args ?? {});
  const payload = extractJson(r.text);
  if (!payload) {
    if (r.isError) throw new Error(r.text || '工具返回错误');
    return { success: true, data: r.text, text: r.text };
  }
  if (payload?.success === false) {
    const bits = [payload.code && `code=${payload.code}`, payload.traceId && `traceId=${payload.traceId}`]
      .filter(Boolean)
      .join(' ');
    throw new Error(`${name} 失败：${payload.message || '未知错误'}${bits ? `（${bits}）` : ''}`);
  }
  return payload;
}

function guardWrite(name, args) {
  if (!WRITE_TOOLS.has(name)) return true;
  if (flags.confirm) return true;
  out('⛔ 这个工具会**真的改变账户/花钱**，已拦截，没有发出。');
  out('');
  out(`工具：${name}`);
  out(`入参：${JSON.stringify(args, null, 2)}`);
  out('');
  out('确认无误后加 --confirm 再跑一次。');
  process.exit(3);
}

/** 缓存工具清单，用于把 k=v 按声明类型转换 */
let _toolMap = null;
async function toolSchema(name) {
  if (!_toolMap) {
    const client = makeClient();
    const cached = cacheGet('tools', 30 * 60 * 1000);
    const tools = cached || (await client.listTools());
    if (!cached) cacheSet('tools', tools);
    _toolMap = new Map(tools.map((t) => [t.name, t]));
  }
  return _toolMap.get(name);
}

/** 按工具入参 schema 的类型，把字符串转成对的值 */
function coerceBySchema(value, prop) {
  const type = Array.isArray(prop?.type) ? prop.type.find((t) => t !== 'null') : prop?.type;
  if (type === 'integer' || type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === 'boolean') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  }
  if (type === 'array' || type === 'object') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return String(value);
}

/* ─────────────────────────── 偏好与门店 ─────────────────────────── */

function currentMode() {
  const key = String(flags.mode || getProfile().mode || 'pickup');
  const m = MODES[key];
  if (!m) throw new Error(`未知取餐方式「${key}」，可选：${Object.keys(MODES).join(' / ')}`);
  return { key, ...m };
}

/** 取当前要用的门店；没有就报清楚下一步做什么 */
let _warnedStoreMode = false;

function currentStore(mode) {
  const p = getProfile();
  let store = p.store;

  if (flags.store) {
    store = { ...(store || {}), storeCode: String(flags.store) };
    if (flags.becode) store.beCode = String(flags.becode);
    if (!store.storeName) store.storeName = `门店 ${flags.store}`;
  }
  if (!store?.storeCode) {
    throw new Error(
      '还没有默认门店。先跑一次：\n' +
        `  node scripts/mcd.mjs stores${p.city ? '' : ' --city 上海 --keyword 你的地址'}\n` +
        '  node scripts/mcd.mjs profile use-store 1     # 用列表里的第 1 家\n',
    );
  }
  // 到店自取不需要 beCode，其它场景必须带
  if (mode.beType !== 1 && !store.beCode) {
    throw new Error(
      `${mode.label}场景需要 beCode，但门店 ${store.storeCode} 没有。\n` +
        `重新用 --mode ${mode.key} 跑一次 stores，再 profile use-store。`,
    );
  }

  // 默认门店是按某种取餐方式选的；换成另一种多半不通用（麦乐送/得来速要配送门店）
  const stored = store.beType != null ? Number(store.beType) : null;
  if (stored != null && stored !== mode.beType) {
    const storedLabel = Object.values(MODES).find((m) => m.beType === stored)?.label || `beType=${stored}`;
    if (mode.orderType === 2) {
      throw new Error(
        `当前默认门店是按「${storedLabel}」选的，${mode.label}要用能配送的门店。\n` +
          `  node scripts/mcd.mjs stores --mode ${mode.key}\n` +
          '  node scripts/mcd.mjs profile use-store 1',
      );
    }
    if (!_warnedStoreMode && !flags.brief && !flags.json) {
      _warnedStoreMode = true;
      out(`  ⚠️ 默认门店是按「${storedLabel}」选的，现在是「${mode.label}」。可能不通用，失败就重新 stores + use-store。`);
    }
  }
  return store;
}


/* ─────────────────────────── 菜单索引 ─────────────────────────── */

function buildMenu(data) {
  const items = {};
  for (const [code, m] of Object.entries(data?.meals || {})) {
    items[code] = {
      code,
      name: m.name || code,
      price: m.currentPrice,
      originalPrice: m.originalPrice,
      productType: m.productType,
      canWithOrder: m.canWithOrder,
      category: '',
    };
  }
  const categories = [];
  for (const c of data?.categories || []) {
    const codes = (c.meals || []).map((x) => x.code).filter((x) => x);
    categories.push({ name: c.name, codes });
    for (const code of codes) if (items[code]) items[code].category = c.name;
  }
  return { items, categories, frequent: data?.frequent?.code || null };
}

async function fetchMenu(store, mode, { force = false, reservationDate } = {}) {
  const at = reservationDate || flags.at;
  const key = ['menu', store.storeCode, mode.orderType, mode.beType, store.beCode || '-', at || '-'].join(':');
  if (!force) {
    const cached = cacheGet(key, 10 * 60 * 1000);
    if (cached) return cached;
  }
  const args = { storeCode: store.storeCode, orderType: mode.orderType, beType: mode.beType };
  if (mode.beType !== 1 && store.beCode) args.beCode = store.beCode;
  if (at) args.reservationDate = at;
  const payload = await runTool('query-meals', args);
  const menu = buildMenu(payload.data);
  cacheSet(key, menu);
  return menu;
}

const norm = (s) =>
  String(s)
    .replace(/[\s（）()·、,，。.\-—_【】\[\]]/g, '')
    .toLowerCase();

/** 把「巨无霸」这种名字解析成菜单项；也接受商品编码 */
function resolveItem(query, menu) {
  const q = String(query).trim();
  if (!q) throw new Error('商品名不能为空');
  if (menu.items[q]) return menu.items[q];

  const nq = norm(q);
  const all = Object.values(menu.items);

  const exact = all.find((i) => norm(i.name) === nq);
  if (exact) return exact;

  let cands = all.filter((i) => norm(i.name).includes(nq));
  if (cands.length === 0) {
    cands = all.filter((i) => norm(i.name).length >= 2 && nq.includes(norm(i.name)));
  }
  if (cands.length === 1) return cands[0];
  if (cands.length > 1) {
    // 完全包含的优先，短名字优先
    cands.sort((a, b) => a.name.length - b.name.length);
    throw new Error(
      `「${q}」匹配到 ${cands.length} 个，说具体一点或直接用编码：\n` +
        cands
          .slice(0, 10)
          .map((c) => `  ${pad(c.code, 12)}${pad(c.name, 22)}¥${c.price ?? '?'}`)
          .join('\n'),
    );
  }
  throw new Error(`菜单里没有「${q}」。换个说法，或先 mcd menu --grep ${q} 看看有哪些。`);
}

/** 解析 --item：支持「巨无霸」「巨无霸:2」「巨无霸*2」 */
function itemSpecs() {
  return list(flags.item).map((raw) => {
    const s = String(raw).trim();
    let name = s;
    let qty = 1;
    const m1 = s.match(/^(.*?)\s*[*x×]\s*(\d+)$/i);
    const m2 = s.match(/^(.*?)\s*[:：]\s*(\d+)$/);
    if (m1) {
      name = m1[1];
      qty = Number(m1[2]);
    } else if (m2) {
      name = m2[1];
      qty = Number(m2[2]);
    }
    return { name: name.trim(), quantity: Math.max(1, qty || 1) };
  });
}

/* ─────────────────────────── 算价 ─────────────────────────── */

function priceArgsOf(store, mode, items, { reservationDate, takeWay, forOrder = false } = {}) {
  const args = { storeCode: store.storeCode, orderType: mode.orderType, beType: mode.beType, items };
  if (mode.beType !== 1 && store.beCode) args.beCode = store.beCode;
  const at = reservationDate || flags.at;
  if (at) args.reservationDate = at;
  if (takeWay) args.takeWayCode = takeWay;
  const taste = getProfile().taste || {};
  args.needTableware = Boolean(taste.tableware);

  // 外送下单必须带 addressId（calculate-price 不吃这个参数，只有 create-order 要）
  if (forOrder && mode.orderType === 2) {
    const addr = getProfile().address;
    if (!addr?.addressId) {
      throw new Error(
        '麦乐送下单要先选收货地址：\n' +
          '  node scripts/mcd.mjs address         # 看列表\n' +
          '  node scripts/mcd.mjs address use 3   # 选一个\n' +
          '  node scripts/mcd.mjs address new …   # 或者新建',
      );
    }
    args.addressId = String(addr.addressId);
    delete args.takeWayCode;
  }
  return args;
}

/** 外送单带上口味备注；备注最多 50 字，超了截断 */
function withRemark(args, mode) {
  if (mode.orderType !== 2) return args;
  const notes = String(getProfile().taste?.notes || '').trim();
  if (notes) args.remark = notes.slice(0, 50);
  return args;
}

function parsePrice(payload) {
  const d = payload.data || {};
  const list = (d.productList || []).map((p) => ({
    code: p.productCode,
    name: p.productName,
    quantity: p.quantity,
    subtotal: p.subtotal,
    original: p.originalSubtotal,
  }));
  return {
    items: list,
    productPrice: d.productPrice ?? 0,
    originalPrice: d.originalPrice ?? d.productOriginalPrice ?? 0,
    discount: d.discount ?? 0,
    deliveryPrice: d.deliveryPrice ?? 0,
    total: d.price ?? 0,
    takeWayList: d.takeWayList || [],
    raw: d,
  };
}

function printPrice(p) {
  out(`  ${pad('商品', 26)}${pad('数量', 6)}${pad('小计', 10)}`);
  for (const it of p.items) {
    out(`  ${pad(it.name, 26)}${pad('×' + it.quantity, 6)}${pad('¥' + yuan(it.subtotal), 10)}`);
  }
  out('');
  out(`  商品金额  ¥${yuan(p.originalPrice)}`);
  if (p.discount) out(`  优惠      −¥${yuan(p.discount)}`);
  if (p.deliveryPrice) out(`  配送费    ¥${yuan(p.deliveryPrice)}`);
  out('  ────────────────────────────');
  out(`  ▶ 实付    ¥${yuan(p.total)}`);
  out('  ────────────────────────────');
  if (p.takeWayList.length) {
    out('');
    out('  取餐方式：' + p.takeWayList.map((t) => `${t.code}(${t.title})`).join('  '));
  }
}

function wantAutoCoupon() {
  if (flags['auto-coupon'] === true) return true;
  if (flags['no-auto-coupon'] === true) return false;
  return Boolean(getProfile().autoCoupon);
}

/**
 * 一次算价把该做的都做了：解析商品 → 自动挑券 → 算价 → 比对菜单标价。
 * price 和 order 共用，保证两边的数一定一致。
 */
async function quote(store, mode, specs, { autoCoupon = false, menuForce = false } = {}) {
  const menu = await fetchMenu(store, mode, { force: menuForce });
  const picked = specs.map((s) => {
    const it = resolveItem(s.name, menu);
    return { ...it, quantity: s.quantity };
  });
  const clean = picked.map((it) => ({ productCode: it.code, quantity: it.quantity }));

  let used = clean;
  let base = null;
  let p = null;
  if (autoCoupon) {
    // 先算「不用券」的价，再让自动选券去试；试出更好的就直接用，避免重复请求
    base = parsePrice(await runTool('calculate-price', priceArgsOf(store, mode, clean)));
    const plan = await bestCouponPlan(store, mode, clean);
    used = plan.items;
    p = plan.best || base;
  } else {
    p = parsePrice(await runTool('calculate-price', priceArgsOf(store, mode, used)));
  }

  // 菜单上写的价 vs 实际算出来的价，对不上要当面说
  const diffs = [];
  for (const line of p.items) {
    const m = picked.find((x) => x.code === line.code);
    if (!m || m.price == null) continue;
    const menuUnit = Number(m.price);
    const calcUnit = Number(line.subtotal) / Math.max(1, Number(line.quantity)) / 100;
    if (Number.isFinite(menuUnit) && Math.abs(menuUnit - calcUnit) > 0.011) {
      diffs.push({ name: line.name, menu: menuUnit, calc: calcUnit });
    }
  }
  return { store, mode, menu, picked, clean, used, p, base, diffs };
}

function printMenuDiff(q) {
  if (!q.diffs.length) return;
  out('');
  out('  ⚠️ 菜单标价和实算不一致（到店/外送价不同、活动价、券都会造成差异）：');
  for (const d of q.diffs) out(`     ${d.name}：菜单 ¥${d.menu} → 实算 ¥${d.calc.toFixed(2)}`);
  out('     判断时以「实付」那一行为准。');
}

function printBudget(p) {
  const budget = getProfile().budget;
  if (budget && Number(p.total) / 100 > Number(budget)) out(`  ⚠️ 超过你设的单餐预算 ¥${budget}`);
}

/** 把套餐里"还能换成什么"摆到台面上 —— 这是之前漏掉的一步 */
async function printComboHints(store, mode, q, { all = false } = {}) {
  const lines = [];
  for (const it of q.picked.slice(0, 2)) {
    let d;
    try {
      d = await fetchDetail(store, mode, it.code);
    } catch {
      continue;
    }
    const reps = replaceables(d);
    if (!reps.length) continue;
    lines.push('');
    lines.push(`  【${it.name}】套餐里可以换的东西：`);
    for (const r of reps.slice(0, 5)) {
      const shown = all ? r.others : r.others.slice(0, 3);
      const opts = shown.map((c) => `${c.name}${c.diffPrice && c.diffPrice !== '+ ¥0' ? ` ${c.diffPrice}` : ''}`);
      lines.push(
        `     · ${String(r.round).replace(/\n/g, ' ')}：默认「${r.def?.name}」，也可换 ${opts.join(' / ')}` +
          (r.others.length > shown.length ? ` 等 ${r.others.length} 个` : ''),
      );
    }
    lines.push('     接口只能「看」不能提交替换：要换请在麦当劳 App 里改，或者我按单点重新组一套（总价重算给你）。');
  }
  if (lines.length) out(lines.join('\n'));
}

/** 自动挑最省的券：先把每张券在每件商品上试一遍，再尝试叠加 */async function bestCouponPlan(store, mode, baseItems, { reservationDate } = {}) {
  const cArgs = { storeCode: store.storeCode, orderType: mode.orderType, beType: mode.beType };
  if (mode.beType !== 1 && store.beCode) cArgs.beCode = store.beCode;
  if (reservationDate) cArgs.reservationDate = reservationDate;

  let coupons = [];
  try {
    const payload = await runTool('query-store-coupons', cArgs);
    coupons = Array.isArray(payload.data) ? payload.data : payload.data?.coupons || [];
  } catch {
    return { items: baseItems, best: null, tried: 0 };
  }
  if (coupons.length === 0) return { items: baseItems, best: null, tried: 0, coupons };

  const pool = coupons.slice(0, 5);
  let best = null;
  let bestItems = baseItems;
  let tried = 0;

  for (const coupon of pool) {
    const id = coupon.couponId ?? coupon.id ?? coupon.couponCode;
    if (!id) continue;
    for (let idx = 0; idx < baseItems.length; idx++) {
      const trial = baseItems.map((it, i) =>
        i === idx ? { ...it, couponId: String(id), ...(coupon.couponCode ? { couponCode: String(coupon.couponCode) } : {}) } : it,
      );
      tried++;
      try {
        const payload = await runTool('calculate-price', priceArgsOf(store, mode, trial, { reservationDate }));
        const p = parsePrice(payload);
        if (!best || p.total < best.total) {
          best = p;
          bestItems = trial;
        }
      } catch {
        /* 这张券不适用于这件商品，跳过 */
      }
    }
  }
  if (!best) return { items: baseItems, best: null, tried, coupons };
  return { items: bestItems, best, tried, coupons };
}

/* ─────────────────────────── 渲染 ─────────────────────────── */

function renderStores(stores) {
  const rows = stores.map((s, i) => [String(i + 1), s.storeCode, s.storeName || '', s.address || '', s.distance != null ? `${s.distance}m` : '', s.businessStatus === false ? '暂停营业' : `${s.businessStartTime || ''}-${s.businessEndTime || ''}`]);
  const w = [3, 10, 30, 30, 7, 12].map((n, i) => Math.max(n, ...rows.map((r) => width(r[i]))));
  out(rows.map((r) => '  ' + r.map((c, i) => pad(c, w[i])).join('  ')).join('\n'));
}

function renderMenu(menu, grep, opts = {}) {
  const { all = false, cat: catFilter = '', limit = 8 } = opts;
  const lines = [];
  let shown = 0;
  let matchedCats = 0;

  for (const cat of menu.categories) {
    const catName = cat.name.replace(/\n/g, ' ');
    if (catFilter && !norm(catName).includes(norm(catFilter))) continue;
    const codes = cat.codes.filter((c) => {
      if (!grep) return true;
      const it = menu.items[c];
      return it && (norm(it.name).includes(norm(grep)) || norm(catName).includes(norm(grep)));
    });
    if (codes.length === 0) continue;
    matchedCats++;

    // 默认只给摘要：分类 + 条数 + 前几样，避免一次糊 99 行出去
    // --grep / --cat / --all 时要全给，否则"搜出来只有 8 条"很容易误以为没有
    const showAll = all || Boolean(grep) || Boolean(catFilter);
    const cap = showAll ? codes.length : Math.min(3, codes.length);
    const rows = showAll ? cap : Math.min(cap, limit);

    lines.push('');
    lines.push(`  ── ${catName}（${codes.length} 项）──`);
    for (let i = 0; i < rows; i++) {
      const it = menu.items[codes[i]];
      if (!it) continue;
      shown++;
      const price = it.price != null ? `¥${it.price}` : '';
      const orig = it.originalPrice && it.originalPrice !== it.price ? ` (原价 ¥${it.originalPrice})` : '';
      const addon = it.canWithOrder === true ? '  [可随单购]' : '';
      lines.push(`    ${pad(codes[i], 12)}${pad(it.name, 30)}${pad(price, 10)}${orig}${addon}`);
    }
    if (codes.length > rows) {
      lines.push(`    … 还有 ${codes.length - rows} 项，只看这类：--cat "${catName}"`);
    }
  }

  if (matchedCats === 0) {
    return `  没找到「${grep || catFilter || ''}」。试试更短的关键词，或者 --all 看全部。`;
  }

  lines.push('');
  if (!all && !grep && !catFilter) {
    lines.push(`  默认只给摘要（${shown} 项示例）。要看全：--all；看某类：--cat "套餐"；搜商品：--grep 巨无霸`);
  } else {
    lines.push(`  共 ${shown} 项。下单用编码或名字都行：--item "巨无霸:1"`);
  }
  return lines.join('\n');
}


/* ─────────────────────────── 套餐详情 ─────────────────────────── */

async function fetchDetail(store, mode, code, { force = false } = {}) {
  const at = flags.at;
  const key = ['detail', store.storeCode, mode.orderType, mode.beType, store.beCode || '-', at || '-', code].join(':');
  if (!force) {
    const cached = cacheGet(key, 10 * 60 * 1000);
    if (cached) return cached;
  }
  const args = { storeCode: store.storeCode, orderType: mode.orderType, beType: mode.beType, code };
  if (mode.beType !== 1 && store.beCode) args.beCode = store.beCode;
  if (at) args.reservationDate = at;
  const payload = await runTool('query-meal-detail', args);
  const d = payload.data || {};
  cacheSet(key, d);
  return d;
}

/** 套餐结构里挑出「可替换」的项：round 下非默认、且可选的 choices */
function replaceables(detail) {
  const rounds = detail?.rounds || [];
  return rounds
    .map((r) => {
      const choices = r.choices || [];
      const def = choices.find((c) => c.isDefault === 1) || choices[0];
      return {
        round: r.name,
        quantity: r.quantity,
        def,
        choices,
        others: choices.filter((c) => c !== def),
      };
    })
    .filter((x) => x.others.length > 0);
}

const diffToYuan = (s) => {
  const m = String(s || '').match(/([+-])\s*¥?\s*([\d.]+)/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * Number(m[2]);
};

function renderDetail(item, detail, { all = false, mod = false } = {}) {
  const lines = [];
  const rounds = detail?.rounds || [];
  const price = item?.price != null ? `¥${item.price}` : '';
  lines.push(`${item?.code || detail?.code || ''}  ${detail?.name || item?.name || ''}  ${price}`);
  if (item?.originalPrice && item.originalPrice !== item.price) {
    lines.push(`  原价 ¥${item.originalPrice}`);
  }

  if (!rounds.length) {
    lines.push('  （这个不是套餐，没有可替换组成）');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`  组成 ${rounds.length} 项：`);
  for (const r of rounds) {
    const choices = r.choices || [];
    const def = choices.find((c) => c.isDefault === 1) || choices[0];
    const others = choices.filter((c) => c !== def);
    lines.push('');
    lines.push(`  ${r.id}) ${String(r.name).replace(/\n/g, ' ')} ×${r.quantity}`);
    lines.push(`      ★ ${def?.name || '?'}${def?.diffPrice && def.diffPrice !== '+ ¥0' ? `（${def.diffPrice}）` : ''}`);
    if (others.length) {
      lines.push(`      可换成（${others.length} 个）：`);
      const cap = all ? others.length : Math.min(5, others.length);
      for (let i = 0; i < cap; i++) {
        const c = others[i];
        lines.push(`        · ${pad(c.name, 26)}${c.diffPrice || ''}`);
      }
      if (others.length > cap) lines.push(`        … 还有 ${others.length - cap} 个，加 --all 全看`);
    } else {
      lines.push('      这一项不能换');
    }
    if (mod && def?.supportModify) {
      const groups = def.modification?.items || [];
      for (const g of groups) {
        const vals = (g.values || []).map((v) => `${v.name}${v.selectedQuantity > 0 ? '(默认加)' : ''}`);
        if (vals.length) lines.push(`      可特调：${vals.join(' / ')}`);
      }
    }
  }

  lines.push('');
  lines.push('  说明：');
  lines.push('    · 换套餐里的东西：MCP 接口只能「看」，不能提交替换。要换请在麦当劳 App 里改，');
  lines.push('      或者告诉我，我用单点重新给你组一套（总价会重新算一遍给你）。');
  if (rounds.some((r) => (r.choices || []).some((c) => c.supportModify))) {
    lines.push('    · 「可特调」的项（去冰、加酱等）能在下单时指定，加 --mod 看具体选项。');
  }
  return lines.join('\n');
}

/** 一句话价格给聊天用：直接把这段发出去就行 */
function briefPrice(item, p, mode, store) {
  const lines = [];
  const names = p.items.map((x) => `${x.name}×${x.quantity}`).join(' + ');
  lines.push(names);
  lines.push(`合计 ¥${yuan(p.total)}（商品 ¥${yuan(p.originalPrice)}${p.discount ? `，优惠 −¥${yuan(p.discount)}` : ''}${p.deliveryPrice ? `，配送费 ¥${yuan(p.deliveryPrice)}` : ''}）`);
  if (mode.orderType === 1 && p.takeWayList.length) {
    const t = p.takeWayList.find((x) => x.code === 'take-in-store') || p.takeWayList[0];
    lines.push(`取餐：${store.storeName || store.storeCode} · ${t?.title || ''}`);
  }
  return lines.join('\n');
}

/* ─────────────────────────── 可领券 ─────────────────────────── */

/**
 * available-coupons 有时返回 JSON 数组，有时直接返回 Markdown 文案，
 * 两种都得认，不能只写一种。
 */
function parseCouponList(data) {
  if (Array.isArray(data)) {
    return data
      .map((c) => ({
        name: c.couponName || c.name || '',
        status: c.couponStatus || c.status || '',
        label: c.label || '',
        raw: c,
      }))
      .filter((x) => x.name);
  }
  if (data && typeof data === 'object' && Array.isArray(data.coupons)) {
    return parseCouponList(data.coupons);
  }
  if (typeof data !== 'string') return [];

  // Markdown 形态：
  //   - 优惠券标题：免费脆薯饼 \
  //     状态：可领取 \
  const list = [];
  let cur = null;
  for (const line of data.split(/\r?\n/)) {
    const t = line.match(/优惠券标题[:：]\s*(.+?)(?:\s*\\\s*)?$/);
    if (t) {
      if (cur) list.push(cur);
      cur = { name: t[1].trim(), status: '', label: '', raw: null };
      continue;
    }
    const s = line.match(/状态[:：]\s*(.+?)(?:\s*\\\s*)?$/);
    if (s && cur) cur.status = s[1].trim();
  }
  if (cur) list.push(cur);
  return list.filter((x) => x.name);
}

const isClaimable = (c) => /可领取|CAN_GET|未领取/.test(String(c.status || c.label || ''));

/** 取了就缓存 5 分钟，别每次算价都去打一次接口 */
async function fetchClaimable({ force = false } = {}) {
  if (!force) {
    const cached = cacheGet('claimable', 5 * 60 * 1000);
    if (cached) return cached;
  }
  const payload = await runTool('available-coupons', {});
  const list = parseCouponList(payload.data);
  cacheSet('claimable', list);
  return list;
}

/** 算价/下单时顺手提醒一句「还有券能领」 */
async function claimHint() {
  if (flags['no-claim-hint'] === true) return;
  if (!wantAutoCoupon()) return;
  let list;
  try {
    list = await fetchClaimable();
  } catch {
    return;
  }
  const can = list.filter(isClaimable);
  if (!can.length) return;
  const names = can.slice(0, 3).map((c) => c.name).join(' / ');
  out('');
  out(`  💡 还有 ${can.length} 张券可以领：${names}${can.length > 3 ? ' 等' : ''}`);
  out('     领了再算一次可能更省：node scripts/mcd.mjs claim --confirm');
}

/* ─────────────────────────── 收货地址 ─────────────────────────── */

/** 取收货地址列表：优先缓存，可强制刷新 */
async function loadAddresses({ force = false } = {}) {
  if (!force) {
    const cached = cacheGet('last-addresses', 30 * 60 * 1000);
    if (cached?.length) return cached;
  }
  const payload = await runTool('delivery-query-addresses', {});
  const raw = payload.data?.addresses || payload.data;
  const list = Array.isArray(raw) ? raw : [];
  if (list.length) cacheSet('last-addresses', list);
  return list;
}

function pickAddress(list, arg) {
  const s = String(arg ?? '');
  if (/^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= list.length) return list[Number(s) - 1];
  return list.find((a) => String(a.addressId) === s);
}

/** 把某个地址写成默认；只存本机，不写进任何仓库 */
function applyAddress(pick) {
  setProfilePath('address', {
    addressId: String(pick.addressId),
    contactName: pick.contactName || '',
    phone: pick.phone || '',
    address: pick.fullAddress || pick.address || '',
    city: pick.city || '',
  });
  out(`默认收货地址已设为：${pick.contactName || ''} ${pick.fullAddress || pick.address || ''}`);
  return out(`  ${pick.addressId}`);
}

/* ─────────────────────────── 命令 ─────────────────────────── */

const HELP = `
mcd — 麦当劳中国 MCP 命令行客户端

  日常
    node scripts/mcd.mjs home              一屏概览：积分 / 券 / 默认门店 / 上一单
    node scripts/mcd.mjs status            连接自检
    node scripts/mcd.mjs now               服务器当前时间

  点餐
    node scripts/mcd.mjs stores [--city 上海 --keyword 人民广场] [--mode pickup|dt|delivery]
    node scripts/mcd.mjs profile use-store 1        把列表第 1 家设为默认门店
    node scripts/mcd.mjs menu [--grep 巨无霸] [--cat 套餐] [--all]
    node scripts/mcd.mjs detail "巨无霸四件套"       套餐组成 / 可替换项 / 差价
    node scripts/mcd.mjs price --item "巨无霸:1" [--auto-coupon] [--detail] [--brief]
    node scripts/mcd.mjs order --item "巨无霸:1" --confirm
    node scripts/mcd.mjs history [-n 5]
    node scripts/mcd.mjs reorder [--confirm]        上一单再来一份
    node scripts/mcd.mjs watch <订单号>              盯状态，变化时可跑外部命令

  偏好（会记住，下次不用再说）
    node scripts/mcd.mjs profile                    看当前偏好
    node scripts/mcd.mjs profile set city 上海
    node scripts/mcd.mjs profile set mode delivery   默认取餐方式
    node scripts/mcd.mjs profile unset budget
    node scripts/mcd.mjs profile clear
    node scripts/mcd.mjs remark "不要生菜，可乐去冰"   口味/配送备注
    node scripts/mcd.mjs address                    收货地址列表
    node scripts/mcd.mjs address use 2              选默认地址
    node scripts/mcd.mjs address new --name 张三 --phone 13800138000 \\
         --city 上海 --addr 中山北路3663号 --detail 12号楼301室 --confirm

  券与积分
    node scripts/mcd.mjs coupons                    我卡包里的券
    node scripts/mcd.mjs claimable                  麦麦省里可领的券      ← 自动提醒
    node scripts/mcd.mjs claim --confirm            一键全领
    node scripts/mcd.mjs store-coupons              当前门店可用券
    node scripts/mcd.mjs points                     积分（含本月将过期）

  裸调用（任何工具）
    node scripts/mcd.mjs call <工具名> k=v k=v ...
    node scripts/mcd.mjs call <工具名> --file args.json
    node scripts/mcd.mjs tools | schema <工具名> | doc

  通用选项
    --json        机器可读输出
    --mode        临时指定取餐方式（不写入偏好）
    --store       临时指定门店编码
    --at "2026-11-02 18:00"   预约单的送达/取餐时间
    --no-cache    跳过本地缓存
    --confirm     写入类工具（下单/取消/领券/抽奖）必须带
`.trim();

async function main() {
  switch (command) {
    case 'help':
    case '-h':
    case '--help':
      return out(HELP);

    case 'where':
      return out(configPath());

    /* ── 登录 ── */
    case 'login': {
      const token = rest[0] || flags.token || process.env.MCD_MCP_TOKEN;
      if (!token || token === true) {
        return die('用法：node scripts/mcd.mjs login <token>\nToken 从 https://open.mcd.cn/mcp 控制台复制。');
      }
      const cfg = loadConfig();
      cfg.token = String(token).trim();
      if (flags.url) cfg.url = flags.url;
      const p = saveConfig(cfg);
      out(`已保存 Token（${maskToken(cfg.token)}）到 ${p}`);
      _client = null;
      try {
        const tools = await makeClient().listTools();
        cacheSet('tools', tools);
        out(`连接正常：${tools.length} 个工具可用，协议版本 ${makeClient().negotiatedVersion}。`);
      } catch (e) {
        die(`已写入配置，但连接校验失败：${e.message}\n（Token 是否复制完整？可先用 status 复查）`);
      }
      return;
    }

    case 'logout': {
      const cfg = loadConfig();
      delete cfg.token;
      saveConfig(cfg);
      return out(`已删除本地 Token（${configPath()}）。`);
    }

    case 'status': {
      const cfg = loadConfig();
      const token = process.env.MCD_MCP_TOKEN || cfg.token;
      out(`配置路径 : ${configPath()}`);
      out(`服务地址 : ${flags.url || process.env.MCD_MCP_URL || cfg.url || DEFAULT_BASE_URL}`);
      out(`Token    : ${maskToken(token)}${process.env.MCD_MCP_TOKEN ? '（来自环境变量）' : ''}`);
      if (!token) return die('未配置 Token。先运行 login，或设置 MCD_MCP_TOKEN。');
      const t0 = Date.now();
      const client = makeClient();
      const tools = await client.listTools();
      cacheSet('tools', tools);
      out(`连接     : 正常（${Date.now() - t0} ms）`);
      out(`协议版本 : ${client.negotiatedVersion}`);
      out(`工具数量 : ${tools.length}`);
      return;
    }

    /* ── 概览 ── */
    case 'home':
    case 'me': {
      const p = getProfile();
      out(`默认门店 : ${p.store ? `${p.store.storeName || p.store.storeCode}（${p.store.storeCode}）` : '（未设置）'}`);
      out(`取餐方式 : ${MODES[p.mode]?.label || p.mode}`);
      if (p.taste?.notes) out(`口味备注 : ${p.taste.notes}`);

      const tasks = [
        runTool('query-my-account', {}).catch(() => null),
        runTool('available-coupons', {}).catch(() => null),
        runTool('query-my-coupons', {}).catch(() => null),
        runTool('order-list', {}).catch(() => null),
      ];
      const [acc, avail, mine, hist] = await Promise.all(tasks);

      if (acc?.data) {
        const d = acc.data;
        out('');
        out(`积分      : ${d.availablePoint} 可用（累计 ${d.accumulativePoint}，已过期 ${d.expiredPoint}）`);
        if (Number(d.currentMouthExpirePoint) > 0) {
          out(`将要过期  : ${d.currentMouthExpirePoint} 分（本月）→ 可以换点东西，别浪费`);
        }
      }
      if (avail?.data) {
        const list = parseCouponList(avail.data);
        const can = list.filter(isClaimable);
        if (can.length) {
          cacheSet('claimable', list);
          out('');
          out(`可领的券  : ${can.length} 张（麦麦省）`);
          for (const c of can.slice(0, 5)) out(`            · ${c.name}`);
          out('            领：node scripts/mcd.mjs claim --confirm');
        }
      }
      if (mine?.data) {
        const arr = mine.data.coupons || (Array.isArray(mine.data) ? mine.data : []);
        if (arr.length) out(`卡包里的券: ${arr.length} 张`);
      }
      if (hist?.data?.list?.length) {
        const o = hist.data.list[0];
        const names = (o.orderProductList || []).map((x) => `${x.productName}×${x.quantity}`).join('、');
        out('');
        out(`上一单    : ${o.createTime}  ${o.storeName || ''}`);
        out(`            ${names}  ¥${o.realTotalAmount || '?'}`);
        out(`            node scripts/mcd.mjs reorder   # 原样再来一份`);
      }
      return;
    }

    case 'now': {
      const p = await runTool('now-time-info', {});
      const d = p.data || {};
      return out(`${d.formatted}  ${d.dayOfWeek}  ${d.timezone}`);
    }

    /* ── 偏好 ── */
    case 'profile':
    case 'pref': {
      const sub = rest[0];
      if (!sub || sub === 'show') {
        const p = getProfile();
        if (flags.json) return out(JSON.stringify(p, null, 2));
        out(`城市      : ${p.city || '（未设置）'}`);
        out(`位置关键词: ${p.keyword || '（未设置）'}`);
        out(`取餐方式  : ${MODES[p.mode]?.label || p.mode}（${p.mode}）`);
        out(`默认门店  : ${p.store ? `${p.store.storeName || ''} ${p.store.storeCode}${p.store.beCode ? ` / beCode ${p.store.beCode}` : ''}` : '（未设置）'}`);
        out(`收货地址  : ${p.address ? `#${p.address.addressId} ${p.address.label || ''} ${p.address.address || ''}` : '（未设置）'}`);
        out(`联系人    : ${p.contact?.name || '（未设置）'} ${p.contact?.phone ? p.contact.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : ''}`);
        out(`口味备注  : ${p.taste?.notes || '（未设置）'}`);
        out(`要餐具    : ${p.taste?.tableware ? '要' : '不要'}`);
        out(`单餐预算  : ${p.budget ? `¥${p.budget}` : '（未设置）'}`);
        out(`自动用券  : ${p.autoCoupon ? '开' : '关'}`);
        out('');
        out('改：node scripts/mcd.mjs profile set <键> <值>');
        return;
      }

      if (sub === 'set') {
        const [key, ...vs] = rest.slice(1);
        if (!key || vs.length === 0) return die('用法：profile set <键> <值>，例如 profile set city 上海');
        const p = setProfilePath(key, vs.join(' '));
        return out(`已设置 ${key}，现在：${JSON.stringify(key.split('.').reduce((a, k) => a?.[k], p))}`);
      }
      if (sub === 'unset') {
        const key = rest[1];
        if (!key) return die('用法：profile unset <键>');
        unsetProfilePath(key);
        return out(`已清除 ${key}`);
      }
      if (sub === 'clear') {
        const cfg = loadConfig();
        delete cfg.profile;
        saveConfig(cfg);
        return out('已清空全部点餐偏好（Token 保留）。');
      }
      if (sub === 'use-store') {
        const arg = rest[1];
        if (!arg) return die('用法：profile use-store <序号|storeCode|名字片段>');
        const last = cacheGet('last-stores', 60 * 60 * 1000);
        if (!last?.length) return die('还没有门店列表。先跑一次 stores。');
        let pick = null;
        if (/^\d+$/.test(arg) && Number(arg) <= last.length) pick = last[Number(arg) - 1];
        else pick = last.find((s) => s.storeCode === arg) || last.find((s) => norm(s.storeName || '').includes(norm(arg)));
        if (!pick) return die(`门店列表里没有「${arg}」。`);
        setProfilePath('store', {
          storeCode: pick.storeCode,
          beCode: pick.beCode || '',
          storeName: pick.storeName || '',
          address: pick.address || '',
          beType: pick.__beType ?? currentMode().beType,
        });
        return out(`默认门店已设为：${pick.storeName}（${pick.storeCode}）`);
      }
      if (sub === 'use-address') {
        const arg = rest[1];
        if (!arg) return die('用法：profile use-address <序号|addressId>');
        const list = await loadAddresses();
        if (!list.length) return die('账号里还没有收货地址。用 address new 建一个。');
        const pick = pickAddress(list, arg);
        if (!pick) return die(`地址列表里没有「${arg}」。先用 address 看一眼。`);
        return applyAddress(pick);
      }
      return die(`未知子命令：profile ${sub}\n可用：show / set / unset / clear / use-store / use-address`);
    }

    /* ── 收货地址 ── */
    case 'address':
    case 'addresses': {
      const sub = rest[0];

      if (sub === 'new' || sub === 'add') {
        const p = getProfile();
        const name = flags.name || p.contact?.name;
        const phone = flags.phone || p.contact?.phone;
        const city = flags.city || p.city;
        const addr = flags.addr || flags.address;
        const detail = flags.detail || flags.addressDetail;
        const missing = [
          ['--name', name],
          ['--phone', phone],
          ['--city', city],
          ['--addr', addr],
          ['--detail', detail],
        ].filter(([, v]) => !v);
        if (missing.length) {
          return die(
            '还缺：' + missing.map(([k]) => k).join(' ') + '\n' +
              '  例：node scripts/mcd.mjs address new --name 张三 --phone 13800138000 \\\n' +
              '        --city 上海 --addr 中山北路3663号 --detail 12号楼301室 --confirm',
          );
        }
        if (!/^1\d{10}$/.test(String(phone))) return die('手机号要 11 位纯数字。');
        const args = {
          city: String(city),
          contactName: String(name),
          phone: String(phone),
          address: String(addr),
          addressDetail: String(detail),
        };
        if (flags.gender) args.gender = String(flags.gender);
        guardWrite('delivery-create-address', args);
        await runTool('delivery-create-address', args);
        out('地址已提交。重新拉一次列表并设为默认……');
        const list2 = await loadAddresses({ force: true });
        const hit = list2.find((a) => String(a.fullAddress || a.address || '').includes(String(addr)));
        if (hit) {
          applyAddress(hit);
          return out(`默认收货地址：${hit.fullAddress || hit.address}`);
        }
        return out('地址已创建，但没在列表里找到，请跑 address 选一次。');
      }

      if (sub === 'use') {
        const arg = rest[1];
        if (!arg) return die('用法：address use <序号|addressId>');
        const list = await loadAddresses();
        const pick = pickAddress(list, arg);
        if (!pick) return die(`地址列表里没有「${arg}」。`);
        return applyAddress(pick);
      }

      const list = await loadAddresses({ force: rest[0] === 'refresh' || Boolean(flags['no-cache']) });
      if (flags.json) return out(JSON.stringify(list, null, 2));
      if (!list.length) {
        return out('账号里还没有收货地址。建一个：\n  node scripts/mcd.mjs address new --name … --phone … --city … --addr … --detail … --confirm');
      }
      const cur = getProfile().address;
      list.forEach((a, i) => {
        const isDefault = cur && String(cur.addressId) === String(a.addressId) ? ' ★' : '  ';
        out(`${String(i + 1).padStart(2)}${isDefault} ${a.contactName || ''}  ${a.phone || ''}`);
        out(`     ${a.fullAddress || a.address || ''}`);
        out(`     ${a.addressId}`);
      });
      out(`\n共 ${list.length} 个。★ = 当前默认。切换：node scripts/mcd.mjs address use 2`);
      return;
    }

    /* ── 口味备注 ── */
    case 'remark':
    case 'note': {
      if (rest.length === 0 || rest[0] === 'show') {
        const t = getProfile().taste || {};
        if (!t.notes) return out('还没有口味备注。设置：node scripts/mcd.mjs remark "不要生菜，可乐去冰"');
        return out(`口味备注：${t.notes}\n（外送单会自动作为订单备注传给门店，最多 50 字）`);
      }
      if (rest[0] === 'clear' || rest[0] === 'unset') {
        setProfilePath('taste.notes', '');
        return out('已清除口味备注。');
      }
      const text = rest.join(' ');
      if (text.length > 50) out(`注意：长度 ${text.length} 字，超过 50 字的部分下单时会被截断。`);
      setProfilePath('taste.notes', text);
      return out(`口味备注已设为：${text}`);
    }

    case 'cancel': {
      const orderId = rest[0] || flags.order;
      if (!orderId) return die('用法：node scripts/mcd.mjs cancel <orderId> [--reason 1] [--confirm]');
      const args = { orderId: String(orderId), cancelReasonCode: String(flags.reason || '1') };
      out('取消原因：1 改主意了 / 2 重复下单 / 3 点错了 / 4 地址或电话填错 / 5 送达时间选错 / -1 其它');
      guardWrite('cancel-order', args);
      const p = await runTool('cancel-order', args);
      return out(`已提交取消：${JSON.stringify(p.data)}`);
    }

    /* ── 订单跟踪（可拿来推送） ── */
    case 'watch':
    case 'track-order': {
      const orderId = String(rest[0] || flags.order || '');
      if (!orderId) return die('用法：node scripts/mcd.mjs watch <orderId> [--interval 60] [--times 90] [--on-change "命令"]');
      const interval = Math.max(15, Number(flags.interval || 60));
      const maxTimes = Math.max(1, Number(flags.times || (flags.once ? 1 : 120)));
      const hook = typeof flags['on-change'] === 'string' ? flags['on-change'] : null;
      const hookInit = typeof flags['on-start'] === 'string' ? flags['on-start'] : null;
      const appendTo = typeof flags.append === 'string' ? resolve(flags.append) : null;
      const TERMINAL = /完成|取消|评价|退款/;

      let last = null;
      let fired = 0;
      const stateKey = `watch:${orderId}`;
      // 被计划任务反复调用时（--once），靠这个记住上次状态，只在"变化"时通知
      const remembered = cacheGet(stateKey, 24 * 60 * 60 * 1000);
      if (flags.once && remembered && flags['no-remember'] !== true) last = remembered;

      for (let i = 0; i < maxTimes; i++) {
        let d;
        try {
          const payload = await runTool('query-order', { orderId });
          d = payload.data || {};
        } catch (e) {
          if (i === 0) throw e;
          out(`[${stamp()}] 查询失败：${e.message}`);
          d = null;
        }
        if (d) {
          const status = d.orderStatus || String(d.status || '');
          if (status !== last) {
            const isFirst = last === null;
            last = status;
            cacheSet(stateKey, status);
            const line = `[${stamp()}] ${status}`;
            if (!flags.quiet) {
              out(line + (d.pickupCode ? `  取餐码 ${d.pickupCode}` : '') + (d.realTotalAmount ? `  ¥${d.realTotalAmount}` : ''));
            }
            if (appendTo) {
              try {
                mkdirSync(dirname(appendTo), { recursive: true });
                appendFileSync(appendTo, line + '\n', 'utf8');
              } catch {
                /* 日志失败不影响主流程 */
              }
            }
            const cmd = isFirst ? hookInit : hook;
            if (cmd) runHook(cmd, { status, orderId, order: d, first: isFirst });
            if (!isFirst) fired++;
          }
          if (flags.once || TERMINAL.test(status) || d.orderStatus === '已完成') {
            if (!flags.quiet) out(flags.once ? '' : `\n  结束：${status}`);
            return;
          }
        }
        if (i < maxTimes - 1) await sleep(interval * 1000);
      }
      if (!flags.quiet) out(`\n  达到最多 ${maxTimes} 次检查，先停了。继续盯：node scripts/mcd.mjs watch ${orderId}`);
      return;
    }

    /* ── 订单状态 ── */
    case 'order-status':
    case 'track': {
      const orderId = rest[0] || flags.order;
      if (!orderId) return die('用法：node scripts/mcd.mjs order-status <orderId>');
      const p = await runTool('query-order', { orderId: String(orderId) });
      const d = p.data || {};
      if (flags.json) return out(JSON.stringify(d, null, 2));
      out(`订单 ${d.orderId || orderId}`);
      if (d.orderStatus) out(`状态：${d.orderStatus}`);
      if (d.takeCode) out(`取餐码：${d.takeCode}`);
      if (d.realTotalAmount) out(`金额：¥${d.realTotalAmount}`);
      if (!d.orderStatus && !d.takeCode) out(JSON.stringify(d, null, 2));
      return;
    }

    /* ── 门店 ── */
    case 'stores': {
      const mode = currentMode();
      const p = getProfile();
      const city = flags.city || p.city;
      const keyword = flags.keyword || p.keyword;

      if (mode.orderType === 2) {
        if (flags.store) {
          return out(`已指定门店 ${flags.store}，不用再查。`);
        }
        const addr = p.address;
        if (!addr?.addressId) {
          return die(
            '麦乐送要先有收货地址：\n' +
              '  node scripts/mcd.mjs call delivery-query-addresses\n' +
              '  node scripts/mcd.mjs profile use-address <addressId>',
          );
        }
        const payload = await runTool('delivery-query-stores', { addressId: addr.addressId, beType: mode.beType });
        const stores = Array.isArray(payload.data) ? payload.data : payload.data?.stores || [];
        if (!stores.length) return out('这个地址附近没有可配送门店。');
        stores.forEach((s) => (s.__beType = mode.beType));
        cacheSet('last-stores', stores);
        renderStores(stores);
        out(`\n  共 ${stores.length} 家。选一家：node scripts/mcd.mjs profile use-store 1`);
        return;
      }

      if (!city || !keyword) {
        return die(
          '还差找门店的条件。给一次就行，之后会记住：\n' +
            '  node scripts/mcd.mjs stores --city 上海 --keyword 人民广场',
        );
      }
      const payload = await runTool('query-nearby-stores', { searchType: 2, beType: mode.beType, city, keyword });
      const stores = Array.isArray(payload.data) ? payload.data : [];
      if (!stores.length) return out(`「${city} ${keyword}」附近没有找到门店。`);
      stores.forEach((s) => (s.__beType = mode.beType));
      cacheSet('last-stores', stores);
      renderStores(stores);
      out(`\n  共 ${stores.length} 家。选一家：node scripts/mcd.mjs profile use-store 1`);
      if (!p.city || !p.keyword) {
        out(`  （想下次不用再说：profile set city ${city} && profile set keyword ${keyword}）`);
      }
      return;
    }

    /* ── 菜单 ── */
    case 'menu': {
      const mode = currentMode();
      const store = currentStore(mode);
      const menu = await fetchMenu(store, mode, { force: Boolean(flags['no-cache']) });
      const grep = typeof flags.grep === 'string' ? flags.grep : '';
      const cat = typeof flags.cat === 'string' ? flags.cat : '';
      if (flags.json) return out(JSON.stringify(menu, null, 2));
      out(`门店 ${store.storeName || store.storeCode} · ${mode.label}`);
      out(
        renderMenu(menu, grep, {
          all: Boolean(flags.all),
          cat,
          limit: Number(flags.limit || 8),
        }),
      );
      return;
    }

    /* ── 套餐详情（可替换项 / 特制项） ── */
    case 'detail':
    case 'meal': {
      const mode = currentMode();
      const store = currentStore(mode);
      const q = rest[0] || flags.item;
      if (!q) return die('用法：node scripts/mcd.mjs detail "巨无霸四件套"');
      const menu = await fetchMenu(store, mode);
      const it = resolveItem(String(q), menu);
      const d = await fetchDetail(store, mode, it.code);
      if (flags.json) return out(JSON.stringify({ menu: it, detail: d }, null, 2));
      out(`门店 ${store.storeName || store.storeCode} · ${mode.label}`);
      out('');
      out(renderDetail(it, d));
      return;
    }

    /* ── 算价 ── */
    case 'price':
    case 'calc': {
      const mode = currentMode();
      const store = currentStore(mode);
      const specs = itemSpecs();
      if (!specs.length) return die('要算什么？例如：--item "巨无霸:1" --item "可乐:1"');

      const q = await quote(store, mode, specs, {
        autoCoupon: wantAutoCoupon(),
        menuForce: Boolean(flags['no-cache']),
      });
      if (flags.json) {
        return out(JSON.stringify({ price: q.p, items: q.used, menuDiff: q.diffs }, null, 2));
      }
      if (flags.brief) return out(briefPrice(q.picked, q.p, mode, store));

      out(`门店 ${store.storeName || store.storeCode} · ${mode.label}`);
      out('');
      printPrice(q.p);

      if (q.base && q.p.total < q.base.total) {
        out('');
        out(`  ✨ 已自动用券，比不用省 ¥${yuan(q.base.total - q.p.total)}`);
      }
      printMenuDiff(q);
      if (flags.detail) await printComboHints(store, mode, q, { all: Boolean(flags.all) });
      await claimHint();
      printBudget(q.p);
      return;
    }

    /* ── 下单 ── */
    case 'order': {
      const mode = currentMode();
      const store = currentStore(mode);
      const specs = itemSpecs();
      if (!specs.length) return die('要下单什么？例如：order --item "巨无霸:1" --confirm');

      const q = await quote(store, mode, specs, {
        autoCoupon: wantAutoCoupon(),
        menuForce: Boolean(flags['no-cache']),
      });
      const p = q.p;
      const items = q.used;

      const takeWay =
        flags.takeway ||
        (mode.beType === 1
          ? (p.takeWayList.find((t) => t.code === 'take-in-store') || p.takeWayList[0])?.code
          : undefined);

      out(`门店 ${store.storeName || store.storeCode} · ${mode.label}`);
      out('');
      printPrice(p);
      printMenuDiff(q);
      // 下单前一定会把套餐的可换项摆出来，避免"买完了才知道还能换"
      if (flags['no-detail'] !== true) await printComboHints(store, mode, q, { all: Boolean(flags.all) });
      await claimHint();
      printBudget(p);

      const orderArgs = priceArgsOf(store, mode, items, { takeWay, forOrder: true });
      delete orderArgs.items;
      orderArgs.items = items;
      withRemark(orderArgs, mode);
      guardWrite('create-order', orderArgs);

      const res = await runTool('create-order', orderArgs);
      const d = res.data || {};
      out('');
      out(`✅ 已创建订单 ${d.orderId || ''}`);
      if (d.realTotalAmount) out(`   应付 ¥${d.realTotalAmount}`);
      const pay = d.payH5Url || d.scanToPayUrl || d.payUrl;
      if (pay) {
        out('');
        out('   支付链接（自己扫码）：');
        out(`   ${pay}`);
      } else {
        out(JSON.stringify(d, null, 2));
      }
      out('');
      out(`   查进度：node scripts/mcd.mjs order-status ${d.orderId || '<订单号>'}`);
      if (d.orderId) {
        cacheSet('last-order', { orderId: String(d.orderId), at: Date.now(), amount: d.realTotalAmount || '' });
        const notify = String(getProfile().notify || '').trim();
        out('');
        if (notify) {
          out('   盯着它（状态一变就通知你）：');
          out(`   node scripts/mcd.mjs watch ${d.orderId} --interval 60 --on-change ${JSON.stringify(notify)}`);
        } else {
          out(`   盯着它：node scripts/mcd.mjs watch ${d.orderId}`);
          out('   想自动收到「配餐中 / 配送中 / 已送达」：先设通知命令');
          out('     node scripts/mcd.mjs profile set notify "你的推送命令 {status} {orderId}"');
        }
      }
      return;
    }

    /* ── 历史 ── */
    case 'history':
    case 'orders': {
      const n = Number(flags.n || rest[0] || 5);
      const payload = await runTool('order-list', {});
      const list = payload.data?.list || [];
      if (!list.length) return out('还没有麦当劳订单记录。');
      if (flags.json) return out(JSON.stringify(list.slice(0, n), null, 2));
      for (const o of list.slice(0, n)) {
        const names = (o.orderProductList || []).map((x) => `${x.productName}×${x.quantity}`).join('、');
        out(`${o.createTime}  ${o.orderStatus}  ¥${o.realTotalAmount}  ${o.storeName || ''}`);
        out(`  ${names}`);
        out(`  ${o.orderId}`);
      }
      return;
    }

    case 'reorder': {
      const payload = await runTool('order-list', {});
      const last = payload.data?.list?.[0];
      if (!last) return out('没有历史订单可以重下。');
      const specs = (last.orderProductList || []).map((x) => `${x.productCode}:${x.quantity}`);
      out(`上一单：${last.createTime} ${last.storeName} ¥${last.realTotalAmount}`);
      out(`商品：${(last.orderProductList || []).map((x) => `${x.productName}×${x.quantity}`).join('、')}`);
      out('');
      out('按当前默认门店重新算价……');
      flags.item = specs;
      // 复用 order 的流程
      const mode = currentMode();
      const store = currentStore(mode);
      const menu = await fetchMenu(store, mode);
      const items = [];
      const missing = [];
      for (const sp of specs) {
        const [code, qty] = sp.split(':');
        if (!menu.items[code]) {
          missing.push(code);
          continue;
        }
        items.push({ productCode: code, quantity: Number(qty) || 1 });
      }
      if (items.length === 0) return out(`这些商品在当前门店都没有卖（${missing.join(', ')}），换个门店或直接点。`);
      if (missing.length) out(`注意：${missing.length} 个商品当前门店没有，已跳过。`);
      const p2 = await runTool('calculate-price', priceArgsOf(store, mode, items));
      const p = parsePrice(p2);
      out('');
      printPrice(p);
      if (!flags.confirm) {
        out('');
        out('加 --confirm 才真的下单。');
        return;
      }
      const takeWay = (p.takeWayList.find((t) => t.code === 'take-in-store') || p.takeWayList[0])?.code;
      const orderArgs = { ...priceArgsOf(store, mode, items, { takeWay, forOrder: true }), items };
      if (mode.orderType === 2) delete orderArgs.takeWayCode;
      withRemark(orderArgs, mode);
      guardWrite('create-order', orderArgs);
      const res = await runTool('create-order', orderArgs);
      const d = res.data || {};
      out('');
      out(`✅ 已创建订单 ${d.orderId || ''}`);
      if (d.payH5Url) out(`   支付链接：${d.payH5Url}`);
      return;
    }

    /* ── 券与积分 ── */
    case 'coupons': {
      const payload = await runTool('query-my-coupons', {});
      const arr = payload.data?.coupons || (Array.isArray(payload.data) ? payload.data : []);
      if (flags.json) return out(JSON.stringify(arr, null, 2));
      if (!arr.length) return out('卡包里没有券。看看有没有可领的：node scripts/mcd.mjs claimable');
      for (const c of arr) out(`${c.couponName || c.name || ''}  ${c.couponId || ''}`);
      out(`\n共 ${arr.length} 张`);
      return;
    }

    /* ── 可领券（麦麦省） ── */
    case 'claimable':
    case 'available': {
      const list = await fetchClaimable({ force: rest[0] === 'refresh' || Boolean(flags['no-cache']) });
      if (flags.json) return out(JSON.stringify(list, null, 2));
      if (!list.length) return out('现在没有可领的券。');
      const can = list.filter(isClaimable);
      list.forEach((c, i) => out(`${String(i + 1).padStart(2)}. ${c.name}　${c.status || ''}`));
      out('');
      if (!can.length) return out(`共 ${list.length} 张，但都已经领过了。`);
      out(`共 ${list.length} 张，其中 ${can.length} 张可领。`);
      out('一键全领：node scripts/mcd.mjs claim --confirm');
      return;
    }

    /* ── 一键领券 ── */
    case 'claim': {
      const list = await fetchClaimable();
      const can = list.filter(isClaimable);
      if (!can.length) return out('现在没有可领的券。');
      out(`准备领取 ${can.length} 张：`);
      for (const c of can) out(`  · ${c.name}`);
      guardWrite('auto-bind-coupons', {});
      const payload = await runTool('auto-bind-coupons', {});
      cacheSet('claimable', []);
      out('');
      out('✅ 已提交领取。');
      const d = payload.data;
      if (d && typeof d === 'object') out(JSON.stringify(d, null, 2));
      out('');
      out('核实一下卡包：node scripts/mcd.mjs coupons');
      return;
    }

    case 'store-coupons': {
      const mode = currentMode();
      const store = currentStore(mode);
      const args = { storeCode: store.storeCode, orderType: mode.orderType, beType: mode.beType };
      if (mode.beType !== 1 && store.beCode) args.beCode = store.beCode;
      if (flags.at) args.reservationDate = flags.at;
      const payload = await runTool('query-store-coupons', args);
      const arr = Array.isArray(payload.data) ? payload.data : payload.data?.coupons || [];
      if (flags.json) return out(JSON.stringify(arr, null, 2));
      if (!arr.length) return out(`${store.storeName || store.storeCode} 当前没有可用券。`);
      for (const c of arr) out(`${c.couponName || c.name || ''}  ${c.couponId || ''}`);
      out(`\n共 ${arr.length} 张`);
      return;
    }

    case 'points': {
      const payload = await runTool('query-my-account', {});
      const d = payload.data || {};
      if (flags.json) return out(JSON.stringify(d, null, 2));
      out(`可用积分  : ${d.availablePoint}`);
      out(`累计积分  : ${d.accumulativePoint}`);
      out(`本月将过期: ${d.currentMouthExpirePoint}`);
      out(`已过期    : ${d.expiredPoint}`);
      return;
    }

    /* ── 裸调用 ── */
    case 'call':
    case 'run': {
      const name = rest[0];
      if (!name) return die('用法：node scripts/mcd.mjs call <工具名> k=v ...  （或 --file args.json）');
      const args = await readArgs(name);
      guardWrite(name, args);
      const payload = await runTool(name, args);
      if (flags.raw) return out(JSON.stringify(payload, null, 2));
      if (flags.json) return out(JSON.stringify(payload.data, null, 2));
      const text = typeof payload.data === 'string' ? payload.data : JSON.stringify(payload.data, null, 2);
      return out(text);
    }

    /* ── 工具浏览 ── */
    case 'tools': {
      const tools = (await toolSchema('__all__'), [..._toolMap.values()]);
      const kw = typeof flags.grep === 'string' ? flags.grep : null;
      let list_ = tools;
      if (kw) {
        const k = kw.toLowerCase();
        list_ = tools.filter(
          (t) =>
            String(t.name).toLowerCase().includes(k) ||
            String(t.title || '').toLowerCase().includes(k) ||
            String(t.description || '').toLowerCase().includes(k),
        );
      }
      if (flags.json) return out(JSON.stringify(list_, null, 2));
      const w = Math.max(4, ...list_.map((t) => t.name.length));
      out(list_.map((t) => `  ${pad(t.name, w)}  ${(t.title || t.description || '').replace(/\s+/g, ' ').slice(0, 40)}`).join('\n'));
      out(`\n共 ${list_.length} 个工具${kw ? `（筛选：${kw}）` : ''}。入参：schema <工具名>`);
      return;
    }

    case 'schema': {
      const name = rest[0];
      if (!name) return die('用法：node scripts/mcd.mjs schema <工具名>');
      await toolSchema('__all__');
      const tool = _toolMap.get(name);
      if (!tool) return die(`没有名为 ${name} 的工具。先跑 tools 看清单。`);
      return out(JSON.stringify(tool, null, 2));
    }

    case 'doc': {
      const tools = (await toolSchema('__all__'), [..._toolMap.values()]);
      const target = typeof flags.out === 'string' ? resolve(flags.out) : resolve(HERE, '..', 'references', 'tools.md');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, renderToolsDoc(tools), 'utf8');
      return out(`已生成 ${target}（${tools.length} 个工具）`);
    }

    case 'cache': {
      if (rest[0] === 'clear') {
        const n = cacheClear();
        return out(`已清掉 ${n} 个缓存文件。`);
      }
      return out(`缓存目录：${cacheDir()}\n清空：node scripts/mcd.mjs cache clear`);
    }

    default:
      die(`未知命令：${command}\n\n${HELP}`);
  }
}

/* ─────────────────────────── 入参构造 ─────────────────────────── */

async function readArgs(toolName) {
  if (typeof flags.file === 'string') {
    const p = resolve(flags.file);
    if (!existsSync(p)) return die(`找不到文件：${p}`);
    const text = readFileSync(p, 'utf8').trim();
    return text ? JSON.parse(text) : {};
  }
  if (flags.stdin || rest[1] === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text ? JSON.parse(text) : {};
  }
  if (typeof flags.args === 'string') return JSON.parse(flags.args);

  // k=v 形式（Windows PowerShell 下最稳，不用跟引号打架）
  const args = {};
  for (const pair of rest.slice(1)) {
    const i = pair.indexOf('=');
    if (i <= 0) return die(`参数「${pair}」不是 k=v 形式。\n整体入参较复杂时改用：--file args.json 或 --stdin`);
    const k = pair.slice(0, i);
    const v = pair.slice(i + 1);
    args[k] = v;
  }

  // 按 schema 的类型规整
  if (Object.keys(args).length) {
    const tool = await toolSchema(toolName);
    const props = tool?.inputSchema?.properties || {};
    for (const [k, v] of Object.entries(args)) {
      if (props[k]) args[k] = coerceBySchema(v, props[k]);
    }
  }

  // --item 简写直接补 items[]
  const items = list(flags.item);
  if (items.length) {
    args.items = items.map((raw) => {
      const s = String(raw).trim();
      const m = s.match(/^(\d+)\s*[:x×*]\s*(\d+)$/i);
      if (m) return { productCode: m[1], quantity: Number(m[2]) };
      const i = s.indexOf(':');
      if (i > 0) return { productCode: s.slice(0, i), quantity: Number(s.slice(i + 1)) || 1 };
      return { productCode: s, quantity: 1 };
    });
  }
  return args;
}

/* ─────────────────────────── 文档生成 ─────────────────────────── */

function renderToolsDoc(tools) {
  const now = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('# 麦当劳 MCP 工具清单');
  lines.push('');
  lines.push(`> 由 \`node scripts/mcd.mjs doc\` 于 ${now} 自动生成，共 **${tools.length}** 个工具。`);
  lines.push('> 入参 Schema 是服务器 `tools/list` 返回的原文，不要手改。');
  lines.push('');
  lines.push('## 目录');
  lines.push('');
  for (const t of tools) lines.push(`- [\`${t.name}\`](#${t.name.replace(/[^A-Za-z0-9-]/g, '').toLowerCase()})　${oneLine(t.title || '')}`);
  lines.push('');

  for (const t of tools) {
    lines.push(`## \`${t.name}\``);
    lines.push('');
    if (t.title) lines.push(`**${oneLine(t.title)}**`);
    if (t.description) {
      lines.push('');
      lines.push(oneLine(t.description));
    }
    lines.push('');
    const schema = t.inputSchema || { type: 'object', properties: {} };
    lines.push('```json');
    lines.push(JSON.stringify(schema, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('调用示例：');
    lines.push('');
    lines.push('```bash');
    lines.push(`node scripts/mcd.mjs call ${t.name} ${exampleArgs(schema)}`);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function exampleArgs(schema) {
  const props = schema?.properties || {};
  const required = schema?.required || [];
  const keys = required.length ? required : Object.keys(props).slice(0, 1);
  return keys.map((k) => `${k}=<${placeholder(props[k], k)}>`).join(' ');
}

function placeholder(p, key = '') {
  if (p?.default !== undefined) return p.default;
  if (p?.enum?.length) return p.enum[0];
  const type = Array.isArray(p?.type) ? p.type.find((x) => x !== 'null') : p?.type;
  if (type === 'array' || type === 'object') return 'JSON';
  if (type === 'boolean') return 'true';
  if (type === 'integer' || type === 'number') return '0';
  return key;
}

/* ─────────────────────────── 启动 ─────────────────────────── */

main().catch((e) => {
  if (e instanceof McpError) die(`出错：${e.message}`);
  die(`出错：${e?.message || e}`);
});
