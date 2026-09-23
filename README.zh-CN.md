<div align="center">

# Agent Anywhere

**让你的编码智能体进驻每一个聊天软件。**

[![CI](https://github.com/noir017/agent-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/noir017/agent-anywhere/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-anywhere-cli)](https://www.npmjs.com/package/agent-anywhere-cli)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) | 简体中文

</div>

一个网关守护进程，将聊天平台接入你的编码智能体——支持
[Agent Client Protocol](https://agentclientprotocol.com) 的 Claude
Code、Codex、OpenCode，以及 Google 的 Antigravity CLI。给机器人发消息，
智能体在你自己的机器上运行，回答以流式写入同一条消息、原地编辑。

```text
 Discord ───┐
 Telegram ──┤     ┌──────────────────────┐
 Slack ─────┤     │        daemon        │       ┌─► claude
 Lark ──────┤     │  routing · sessions  │◄─────►├─► codex
 QQ ────────┼────►│  streaming · access  │       ├─► opencode
 LINE ──────┤     └──────────▲───────────┘       ├─► agy
 WeCom ─────┤                │ unix socket       └─► custom
 DingTalk ──┤                └─ agent-anywhere CLI (send-file / ask / react …)
 网页端 ────┘  （守护进程自带的浏览器页面——不用注册机器人，也不用账号）
```

## 特性

- **八个平台，一个进程** —— Discord、Telegram、Slack、飞书、QQ、LINE、企业微信、钉钉；支持多账号。
- **也可以一个平台都不用** —— 内置网页端：守护进程自己起的一个朴素深色聊天页，用一个共享密钥登录。不用建机器人，不用申请任何东西。
- **任意 ACP 智能体，外加 agy** —— 内置 Claude Code、Codex、OpenCode 与 Antigravity（`agy`）预设，另有 `custom`；按平台、频道、用户或斜杠命令路由。
- **原生流式体验** —— 消息原地编辑、工具调用气泡、生命周期回应表情、新消息打断。
- **在聊天中行动** —— 智能体可发文件、加回应、引用回复、开子区、读历史、发按钮提问。
- **附件处理** —— 收到的图片和文件自动下载并交给智能体。
- **话题是一等公民** —— Telegram 话题、飞书话题、Slack 线程、Discord 子区各自是独立会话，各自绑定智能体；绑定粘在会话上，用 `/oc` 切换。
- **持久会话** —— 重启不丢上下文；`/new` 重置，`/stop` 打断当前轮，`/kill` 结束卡住的智能体进程；作用域可按子区、频道、用户或全局。闲置会话会释放智能体进程，下一条消息再从原处恢复。
- **精简配置** —— 五个部分，凭据按平台校验，支持 `${VAR}` 与 `.env` 展开；值得在聊天里改的那几项用 `/setting` 直接改。

## 快速开始

```bash
npm install -g agent-anywhere-cli

agent-anywhere setup    # 向导：选平台、填凭据、选智能体
agent-anywhere doctor   # 自检
agent-anywhere start    # 给机器人发消息即可
```

`harness: claude` 复用本机的 `claude /login` 登录态——个人使用无需 API key。

<details>
<summary><strong>或者让你的智能体代劳</strong></summary>

把下面这段粘贴给 Claude Code（或任何编码智能体）：

```text
Set up https://github.com/noir017/agent-anywhere for me: install the CLI
(npm i -g agent-anywhere-cli) and its skill (npx skills add
https://github.com/noir017/agent-anywhere/tree/main/skill -g), then follow
the skill to configure and start it.
```

</details>

## 配置

`~/.config/agent-anywhere/config.yaml`，或用 `--config <path>` 指定：

```yaml
version: 1

platforms:                    # 命名实例；键即实例 id
  discord-main:
    type: discord             # discord|telegram|slack|lark|qq|line|wecom|dingtalk|webui
    token: ${DISCORD_TOKEN}   # 所有字符串支持 ${VAR}
    chat:
      requireMention: true    # 群聊需 @ 机器人
  telegram-bot:               # 同类型出现两次 = 多账号
    type: telegram
    token: ${TELEGRAM_TOKEN}

agents:                       # 至少一个；路由按 id 选取
  - id: claude
    harness: claude           # claude|codex|opencode|agy|custom
    cwd: ~/projects/main
  - id: codex
    harness: codex

routing:
  default: claude
  pipeline:                   # 有序；首个匹配生效
    - when: { platform: telegram-bot }
      use: { agent: codex }
    - when: { command: codex } # "/codex fix the tests" → codex 智能体
      use: { agent: codex }

session:
  scope: per_thread           # per_thread|per_channel|per_user|shared
  idleTimeoutMs: 3600000      # 闲置 1 小时后停掉该会话的智能体进程；0 = 从不

access:
  allowFrom: ["discord-main:123456"]   # <实例id>:userId；留空 = 任何人
```

`${VAR}` 从环境变量及 `<配置目录>/.env` 展开，YAML 本身可以提交进仓库。

> [!WARNING]
> 智能体拥有完整工具权限。`access.allowFrom` 留空意味着任何能给机器人发消息的人
> 都能在你的机器上执行命令——共享部署务必填写白名单。

## 智能体

| Harness | 启动方式 | 额外安装 | 认证 |
|---|---|---|---|
| `claude` | 内置 [claude-agent-acp](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) | 无 | `claude /login` 或 `ANTHROPIC_API_KEY` |
| `codex` | `codex-acp` | [@agentclientprotocol/codex-acp](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)（`npm i -g`） | Codex CLI 登录态 |
| `opencode` | `opencode acp` | OpenCode CLI | OpenCode 登录态 |
| `agy` | `agy --input-format stream-json` | Antigravity CLI | `agy` 的 Google 登录态（系统钥匙串） |
| `custom` | 你的 `command` + `args` | 任意 ACP 可执行文件 | 由智能体自身决定 |

每个智能体可设 `cwd`、`env`、`args` 及尽力传递的 `model`。支持会话恢复
的智能体，上下文可跨重启保留；智能体自己声明的斜杠命令不会全局注册，而是通过
它的 `/<agent>` 菜单调出（见[聊天命令](#聊天命令)）。
`doctor` 会逐一校验已配置的 harness。

### Antigravity（`agy`）

`agy` 是唯一不说 ACP 的预设——它根本没有 ACP 模式——因此改用它自带的
[headless stream-json 协议](https://antigravity.google/docs/cli/headless/)驱动。
流式输出、工具气泡、多轮上下文、重启续接、skills、`/model`、`/context`、`/usage`
都与 ACP 预设一致；不同的是后三者从哪里取——agy 把它们各自发布在会话之外：

- **它自带的斜杠命令改由独立进程应答。** 在 stream-json 模式下，由 CLI 自己应答的
  斜杠（`/model`、`/usage`、`/credits` 等）会直接中止整个会话，因此守护进程用一次性
  的 `agy -p=/<name>` 回答这十一个命令，绝不转发进会话。其余输入——首先是你的
  **skills**——照常进入会话并正常展开。
- **上下文占用来自 agy 的状态栏。** agy 的协议不上报 token 数，但它会把上下文快照
  交给 `~/.gemini/antigravity-cli/settings.json` 里配置的 `statusLine` 命令。守护进程
  启动时会先备份该文件一次，再把这项指向自己的 shim：既通过一条管道把数字——以及
  其他途径都拿不到的 agy 默认模型名——直接交回守护进程供页脚使用，也照样为你的终端
  画出状态栏。设 `AGENT_ANYWHERE_NO_AGY_STATUSLINE=1` 可以不动这项
  配置（代价是没有这些数字）。
- **skills** 从 `<cwd>/.agents/skills`、`~/.agents/skills`、
  `~/.gemini/antigravity-cli/skills`、`~/.gemini/skills`、`~/.gemini/config/skills`
  读取，所以 `/skills` 能列出它们，`/<名字> <请求>` 能直接调用。
- **`/new` 开启新对话**，与其他 harness 一致。打断当轮会重启子进程并续接同一
  对话，因此上下文不会丢失。

守护进程的所有默认参数都可通过 `args` 覆盖（它们追加在默认值之后，而 agy 的
参数解析是后者生效）。

> [!NOTE]
> Google 的 FAQ 声明：用第三方工具访问 Antigravity 违反其服务条款，可能导致
> 账号封禁。本 harness 只调用 agy 官方自带的 headless 接口，且完全不接触你的
> 凭据（登录全程在 `agy` 内部完成），但守护进程终究是一个非 Google 客户端在
> 驱动你的账号——请自行判断。

## 平台

| | Discord | Telegram | Slack | 飞书 | QQ | LINE | 企业微信 | 钉钉 | 网页端 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 流式原地编辑 | ✓ | ✓ | ✓ | ✓ | – | – | – | – | ✓ |
| 生命周期回应 | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | ✓ |
| 输入中指示 | ✓ | ✓ | – | – | – | ✓ | – | – | ✓ |
| 原生引用回复 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| 子区 / 自动开区 | ✓ | ✓ | ✓ | ✓ | – | – | – | – | ✓ |
| 按钮（`ask`） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| 斜杠命令 | ✓ | ✓ | ✓ | – | – | – | – | – | ✓ |

Markdown 按平台分别渲染；缺失的能力平滑降级（不能编辑 → 分段发送，没有按钮 →
纯文本提问）。Slack、飞书、钉钉默认走 WebSocket 长连接，无需公网回调地址。

### 网页端

守护进程自己提供的一个朴素深色聊天页。不用注册机器人、不用账号、不依赖任何外部
服务——这是把网关跑起来最快的方式，也是唯一一个完全不需要聊天平台的入口。

```yaml
platforms:
  web:
    type: webui
    token: ${AA_WEB_TOKEN}    # 必填：登录页要输的共享密钥
    host: 0.0.0.0             # 默认；想只走 SSH 隧道就填 127.0.0.1
    port: 8787                # 默认
    title: Chat               # 默认；浏览器标签页标题

access:
  allowFrom: ["web:owner"]    # 身份恒为 <实例 id>:owner
```

打开 `http://<host>:8787`，输入密钥，就得到和其他平台一样的会话：流式回复、工具
气泡、`/model` `/effort` `/cd` `/setting` 按钮菜单、`ask` 提问、附件上传与下载。

**话题。** 顶部一行名字用来切换并行的会话，和 Telegram 的论坛话题、飞书的话题群是同一种
形状：每个话题有自己的 agent session、自己的上下文，并且会根据聊下来的内容被自动命名。
点 `+` 新建；agent 自己也可以用 `agent-anywhere create-thread` 开一个，用
`--channel main/<话题 id>` 往指定话题里写。

**停下来。** 回复正在流式输出时，Send 旁边的 **Stop** 结束这一轮（`/stop`）。话题背后有
智能体进程在跑时，标题旁的电源按钮结束这个进程（`/kill`）—— 会话保留，下一条消息接着原来的
继续。两个按钮都只是替你发出对应命令，输入框里写了一半的草稿不受影响。

**为弱网写的。** 回复是在内容稳定后才发，而不是流式的每一次刷新都发；线路上的东西全部压缩；
断线重连从断点续传，而不是重新下载整个会话。一次 30 秒的流式回答，13 次更新被压成 3 次，
字节数大约是原来的四分之一。发送带 nonce，所以页面可以放心重试。

**可选的终端。** 打开之后，聊天页顶栏会多一个 `>_` 按钮，在聊天记录之上开出一个守护
进程所在机器的真终端——于是**任何** coding agent 的 CLI，连同它的 TUI，都能在同一个页面里
直接跑。它是**每个话题一个窗口**，右上角两个按钮是两件不同的事：最小化只是收起来，里面
跑着的东西照常跑、连接也不断；关闭才是真的结束这个会话。话题列表会标出哪些话题开着终端。
守护进程自己不实现终端：它只是把请求过同一道登录门之后，转发给你自己跑在 unix
socket 上的 [`ttyd`](https://github.com/tsl0922/ttyd)。默认关闭，要自己打开。

```yaml
platforms:
  web:
    type: webui
    token: ${AA_WEB_TOKEN}
    terminal:
      enabled: true
      socket: ~/.config/agent-anywhere/webui-term-web.sock   # 你的 ttyd 监听在哪
      # 可选：怎么「结束一个会话」。不配的话窗口上就没有关闭按钮，只有最小化——
      # 因为会话能在断线之后活下来是你那边的安排，不是这个守护进程的。
      # 是 argv 数组，不是 shell 字符串。
      endCommand: ["tmux", "-L", "aa-web", "kill-session", "-t", "aa-{topic}"]
```

```bash
# 另一半不归这个包管。wrapper 里要套一层 tmux——否则关掉标签页，
# 里面正在跑的东西会跟着被 SIGHUP 掉。
printf '#!/bin/sh\nexec tmux -L aa-web new -A -s "aa-$1"\n' > /usr/local/bin/aa-terminal.sh
chmod +x /usr/local/bin/aa-terminal.sh
ttyd -i ~/.config/agent-anywhere/webui-term-web.sock -b /term -W -a -O \
     -T xterm-256color /usr/local/bin/aa-terminal.sh
```

> [!WARNING]
> 默认监听所有网卡且是明文 HTTP，所以那个密钥就是你的网络和一个拥有完整工具权限的
> 智能体之间的全部屏障。要暴露到你掌控范围之外，先在前面加一层带 TLS 的反向代理；
> 或者设 `host: 127.0.0.1`，用 SSH 隧道访问。
> 如果确实过反代，务必**关掉响应缓冲**（nginx 里 `proxy_buffering off;`）——被缓冲的
> SSE 会让整轮回复到结束才一次性出现；开了终端的话还要放行 `Upgrade`/`Connection`。
> 另外：打开终端，等于把这个密钥从「守着一条和智能体的对话」变成「守着一个 shell」。
> 权限上限没变，但从密钥泄漏到任意命令的距离短了很多。

**单点登录：一个共享密钥不够用的时候。** 共享密钥上没有名字、不会过期，也没法只
吊销某一个人。如果这个页面前面已经有一层认证代理——Cloudflare Access、Teleport 的
Application Service——那它已经认过「人」了（SSO + MFA），并把结论签成一个 JWT 带
过来。把 `sso:` 指向这个代理的公钥，守护进程就去验这个签名，而不是再问一遍密码。

```yaml
platforms:
  web:
    type: webui
    token: ${AA_WEB_TOKEN}
    sso:
      # 这里是 Cloudflare Access。Teleport 换成：header Teleport-Jwt-Assertion、
      # jwksUrl https://<proxy>/.well-known/jwks.json、claim username。
      header: Cf-Access-Jwt-Assertion          # 默认值
      cookie: CF_Authorization                 # WebSocket 握手拿不到 header 时的那份
      jwksUrl: https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
      issuer: https://<team>.cloudflareaccess.com
      audience: <这个应用的 AUD tag>           # 不是可选项：它挡住的是「同一个 IdP
                                               # 给另一个应用签的 token」
      claim: email                             # 默认值
      allow: ["you@example.com"]
      from: ["172.24.0.0/16"]                  # 只有代理，别的都不行
      password: false                          # SSO 跑通之后，把老门关掉
```

`from` 是必填的：签名本身已经让伪造请求头没有意义，`from` 保的是上面四个字段里写
错一个也不至于致命。被拒的请求会把来源地址打进日志——那行就是你该往 `from` 里填
什么的答案。`agent-anywhere doctor` 会去拉一次 JWKS 并报告拿到几把钥匙，**在设
`password: false` 之前先跑一次**：老门关掉之后，IdP 一挂就没人打得开这个页面了。


有两件事要有预期：知道密钥的人共用同一条会话；守护进程重启后页面是空的，但智能体
的上下文还在——聊天记录在内存里，会话本身不在。

## 聊天命令

在支持原生斜杠命令的平台（Telegram、Discord、Slack）上会注册进命令菜单；
其余平台直接当普通文本输入，效果相同。

| | |
|---|---|
| `/help` | 列出下面这些，并按当前作答的智能体过滤 |
| `/new`、`/clear` | 开启新会话（清空上下文） |
| `/stop` | 停掉当前这一轮，会话本身保留 |
| `/kill` | 结束智能体进程，会话本身保留，下一条消息接着原来的继续 |
| `/cd` | 选这个会话的工作目录，见下 |
| `/title` | 给这个话题起名字；不起则自动命名，见下 |
| `/setting` | 改 config.yaml 里的设置，见下 |
| `/cc`、`/oc`、`/cx`、`/gm`、`/agy` | 每个已配置 harness 一个，见下 |
| `/compact`、`/context`、`/model`、`/effort`、`/usage`、`/doctor`、`/mcp`、`/init`、`/review` | 通用词表，按 harness 翻译成各自的原生拼写 |

**智能体命令**以 harness 命名 —— `/cc` claude、`/oc` opencode、`/cx` codex、
`/gm` gemini、`/agy` Antigravity。只有你实际配置了的 harness 才会被注册。
它有两种用法：

```
/oc 修一下挂掉的测试   →  把当前会话切到 opencode，并把这句话发给它
/oc                    →  切过去，然后问「在哪个目录」（新会话）
                          或列出 opencode 自己的命令（会话进行中）
```

绑定是**粘性**的：`/oc` 之后的每条消息都继续由 opencode 作答，直到你点名
别人为止；切回来时会恢复该智能体自己的线程，而不是从头开始。全称
（`/opencode`）手输仍然有效，只是不再注册，不占用平台菜单的名额。

点名一个你**没有配置**的 harness（配置里没有 `harness: agy` 却发 `/agy`），
网关会直接说明这一点，并且不跑任何一轮 —— 否则这条消息会带着 `/agy` 前缀原样
发给当前绑定的智能体，被它当成自己的斜杠命令，找不到、什么也不输出，最后只回
一句"命令跑过了，但没有内容可显示"。

只输入命令本身，也是调出该 harness **自带命令**（`/customize-opencode` 之类）
的唯一入口 —— 前提是这个会话已经跑起来了。它们刻意不做全局注册：原生斜杠命令是
每个机器人一份的，而智能体是每个会话一个，合并成一张菜单既说不清某一项归谁，
也无法把它路由回去。不上报命令列表的 harness（`agy`）则只确认切换。

通用命令会被改写成目标 harness 的原生拼写（`/compact` → gemini 的
`/compress`）；没有对应命令的 harness 会直接说明，而不是浪费一轮去让它猜。

其中几条，在 harness 没有对应命令时由网关自己回答 —— 因为这些能力它是通过
协议暴露的，而不是做成斜杠命令：`/context` 打印智能体最近上报的上下文用量，
`/model` 用来查看和切换模型，`/effort` 用来查看和切换推理强度（思考深度）。

单独发 `/model` 会弹出一个**可翻页的按钮菜单**，直接停在当前模型所在那一页；
◀ ▶ 在同一条消息上原地翻页，点某个模型即为该会话切换。这需要平台既能发按钮、
又能改按钮，也就是 Discord、Telegram、Slack、Lark；其余平台仍回原来那行摘要。
`/model <名字的一部分>` 在所有平台都能按子串切换，匹配到多个时列出候选，而不是
替你猜一个。opencode 和 claude 都走这条路——两者都不把 `/model` 登记成命令，
却都在 ACP 会话里暴露了模型选择器。

`/effort` 在 `claude`、`codex`、`opencode` 上用法相同：单独发会弹出档位按钮，
● 标出当前档（不能改按钮的平台回一行文字）；`/effort high`，或任何能唯一确定的
开头（`/effort x` 即 `xhigh`），为该会话切换档位，从下一条消息起生效。档位是
模型给的，不是 harness 给的，所以会随 `/model` 变化，也可能一个都没有：opencode
只对有推理变体的模型提供，codex 只对本机 codex-cli 自带模型目录里的模型提供
（0.155.1 的目录里没有 `gpt-6-luna`，0.156.1 有）。回复会说明你属于哪种情况。
智能体因空闲被回收后选择依然有效 —— claude 和 codex 重载会话时会回到默认档，
网关会重新设一次 —— 直到 `/new` 或 daemon 重启为止。`agy` 没有这项设置，它的思考档位是独立的
模型，在 `/model` 里选。

## 选智能体在哪儿干活

`agents[].cwd` 定的是某个智能体从哪个目录起步，`/cd` 定的是**这个会话**在哪个
目录干活 —— 于是这个话题聊 A 项目、下个话题聊 B 项目，不用去动 config.yaml。

候选目录就是该智能体自己的 `cwd` 加上它下面一层的子目录：不另开一处声明项目，
新项目只要在磁盘上存在就会出现在菜单里。根目录始终在列，所以进了某个项目还能
退出来。

```
/cd                →  根目录下各项目的按钮菜单
/cd quantlab       →  按子串直接切，所有平台都能用
```

菜单按你真正在用的目录排序：一个项目的名次取决于它被选中过多少次，而每一次都
按「过了多久」打折（半衰期两周）。只数次数的话，上个季度的项目会永远压在最前
面；只看最近一次的话，随手点开一次的目录就能把你整月都待着的项目挤下去。从没
选过的目录保持字母序，根目录仍排第一 —— 它是退出项目的出口，不是项目本身。这
份记录按机器保存而不是按会话，所以新开的话题第一次弹菜单就能享受到。

一页能放多少由平台声明：Telegram、Discord、Slack 都是 12 个，对一个常见规模的
工作区来说就是一页 —— 于是选目录通常是点一下，而不是先翻页。

这个问题只在两个「问了不亏」的时刻抛出来：会话从没跑过时的裸智能体命令
（`/cc`、`/oc`、`/agy`），以及 `/new` 之后。**进行中**的会话不会被它打断 ——
包括那些闲置久了智能体进程已被回收的，它们会照常从原处恢复。

切目录意味着**在新目录开一个全新会话**，菜单在你点之前就会写明这一点。这不是
选择题：会话的目录在创建时就定死了（ACP 在 `session/new` 时接收 `cwd`，agy 在
拉起进程时接收），所以这次移动够不着一个已经在跑的进程。点你已经在的那个目录
（标着 ●）则什么都不会发生。这个选择按会话记录，因此能扛过重启和 `/new`，并且
对在这里作答的每个智能体都生效。

## 话题叫什么名字

Telegram 的话题一旦建好，名字就一直是建的时候那个 —— 所以「一个话题一件事」的
用法最后会变成一列在动手**之前**敲下的名字。所以网关来起名：一个话题第一次成功
作答之后，它的开场消息会被总结成一个名字，**只起一次**。

```
/title                  →  这个话题上次被我起的名字，以及是谁起的
/title ask 超时          →  自己起名
/title auto             →  忘掉这个名字，下一次作答重新起
```

「只起一次」是刻意的。之前那版跟着 harness 自己的会话标题走，而那个标题会随会话
推进不断重生成 —— 于是话题名一直漂到「最近在聊什么」，而这不是名字该干的事。你在
话题列表里是靠记忆找东西的，一个一直在变的名字比一个稍微不准的名字代价更大。想整个
关掉，用 `platforms.<id>.autoRenameThread: false`。

总结用任何 OpenAI 兼容的接口都行：

```yaml
title:
  llm:
    baseUrl: https://api.example.com/v1   # 写到 /v1 为止
    apiKey: ${SOME_KEY}                   # ${VAR} 从同目录的 .env 展开
    model: gemini-3-flash-lite            # flash 档的模型就够用
```

flash 档模型一两秒出结果，每个会话约 60 token —— 一个话题一辈子一次调用，不是
每轮一次。不配 `title.llm` 的话，名字就是开场消息截到 40 字，那是个 substring 而
不是总结，读起来也就那样。调用失败会退回同一个兜底，所以起名这件事不依赖那个接口活着。

一个限制值得知道：Telegram 没有任何接口能读回话题当前的名字，所以你直接在 Telegram
界面里改的名字这边看不见。它不会被覆盖（已经有名字的话题不会再被改名），但 `/title`
报的是它自己设过的那个，不是你看到的那个。

## 在聊天里改配置

`/setting` 改的是 **config.yaml 本身**，所以一次改动既跨会话也跨重启 —— 这正是
它和 `/model` 的分工：`/model` 只覆盖当前这个会话，重置即失效。它替掉的是原来
那条路：登上机器、手改 YAML、重启守护进程 —— 而重启会杀掉所有常驻智能体。

| 改什么 | config.yaml 位置 | 接受的值 | 何时生效 |
|---|---|---|---|
| 默认智能体 | `routing.default` | 任一已配置的 agent id | 立即 |
| 某个智能体的默认模型 | `agents[].model` | 该智能体上报的模型、任意名字，或 `-` 清空 | 它的下一个会话（`/new` 可立刻开一个） |
| 空闲回收窗口 | `session.idleTimeoutMs` | `off`、`15m`、`4h` …… | 立即 |
| 会话粒度 | `session.scope` | `per_thread`、`per_channel`、`per_user`、`shared` | 重启后 |
| 流式输出 | `stream.enabled` | `on`、`off`（默认 `off`） | 立即 —— 下一条回复生效 |

```
/setting                       →  整个设置面板，能放按钮的平台就是按钮
/setting idle                  →  这一项当前是什么、接受什么
/setting idle 4h               →  直接设，所有平台都能用
/setting model.cc opus         →  某个智能体开新会话时用的模型
```

在既能发按钮、又能改按钮的平台（Discord、Telegram、Slack、飞书），单独发
`/setting` 会弹出两级菜单 —— 点一项、点一个值，然后回到列表，新值就写在那一行
上。其余平台上同样这四条命令按文本用。模型太多会自动翻页；harness 认但没有上报
过的名字（比如 `opusplan`）会按你输入的原样保存。

每条回执都会说清**这次改动什么时候生效**，因为它们并不一样：会话粒度只写文件、
重启后才应用 —— 在会话还开着的时候换掉「什么算一个会话」，会悄悄把所有现存会话
换成另一个身份。

文件里其余部分仍然只在文件里改，而 `/setting` 会**点名拒绝**并说明原因，而不是
装作这个键不存在。其中最值得单独说的是 `access.allowFrom`：那一项填错一次，就
把你锁在唯一能用来修它的那个界面外面了。

写入走 YAML 文档接口，所以你的注释、键顺序和 `${VAR}` 模板都原样保留；而且写盘
前会先拿整份配置校验一遍 —— `/setting` 不会给你留下一份下次重启加载不了的
config.yaml。

## 向你提问

当智能体需要一个它替你做不了的决定时，它会**问**——以按钮的形式发进聊天，然后等你点：

> **这个项目用哪个数据库？**
> **PostgreSQL** — 你这台机器已经在跑 pgvector，直接复用零成本。
> **MySQL** — 生态更广，但本机还没有现成实例。
>
> `[ PostgreSQL ]` `[ MySQL ]`

这是模型自己的提问工具，不是网关外挂的功能：守护进程在握手时声明 ACP 的
`elicitation.form` 能力，而这正是解锁 Claude Code `AskUserQuestion` 的开关——不声明的话
适配器会把那个工具直接禁用。整个过程**没有向提示词注入任何东西**。

**选项都不合适时，直接打字回答就行。**问题还挂在屏幕上时发的消息，会被记成对那道题的回答，
而不是开启新一轮——所以一次问三件事的表单仍然会把三件事问完，哪怕你用自己的话回答了第二题。
无论点按钮还是打字，提问那条消息都会被就地编辑：按钮撤掉，并写上你的回答。
实在不想回答，用 `/stop`（或 `/new`）把问题撤掉。

不实现 elicitation 的 harness——`opencode` 1.18.27 与 `dsh` 0.1.2-rc.1——提示里改为保留
`ask` 这条 CLI，模型照样能给你弹按钮；再不行就用纯文本把问题问出来并结束这一轮，
你在下一条消息里回答即可。

## 在聊天中行动

纯文本回答自动流式返回。智能体被告知的，只有文本通道唯一做不到的那一件事：

```bash
agent-anywhere send-file ./report.pdf --caption "Q3 数据"
```

其余命令智能体依然能用，但**刻意不告诉它**——在模型读到你第一个字之前，一份命令清单
先花掉的是它的注意力：`send-message`、`reply`、`edit-message`、`react`、`delete`、
`fetch-messages`、`create-thread`。完整列表见 `agent-anywhere --help`，每一条为什么
冗余见 [`src/ipc/README.md`](src/ipc/README.md)。

如果你希望智能体熟练使用它们，装上内置 [skill](skill/SKILL.md)——它带完整用法，
按需加载，而不是每个会话都注入一遍：

```bash
npx skills add https://github.com/noir017/agent-anywhere/tree/main/skill -g
```

## CLI

| 命令 | |
|---|---|
| `setup` | 交互式配置向导 |
| `doctor` | 自检（默认命令）；`--migrate-config` 升级 v0 配置文件 |
| `start` | 运行守护进程 |
| `<反向命令>` | 供智能体使用的聊天操作（见上文） |

所有命令均接受 `-c, --config <path>`，并将结构化输出写到 stdout。

## 参与开发

[AGENTS.md](AGENTS.md) 记录了代码约定、分层规则与安全不变量，并索引了各模块文档
（[config](src/config/README.md) · [core](src/core/README.md) ·
[platform](src/platform/README.md) · [daemon](src/daemon/README.md) ·
[ipc](src/ipc/README.md) · [commands](src/commands/README.md)）。改代码前请先读它。

## 许可证

[MIT](LICENSE)

本项目起初是 [l0ng-ai/agent-anywhere](https://github.com/l0ng-ai/agent-anywhere) 在 `3d855f8`
处的一个分支，原作者的架构设计（尤其是 platform 的 profile 抽象层）至今仍是这套代码的骨架，
此后在其基础上做了大量扩展。上游的 MIT 版权声明保留在 [LICENSE](LICENSE) 中，该声明同时
覆盖两边的代码。
