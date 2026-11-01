# 点餐编排与踩坑（flows）

> 服务器实时返回的 `inputSchema` **永远优先于本文件**：
> `node scripts/mcd.mjs schema <工具名>`，或看 [`tools.md`](tools.md)。
> 这里记的是**字段含义、顺序、单位、容易想当然的地方**。

## 0. 先设偏好，后面全是短命令

```bash
node scripts/mcd.mjs profile set city 上海
node scripts/mcd.mjs profile set keyword 人民广场
node scripts/mcd.mjs stores                       # 用偏好里的 city + keyword
node scripts/mcd.mjs profile use-store 1          # 认准一家
```

设完之后 `menu` / `price` / `order` / `store-coupons` 都不再需要 `storeCode`，
用户说「老样子」就直接 `reorder`。

## 1. 四个业务类型：`beType` 与 `orderType` 是两件事

| 场景 | `beType` | `orderType` | 门店从哪来 | `beCode` |
|---|---|---|---|---|
| 到店自取 | `1` | `1` | `query-nearby-stores` | **不传** |
| 得来速（DT） | `5` | `1` | `query-nearby-stores` | 必传 |
| 麦乐送外送 | `2` | `2` | `delivery-query-stores` | 必传 |
| 企业团餐 | `6` | `2` | `delivery-query-stores` | 必传 |

- `orderType` 只有 `1` 到店 / `2` 外送；`beType` 取 `1/2/5/6`，两者不能混用。
- **到店自取不传 `beCode`**（工具描述原文：`beType=1 → orderType=1，不传 beCode`）。
  这一点和另外三种场景相反，最容易记错。
- **`reservationDate`（预约单）整条链路必须一致**，格式 `yyyy-MM-dd HH:mm`。
  改了时间，券和价格都会变。CLI 里用 `--at "2026-11-02 18:00"`。

## 2. 到店取餐：完整链路

```bash
node scripts/mcd.mjs now
node scripts/mcd.mjs stores --city 上海 --keyword 中山北路3663号
node scripts/mcd.mjs profile use-store 1
node scripts/mcd.mjs menu --grep 巨无霸
node scripts/mcd.mjs store-coupons
node scripts/mcd.mjs price --item "巨无霸:1" --item "中薯条:1"
node scripts/mcd.mjs order --item "巨无霸:1" --confirm
```

`price` 会自动完成：`query-meals`（带缓存）→ 名字解析成 `productCode`
→ `query-store-coupons` → 逐张券试价 → 挑最省 → `calculate-price`。
要跳过自动用券：`--no-auto-coupon` 或 `profile set autoCoupon false`。

## 3. 麦乐送外送

```bash
node scripts/mcd.mjs call delivery-query-addresses
node scripts/mcd.mjs profile use-address 12345
node scripts/mcd.mjs --mode delivery stores       # 用地址附近的配送门店
node scripts/mcd.mjs profile use-store 1
node scripts/mcd.mjs price --mode delivery --item "巨无霸:1"
node scripts/mcd.mjs order --mode delivery --item "巨无霸:1" --confirm
```

- 外送**不需要** `takeWayCode`；到店/得来速**必须**有（取自 `calculate-price` 的 `takeWayList`）。
- 外送单会带 `remark`：内容来自 `profile` 的 `taste.notes`，**≤50 字**，超了自动截断。
- 企业团餐（`beType=6`）额外要 `gmServiceCode`，来自 `query-meal-assistance`。
- 团餐促销另看 `query-promotions`（`beType=6`、`orderType=2` 专用）。

## 4. `items[]` 的结构（最容易写错）

```json
[{ "productCode": "1100", "quantity": 1, "couponId": "123456" }]
```

- 必须是**对象数组**，不是字符串。
- 只有 `productCode` / `quantity` / `couponId` / `couponCode` / `modification` 这几个字段。
- `calculate-price` 与 `create-order` 的 `items` 必须**完全一致**，否则实付会变。

### 4.1 套餐：能看不能改（实测结论）

`query-meal-detail` 返回的 `rounds[]` 就是套餐的各个组成部分，每个 round 下有 `choices[]`——
**那就是可替换项**，`isDefault: 1` 是默认选中的，`diffPrice` 是换它要加多少钱。

```
rounds[0] = 巨无霸 ×1     choices: [巨无霸]                       （只有一种，换不了）
rounds[1] = 小食 ×1       choices: [★中薯条 +¥0, 奥利奥麦旋风 +¥2, 大杯玉米杯 +¥2.5 …]
rounds[3] = 饮料 ×1       choices: [★可乐中杯 +¥0, 雪碧 +¥0, 拿铁 +¥11 …]（最多 29 种）
```

**实测：替换提交不了。** 把替换项写成 `items[].modification.values`（试过
`{code}` / `{code,key:code}` / `{code,key:"0-1"}` 三种）传给 `calculate-price`，
返回的价格和 `productList` **完全没有变化**。MCP 的 `items[]` 里没有表达
"这个 round 选哪个 choice" 的字段。

⇒ 正确做法：

1. 用 `detail` 把可换项和差价**摆给用户看**（这是应该做的）；
2. 真要换：
   - 让用户在麦当劳 App 里改；
   - 或按**单点重组**（汉堡 + 单点小食 + 单点饮料），价格重新算。

CLI 已经把这个做进命令里：`mcd detail "套餐名"`、`mcd price --item ... --detail`、
`mcd order` 默认会先打印可换项。


### 特制（modification）

`query-meal-detail` 会返回每个套餐可选的特制项，带 `selectedKey` / `unselectedKey`。
规则很绕：**选中的用 `selectedKey`，未选中的项若 `unselectedKey` 非空也必须用 `unselectedKey` 传进去**。
用不上就别碰，别自己编 key。

## 5. 金额单位：最大的坑

| 工具 | 单位 |
|---|---|
| `calculate-price` 的价格字段（`productPrice` / `deliveryPrice` / `price`） | **分**，÷100 |
| `query-meals` / `query-meal-detail` / `create-order` / `query-order` | **元**，直接用 |
| 麦麦商城（`mall-create-order` / `mall-order-list` / `mall-order-detail`） | **元**，直接用 |
| `points` / `totalPoints` / `goodsTotalPoints` | 积分，不是钱 |

别对已经是元的字段再除 100 —— 6.5 元的可乐会变成 0.065 元。

## 6. 券

- `query-my-coupons` = 卡包里有什么；`query-store-coupons` = **这张单这家店能不能用**。不能互替。
- `available-coupons` = 麦麦省**可领**的；`auto-bind-coupons` = 一键**全领**。
  后者不可逆，先问。
- 券不生效的常见原因：门店不参与、商品不在范围、没到金额门槛、已过期、限用张数。
- `calculate-price` 返回 `discount`（分）就是优惠掉的金额。

## 7. 积分与麦麦商城

```bash
node scripts/mcd.mjs points
node scripts/mcd.mjs call query-mall-products              # 可选 catRuleIds，如 "1>4,2"
node scripts/mcd.mjs call mall-product-detail spuId=123    # → skuList[].skuId、spuCategory
node scripts/mcd.mjs call mall-create-order skuId=456 spuCategory=1 count=1 --confirm
node scripts/mcd.mjs call mall-create-order skuId=456 spuCategory=2 addressId=123 --confirm
```

- `spuCategory`：`"1"` 虚拟（发券码）、`"2"` 实物（要 `addressId`）。
- 一单一个商品，多个串行。
- 兑换结果别凭文字下结论，用 `mall-order-list` / `mall-order-detail` 核实。
- 积分会过期：`query-my-account` 的 `currentMouthExpirePoint` 是本月将过期分数，
  `home` 会主动提醒。

## 8. 派对与主题活动

```bash
call query-party-city spuId=123
call query-party-store code=<城市code>
call query-party-store-date spuId=123 storeCode=<门店>
call query-party-store-session dateStr=2026-11-08 spuId=123 storeCode=<门店>
call party-order-create partyType=1 ... --confirm
```

- 城市 → 门店 → 日期 → 场次，逐级拿 id / code，不能猜。
- 场次有「可预约 / 已满」，别只看日期就下结论。
- 下单前把「城市 / 门店 / 日期 / 场次 / 人数 / 金额」念一遍。

## 9. 取消与查单

```bash
node scripts/mcd.mjs history 5
node scripts/mcd.mjs order-status <orderId>
node scripts/mcd.mjs cancel <orderId> --reason 3 --confirm
```

`cancelReasonCode`：`1` 改主意了 / `2` 重复下单 / `3` 点错了点多了点少了 /
`4` 地址或电话填错 / `5` 送达时间选错 / `-1` 其它。

## 10. 返回值要按"两层"看

1. **传输层**：CLI 已经把 `content[].text` 里的业务 JSON 抠出来了
   （麦当劳会在 JSON 前后附一段给人看的说明文字，直接 `JSON.parse` 会失败）。
2. **业务层**：`success` / `code` / `message` / `data`。
   **`success=false` 就是没成功，哪怕 HTTP 是 200。** 失败时带 `traceId`，报客服时报 traceId，别报 Token。

少数工具（`available-coupons`、`list-nutrition-foods`）直接返回 Markdown / TOON 文本，
不是 JSON —— 按文本读，别硬解析。

## 11. 防重复下单

`create-order` 超时、断网、进程被杀时，**不要立刻重试**：

```bash
node scripts/mcd.mjs order-list     # 或 mcd.mjs history
```

确认没有生成再重下。饭钱重复扣一次也很烦。

## 12. 时段与菜单

- 早餐只在早市（约 05:00–10:30，各店不同），午市菜单里查不到。
- `query-meals` 返回的是**该门店当下**的可售清单，早晚不一样，所以 CLI 默认缓存 10 分钟。
- 菜单里 `canWithOrder: true` 表示**可以随单购**（搭配主餐更便宜），不是"能不能下单"。
- 菜单默认只给摘要（每类前 3 样），要看全加 `--all`，看一类加 `--cat`。全量有 99 项，别整段贴给用户。

## 13. 三个价格，到底看哪个

同一份套餐，你会同时看到三个数字：

| 来源 | 例子 | 什么时候出现 |
|---|---|---|
| 菜单标价 `query-meals.currentPrice` | ¥29 | 浏览时 |
| 算价 `calculate-price.price`（分） | ¥58 | 下单前 |
| 实付 `create-order.realTotalAmount` / `query-order` | ¥45.8 | 付款后 |

**三者可以都不一样**：到店价、外送价、活动价、券、包装费、配送费各算各的。

规矩：

1. 给用户报价**只用 `price` 的 `▶ 实付`**；
2. 菜单价和算价不一致时，`price` 会打印 ⚠️，**必须原样转述**，不要挑一个数报；
3. 商品/规格/数量/券/取餐方式任一变化 → **重算、重报**，并说明比上一版多还是少。

## 14. 盯单与主动推送（MCP 不会推，只能轮询）

MCP 没有任何回调机制。`create-order` 之后只能靠反复 `query-order` 看状态。

```bash
# 前台盯：每 60 秒查一次，状态变化时打印
node scripts/mcd.mjs watch <orderId> --interval 60

# 被计划任务反复调用：只查一次，状态有变化才触发回调
node scripts/mcd.mjs watch <orderId> --once --on-change "your-notify.exe {status}"
```

- `--once` 会把上次状态记进缓存（24 小时），所以**同样的状态不会重复通知**——
  这才让「每 2 分钟跑一次」变得安全。
- 占位符：`{status}` 中文状态、`{orderId}`、`{code}` 取餐码、`{amount}` 金额。
- `--append log.txt` 记流水；`--quiet` 不打印到 stdout。
- 状态文案直接用服务端返回的 `orderStatus`（如「待支付 / 配餐中 / 配送中 / 制作完成 / 已完成 / 已取消」），
  不要自己硬编码数字码。

想做到「支付后 → 配餐中 → 配送中 → 已送达」每条都推，最省事的组合是：
**计划任务每 2 分钟跑一次 `watch --once --on-change`**，回调里发你自己的消息通道。

