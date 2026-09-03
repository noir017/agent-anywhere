<div align="center">

# Agent Anywhere

**让你的编码智能体进驻每一个聊天软件。**

[![CI](https://github.com/l0ng-ai/agent-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/l0ng-ai/agent-anywhere/actions/workflows/ci.yml)
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
 Lark ──────┼────►│  routing · sessions  │◄─────►├─► codex
 QQ ────────┤     │  streaming · access  │       ├─► opencode
 LINE ──────┤     └──────────▲───────────┘       ├─► agy
 WeCom ─────┤                │ unix socket       └─► custom
 DingTalk ──┘                └─ agent-anywhere CLI (send-file / ask / react …)
```

## 特性

- **八个平台，一个进程** —— Discord、Telegram、Slack、飞书、QQ、LINE、企业微信、钉钉；支持多账号。
- **任意 ACP 智能体，外加 agy** —— 内置 Claude Code、Codex、OpenCode 与 Antigravity（`agy`）预设，另有 `custom`；按平台、频道、用户或斜杠命令路由。
- **原生流式体验** —— 消息原地编辑、工具调用气泡、生命周期回应表情、新消息打断。
- **在聊天中行动** —— 智能体可发文件、加回应、引用回复、开子区、读历史、发按钮提问。
- **附件处理** —— 收到的图片和文件自动下载并交给智能体。
- **话题是一等公民** —— Telegram 话题、Slack 线程、Discord 子区各自是独立会话，各自绑定智能体；绑定粘在会话上，用 `/oc` 切换。
- **持久会话** —— 重启不丢上下文；`/new` 重置；作用域可按子区、频道、用户或全局。
- **精简配置** —— 五个部分，凭据按平台校验，支持 `${VAR}` 与 `.env` 展开。

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
Set up https://github.com/l0ng-ai/agent-anywhere for me: install the CLI
(npm i -g agent-anywhere-cli) and its skill (npx skills add
https://github.com/l0ng-ai/agent-anywhere/tree/main/skill -g), then follow
the skill to configure and start it.
```

</details>

## 配置

`~/.config/agent-anywhere/config.yaml`，或用 `--config <path>` 指定：

```yaml
version: 1

platforms:                    # 命名实例；键即实例 id
  discord-main:
    type: discord             # discord|telegram|slack|lark|qq|line|wecom|dingtalk
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
| `codex` | 内置 [codex-acp](https://www.npmjs.com/package/@zed-industries/codex-acp) | 无 | Codex CLI 登录态 |
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
流式输出、工具气泡、多轮上下文、重启续接都与 ACP 预设一致，只有两点不同：

- **它自带的斜杠命令被禁用。** 在 stream-json 模式下，由 CLI 自己应答的斜杠
  （`/model`、`/usage`）会直接中止整个会话，而聊天场景里用户频繁输入 `/…`——
  所以守护进程启动时加了 `--disable-slash-commands`，此类输入会被当作普通文本。
  想恢复原生行为可传 `args: ["--disable-slash-commands=false"]`。
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

| | Discord | Telegram | Slack | 飞书 | QQ | LINE | 企业微信 | 钉钉 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 流式原地编辑 | ✓ | ✓ | ✓ | ✓ | – | – | – | – |
| 生命周期回应 | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – |
| 输入中指示 | ✓ | ✓ | – | – | – | ✓ | – | – |
| 原生引用回复 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| 子区 / 自动开区 | ✓ | ✓ | ✓ | – | – | – | – | – |
| 按钮（`ask`） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| 斜杠命令 | ✓ | ✓ | ✓ | – | – | – | – | – |

Markdown 按平台分别渲染；缺失的能力平滑降级（不能编辑 → 分段发送，没有按钮 →
纯文本提问）。Slack、飞书、钉钉默认走 WebSocket 长连接，无需公网回调地址。

## 聊天命令

在支持原生斜杠命令的平台（Telegram、Discord、Slack）上会注册进命令菜单；
其余平台直接当普通文本输入，效果相同。

| | |
|---|---|
| `/help` | 列出下面这些，并按当前作答的智能体过滤 |
| `/new`、`/clear` | 开启新会话（清空上下文） |
| `/cc`、`/oc`、`/cx`、`/gm`、`/agy` | 每个已配置 harness 一个，见下 |
| `/compact`、`/context`、`/model`、`/usage`、`/doctor`、`/mcp`、`/init`、`/review` | 通用词表，按 harness 翻译成各自的原生拼写 |

**智能体命令**以 harness 命名 —— `/cc` claude、`/oc` opencode、`/cx` codex、
`/gm` gemini、`/agy` Antigravity。只有你实际配置了的 harness 才会被注册。
它有两种用法：

```
/oc 修一下挂掉的测试   →  把当前会话切到 opencode，并把这句话发给它
/oc                    →  切过去，然后把 opencode 自己的命令列成按钮
```

绑定是**粘性**的：`/oc` 之后的每条消息都继续由 opencode 作答，直到你点名
别人为止；切回来时会恢复该智能体自己的线程，而不是从头开始。全称
（`/opencode`）手输仍然有效，只是不再注册，不占用平台菜单的名额。

只输入命令本身，是调出该 harness **自带命令**（`/customize-opencode` 之类）
的唯一入口。它们刻意不做全局注册：原生斜杠命令是每个机器人一份的，而智能体
是每个会话一个，合并成一张菜单既说不清某一项归谁，也无法把它路由回去。
不上报命令列表的 harness（`agy`）则只确认切换。

通用命令会被改写成目标 harness 的原生拼写（`/compact` → gemini 的
`/compress`）；没有对应命令的 harness 会直接说明，而不是浪费一轮去让它猜。

## 在聊天中行动

纯文本回答自动流式返回。其余操作由智能体调用同一个 CLI 完成，命令默认作用于
当前会话：

```bash
agent-anywhere send-file ./report.pdf --caption "Q3 数据"
agent-anywhere react <messageId> <emoji>
agent-anywhere fetch-messages --limit 20
agent-anywhere create-thread <messageId> "排查记录"
agent-anywhere ask "部署到生产？" -o 部署 -o 演练 -o 取消
```

`ask` 阻塞等待用户点击按钮，并把所选标签写到 stdout。此外还有：
`send-message`、`reply`、`edit-message`、`delete`。

守护进程每轮注入一行提示，任何智能体都能自行发现这些命令；完整用法见内置
[skill](skill/SKILL.md)：

```bash
npx skills add https://github.com/l0ng-ai/agent-anywhere/tree/main/skill -g
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
