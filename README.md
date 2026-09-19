# 中北大学信息汇总 · Better News

把分散在中北大学各部门官网上、必须挨个点开才能看的通知公告，汇总到一个页面里，按栏目分栏，并对新消息和截止时间做提醒。支持部署成网页（手机可加到主屏幕当 App 用）。

**线上地址：<https://ysppwn721.github.io/better-news/>** （手机用浏览器打开后「添加到主屏幕」即可当 App 用）

> **它解决什么问题**：学校的党务通知、学生工作部通知、选课通知、研究生院通知分别挂在不同的网站上，没有统一入口。漏看一条选课或评奖通知，后续计划就会受影响。这个工具把这些页面定时抓下来，去重、归类、加标签，让你在一个页面里看完。

---

## 当前部署形态

```
GitHub Actions（每天 6 次定时抓取）
        │  抓取 → 导出静态 JSON 快照 → 提交到仓库
        ▼
GitHub Pages（托管 public/ 目录）──► 手机 / 电脑浏览器
```

| 组件 | 位置 | 说明 |
|---|---|---|
| 前端 + 数据快照 | GitHub Pages | 纯静态，无需服务器，HTTPS 自动签发 |
| 定时抓取 | GitHub Actions `fetch.yml` | 每天 6 次，结果自动提交并触发重新发布 |
| 发布站点 | GitHub Actions `pages.yml` | `main` 有推送即重新发布 |
| 后台推送 | Cloudflare Worker（可选） | 见「开启手机后台推送」 |

---

## 两种使用方式

### 方式一：直接用线上站点（推荐）

打开 <https://ysppwn721.github.io/better-news/>，手机「添加到主屏幕」。
数据由 GitHub Actions 自动更新，不需要你保持任何东西运行。

### 方式二：本地运行（可手动抓取、改代码调试）

```bash
npm install
npm run fetch      # 抓取校级信源（首次约 1 分钟）
npm start          # 打开 http://127.0.0.1:5178
```

想要学院通知（含计算机科学与技术学院）：

```bash
npm run discover   # 自动发现 21 个学院的通知栏目（约 3 分钟）
npm run fetch:all  # 抓取校级 + 学院
```


---

## 功能

### 分栏汇总
按**发布主体**分栏，因为学生的真实心智是"这是哪个部门发的"：

| 栏目 | 来源 |
|---|---|
| ★ 计算机科学与技术学院 | 本人所在学院（默认置顶） |
| 党务工作 | 主站通知公告、教务部党建、研究生院党建、各学院党群工作栏 |
| 学生工作 | 学生工作部通知、学生奖助、思政教育 |
| 教务选课 | 教务部通知（选课、考试、学籍、培养） |
| 研究生 | 研究生院通知（招生、培养、学位） |
| 团学活动 | 校团委重要通知、团情快讯 |
| 学校主页 | 学校层面通知公告 |
| 学院通知 | 21 个二级学院的通知栏目（自动发现） |

> 党务类信息没有独立网站——党委通知散落在主站、教务部、研究生院和各学院的党建栏里。
> 本工具用关键词规则把它们**跨站聚合**到「党务工作」一栏，这是分栏能成立的关键。

### 标签与面向对象
每条通知自动打标签（选课 / 考试 / 评奖评优 / 资助补助 / 党务工作 / 团学组织 / 学籍学位 / 竞赛创新 / 就业实习 …），
并识别面向对象（研究生 / 本科毕业班 / 新生 / 党员 / 团员 / 家庭经济困难学生 / 教职工），
便于快速判断"这条跟我有没有关系"。侧栏可按标签一键筛选。

### 提醒
- **后台推送**（需部署推送服务，见下）：即使关掉网页，有新通知也会推送到手机。
  可按栏目订阅，也可只收「重要」通知。
- **新通知提醒**：浏览器桌面通知（点「🔔 提醒」授权一次），页面打开时生效。
- **截止时间提醒**：自动从正文识别「截止/截至 …」的日期，卡片直接显示「⏰ 2026-09-30 剩 3 天」，顶部「⏰」面板按紧迫度汇总。
- **重要标记**：标题含「紧急 / 务必 / 截止 / 名单公示 / 停课」等关键词的自动标红角标。
- 提醒间隔、参与提醒的栏目、是否只提醒重要项，均可设置。

### 手机使用
页面是 **PWA**（渐进式 Web 应用），无需安装 APK：

- iPhone Safari：分享 → **添加到主屏幕**（iOS 16.4+ 才能订阅后台推送）
- Android Chrome：菜单 → **添加到主屏幕 / 安装应用**

添加后从主屏幕图标打开即为全屏 App 样式（无浏览器地址栏），底部有「全部 / 栏目 / 搜索 / 截止」导航，支持离线打开（已抓取的数据会缓存在本地）。

> **为什么不是原生 App**：PWA 能做到添加到主屏幕、全屏运行、离线可用、接收系统级推送，
> 而无需应用商店审核、签名与分发。对这个场景（个人查看通知）原生 App 只增加维护成本，不增加能力。

### 其他
- 全文搜索（标题 + 正文摘要）、已读/未读、收藏、按栏目一键已读
- 详情页内直接读正文，附件链接可点，一键跳官网原文
- 已读与收藏记录存在本机浏览器，不上传

---

## 部署到线上

### 方案 A：GitHub Pages（当前使用，无需额外账号）

仓库已配置好，推送到 `main` 即自动发布：

- `.github/workflows/pages.yml` —— 把 `public/` 发布到 Pages
- `.github/workflows/fetch.yml` —— 定时抓取并提交快照，提交后触发上面的发布

首次启用 Pages（仓库 Settings → Pages → Source 选 **GitHub Actions**，或执行）：

```bash
node scripts/enable-pages.mjs <你的用户名>/better-news
```

> 注意：免费账号的 GitHub Pages 要求仓库为**公开**。本站内容全部来自学校官网公开通知，
> 公开无妨；若想私有，请改用方案 B。

绑定自有域名：Settings → Pages → Custom domain，填你的域名并在 DNS 添加 CNAME。

### 方案 B：Cloudflare Pages（国内访问更快，需 Cloudflare 账号）

```bash
node scripts/check-ready.mjs     # 先看缺什么
node scripts/deploy-cloud.mjs    # 一键部署（幂等，可重复执行）
```

或在 Cloudflare 控制台 **Workers & Pages → Create → Pages → Connect to Git**：

| 配置项 | 值 |
|---|---|
| Framework preset | None |
| Build command | （留空） |
| Build output directory | `public` |

两种方案可同时存在，互不影响。


---

## 开启手机后台推送（关掉网页也能收到提醒）

前面说过：网页端的通知只在页面打开时生效。要做到**关掉网页也能收到提醒**，
需要一个服务端在后台主动推送——本项目用 Cloudflare Worker 承担这个角色。

```
GitHub Actions 定时抓取 → 发布数据快照 → Cloudflare Worker 每 15 分钟检查快照
                                              │  发现新通知
                                              ▼
                                    Web Push 推送到你的手机
```

### 1. 生成 VAPID 密钥

```bash
node scripts/gen-vapid.mjs
```

记下输出的公钥与私钥（私钥不要提交到仓库、不要外泄）。

### 2. 部署 Worker

```bash
cd worker
npm install

# 创建 KV 存储，把返回的 id 填到 wrangler.toml 的 [[kv_namespaces]] 里
npx wrangler kv namespace create PUSH_KV

# 写入密钥
npx wrangler secret put VAPID_PUBLIC_KEY     # 粘贴公钥
npx wrangler secret put VAPID_PRIVATE_KEY    # 粘贴私钥
npx wrangler secret put VAPID_SUBJECT        # 填 mailto:你的邮箱

# 把 wrangler.toml 里的 SITE_URL 改成你的 Pages 域名，然后部署
npx wrangler deploy
```

部署后会得到一个形如 `https://better-news-push.<你的子域>.workers.dev` 的地址。

### 3. 让前端知道推送服务地址

重新导出快照时带上 Worker 地址：

```bash
# Linux / macOS
BN_PUSH_WORKER="https://better-news-push.xxx.workers.dev" npm run export

# Windows PowerShell
$env:BN_PUSH_WORKER="https://better-news-push.xxx.workers.dev"; npm run export
```

也可以直接在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables**
添加 `BN_PUSH_WORKER`，并在 `fetch.yml` 的导出步骤里传入：

```yaml
      - name: 导出静态数据快照
        env:
          BN_PUSH_WORKER: ${{ vars.BN_PUSH_WORKER }}
        run: npm run export
```

### 4. 在手机上订阅

用手机打开站点 → **添加到主屏幕** → 从主屏幕图标进入 → **⚙ 设置 → 后台推送 → 开启**。
iOS 需要 **16.4 及以上**，且**必须先添加到主屏幕**（Safari 限制，普通标签页里无法订阅推送）。

### 5. 验证

```bash
curl https://better-news-push.xxx.workers.dev/status    # 查看订阅数
curl -X POST https://better-news-push.xxx.workers.dev/test  # 发一条测试推送
```

---

## 命令

```bash
npm start                        # 启动网页服务（默认 127.0.0.1:5178）
npm run fetch                    # 抓取校级信源
npm run fetch:all                # 抓取校级 + 学院
npm run discover                 # 自动发现学院通知栏目
npm run export                   # 导出静态快照（public/data/）
npm run build:web                # 导出快照 + 生成图标
npm run icons                    # 仅生成 PWA 图标
npm run sources                  # 查看各信源抓取状态
npm run list                     # 命令行查看条目
npm run selftest                 # 自检：解析器单测 + 数据完整性 + 联网抓取（43 项）
npm run health                   # 数据体检

node bin/bn.mjs fetch jwc-tzgg --pages=3 --enrich=30 --concurrency=4
node bin/bn.mjs serve --port=8080
```

`bin/bn.mjs` 参数：`--pages=N` 翻页数、`--enrich=N` 每次抓详情条数、`--concurrency=N` 并发、`--colleges` 含学院、`--db=路径`。

维护脚本：

```bash
npm run retag -- --dry            # 关键词规则改动后本地重算标签（无需重爬）
npm run fix-dates                 # 用列表页权威日期修正库中日期
npm run repair-titles             # 修复被错误页污染的标题
npm run verify-columns            # 校验各学院栏目是否仍可用
```

---

## 工作原理

```
各站点列表页 ──► 通用 CMS 适配器 ──► 增量筛选 ──► 详情并发抓取 ──► 关键词打标 ──► SQLite
                                                                                    │
                                                          静态导出（JSON 快照）◄────┘
                                                                    │
                                                      Cloudflare Pages ──► 手机 / 浏览器
```

**一个适配器覆盖全校站点**。中北大学所有部门站、学院站都基于同一套 Visual SiteBuilder (VSB9) CMS，
因此列表页与详情页的解析只需一份代码（`src/sources/cms.mjs`）。各站差异由多策略链兜住：

| 差异点 | 各站实际形态 |
|---|---|
| 标题容器 | `.article-tt`（教务）/ `h1.c-title`（学工部）/ `h3.title`（主站）/ `meta[pageTitle]` |
| 日期标签 | 「发布时间：」/「发布日期：」/ 无标签 |
| 日期格式 | `2026年09月18日` / `2026-09-16` / `09-182026`（学工部）/ `Sep 15 2026`（环境学院）/ 拆成 `<h3>18</h3><span>/ 2026-09</span>`（主站） |
| 详情链接 | `/info/{栏}/{文}.htm` 与旧式 `/article.jsp?...wbnewsid=N` |
| 编码 | 多为 UTF-8，主站部分页面 GBK |

**栏目自动发现**（`src/sources/discover.mjs`）：23 个学院的栏目路径各不相同，硬编码必然腐坏。
改为扫描学院首页 → 按栏目名语义打分 → **实际抓取候选页验证** → 按「名称先验 + 内容可行动性 + 更新时间新鲜度」综合排序。
站点改版后重跑 `npm run discover` 即可，不需要改代码。

**去重与增量**：条目以 URL 为唯一键。已入库条目跳过详情请求（只对最近 3 条复查，应对"先发后改"的补充通知）。
实测 11 个校级信源约 45 秒，38 个信源约 95 秒。

**快照体积**：`items.json` 约 550 KB（全部条目清单，供本地筛选与搜索）；
单条详情 4 KB 左右，进入详情页时才按需加载；服务端已剥离 Word 内联样式（实测单条最大从 2 MB 降到 252 KB）。

---

## 已知限制

- **浏览器通知需要页面处于打开状态**。这是浏览器对网页的限制，不是本项目的取舍；
  想要"关掉网页也能收到推送"需要 Web Push + 推送服务端（当前未实现）。
  作为替代，可以每天打开一次页面，或依赖「截止时间」面板集中处理。
- **部分栏目需校园网访问**。少数学院把内部公示放在受限栏目，校外抓取会返回"您无权访问此页面"。
  这类条目会保留标题与日期、标注「需校内网」角标，正文为空并提示跳转原文。
- **学院官网更新滞后**。不少学院官网的信息发布已转移到微信群/线下，官网只留部分内容
  （实测材料、创新创业等学院官网最新内容停留在 2026 年上半年）。工具只能汇总官网公开内容。
- **仅覆盖公开通知**，不含教务系统内的个人课表、成绩、选课结果等登录后数据。
- 截止时间靠正文关键词识别，不保证覆盖所有隐式时间要求（如"开学后两周内"）。
- 抓取默认 30 分钟一次，请勿改得过密，避免给学校站点造成压力。
- 抓取遵循普通浏览器访问方式，仅供个人学习与信息汇总使用；请勿用于商业用途或高频刷取。

---

## 目录结构

```
bin/bn.mjs                  命令行入口
src/core/http.mjs           抓取客户端（编码自适应、超时、退避重试、限速）
src/core/html.mjs           轻量 HTML 解析（零依赖：实体解码、文本抽取、标签配平）
src/core/keywords.mjs       关键词规则（标签、面向对象、重要性、摘要）
src/core/deadline.mjs       截止时间识别（服务端与导出器共用）
src/core/fetcher.mjs        抓取编排（列表 → 增量筛选 → 详情并发 → 打标 → 入库）
src/core/sources.mjs        信源装配（内置 + 学院发现结果）
src/sources/cms.mjs         通用 CMS 适配器（列表解析 + 详情解析 + 受限页识别）
src/sources/discover.mjs    栏目自动发现与排序
src/sources/registry.mjs    栏目定义、21 个学院域名、内置信源
src/store/db.mjs            SQLite 存储（Node 内置 node:sqlite，零原生依赖）
src/api/server.mjs          REST API + 静态服务 + 定时任务（本地模式）
public/index.html           前端页面
public/app.js               前端逻辑（客户端筛选、渲染、提醒）
public/store.js             数据层（Node API / 静态快照双模式）
public/sw.js                Service Worker（离线可用）
public/data/                静态快照（由 npm run export 生成）
scripts/export-static.mjs   静态导出
scripts/selftest.mjs        自检（43 项）
.github/workflows/          定时抓取 + 部署
```

## REST API（本地模式）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/meta` | 全局统计、设置、运行状态 |
| GET | `/api/categories` | 各栏目条目数与未读数 |
| GET | `/api/items` | 条目列表（`category/source/q/tag/limit/offset/sinceId/sort`） |
| GET | `/api/items/:id` | 条目详情（含正文与附件） |
| PATCH | `/api/items/:id` | 标记已读 / 收藏 |
| POST | `/api/items/read-all` | 按栏目全部已读 |
| GET | `/api/sources` | 信源状态 |
| POST | `/api/fetch` | 触发抓取（异步，`GET /api/status` 查进度） |
| GET | `/api/notifications?since=N` | 新条目（前端轮询做提醒） |
| GET | `/api/deadlines?days=30` | 即将截止事项 |
| GET/PUT | `/api/settings` | 读取 / 修改设置 |
| POST | `/api/retag` | 重算全部标签 |

静态模式的对应数据在 `public/data/`：`index.json`（统计/信源/截止）、`items.json`（条目清单）、`detail/{id}.json`（正文）。

---

## 环境要求

Node.js ≥ 22.5（数据库用内置 `node:sqlite`，无需编译原生模块）。
运行依赖仅 `express` 与 `node-cron`，前端无构建步骤。
