# 麦当劳 MCP Skill｜一句话让 AI 帮你点麦当劳

给 AI agent 用的麦当劳中国官方 MCP 接入包：**零依赖**、**不用装别的包**、
**任何能跑 `node` 的 agent 都能用**。

```bash
node scripts/mcd.mjs login <你的 Token>
node scripts/mcd.mjs home
```

然后你对 AI 说「帮我点个巨无霸，怎么省怎么来」，它就会去查门店、拉菜单、叠券、算价、
把订单和支付链接给你，**最后一步扫码付款永远是你自己**。

---

## 这是什么

📘 **两份文档，按你的身份选一份：**

| 文档 | 给谁 | 内容 |
|---|---|---|
| [麦当劳AI点餐-使用指南.pdf](docs/麦当劳AI点餐-使用指南.pdf) | **普通用户** | 只会跟 AI 说话就能用：怎么接入、怎么开口点单、怎么付款、隐私。6 页，没有一行命令行 |
| [麦当劳MCP-开发者手册.pdf](docs/麦当劳MCP-开发者手册.pdf) | 动手的人 | 命令行全部参数、配置项、36 个工具、自动化盯单、排错。15 页 |

| | |
|---|---|
| 服务方 | 麦当劳中国官方 MCP 服务，端点 `https://mcp.mcd.cn` |
| 协议 | MCP / Streamable HTTP，请求头带 `Authorization: Bearer <Token>` |
| 覆盖 | 麦乐送外送 · 到店取餐 · 得来速 · 企业团餐 · 积分商城 · 积分抽奖 · 派对与主题活动 · 活动日历 |
| 工具数 | 36 个（清单见 [references/tools.md](references/tools.md)，由服务端实时生成） |
| 依赖 | 无。只要有 Node 18+（用内置 `fetch`），不装 npm 包、不需要 Python |
| 限制 | 仅中国大陆（不含港澳台）；每 Token 600 请求/分钟 |

本仓库**不是**麦当劳官方项目，只是官方 MCP 服务的一个客户端 + 使用说明。
服务本身的行为、价格、库存、活动以麦当劳官方页面为准。

## 为什么还要一个命令行

很多 agent 客户端原生支持 MCP，填个 JSON 就完事。但现实里：

- 有的客户端连 MCP 会卡在握手、有的只支持 stdio；
- 有的场景（定时任务、QQ 机器人、shell 脚本）根本没有 MCP 层；
- 把 36 个工具的 schema 塞进系统提示，会让**每一轮**都变贵。

所以提供两条路：**原生 MCP** 和 **命令行**。命令行是所有环境都能跑的那条。

## 安装

```bash
git clone https://github.com/Riyuu1103/mcd-skill.git
cd mcd-skill
node scripts/mcd.mjs status        # 没配 Token 会提示怎么做
```

没有构建步骤，没有 `npm install`。

### 拿 Token

1. <https://open.mcd.cn/mcp> → 右上角【登录】→ 手机号验证码登录。
2. 【控制台】→【激活】→ 同意服务协议 → 复制 Token。
3. `node scripts/mcd.mjs login <粘贴>`

Token 落在 `%APPDATA%\mcd-mcp\config.json`（Windows）或
`~/.config/mcd-mcp/config.json`，权限 600；环境变量 `MCD_MCP_TOKEN` 可覆盖。

## 先设偏好，之后全是短命令

这是本工具最省事的地方 —— **设一次，以后不用再把门店、地址、口味念一遍**。

```bash
node scripts/mcd.mjs profile set city 上海
node scripts/mcd.mjs profile set keyword 人民广场
node scripts/mcd.mjs stores                 # 用偏好里的城市+关键词
node scripts/mcd.mjs profile use-store 1    # 认准一家
node scripts/mcd.mjs profile set taste.notes "不要生菜，可乐去冰"
node scripts/mcd.mjs profile set budget 30
```

之后：

```bash
node scripts/mcd.mjs price --item "巨无霸:1"     # 不用再说哪家店
node scripts/mcd.mjs reorder                     # 上一单再来一份
```

| 偏好键 | 作用 |
|---|---|
| `city` / `keyword` | 找门店的默认条件 |
| `mode` | `pickup` 到店 / `dt` 得来速 / `delivery` 麦乐送 |
| `store` | 默认门店（含 storeCode / beCode） |
| `address` | 默认收货地址（麦乐送用） |
| `contact.name/phone/gender` | 新增收货地址时自动带入 |
| `taste.notes` | 口味备注，**外送单会作为订单备注传给门店**（≤50 字） |
| `taste.tableware` | 是否要餐具 |
| `budget` | 单餐预算，超了只提示 |
| `autoCoupon` | 算价时自动挑最省的券（默认开） |

## 命令

```bash
node scripts/mcd.mjs home           # 积分 / 可领券 / 默认门店 / 上一单
node scripts/mcd.mjs status         # 连接自检
node scripts/mcd.mjs now            # 服务器时间

node scripts/mcd.mjs stores --city 上海 --keyword 中山北路3663号
node scripts/mcd.mjs menu                    # 摘要：分类 + 前几样
node scripts/mcd.mjs menu --grep 巨无霸       # 搜商品
node scripts/mcd.mjs menu --cat 套餐          # 只看一类
node scripts/mcd.mjs menu --all              # 全量（99 项，终端里看）

node scripts/mcd.mjs detail "巨无霸四件套"    # 套餐组成 + 能换成什么 + 差价
node scripts/mcd.mjs price --item "巨无霸:1" --item "中薯条:1"
node scripts/mcd.mjs price --item "巨无霸:1" --detail   # 顺带列出套餐可换项
node scripts/mcd.mjs price --item "巨无霸:1" --brief    # 三行简版，可直接转发
node scripts/mcd.mjs price --mode delivery --item "巨无霸:1"
node scripts/mcd.mjs price --item "巨无霸:1" --at "2026-11-02 18:00"
node scripts/mcd.mjs order --item "巨无霸:1" --confirm

node scripts/mcd.mjs history 5
node scripts/mcd.mjs reorder [--confirm]
node scripts/mcd.mjs order-status <orderId>
node scripts/mcd.mjs watch <orderId> --interval 60        # 盯状态
node scripts/mcd.mjs watch <orderId> --once --on-change "通知程序 {status}"
node scripts/mcd.mjs cancel <orderId> --reason 3 --confirm

node scripts/mcd.mjs coupons        # 卡包里的券
node scripts/mcd.mjs store-coupons  # 当前门店可用券
node scripts/mcd.mjs points         # 积分 + 本月将过期

node scripts/mcd.mjs call <工具名> k=v k=v ...
node scripts/mcd.mjs tools | schema <工具名> | doc
```

<details>
<summary>一次真实调用长什么样</summary>

```bash
$ node scripts/mcd.mjs price --item "巨无霸:1" --item "薯条:1"
门店 麦当劳人民广场餐厅 · 到店自取

  商品                      数量  小计
  巨无霸                    ×1    ¥25.50
  中薯条                    ×1    ¥13.50

  商品金额  ¥39.00
  ────────────────────────────
  ▶ 实付    ¥39.00
  ────────────────────────────

  取餐方式：eat-in(堂食)  take-in-store(外带)
```

注意 `薯条` 自动匹配到了「中薯条」——名字不用写全，也能直接用商品编码。

</details>

### 为什么是 `k=v` 而不是 JSON

Windows 的 PowerShell 会把 `'{"a":1}'` 里的双引号**吃掉**，`JSON.parse` 直接报错。
这是本项目最早踩的坑，所以 `call` 改成 `k=v`，复杂入参用 `--file` / `--stdin`。

## 写入类工具默认拦一道

下单、取消、领券、抽奖、新建地址、积分兑换 —— 这些会**真的花钱或改账户**。
不带 `--confirm` 一律不发出（退出码 3），只把入参打出来让你核对。

```bash
$ node scripts/mcd.mjs order --item "巨无霸:1"
⛔ 这个工具会**真的改变账户/花钱**，已拦截，没有发出。
工具：create-order
入参：{ ... }
确认无误后加 --confirm 再跑一次。
```

## 给 AI 用：把 `SKILL.md` 交给它

`SKILL.md` 是写给人机共读的说明，`.dsh/skills`、Claude Code 的 skills、
Cursor rules 都能直接吃。核心三件事：

1. **先偏好、再时间、再门店、再菜单** —— 名字不是编码，编码当天有效；
2. **不可逆动作必须确认** —— 下单、扣积分、领券、抽奖、取消；
3. **支付永远由用户本人完成** —— 只把支付链接递过去。

## 原生 MCP 接入（可选）

```json
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}
```

| 客户端 | 位置 |
|---|---|
| Claude Code / Cherry Studio / Cursor / Trae / Kiro / VSCode | 各自的 MCP 配置面板，选 "Streamable HTTP" |
| DeepSeek Harness (DSH) | `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml` 加一条 `insert:` |
| OpenClaw | `openclaw mcp add`，或 `openclaw.json` 的 `mcp.servers` |

## 接聊天机器人（可选）

`references/bot-integration.md` 讲怎么把点餐挂到 QQ / Telegram / 微信机器人上：
机器人只负责查、算、下单，把**支付链接**发回来，人自己扫码付。
任何有 shell 权限的机器人都适用。

> 不接机器人也完全能用 —— 用户直接跟 AI 说话就行，见《使用指南》。

## 目录

```
docs/
  麦当劳AI点餐-使用指南.pdf     ← 给普通用户（6 页，不含命令行）
  麦当劳MCP-开发者手册.pdf      ← 给动手的人（15 页）
  user-guide.html / dev-manual.html   两份 PDF 的源文件
SKILL.md                 给 AI 的技能说明（先读这个）
scripts/mcp-client.mjs   MCP Streamable HTTP 客户端（可单独复用）
scripts/mcd.mjs          CLI
scripts/store.mjs        本地偏好与缓存
references/tools.md      36 个工具的真实入参 Schema（自动生成，别手改）
references/flows.md      点餐编排、金额单位、常见的坑
references/bot-integration.md  聊天机器人接入（可选）
```

## 安全

- 不收集、不上传任何东西。所有请求只发往 `mcp.mcd.cn`。
- 只用 MCP Token，不碰账号密码。
- 仓库里没有任何密钥。`login` 之后请确认 `git status` 是干净的。
- `.gitignore` 已经挡掉配置文件与常见凭据路径。

## 已知坑（都踩过）

| 坑 | 说明 |
|---|---|
| 金额单位不统一 | `calculate-price` 是**分**，其它工具是**元**，混用差 100 倍 |
| `beType` ≠ `orderType` | 前者是场景（1/2/5/6），后者只有 1 到店、2 外送 |
| 到店自取不传 `beCode` | 只有得来速 / 外送 / 团餐才传，最易记反 |
| 返回里混着说明文字 | 工具结果前后有一段给人看的 Markdown，直接 `JSON.parse` 会失败 |
| 有些工具返回 Markdown | `available-coupons`、`list-nutrition-foods` 本来就不是 JSON |
| 想换套餐里的小食 | 下单接口不支持 |
| 没有 GPS | 到店取餐必须给文字地址 |
| 早餐查不到 | 早餐只在早市有，午市菜单里本来就没有 |
| PowerShell 吃引号 | 用 `k=v`，别手写 JSON |

## License

代码 MIT。麦当劳、麦乐送、巨无霸等是麦当劳及其关联方的商标，
本项目与麦当劳中国无隶属或背书关系。详见 [NOTICE.md](NOTICE.md)。
