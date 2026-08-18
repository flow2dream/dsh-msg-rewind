# dsh-msg-rewind

**中文** | [English ↓](#dsh-msg-rewind-english)

为 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) Web 版提供的对话回退命令。

- `/undo` — 回退上一轮对话（删除最后一条真实用户消息及其后的所有内容）
- `/rewind` — 从对话框中选择一条历史用户消息，把对话回退到该位置
- **可视化回退** — 将鼠标悬浮到对话中的用户消息气泡上，点击 ⤺ 撤销按钮即可回退到该条消息

回退会同时截断**模型上下文**与**可见对话记录**，并重写持久化 JSONL 文件，重启后回退依然生效。

## 展示效果

![回退](https://raw.githubusercontent.com/flow2dream/dsh-msg-rewind/main/docs/rewind.png)

![回退对话框](https://raw.githubusercontent.com/flow2dream/dsh-msg-rewind/main/docs/rewind_dialog.png)

![撤回按钮](https://raw.githubusercontent.com/flow2dream/dsh-msg-rewind/main/docs/rewind_logo.png)

![撤销](https://raw.githubusercontent.com/flow2dream/dsh-msg-rewind/main/docs/undo.png)

*均为 dsh web 真实运行截图。*

## 功能特性

| 功能 | 说明 |
| --- | --- |
| `/undo` | 回退上一轮：删除最后一条真实用户消息及其后的所有事件 |
| `/rewind`（裸调用） | 弹出对话框，列出所有用户消息（按时间正序，默认选中最近一条）；选择后回退到该位置 |
| `/rewind <seq>` | 直接按消息序号回退 |
| 可视化回退 | 悬浮任意用户气泡 → 点击撤销图标（与时间、复制按钮一同显示）回退到该消息 |
| 持久化 | 重写会话的 JSONL+zstd 文件，回退在重启后依然保留 |
| 界面整洁 | 回退后不显示"命令 已完成"之类的冗余卡片 |

## 环境要求

- DeepSeek Harness Web 版（dsh web）
- Node `^22.19.0 || >=24.0.0`

## 安装

### 通过 npm 安装（推荐）

```bash
dsh plugin --profile web add @flow2dream/dsh-msg-rewind@0.1.0
```

然后重启 web profile：

```bash
dsh web
```

### 通过 GitHub 安装

```bash
dsh plugin --profile web add dsh-msg-rewind@github:flow2dream/dsh-msg-rewind
```

然后重启 web profile：

```bash
dsh web
```

### 手动安装

在 web profile 中添加依赖与 bundle：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "@flow2dream/dsh-msg-rewind": "0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["@flow2dream/dsh-msg-rewind"]
    }
  }
}
```

然后安装并重启 web profile：

```bash
cd ~/.dsh/profiles/web
pnpm install
dsh web
```

## 使用方法

在任意对话中：

- 输入 `/undo` — 对话回退一轮。
- 输入 `/rewind` — 弹出对话框，列出所有用户消息，默认选中最近一条；方向键导航，回车回退。
- 悬浮**用户**消息气泡 — 复制按钮旁会出现一个小撤销图标；点击即可回退到该条消息。

回退目标始终是**真实用户消息**（系统注入内容，如运行时上下文、技能目录快照，绝不会被当作用户轮次）。

## 工作原理

- **宿主端**（`lib/index.js`）注册 `/undo` 与 `/rewind` 命令。回退时先排空持久化协调器的缓冲，截断实时会话日志，重置所有派生缓存，重写 JSONL 文件，重置 agent 的请求头锚点，并广播 `session/rewind` 事件。
- **浏览器端**（`lib/client.js`）监听 `session/rewind`，从宿主重新同步目标会话的对话窗口，并向用户气泡注入悬浮撤销按钮。
- `session/rewind` 事件已加入 `dsh-api-remotes` 的转发白名单。

## 开发

```bash
# 在 web profile 目录下
npm install /path/to/dsh-msg-rewind
```

源码位于 `lib/`：

- `lib/index.js` — 宿主端（命令 + 日志截断）
- `lib/client.js` — 浏览器端（窗口重同步 + 可视化回退）

## 许可证

MIT

---

# dsh-msg-rewind (English)

Conversation rewind commands for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) web.

- `/undo` — roll the chat back one full turn (drop the last real user message and everything after it)
- `/rewind` — pick a past user message from a dialog and cut the conversation back to it
- **Visual rewind** — hover a user message bubble in the chat and click the ⤺ undo button to rewind to that point

Both the model context **and** the visible transcript are truncated, and the durable JSONL artifact is rewritten so the cut survives a restart.

## Screenshots

![rewind](https://raw.githubusercontent.com/flow2dream/dsh-msg-rewind/main/docs/rewind.png)

![rewind dialog](https://raw.githubusercontent.com/flow2dream/dsh-msg-rewind/main/docs/rewind_dialog.png)

![rewind logo](https://raw.githubusercontent.com/flow2dream/dsh-msg-rewind/main/docs/rewind_logo.png)

![undo](https://raw.githubusercontent.com/flow2dream/dsh-msg-rewind/main/docs/undo.png)

*Real screenshots from dsh web.*

## Features

| Capability | Detail |
| --- | --- |
| `/undo` | Reverts the previous turn: deletes the last real user message and all events after it |
| `/rewind` (bare) | Opens a dialog listing every user message (chronological, most recent preselected); pick one to rewind there |
| `/rewind <seq>` | Directly rewinds to the given message seq |
| Visual rewind | Hover any user bubble → click the undo icon (shown with time + copy) to rewind to that message |
| Durable | Rewrites the session's JSONL+zstd artifact; the cut survives a restart |
| Clean UI | No "command completed" noise cards after a rewind |

## Requirements

- DeepSeek Harness web (dsh web)
- Node `^22.19.0 || >=24.0.0`

## Install

### Via npm (recommended)

```bash
dsh plugin --profile web add @flow2dream/dsh-msg-rewind@0.1.0
```

Then restart the web profile:

```bash
dsh web
```

### Via GitHub

```bash
dsh plugin --profile web add dsh-msg-rewind@github:flow2dream/dsh-msg-rewind
```

Then restart the web profile:

```bash
dsh web
```

### Manual

Add the dependency and bundle to your web profile:

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "@flow2dream/dsh-msg-rewind": "0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["@flow2dream/dsh-msg-rewind"]
    }
  }
}
```

Then install and restart the web profile:

```bash
cd ~/.dsh/profiles/web
pnpm install
dsh web
```

## Usage

In any conversation:

- Type `/undo` — the chat rolls back one turn.
- Type `/rewind` — a dialog opens with every user message; the most recent one is preselected. Arrow keys navigate, Enter rewinds.
- Hover a **user** message bubble — a small undo icon appears next to the copy button; click it to rewind to that message.

The rewind target is the real user message (system injections such as runtime-context and skill-catalog snapshots are never treated as user turns).

## How it works

- **Host** (`lib/index.js`) registers the `/undo` and `/rewind` commands. A rewind drains the persistence coordinator, splices the live session log, resets every derived cache, rewrites the JSONL artifact, resets the agent's request-header anchor, and broadcasts `session/rewind`.
- **Browser** (`lib/client.js`) listens for `session/rewind`, resyncs the target session's window from the host, and injects the hover undo button into user bubbles.
- The `session/rewind` event is allowlisted in `dsh-api-remotes`'s forwarded events.

## Development

```bash
# from your web profile
npm install /path/to/dsh-msg-rewind
```

Source lives in `lib/`:

- `lib/index.js` — host half (commands + truncation)
- `lib/client.js` — browser half (resync + visual rewind)

## License

MIT
