---
name: mcd-mcp
description: >-
  接入并使用麦当劳中国官方 MCP 服务（https://mcp.mcd.cn）：查门店与菜单、看套餐可替换项、
  算价、叠券、点麦乐送 / 到店取餐 / 得来速 / 团餐、积分商城兑换、积分抽奖、派对与主题活动预约、
  查订单、跟踪出餐状态。自带点餐偏好（常用门店、地址、口味备注、默认取餐方式），设一次以后不用重复说。
  当用户说「点麦当劳」「麦乐送」「麦当劳有什么优惠券」「积分快过期了换点什么」「帮我订个派对」
  「麦当劳订单到哪了」「老样子来一份」「这个套餐能换什么」时启用。
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
node scripts/mcd.mjs coupons        # 卡包里的券
node scripts/mcd.mjs claimable      # 麦麦省「可领」的券（会自动提醒）
node scripts/mcd.mjs claim --confirm  # 一键全领（不可逆）
node scripts/mcd.mjs store-coupons  # 当前门店这一单能用的券
node scripts/mcd.mjs points         # 积分 + 本月将过期

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

### 5.3 券（三件事别混）

| 问题 | 用哪个 |
|---|---|
| 我卡包里有什么 | `query-my-coupons` / `coupons` |
| 麦麦省里还有哪些**能领** | `available-coupons` / `claimable` |
| 这张单、这家店**能不能用** | `query-store-coupons` / `store-coupons` |

**自动提醒**：`price` / `order` 每次都会顺手查一次「可领券」，有就提示一句
「还有 N 张券可以领」。`home` 也会列出来。缓存 5 分钟，不会反复打接口。

**领券是不可逆动作**：`claim` 不带 `--confirm` 会被拦下。领之前把券名念给用户听。
领完再 `price` 一次，价格可能更好。

`auto-bind-coupons` 是「一次性领光所有能领的券」，没有挑选余地。

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

### 6.1 先说清楚：MCP **不会**推送

麦当劳 MCP 没有任何回调/订阅机制，只能轮询 `query-order`。
所以「配餐中 → 配送中 → 已送达 自动通知」**不是装上就有**，必须有人**定时去问**。

本 skill 提供的那一半是：**轮询 + 判定变化 + 执行回调命令**。
另一半（发到哪）必须你自己接。

### 6.2 三层拼起来才叫"会通知"

```
计划任务/常驻进程  →  mcd watch --once  →  状态变了  →  你的通知命令  →  QQ/Telegram/邮件
```

```bash
# 手工盯一会儿（前台阻塞，适合立刻要看）
node scripts/mcd.mjs watch <orderId> --interval 60

# 交给计划任务：每次只问一次，状态变了才触发回调
node scripts/mcd.mjs watch --last --once --quiet --on-change "你的推送命令"
```

- `--last`：盯「刚刚下的那一单」（读本地下单缓存），不用每次传订单号；超过 `--max-age` 分钟（默认 180）就不盯了。
- `--once`：查一次就退。上次状态会记进缓存（24h），**同一状态不重复通知**，所以可以安全地每 2 分钟跑一次。
- 已经收尾（完成/取消/评价/退款）的单，下次直接短路，不会再去打接口。
- `--on-change` 不给的话，用偏好里的 `notify`：

```bash
node scripts/mcd.mjs profile set notify "node 你的推送脚本"
```

- 占位符：`{status}` 中文状态、`{orderId}`、`{code}` 取餐码、`{amount}` 金额。
- **同时**写成环境变量 `MCD_STATUS` / `MCD_ORDER_ID` / `MCD_CODE` / `MCD_AMOUNT`
  —— Windows 走 shell 传中文参数会乱码，**读环境变量更稳**，推荐这条路。
- `--append log.txt` 记流水。

### 6.3 三种接线方式

| 方式 | 适合 | 代价 |
|---|---|---|
| Windows 计划任务 / cron 每 2 分钟跑 `watch --last --once` | 自己电脑常开 | 零 token，最省 |
| 聊天机器人常驻循环 | 有服务器/常驻进程 | 要一直活着 |
| 云函数定时触发 | 有云账号 | 要暴露一个入口 |

**注意**：AI 助手**不会自己常驻**。一次对话结束它就不动了，所以「让它盯着」这句话本身不构成推送 ——
必须落到上面三种之一。

### 6.4 接任意 bot：`notify`（不用写代码）

`scripts/notify.mjs` 是个通用分发器，目标全写在配置里，**支持三种出口**：

| 出口 | 适用 |
|---|---|
| `webhook` | 任意 HTTP 接口 —— QQ/飞书/钉钉/Slack/Bark/自建服务都行 |
| `telegram` | Telegram Bot API |
| `command` | 交给任意命令行程序（连脚本都不用写） |

**一条命令接入**（会自动把 `profile.notify` 设好，之后 `watch` 直接用它）：

```bash
node scripts/mcd.mjs notify add --type webhook --url "https://你的机器人回调地址"
node scripts/mcd.mjs notify test          # 立刻发一条测试，看通不通
```

**webhook 的请求体**是 `{"text": "..."}`；要对接别的格式就自己给 `--body`：

```bash
# 飞书
notify add --type webhook --url "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" \
  --body '{"msg_type":"text","content":{"text":"{{text}}"}}'
# 钉钉
notify add --type webhook --url "https://oapi.dingtalk.com/robot/send?access_token=xxx" \
  --body '{"msgtype":"text","text":{"content":"{{text}}"}}'
# Bark（iOS 推送，直接拼进 URL）
notify add --type webhook --method GET --url "https://api.day.app/你的key/麦当劳-{status}"
```

`{{text}}` 会被替换成**已经 JSON 转义**的整段文案；`{status}` `{orderId}` `{code}` `{amount}`
在任何位置（含 URL）都能用。

**其它子命令**：

```bash
node scripts/mcd.mjs notify list                  # 看当前目标
node scripts/mcd.mjs notify remove 2              # 删第 2 个
node scripts/mcd.mjs notify text "🍟 {status}！"   # 改文案
node scripts/mcd.mjs notify test --status 配送中   # 换内容再测
```

**最后一道门（最自由）**：如果你有现成的推送脚本，直接 `--on-change` 指过去就行，
它会继承 `MCD_STATUS` / `MCD_ORDER_ID` / `MCD_CODE` / `MCD_AMOUNT` 和 `MCD_TEXT` 环境变量，
不限定语言、不限定平台。

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

## 9. 接聊天机器人（可选）

见 [`references/bot-integration.md`](references/bot-integration.md)。要点：机器人只算账、只递链接，
付款永远是用户本人。不接机器人也完全能用。

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
