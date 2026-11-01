// 本地状态：点餐偏好（profile）与响应缓存（cache）
// 两者都落在配置文件同目录，不进任何仓库。

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configPath, loadConfig, saveConfig } from './mcp-client.mjs';

/* ───────────────────────── 缓存 ───────────────────────── */

export function cacheDir() {
  return join(dirname(configPath()), 'cache');
}

function cacheFile(key) {
  const safe = key.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return join(cacheDir(), `${safe}.json`);
}

/** 读缓存；过期或不存在返回 null */
export function cacheGet(key, ttlMs) {
  try {
    const p = cacheFile(key);
    if (!existsSync(p)) return null;
    const box = JSON.parse(readFileSync(p, 'utf8'));
    if (!box?.at || Date.now() - box.at > ttlMs) return null;
    return box.value;
  } catch {
    return null;
  }
}

export function cacheSet(key, value) {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cacheFile(key), JSON.stringify({ at: Date.now(), value }), 'utf8');
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

export function cacheClear() {
  const dir = cacheDir();
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    try {
      rmSync(join(dir, f), { force: true });
      n++;
    } catch {
      /* ignore */
    }
  }
  return n;
}

/* ───────────────────────── 点餐偏好 ───────────────────────── */

export const DEFAULT_PROFILE = {
  city: '', // 城市，例如「上海」
  keyword: '', // 找门店用的位置关键词，例如「人民广场」
  mode: 'pickup', // pickup 到店自取 | dt 得来速 | delivery 麦乐送
  store: null, // { storeCode, beCode, storeName, address, beType }
  address: null, // { addressId, label, city, address, contactName, phone }
  contact: { name: '', phone: '', gender: '' },
  taste: {
    notes: '', // 自由文本备注：不要生菜、少冰、不要餐具……（外送会作为订单备注传给门店）
    tableware: false, // 是否需要餐具
  },
  budget: null, // 单餐预算（元），只用来提示，不拦截
  autoCoupon: true, // 算价时自动挑最省的券
};

export const MODES = {
  pickup: { beType: 1, orderType: 1, label: '到店自取', storeTool: 'query-nearby-stores' },
  dt: { beType: 5, orderType: 1, label: '得来速', storeTool: 'query-nearby-stores' },
  delivery: { beType: 2, orderType: 2, label: '麦乐送', storeTool: 'delivery-query-stores' },
};

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

export function getProfile() {
  const cfg = loadConfig();
  return deepMerge(DEFAULT_PROFILE, cfg.profile || {});
}

/** 支持点路径，如 taste.notes、contact.phone */
export function setProfilePath(path, rawValue) {
  const cfg = loadConfig();
  const prof = deepMerge(DEFAULT_PROFILE, cfg.profile || {});
  const keys = String(path).split('.').filter(Boolean);
  if (keys.length === 0) throw new Error('要设置的键不能为空');
  let cur = prof;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = typeof rawValue === 'string' ? coercePreference(rawValue) : rawValue;
  cfg.profile = prof;
  saveConfig(cfg);
  return prof;
}

export function unsetProfilePath(path) {
  const cfg = loadConfig();
  const prof = deepMerge(DEFAULT_PROFILE, cfg.profile || {});
  const keys = String(path).split('.').filter(Boolean);
  let cur = prof;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur?.[keys[i]];
    if (!cur || typeof cur !== 'object') return prof;
  }
  delete cur[keys[keys.length - 1]];
  cfg.profile = prof;
  saveConfig(cfg);
  return prof;
}

/** 偏好值的类型：布尔/数字/JSON 对象数组会自动识别，其余按字符串 */
function coercePreference(v) {
  const s = String(v ?? '').trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      return JSON.parse(s);
    } catch {
      /* 按字符串处理 */
    }
  }
  return s;
}
