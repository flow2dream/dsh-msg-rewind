# 展示效果（Docs）

本目录存放 dsh-msg-rewind 插件的功能展示素材，用于 README 与发布说明。

## 素材清单

| 文件 | 内容 | 用途 |
| --- | --- | --- |
| `rewind-popup.svg` | `/rewind` 命令的选择对话框效果示意 | README 功能演示 |
| `user-hover-button.svg` | USER 消息块悬浮时的"撤回"按钮示意 | README 功能演示 |
| `screenshots/` | 真实运行截图（.png/.gif） | 发布说明、Issue 演示 |

## 如何补充真实截图

1. 在 web 界面执行 `/rewind`，用系统截图工具（macOS `Cmd+Shift+4` / Windows `Win+Shift+S`）截取弹窗效果，保存为 `screenshots/rewind-popup.png`
2. 悬浮到一条 USER 消息，截取带"撤回"按钮的效果，保存为 `screenshots/user-hover-button.png`
3. 如需动图：用 LICEcap / ScreenToGif 录制撤回操作过程，保存为 `screenshots/rewind-demo.gif`

截图命名建议与上方 SVG 保持一致，方便在 README 中替换引用。

## SVG 示意图说明

SVG 为手工绘制的界面示意（非真实截图），用于快速展示交互形态；正式发布时建议替换为真实截图。
