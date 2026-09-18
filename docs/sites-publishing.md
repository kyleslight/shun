# Sites — 轻量预览与发布插件（设计）

把本地 Web 项目发布到一个真实 URL，并管理已经在线的东西。定位与 Browser Preview 同级：
**按需出现、只在用户明确授权后发布**，不做 CI/CD，不做生产托管平台。

静态产物是唯一输入：构建是项目自己的事（Agent 用 `bash`/`background_start` 跑项目原有 build），
Sites 只负责把构建输出目录变成一个可访问的 URL。

标注约定：

- **[V]** 本次已取得来源标注的事实（二手，见下"证据"）。
- **[I]** 本设计的推断，需实施时验证。
- **[?]** 未验证，实施时必须用真实账号做 API 探针确认。

## 证据基础

| 事实 | 来源标注 | 强度 |
| --- | --- | --- |
| Workers 免费版：100k 请求/天、10ms CPU/请求、128MB | `developers.cloudflare.com/workers/platform/limits/` | 二手，单一来源 |
| KV 免费额度：100k 读/天、1000 写/天（不同 key）、1GB/命名空间、单值上限 25MiB、key ≤512B、cacheTtl 最小 30s | `developers.cloudflare.com/kv/platform/limits/` | 二手 |
| "Free 计划包含 Workers KV" | `developers.cloudflare.com/workers/platform/pricing/` | 二手引用句；**免费计划可用绑定**是推断，非直接陈述 |
| Universal SSL 覆盖根域 + 一级子域，更深需 ACM/Total TLS | `developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/` | 唯一逐字引用段落 |
| 委派子域独立成 zone 后的证书覆盖 | 无 | 推断 |
| 通配路由/通配自定义域/DNS 自动创建/同 zone 子请求路由行为；Pages 上限；协议对非 HTML 内容的条款；R2 豁免 | 无 | 未验证，需实测 |

## 成本模型

在用户自己的 Cloudflare 账号里跑，增量成本目标为 0：

- 一条通配 DNS 记录 + 一张 Universal SSL 证书服务全部站点，**每个站点不新增 DNS 记录、不新增证书**。
- 网关 Worker：100k 请求/天免费额度内（一个静态站的浏览远低于此）。
- KV：1GB 存储 + 1000 写/天免费额度，够几十个小站与持续重发。
- 真正的免费额度约束（会打到用户，必须提前说清）：
  - 单文件 ≤ 25MiB **[V]**；
  - 首次发布超过约 800 个文件就可能撞上 1000 写/天 **[V]**；
  - 媒体重的站点（大量图片/视频）适合 R2，但 R2 需要开通计费 **[?]**，因此不进 MVP。

## 拓扑：一个只读网关 + KV，写入全在桌面端

```
用户浏览器 ──► *.base-zone 通配路由 ──► 网关 Worker（只读，无密钥）
                                          │ 读 KV
                                          ▼
                       KV: 主机名映射 / 站点元数据 / 资源字节

Shun 桌面端 ──► Cloudflare API（用户已有 token）──► 写 KV、建资源、清缓存
```

关键性质：**公开面 Worker 完全只读、不持有任何密钥**，发布/改权限/删除只能从装了 Shun 的机器上用
账号 token 发起。这消除了"公开 Worker 被当成上传口"的整类风险。

### 存储布局（KV 命名空间 `shun-sites`）

| Key | 内容 |
| --- | --- |
| `h:<host>` | `{slug, mode, salt, hash, revision, updatedAt}` — 主机名 → 站点 |
| `s:<slug>` | 站点记录：标题、文件数、字节数、mode、绑定主机名、时间戳、revision |
| `f:<slug>` | 清单 `{relpath: {sha256, size, type}}` — 增量发布与 ETag 的来源 |
| `a:<slug>/<relpath>` | 资源字节（单值 ≤25MiB **[V]**） |

### 网关请求路径

1. 取 `Host`（去端口、小写）→ 查站点记录：isolate 内存缓存 + KV（`cacheTtl` ≥ 30s **[V]**）。
2. 无记录 → 未托管主机策略（见"通配域不能遮蔽真实子域"）。
3. `mode`：`public` 直接服务；`off` 返回暂停页；`password` 校验 host-scoped cookie，失败则返回密码页并在 POST 后种 cookie。
4. 解析路径：精确命中 → `<path>/index.html` → `404.html` → 自带 404 页。
5. 响应头：按扩展名给 Content-Type、`ETag` 用清单里的 sha256、HTML `no-cache` + ETag、静态资源短 TTL；`X-Content-Type-Options: nosniff`；预览型 slug 带 `X-Robots-Tag: noindex`。

网关必须保持在 10ms CPU 以内 **[V]**：只做一次 KV 读 + 拼响应，不做 tar 解包、不做 HTML 变换。
重发后要立刻可见 → 复用已实现的 `cloudflare_cache_purge`（30 URL/次）清理变更 URL，而不是靠长 TTL 赌。

## 域名方案（需求 3）

站点 URL：`https://<slug>.<base-zone>/`。

**为什么必须是"平铺一级子域"**：Universal SSL 只覆盖根域 + 一级子域，`aaa.sites.example.com`
属于更深层级，需要 Advanced Certificate Manager（约 $10/月）**[V]**。所以 `aaa.shunagent.com` 这种
平铺形式不是将就，而是免费方案下唯一正确的形状。

两种落地：

- **A（零配置）**：base-zone = 用户已连接的 zone，站点即 `aaa.example.com`。
- **B（推荐，隔离更好）**：在父 zone 里把 `sites.example.com` 委派成独立 zone（免费，一条 NS 委派），
  它自己的 Universal SSL 覆盖 `*.sites.example.com`，于是 `aaa.sites.example.com` 合法且与用户主域
  完全隔离：不遮蔽真实子域、不共享父域 cookie 作用域。委派子域能否正常签发 Universal SSL 属推断 **[I]**，实施时验证；A 永远作为兜底。

**域名与地址都由程序决定，用户不选**：
- 发布域是产品常量（`shunagent.site`，`SHUN_SITES_DOMAIN` 仅供自部署覆盖），zone 由它反查；面板不出现 zone/账号/命名空间等标识。
- 地址自动分配：优先沿用本项目已有地址（按项目身份匹配，重复发布不会新建站点）；否则取**项目根目录名** kebab 化；撞上保留字、其它项目已占、或 zone 内已有同名 DNS 记录时，自动递增 `-2`、`-3`… 直到可用，并把"哪个名字被占用、实际用了哪个地址"写进结果。
- 一个地址属于一个项目：另一个项目要顶掉它必须显式 `take_over`（且只有在用户明确要求时才用）。

## 通配域不能遮蔽真实子域

通配路由覆盖整个 zone，网关照不到的主机名默认不能变成 404。两条措施，按可用性择优 **[?]**：

1. 若"Worker 对同 zone 的 `fetch(request)` 不会重新进入路由"被证实，则无记录主机名**透传回源**。
2. 若不成立，则 setup 阶段把该 zone 内已有代理记录列给用户确认，未确认则不挂通配路由，改写为
   B 方案（委派子域，天然无遮蔽）。

## 开通（幂等，显式用户动作）

1. 复用**已有** Cloudflare 连接（`cloudflare-rest` 的 token），不另要一个 token。
2. 列出可选 zone 交用户在面板里选（动态列表只能来自 host，不能来自 manifest 的静态选项）。
3. 检查 token scope（Zone:Read / Workers Scripts:Edit / Workers KV Storage:Edit / Workers Routes:Edit /
   需要时 DNS:Edit），缺哪条就点明哪条，而不是报一个模糊失败。
4. 建 KV 命名空间 `shun-sites`（已存在则复用）。
5. 上传网关脚本 `shun-sites-gateway`（带 KV 绑定，脚本版本号随插件版本走，升级是显式动作）。
6. 挂 `*.<base>/*`：候选机制 (a) Workers custom domain `*.base`（疑似自动建 DNS）与 (b) zone route + 代理通配 DNS 记录 **[?]**；两者封装在一个内部函数后面，用探针选。
7. **健康检查**：发布一条检查记录并真实 GET 一次，通过后才允许说"发布已就绪"。没有真实探针就不宣称连接成功。

## 发布流程（需求 2）

工具：`sites_publish{ path?, slug?, mode?, title? }`

- `path` 省略时，host 按固定候选列表（`dist`/`build`/`out`/`public`/`_site`/`.output/public`）+ `package.json`
  的提示返回候选，由 Agent/用户选择——**不解析提示词来猜模式**，这是文件系统事实 + 显式选择。
- 流水线：workspace 内 realpath 校验 → 枚举（跳过符号链接、`node_modules`、`.DS_Store`）→ 上限检查
  （>5000 文件 / 单文件 >25MiB / 总量 >200MB 给可读原因并拒绝）→ 根目录需有 `index.html`（或 `index.htm`/`404.html`）
  → 逐文件 sha256 → 与 `f:<slug>` 做差异，**只上传变化的 key**，删除已移除的 key → 写 `f:`/`s:`/`h:` →
  批量清缓存 → GET 一次校验线上状态 → 报告 URL。
- **幂等**：同一目录重发 = 零上传。
- **发布前报告**：若目录里出现 `.env`、`*.pem`、`credentials.json`、`.git/` 等看起来像凭据的文件，先列出
  "这些会公开"让用户确认。这是数据卫生提示，**不是授权判断**——授权只看工具身份与显式用户动作，绝不按路径/命令关键字放行或拦截。

## 工具与呈现

| 工具 | 语义 | 授权 |
| --- | --- | --- |
| `sites_setup` | 幂等开通 | 仅用户明确要求 |
| `sites_publish` | 发布/重发目录 | 仅用户明确要求 |
| `sites_list` | 列出已发布站点与 URL | 只读 |
| `sites_access` | `public` / `password` / `off` | 仅用户明确要求 |
| `sites_delete` | 下线并删除 KV | 仅用户明确要求 |

按 `pluginIds.has('sites')` 延迟注册（同 `cloudflare_*` 的做法），并在 `src/tool-presentation.ts` 加
`sites_*` 适配器（kind `sites`，detail 显示 `slug → URL`），不允许回退到"大写原始工具名 + 占位符"。
配套 bundled Skill `sites-publishing` 写清：只在明确要求时发布；发布后必须验证线上状态再报告；
不得静默重发；URL 一旦在线即视为公开。预览实时页面不新增工具——用现有 Browser Preview（`browser_debug` 传外部 URL）。

## 插件包（内置 tier ①）

```
resources/plugins/sites/
  manifest.json
  assets/icon.svg
  ui/{index.html,app.js,styles.css}
  skills/sites-publishing/SKILL.md
```

- `distribution: "required"`（内置根专属，安装包不写）、`runtime.workspace: "optional"`、
  `rail: "transient"`、`launch: ["user","assistant","tool-result","conversation-action"]`。
- 权限只声明 `workspace.read`（面板里预览"将要发布哪些文件"）；**不要 `workspace.process`**：
  沙箱 iframe 本来就无外部网络、无文件系统，全部 Cloudflare I/O 在 host 侧完成。
  这既避免高信任授权，也让插件包保持 3 个文件 + 1 个 Skill 的体量。
- host RPC（沿用 `terminal.*`/`browser.*` 的 `authenticateView`/`authorizeView` 模式）：
  `sites.status`、`sites.list`、`sites.publish`、`sites.setAccess`、`sites.delete`、`sites.open`
  （由 host 在 Browser Preview 里打开线上 URL；iframe 自己开不了外部页面）。
  变更类方法只在面板里的显式点击或对话里的明确要求下执行。
- 面板布局遵守契约：不画第二套品牌头；首屏即站点列表（名字、URL、可见性、最近发布、打开/复制/删除）；
  有 workspace 时才出现"发布本项目"主操作；密码/slug 等进渐进披露；未开通时给一个紧凑开通态（选 zone → 开通）；
  刷新失败保留旧数据并用平实语言说明。

### 何时出现（需求 5）

四条入口，全部需要用户或 Agent 的显式请求，**没有常驻活动栏项**：

1. 用户在插件面板/活动栏主动打开；
2. 发布成功后由 Skill 调 `plugin_view_present` 呈现面板（展示线上 URL）；
3. `tool-result` 卡片：`sites_publish` 完成后留一张紧凑卡片（`disposition: 'suggest'`，不抢屏）。

不做的：composer 级对话动作。`placement: "composer"` 是常驻在输入框上方的按钮，等于把插件永久挂在对话框里——这正是"只在必要时出现"要排除的形态。

不做的：按文件变化自动弹面板（`activation.fileChanges: **/*.html` 会把每次编辑都变成打扰）。

## 失败与边界状态

未连接 Cloudflare / 无可用 zone / token 缺 scope（点名缺哪条）/ KV 日写额度用尽（说明今天已用尽与明天重置）/
slug 与既有 DNS 记录冲突 / 站点被暂停 / 刷新失败但旧数据仍可用。每一种都用人话说明，不用一个模糊的状态词。

## 安全与隐私

- **离开本机的东西**：只有用户显式发布的那批文件，发布前有报告，其余一律不外发。
- **存哪**：站点内容与元数据在用户自己的 Cloudflare 账号 KV 里；host 设置里只存 zone/命名空间/网关标识，不存密钥。
- **密码模式的真实强度**：它是"挡开路过的人"，不是加密，也不是高价值内容的访问控制；更高要求应走 Cloudflare Access 或私有 zone。这一点必须在 UI 里说实话。
- **共享父域 cookie 风险**：同 zone 下兄弟站点理论上可以设置 `Domain=.zone` 的 cookie。因此认证 cookie 必须 host-scoped 且 HMAC 里绑定 slug；从根本上规避这一点用 B 方案（委派子域）。
- **预览默认 noindex**，避免半成品被搜索引擎收录。

## 分期

| 阶段 | 范围 |
| --- | --- |
| P1 | 开通 + 发布/重发 + 列表 + 三种可见性 + 删除 + 线上验证；A 方案平铺 slug；KV 存资源；transient 面板；bundled Skill |
| P2 | 增量与清缓存打磨、随机预览 slug、`_redirects`/`_headers`、同网关自定义域、委派子域开通助手、R2 后端（媒体重站点，需计费） |
| P3 | Shun 自持共享域（会成为托管方：配额、滥用、协议、隐私都要先做，且与"用自己的账号"是不同产品决策） |

## 实施时必须先跑通的探针

1. 通配路由 vs 通配自定义域：`PUT /accounts/{id}/workers/domains` 是否接受 `*.base`、是否自动建 DNS 记录 **[?]**；否则用 zone route + 代理通配记录。
2. Worker 对同 zone 的 `fetch(request)` 是否重新进入路由（决定"无记录主机名透传回源"是否可用）**[?]**。
3. KV 批量写是否按 key 计入 1000 写/天（决定超过约 800 文件时必须提前警告）**[?]**。
4. 委派子域能否签发覆盖 `*.sites.example.com` 的 Universal SSL **[I]**。
5. 若保留 Pages 作为备选：通配自定义域支持与项目/文件上限 **[?]**；以及协议对"非 HTML 内容占比"的限制是否约束 Workers 静态站 **[?]**（R2 是否豁免同样待查）。

## 实现状态

已落地（`pnpm test` 703 项通过、`tsc --noEmit` 干净）：

| 位置 | 内容 |
| --- | --- |
| `resources/plugins/sites/` | 内置插件包：`manifest.json`（tier ①，`rail: transient`，无 worker、无 `workspace.process`）、图标、`ui/`（管理面板）、`skills/sites-publishing/SKILL.md` |
| `resources/plugins/sites/gateway/worker.mjs` | 只读网关：主机名映射、三种可见性、密码页与 cookie、目录索引/404、ETag 与 304。由 `site-publishing.ts` 在上传时原样送入 Cloudflare，不经打包 |
| [site-publishing.ts](src/main/site-publishing.ts) | 开通、发布（增量）、可见性、删除、线上校验、zone/冲突检查 |
| [cloudflare-rest.ts](src/main/cloudflare-rest.ts) | 抽出 `CloudflareApi`（token + 传输 + 错误形状），插件工具面与 Sites 共用同一份凭证 |
| `src/main/index.ts` | `sites_*` 工具（随插件启停延迟注册）、面板 RPC（`sites.status/zones/setup/publish/setAccess/delete/open`） |

一处对原设计的修正：证书层级判断不是"域名比 zone 深两层"，而是 **`baseDomain !== zoneName` 就告警**——站点永远在 `baseDomain` 下一层，只有 base 就是 zone 本身时才落在一级子域内。

测试覆盖：[site-publishing.test.ts](src/main/site-publishing.test.ts)（开通、绑定回退、增量发布、拒绝条件、密码哈希、删除），[sites-plugin.test.ts](src/main/sites-plugin.test.ts)（包契约 + 网关的 404/资源/304/穿越拒绝/暂停/密码门禁）。

尚未验证，需一次真实运行：面板在已安装状态下的渲染（内置包只在应用启动时扫描，且默认安装迁移在下次启动生效），以及一次真实发布。

## 需要你定的四个选择

1. **A 还是 B**：用户主域平铺（零配置、会遮蔽真实子域），还是委派子域做命名空间（多一步，隔离干净）？
2. **token**：沿用现有 Cloudflare 连接（缺 scope 时引导补齐），还是让 Sites 单独用一个更小权限的 token？
3. **随机预览 slug 是否进 P1**：它是"临时预览"体验的关键，但会扩大 slug 命名空间设计。
4. **媒体的位置**：P1 就接受 25MiB 单文件上限并把大媒体指到 R2/外链，还是 P1 后再谈 R2？
