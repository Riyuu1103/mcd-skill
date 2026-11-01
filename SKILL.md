---
name: mcd-mcp
description: >-
  接入并使用麦当劳中国官方 MCP 服务（https://mcp.mcd.cn）：查门店与菜单、看套餐可替换项、
  算价、叠券、点麦乐送 / 到店取餐 / 得来速 / 团餐、积分商城兑换、积分抽奖、派对与主题活动预约、
  查订单、跟踪出餐状态。自带点餐偏好（常用门店、地址、口味备注、默认取餐方式），设一次以后不用重复说。
  当用户说「点麦当劳」「麦乐送」「麦当劳有什么优惠券」「积分快过期了换点什么」「帮我订个派对」
  「麦当劳订单到哪了」「老样子来一份」「这个套餐能换什么」，或要让薇欧拉（OpenClaw）帮忙点餐时启用。
  Trigger: 麦当劳, 麦乐送, 麦麦, mcd, MCP 点餐, 麦当劳优惠券, 麦当劳积分, 麦当劳派对,
  麦当劳订单, 帮我点个巨无霸, 薯条, 金拱门, 老样子, 点餐偏好, 套餐能换什么.
---

# 麦当劳中国 MCP

麦当劳中国官方托管的 MCP 服务，走 **Streamable HTTP**，一个 Token 就能用。
覆盖：麦乐送 / 到店取餐 / 得来速 / 企业团餐 / 积分商城 / 积分抽奖 / 派对与主题活动 / 活动日历。

本 skill 带一个**零依赖 Node 客户端**（不用装包、不用 Python、不用原生 MCP）：

```
scripts/mcp-client.mjs   MCP Streamable HTTP 客户端（可单独复用）
scripts/mcd.mjs          CLI：偏好 / 门店 / 菜单 / 套餐 / 算价 / 下单 / 券 / 积分 / 盯单
scripts/store.mjs        本地偏好与缓存
```

> 需要给人看/打印的完整说明：`docs/麦当劳MCP-接入与使用指南.pdf`

## 0. 先决条件：Token

1. <https://open.mcd.cn/mcp> → 右上角【登录】→ 手机号验证码。
2. 【控制台】→【激活】→ 同意协议 → 复制 Token。
3. `node scripts/mcd.mjs login <粘贴 token>`

Token 存在 `%APPDATA%\mcd-mcp\config.json`（Windows）或 `~/.config/mcd-mcp/config.json`，
环境变量 `MCD_MCP_TOKEN` 可覆盖。**不要提交进仓库。**

- 限流 600 请求/分钟，超了 429。
- 401 = Token 无效或已过期，重新复制。
- 只服务中国大陆（不含港澳台）。

## 1. 命令速查

```bash
# 看一眼
node scripts/mcd.mjs home        # 积分 / 可领券 / 默认门店 / 上一单
node scripts/mcd.mjs status      # 连接自检
node scripts/mcd.mjs now         # 服务器时间

# 找店与菜单
node scripts/mcd.mjs stores --city 上海 --keyword 人民广场
node scripts/mcd.mjs profile use-store 1        # 列表第 1 家设为默认门店
node scripts/mcd.mjs menu                       # 摘要：分类 + 前几样
node scripts/mcd.mjs menu --grep 巨无霸          # 搜商品
node scripts/mcd.mjs menu --cat 套餐             # 只看某一类
node scripts/mcd.mjs menu --all                 # 全量（终端里看，别转发给用户）

# 套餐（点套餐前必须走这一步）
node scripts/mcd.mjs detail "巨无霸四件套"        # 组成 + 能换成什么 + 差价

# 算价 / 下单
node scripts/mcd.mjs price --item "巨无霸:1" --detail
node scripts/mcd.mjs price --item "巨无霸:1" --brief   # 三行简版，可直接转发
node scripts/mcd.mjs order --item "巨无霸:1" --confirm
node scripts/mcd.mjs history 5
node scripts/mcd.mjs reorder [--confirm]
node scripts/mcd.mjs order-status <orderId>
node scripts/mcd.mjs watch <orderId>            # 盯状态，变化时可跑外部命令
node scripts/mcd.mjs cancel <orderId> --reason 3 --confirm

# 券与积分
node scripts/mcd.mjs coupons / store-coupons / points

# 兜底
node scripts/mcd.mjs call <工具名> k=v k=v ...
node scripts/mcd.mjs tools | schema <工具名> | doc
```

**Windows 传参**：`call` 用 `k=v`，**不要**手写 JSON（PowerShell 会把双引号吃掉）。
复杂入参用 `--file args.json` 或 `--stdin`。

## 2. 点餐偏好（一次设好，以后不用重复说）

```bash
node scripts/mcd.mjs profile                          # 看全部
node scripts/mcd.mjs profile set city 上海
node scripts/mcd.mjs profile set keyword 人民广场
node scripts/mcd.mjs profile set mode delivery        # pickup / dt / delivery
node scripts/mcd.mjs profile set budget 30
node scripts/mcd.mjs profile set autoCoupon false
node scripts/mcd.mjs profile use-store 2
node scripts/mcd.mjs profile use-address 12345

node scripts/mcd.mjs address new --name 张三 --phone 13800138000 \
  --city 上海 --addr 中山北路3663号 --detail "12号楼301室" --confirm
node scripts/mcd.mjs address use 3
node scripts/mcd.mjs remark "不要生菜，可乐去冰"        # 外送单会作为订单备注
```

| 键 | 作用 |
|---|---|
| `city` / `keyword` | 找门店的默认条件 |
| `mode` | `pickup` 到店 / `dt` 得来速 / `delivery` 麦乐送 |
| `store` / `address` | 默认门店、默认收货地址 |
| `contact.*` | 建地址时自动带入 |
| `taste.notes` | 口味备注；**仅外送单**会作为 `remark`（≤50 字）传给门店 |
| `taste.tableware` | 要不要餐具 |
| `budget` | 单餐预算，超了只提示 |
| `autoCoupon` | 算价时自动挑最省的券，默认开 |

⚠️ **不要把示例值当成用户的偏好**。偏好是你亲手设的才算数；
从别人的机器拷来的配置里可能残留测试值，先 `profile` 复核一遍。

## 3. 套餐：先看能换什么，再报价

**只要用户点的是套餐（名字含「套」「三件套」「四件套」「组合」「随心配」），必须：**

1. 先 `detail "套餐名"`；
2. **主动**告诉他每一部分能换成什么、各加多少钱（哪怕他没问）；
3. 然后才报价、才等确认。

`detail` 会打印：组成、每部分的默认项与可换项（带差价）、哪些能「特调」。
加 `--all` 看全部可选项，加 `--mod` 看特制项。

**接口只能「看」不能「提交替换」**（实测：把替换写成 `modification` 传进
`calculate-price` 后，价格和商品清单都没变）。所以：

- 想换 → 让他去麦当劳 App 改；或
- 你**按单点重新组一套**（汉堡 + 单点小食 + 单点饮料），价格重新算一遍给他。

**不许假装能换，也不许说「已换成」。**

## 4. 每次变动都要重报总价

商品、规格、数量、券、取餐方式**任一变化**，都必须重新 `price` 并明确报出新的实付金额，
以及「比上一版多/少 ¥X」。金额一律以 `price` 里 `▶ 实付` 那一行为准。

**菜单价 ≠ 算价**是常态（到店价、外送价、活动价、券各算各的）。
`price` 发现两者不一致会打印 ⚠️ 提示，**要原样转述给用户**，不要只报一个数字糊过去。

## 5. 五个业务流程

细节见 [`references/flows.md`](references/flows.md)。先记住两个参数：

| 场景 | `beType` | `orderType` | 门店工具 | 要不要 `beCode` |
|---|---|---|---|---|
| 到店自取 | `1` | `1` | `query-nearby-stores` | **不传** |
| 得来速 | `5` | `1` | `query-nearby-stores` | 必传 |
| 麦乐送 | `2` | `2` | `delivery-query-stores` | 必传 |
| 企业团餐 | `6` | `2` | `delivery-query-stores` | 必传 |

⚠️ **到店自取不传 `beCode`**，这条最容易记反。

### 5.1 到店取餐

```
now-time-info → query-nearby-stores(searchType=2,beType=1,city,keyword)
→ query-meals → [套餐？detail] → query-store-coupons → calculate-price（takeWayList）
→ 确认 → create-order（带 takeWayCode）
```

### 5.2 麦乐送

```
delivery-query-addresses → delivery-query-stores(addressId,beType=2)
→ query-meals → [套餐？detail] → query-store-coupons → calculate-price
→ 确认 → create-order（addressId + remark）
```

### 5.3 券

`query-my-coupons`（卡包里有什么）≠ `query-store-coupons`（这张单这家店能不能用）。
`auto-bind-coupons` 会一次性领光所有能领的券，**不可逆，先问**。

### 5.4 积分商城

```
query-my-account → query-mall-products → mall-product-detail（skuId / spuCategory）
→ 确认 → mall-create-order（实物还要 addressId）
```

### 5.5 派对

```
query-party-city(spuId) → query-party-store(code) → query-party-store-date
→ query-party-store-session → 确认 → party-order-create
```

### 5.6 金额单位

`calculate-price` 的价格字段是 **分**；`query-meals`/`create-order`/`query-order`/商城订单
返回的**已经是元**。`price` 命令已经替你换算好。

## 6. 盯单与主动通知

```bash
node scripts/mcd.mjs watch <orderId> --interval 60
node scripts/mcd.mjs watch <orderId> --once --on-change "你的推送命令 {status} {orderId}"
```

- 状态变化才触发，同样的状态不会重复叫你。
- 占位符：`{status}` 中文状态、`{orderId}`、`{code}` 取餐码、`{amount}` 金额。
- `--once` 会记住上次状态（缓存 24h），适合被 cron / 计划任务每几分钟调一次。
- `--append log.txt` 顺手记一行流水。

MCP 本身**不支持推送**，只能轮询 `query-order`。要做到「配餐中 → 配送中 → 已送达」
主动发消息，就是 watch + 你自己的通知通道。

## 7. 硬性安全规则

1. **不可逆动作必须有明确同意**：`create-order`、`cancel-order`、`mall-create-order`、
   `party-order-create`、`draw-lottery`、`auto-bind-coupons`、`delivery-create-address`。
   CLI 对这批工具内置护栏：**不带 `--confirm` 一律拦下**（退出码 3），只打印入参。
2. **支付永远由用户本人完成**。`create-order` 返回 `payH5Url`，原样给用户。
3. **不要编地址、电话、联系人**。
4. **超时先查单**：`history` / `order-status`，确认没有再重下。
5. **积分是钱**：抽奖、兑换前报清消耗与剩余。
6. **Token 不外发**。

## 8. 输出习惯

- 菜单只给「名字 + 价格 + code」，**默认用摘要**，别把 99 行全贴给用户。
- 要直接转发的内容用 `--brief`，三行、可直接粘进聊天。
- 下单成功给三样：订单号、支付链接（单独一行）、取餐码或预计送达。
- 金额单位是元，两位小数。

## 9. 与薇欧拉（OpenClaw）联动

见 [`references/viola.md`](references/viola.md)。要点：她只算账、只递链接，付款永远是用户本人。

## 10. 排错

| 现象 | 处理 |
|---|---|
| `HTTP 401` | Token 失效，重新复制后 `login` |
| `HTTP 429` | 超 600 次/分钟，等一分钟 |
| 「还没有默认门店」 | `stores` → `profile use-store 1` |
| 「匹配到 N 个商品」 | 名字写具体点，或直接给商品编码 |
| 算价对不上菜单价 | 常态，见第 4 节；以 `▶ 实付` 为准 |
| 返回是 Markdown 不是 JSON | `available-coupons`、`list-nutrition-foods` 本来就这样 |
| 想换套餐内商品 | 接口不支持，见第 3 节 |

## 11. 边界

- 本 skill 只是官方 MCP 服务的**客户端与使用说明**，与麦当劳中国无隶属关系。
- 不存储账号密码，只用一个 MCP Token，且只落在本机。
- 下单、付款、退款的责任在用户本人，以麦当劳官方页面为准。
