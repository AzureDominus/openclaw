---
read_when:
  - 从旧版 Gmail Pub/Sub watcher 流程迁移
  - 将外部 Gmail 接入器连接到 OpenClaw
summary: OpenClaw 已移除旧版 Gmail Pub/Sub watcher 流程
title: Gmail PubSub
---

# Gmail Pub/Sub

OpenClaw 不再管理 Gmail Pub/Sub watch，也不再提供旧的本地 watch 守护进程。
该流程依赖旧版 watcher CLI，现已移除，并且没有对应的 `gws` 替代实现。

## 仍然可用的能力

- OpenClaw 仍然接受来自外部接入器的 `POST /hooks/gmail`。
- `hooks.presets: ["gmail"]`、`hooks.mappings`、`hooks.gmail.model`、
  `hooks.gmail.thinking`、`hooks.gmail.allowUnsafeExternalContent` 仍然适用于
  Gmail webhook 负载。
- 对于直接的 Gmail CLI 任务，例如搜索、读取或发送邮件，请使用 `gws`。

## 已移除的内容

- `openclaw webhooks gmail setup`
- `openclaw webhooks gmail run`
- Gateway 管理的 Gmail watch 自动续期与本地 Pub/Sub 回调服务

## 推荐做法

1. 启用 OpenClaw hooks，以及 Gmail 预设或自定义 mapping。
2. 在 OpenClaw 之外运行你自己的 Gmail watcher 或 Pub/Sub bridge。
3. 将标准化后的负载投递到 `POST /hooks/gmail`。

示例配置：

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    gmail: {
      model: "openai/gpt-5.2-mini",
      thinking: "off",
    },
  },
}
```

关于 hook 认证、路由、mapping 与负载示例，请参见 [Webhooks](/automation/webhook)。
