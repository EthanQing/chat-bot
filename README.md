# DeepSeek 流式对话机器人

一个本地/私有部署的 Web GUI，对接 DeepSeek OpenAI-compatible API，支持流式输出、思考模式、会话管理、Markdown/代码/数学公式/Mermaid 渲染、Tool Calls、JSON Output、Prefix/FIM Beta 等能力。

## 启动

```bash
python main.py
```

默认监听：<http://127.0.0.1:12322>。

运行时数据保存到 SQLite：

```text
data/chat-bot.sqlite3
```

前端通过 WebSocket `/ws` 接收启动数据和其它标签页的实时更新；SQLite 是唯一权威数据源。浏览器不再使用 IndexedDB/localStorage 保存会话、设置或资源数据。

## 部署到服务器

个人单用户部署可以使用：Python 服务监听本机内部端口，Nginx 负责 HTTPS、Basic Auth、反向代理和 WebSocket Upgrade。

无域名、使用公网 IP 和 `12321` 端口的个人部署步骤见：[`docs/PERSONAL_IP_12321_DEPLOY.md`](docs/PERSONAL_IP_12321_DEPLOY.md)。

## 主要功能

- 多会话：新建、切换、搜索、重命名、删除、置顶、批量删除，服务端 SQLite 持久化，可在电脑/手机间共享。
- 实时数据：WebSocket 首连只加载会话列表，切换会话时再按需加载该会话消息；其它标签页写入后自动广播更新。
- 流式聊天：`fetch` + `ReadableStream` SSE 解析，支持停止生成、错误提示和部分内容保留。
- Thinking Mode：`thinking.enabled/disabled`、`reasoning_effort`、思考过程折叠展示和 thinking token 估算。
- 内容渲染：Markdown、GFM 表格/任务列表、代码高亮/复制/行号、KaTeX、Mermaid 放大预览、JSON 树。
- Tool Calls：内置 calculator / time / mock weather / mock web search，自定义 tools JSON，strict schema 基础校验，多轮工具调用循环。
- Beta：Chat Prefix Completion 和 FIM Completion。
- 设置：弹窗式设置中心，按 API、模型、思考/输出、System Prompt、破限/预设、角色/背景、世界书、工具、界面、数据分页。
- 备份：导出 JSON 备份；导入备份会通过 `backup.replaceAll` 重建 SQLite 数据。

## 安全说明

- API Key、设置和会话数据默认保存在服务端 SQLite，浏览器不保存业务数据。
- 如果服务端配置了 `DEEPSEEK_API_KEY`，前端 API Key 会留空并强制使用同源代理。
- `data/chat-bot.sqlite3` 可能包含 API Key、角色卡、世界书、破限词和聊天记录，请不要上传或分享该文件。
- 默认启用同源代理 `/proxy/deepseek` 转发到 DeepSeek，避免浏览器 CORS 限制；可在设置中关闭。
- Markdown 通过 DOMPurify 清洗，并配置了 CSP。

## 旧数据迁移

首次启动时，如果 SQLite 尚未初始化且 `data/app-state.json` 存在，服务端会把旧整包状态迁移到 SQLite。迁移成功后不会删除旧 JSON 文件，也不会再读写它。

## 参考文档

- DeepSeek Chat Completion API: https://api-docs.deepseek.com/zh-cn/api/create-chat-completion
- Thinking Mode: https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
- Chat Prefix Completion: https://api-docs.deepseek.com/zh-cn/guides/chat_prefix_completion
- FIM Completion: https://api-docs.deepseek.com/zh-cn/guides/fim_completion
- Function Calling: https://api-docs.deepseek.com/zh-cn/guides/function_calling

## 代码结构

前端已拆分为原生 ES Modules，入口为 `web/js/app.js`，兼容入口为 `web/app.js`。详细说明见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。
