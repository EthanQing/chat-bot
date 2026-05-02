# 项目结构说明

本项目保持“无需前端构建工具”的部署方式：`python main.py` 启动本地静态服务，浏览器直接加载原生 ES Modules。

## 目录

```text
.
├── main.py                 # 本地静态服务器 + DeepSeek 代理 + 共享状态接口
├── data/                   # 运行时生成；服务端共享状态，已 gitignore
│   └── app-state.json      # 会话/设置/角色卡/世界书/破限词等共享数据
├── README.md               # 启动和功能说明
├── system-prompt.json      # 用户提供的系统提示词/预设示例
├── docs/
│   └── ARCHITECTURE.md     # 本文件
└── web/
    ├── index.html          # 页面骨架与设置面板
    ├── styles.css          # 全局样式
    ├── app.js              # 兼容入口：import './js/app.js'
    └── js/
        ├── app.js              # 应用入口与 UI/状态编排
        ├── config.js           # 常量、默认设置、内置工具定义、Prompt 模板
        ├── utils.js            # 通用工具函数
        ├── storage.js          # 服务端共享状态优先，IndexedDB/localStorage 兜底
        ├── deepseek-api.js     # DeepSeek 请求、SSE 流式解析
        ├── message-parsers.js  # thinking/role_state/suggestions 抽取与折叠
        ├── character-card.js   # SillyTavern 角色卡 JSON/PNG 解析与编译
        ├── prompt-import.js    # System Prompt / 外部预设 JSON 导入与编译
        ├── world-book.js       # 世界书/lorebook JSON 解析、关键词触发与提示词编译
        └── tool-runtime.js     # 内置工具执行与 tools schema 校验
```

## 模块职责

### `web/js/app.js`
负责应用编排：

- DOM 绑定和事件处理
- 会话管理与 IndexedDB/localStorage 本地持久化
- 会话管理与服务端共享状态同步
- 设置面板同步
- 消息列表渲染
- 流式生成生命周期
- 导入/导出入口
- RP 模式、外部预设、角色卡、背景设定与世界书 UI 编排

它可以调用其它模块，但其它模块不依赖它。

### `web/js/config.js`
集中放置稳定配置：

- IndexedDB/localStorage 存储 key
- 默认系统提示词
- 默认设置
- 模型说明
- Prompt 模板
- 内置 tools 定义

### `web/js/storage.js`
负责本地持久化：

- 优先读写同源 `/api/state`，状态文件默认在 `data/app-state.json`
- 电脑和手机访问同一个本地服务时共享同一份会话、设置、角色卡、世界书、外部预设/破限词
- 首次迁移时，如果服务端为空，会自动把当前浏览器 IndexedDB/localStorage 数据上传到服务端
- IndexedDB/localStorage 保留为离线/服务端接口异常时的兜底缓存
- 浏览器启动时会先显示本地缓存，但会强制校验一次服务端共享文件；校验完成前不会把本地旧缓存上传到服务端
- 同步轮询带超时、指数退避和防回退检查：如果新 revision 看起来像旧快照（消息数减少、助手回复被截断），前端会保留本机较完整数据并回写修复共享文件

### `main.py`
负责本地服务：

- 静态文件服务
- `/proxy/*` DeepSeek 同源代理
- `/api/state` 共享状态读写接口
- 原子写入 `data/app-state.json`，并保留上一次 `app-state.json.bak`

### `web/js/deepseek-api.js`
只处理网络层：

- 同源代理或直连 DeepSeek
- 429/500/503 重试
- SSE `data:` 解析
- `reasoning_content` / `content` / `tool_calls` delta 合并

### `web/js/message-parsers.js`
处理模型输出清洗：

- 抽取 `<thinking>` / `<think>` 到思考区
- 抽取 `role_state` / 状态栏到折叠元数据
- 抽取 `<suggestions>` 为可点击行动选项

### `web/js/character-card.js`
处理酒馆角色卡：

- JSON 卡解析
- PNG `tEXt/iTXt` 元数据解析
- `{{char}}` / `{{user}}` 占位符替换
- 编译角色卡上下文

### `web/js/prompt-import.js`
处理 System Prompt / 外部预设导入：

- 简单 JSON 字段
- OpenAI messages
- SillyTavern prompts + prompt_order 预设
- 过滤会污染最终回复的格式模板/显式思维链模板

同一套解析能力可被“System Prompt”页和“破限/预设”页复用；后者不会覆盖基础 System Prompt，而是保存到当前会话的独立外部预设字段。SillyTavern `system-prompt.json` 会按原版酒馆的方式读取 `prompt_order`、`role`、`system_prompt` 与 marker，展开 `setvar/addvar/getvar` 变量，保留 system/user/assistant 分消息结构，并丢弃扩展配置等不会作为提示词发送的 JSON 字段。

### `web/js/world-book.js`
处理世界书：

- 支持常见 `entries` / `world_info.entries` / `lorebook.entries` / `character_book.entries` JSON 结构
- 统一 key、secondary key、constant、selective、order 等字段
- 根据最近消息和背景上下文触发条目
- 将触发条目编译为独立上下文，和角色卡分开注入

### `web/js/tool-runtime.js`
处理内置工具：

- calculator
- get_current_time
- mock weather
- mock web_search
- strict JSON schema 基础校验

## 维护原则

1. **不引入构建工具**：保持浏览器原生 ES Modules。
2. **模块尽量纯函数化**：解析器、工具、角色卡导入不直接访问 DOM。
3. **网络层和 UI 分离**：DeepSeek 请求逻辑放在 `deepseek-api.js`。
4. **角色卡/背景/世界书不是 System Prompt**：仍由 `app.js` 作为独立上下文拼接进请求；外部破限/预设则作为单独的额外 system 预设保存和注入。
5. **输出清洗集中维护**：新增需要折叠/隐藏的模型输出格式时，优先改 `message-parsers.js`。
