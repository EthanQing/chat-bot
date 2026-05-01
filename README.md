# DeepSeek 流式对话机器人

一个本地运行的精美 Web GUI，对接 DeepSeek OpenAI-compatible API，支持流式输出、思考模式、会话管理、Markdown/代码/数学公式/Mermaid 渲染、Tool Calls、JSON Output、Prefix/FIM Beta 等能力。

## 启动

```bash
python main.py
```

打开终端输出的地址（默认 <http://127.0.0.1:8000>），在设置面板中填入 DeepSeek API Key 即可使用。

服务会默认监听 `0.0.0.0:8000`，并把共享数据保存到：

```text
data/app-state.json
```

同一台电脑和手机访问同一个服务地址时，会共享会话、设置、角色卡、世界书、外部预设/破限词等状态。
前端会在页面加载、回到页面/获得焦点以及约每 5 秒检查一次服务端状态；如果另一台设备刚修改过，当前设备通常刷新或等待数秒即可看到。
如果某台设备数据最完整，可在“设置 → 数据”点击“上传本机状态”覆盖共享文件；另一台设备点击“从共享文件拉取”即可立即同步。

## 部署到服务器

个人单用户部署可以使用：Python 服务监听 `127.0.0.1:8000`，Nginx 负责 HTTPS、Basic Auth 和反向代理。

阿里云 ECS 部署步骤见：[`docs/ALIYUN_PERSONAL_DEPLOY.md`](docs/ALIYUN_PERSONAL_DEPLOY.md)。

## 主要功能

- 多会话：新建、切换、搜索、重命名、删除、置顶、批量删除，服务端本地文件持久化，可在电脑/手机间共享。
- 流式聊天：`fetch` + `ReadableStream` SSE 解析，支持停止生成、错误提示和部分内容保留。
- Thinking Mode：`thinking.enabled/disabled`、`reasoning_effort`、思考过程折叠展示和 thinking token 估算。
- 内容渲染：Markdown、GFM 表格/任务列表、代码高亮/复制/行号、KaTeX、Mermaid 放大预览、JSON 树。
- Tool Calls：内置 calculator / time / mock weather / mock web search，自定义 tools JSON，strict schema 基础校验，多轮工具调用循环。
- Beta：Chat Prefix Completion 和 FIM Completion。
- 设置：弹窗式设置中心，按 API、模型、思考/输出、System Prompt、破限/预设、角色/背景、世界书、工具、界面、数据分页。
- 酒馆体验：System Prompt、外部破限/预设、角色卡、玩家身份、背景设定、世界书分别管理；破限/预设支持按原版 SillyTavern 方式应用 `system-prompt.json`（prompt_order、role、system_prompt、marker、变量宏和分消息结构），角色卡支持常见 SillyTavern JSON/PNG，世界书支持 JSON 导入。

## 安全说明

- API Key、设置和会话数据默认保存在本机服务端 `data/app-state.json`，用于电脑/手机共享；浏览器 IndexedDB/localStorage 仅作为兜底缓存。
- `data/app-state.json` 可能包含 API Key、角色卡、世界书、破限词和聊天记录，请不要上传或分享该文件。
- 默认启用同源本地代理 `/proxy/*` 转发到 DeepSeek，避免浏览器 CORS 限制；可在设置中关闭。
- Markdown 通过 DOMPurify 清洗，并配置了 CSP。

## 参考文档

- DeepSeek Chat Completion API: https://api-docs.deepseek.com/zh-cn/api/create-chat-completion
- Thinking Mode: https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
- Chat Prefix Completion: https://api-docs.deepseek.com/zh-cn/guides/chat_prefix_completion
- FIM Completion: https://api-docs.deepseek.com/zh-cn/guides/fim_completion
- Function Calling: https://api-docs.deepseek.com/zh-cn/guides/function_calling


## 代码结构

前端已拆分为原生 ES Modules，入口为 `web/js/app.js`，兼容入口为 `web/app.js`。详细说明见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。
