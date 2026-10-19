# 仓库侦察（@local/dsh-repo-scout）

一个 Host 插件（bundle），把「我需要一个能做 X 的开源项目，帮我弄下来」变成本地代码：**在 GitHub 检索 → 排序打分 → `git clone`**。

## 三个工具

### `github_account_status`

没有参数。返回当前 GitHub 访问状态：token 是否配置、来自哪里、什么类型、对应哪个账号、令牌权限、搜索额度剩余与重置时间。

刚配置或更换 token、搜索报 401/403/额度用尽、想确认能否访问私有仓库时，先调它。

### `search_github_repositories`

| 参数 | 默认 | 说明 |
|---|---|---|
| `query` | 必填 | 搜索关键词。GitHub 只做关键词匹配，不理解整句话，所以把需求提炼成 2–6 个词最有效 |
| `language` | 不限 | `TypeScript`、`Python`、`Rust`… |
| `minStars` | `0` | 最少 star 数，用来过滤玩具项目 |
| `sort` | `best-match` | `best-match` / `stars` / `forks` / `updated` |
| `limit` | `10` | 返回候选数，最大 30 |
| `includeArchived` / `includeForks` | `false` | 默认排除归档仓库与 fork |

返回每个候选的 `fullName`、`stars`、语言、最近更新、许可证、`score`，以及 `recommended`（建议先克隆的那个）。

打分不是照抄 GitHub 的相关度：以相关度顺序为基础，叠加 star 数的对数、最近更新时间、语言匹配、描述/主题中的关键词命中，并对归档项目、fork、无描述项目扣分。遇到限流（403/429）时，若重置窗口在 15 秒内会等过去再重试一次。

### `clone_github_repository`

| 参数 | 默认 | 说明 |
|---|---|---|
| `repository` | 必填 | `owner/repo`，或完整地址（`https://`、`git@github.com:`、`ssh://`） |
| `directory` | `<工作区>/repos` | 克隆到的父目录 |
| `name` | 仓库名 | 目标目录名 |
| `branch` | 默认分支 | 只克隆某个分支/标签 |
| `depth` | `1` | 浅克隆深度；`0` 表示完整历史 |
| `keepProxy` | `false` | 关掉「绕过失效代理重试」 |
| `mirror` | `auto` | `auto` / `none`（只直连）/ 以 `https://` 开头的镜像前缀（强制走该镜像） |

行为要点：

- 目标目录已是该仓库的检出 → 返回 `exists`，不重复克隆、不覆盖；
- 目标目录非空且不是该仓库 → 拒绝执行，避免覆盖已有数据；
- 克隆完成后只做只读检查（README、`package.json`、`requirements.txt` 等），
  **不安装依赖、不执行仓库里的任何代码**。

## 大仓库与镜像：一次真实的踩坑记录

这台机器上出现过「克隆卡死」：`bojieli/ai-agent-book`（GitHub 报告 777 MB、检出后 1.2 GB）用直连克隆，十分钟只下到 103 MB，然后**彻底停滞**——TCP 连接仍是 `Established`，但不再有任何数据。换后台任务重试，又停在 13 MiB。

三件事叠在一起：

1. **仓库太大** —— 浅克隆也要传两百多 MB；
2. **直连 GitHub 的链路基本不可用** —— 实测 80–170 KB/s，且会在十几到一百 MB 处停死；
3. **中止后留下孤儿进程** —— `execFile` 只 kill 直接子进程 `git.exe`，而 git 再 spawn 的
   `git-remote-https`、`index-pack` 继续活着，占着 `.git/objects/pack/tmp_pack_*` 与
   `shallow.lock`，导致目录删不掉、进程后台空转。

### 结论：走镜像，快 20 倍

同一个仓库，同一台机器：

| 通道 | 握手 | 实测速度 | 结果 |
|---|---|---|---|
| 直连 github.com | 2.0 s | 80–170 KB/s，随后停滞 | 失败（103 MB 处卡死） |
| `ghfast.top` | 1.8 s | 2.4–3.7 MB/s | 成功（约 3 分钟克隆完 1.2 GB） |
| `gh-proxy.com` | 3.3 s | 探测最快（412–516 ms） | 备用 |
| `ghproxy.net` | 6.3 s | 可用但握手慢 | 备用 |
| `ghproxy.cc` / `hub.gitmirror.com` / `gitclone.com` | — | 不可达 / 502 | 已排除 |

镜像就是 `https://<proxy>/https://github.com/owner/repo.git` 这样的前缀，走的仍是标准
git smart-HTTP 协议，克隆出的仓库和直连完全一样（克隆后把 `origin` 改回官方地址即可）。

### 插件怎么用它

`mirror: auto`（默认）时的通道计划：

1. 先查仓库在 GitHub 上的报告体积（`GET /repos/{owner}/{repo}` 的 `size`，单位 KiB）；
2. **≥ 120 MB** → 直接从镜像开始（`mirror → direct`）；
3. **< 120 MB** → 先直连，失败再退镜像（`direct → mirror`）；
4. 每个通道都带 **低速看门狗**：`-c http.lowSpeedLimit=20000 -c http.lowSpeedTime=40`。
   这让「连上了但没数据」在 40 秒后变成一次正常失败，从而触发镜像回退，而不是无限等下去；
5. 每次尝试失败都会清理半成品目录，再换下一条通道；
6. 取消（`abort`）时**立刻停止整个计划**，并用 `taskkill /T /F` 杀掉整棵 git 进程树。

注意镜像只对 `https://github.com/...` 生效；其他主机（GitLab、Bitbucket、自建）只直连。

想强制或禁用镜像：`mirror: https://ghfast.top` / `mirror: none`。

## 配置 token

两种方式，读优先级如下：

1. 环境变量 `GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_ACCESS_TOKEN`
2. Harness 主目录下的令牌文件：`$DSH_HOME/github-token`（其次 `github-token.txt`、`.github-token`）

推荐用令牌文件，因为它**改完立即生效，不需要重启**：

```powershell
notepad C:\Users\admin\.dsh\github-token   # 在注释下面加一行 ghp_xxx 即可
```

文件支持三种写法：裸令牌一行、`GITHUB_TOKEN=ghp_...`、或带 `#` 注释。只读 public 仓库的搜索用
「无 scope」即可；要克隆私有仓库再加仓库读取权限（classic：`repo`；fine-grained：Contents: Read）。

配置了 token 后，克隆失败于认证/私有仓库（`could not read Username`、`Authentication failed`、
`404`）时会带 token 重试一次。token 通过 git 的 `GIT_CONFIG_KEY_0=http.extraheader` 环境变量
传入——**不进命令行参数、不写进 `.git/config`**。

**不要**把 token 贴进对话：它会留在会话记录里。已经贴过的建议在 GitHub 上撤销并重新生成。

## 典型用法

```
用户：帮我找一个能做本地语音转文字的开源项目，用 Python，弄到本地
→ search_github_repositories(query: "speech to text asr", language: "Python", minStars: 500)
→ clone_github_repository(repository: "推荐候选的 fullName")
```

克隆完想顺手把环境配好，用环境医生插件的 `ensure_environment` 对着新目录跑一遍即可。

## 兜底排查

克隆失败时按这个顺序看：

1. `github_account_status` —— token 是否有效、额度是否用完；
2. 错误里是否含 `proxy` —— 本机 git 的 `http.<url>.proxy` 是否指向一个没启动的代理；
3. 错误里是否含 `low speed` / `early EOF` / 停滞 —— 链路问题，`mirror: auto` 应该已经自动回退，
   若仍失败可显式指定 `mirror: https://ghfast.top`；
4. 仓库很大（GitHub `size` > 100 MB）—— 优先镜像，必要时用后台任务跑，避免工具调用被中止。

## 安装与卸载

这是一个 DSH bundle 包，从 GitHub 安装（注意 `git+` 前缀；安装后重启一次 Harness 生效）：

```powershell
dsh plugin --profile desktop add git+https://github.com/wujiawei906/dsh-repo-scout
```

安装器用 `git ls-remote` / `git clone` 拉取仓库，所以这台设备要能访问 github.com。
如果本机 git 配了一条失效代理（`http.<url>.proxy` 指向没启动的本地端口），
`git ls-remote` 会直接失败；可临时用一份干净的 git 配置安装（只影响当前会话）：

```powershell
$clean = "$env:TEMP\gitconfig-clean"
Set-Content $clean "[user]`n`tname = you`n`temail = you@example.com"
$env:GIT_CONFIG_GLOBAL = $clean
dsh plugin --profile desktop add git+https://github.com/wujiawei906/dsh-repo-scout
```

开发时也可以用本地目录：`dsh plugin --profile desktop add C:\path\to\dsh-repo-scout`。

卸载：在 Web 侧边栏「插件」页把该 bundle 关掉/移除，或从 profile 的
`dsh.profile.bundles` 删掉 `@local/dsh-repo-scout`，再在 profile 目录执行
`pnpm remove @local/dsh-repo-scout`。

## 目录结构

```
index.js        三个工具的定义、输出 schema、报告渲染
lib/auth.js     token 发现（环境变量 / 令牌文件）与脱敏
lib/github.js   GitHub 搜索客户端、账号状态、仓库体积查询、限速处理
lib/rank.js     候选打分与推荐
lib/mirrors.js  镜像列表、可用性探测、大小阈值与镜像 URL 拼接
lib/clone.js    地址解析、目标检查、克隆通道计划、代理/认证/镜像/低速自愈
lib/exec.js     spawn 子进程执行（超时、取消、进程树清理、输出截断）
```
