# 项目结构说明

本项目保持“无需前端构建工具”的部署方式：`python main.py` 启动 FastAPI/Uvicorn 服务，浏览器直接加载原生 ES Modules。

## 目录

```text
.
├── main.py                 # FastAPI 静态服务 + DeepSeek 代理 + SQLite/WebSocket 数据层
├── data/                   # 运行时生成；已 gitignore
│   ├── chat-bot.sqlite3    # 会话/设置/角色卡/世界书/破限词等唯一权威数据源
│   └── app-state.json      # 旧版本整包状态；仅首次迁移时读取，不再写入
├── README.md
├── docs/
│   └── ARCHITECTURE.md
└── web/
    ├── index.html
    ├── styles.css
    ├── app.js              # 兼容入口：import './js/app.js'
    └── js/
        ├── app.js              # 应用入口与 UI/状态编排
        ├── data-client.js      # WebSocket 生命周期、bootstrap、会话按需加载、op 队列
        ├── storage.js          # 兼容 app.js 的 SQLite/WebSocket 持久化包装层
        ├── config.js
        ├── utils.js
        ├── deepseek-api.js
        ├── message-parsers.js
        ├── character-card.js
        ├── prompt-import.js
        ├── world-book.js
        └── tool-runtime.js
```

## 数据层

### 服务端

`main.py` 提供：

- `GET /health`
- `GET /api/config`
- `POST /proxy/deepseek`
- `WebSocket /ws`
- 静态页面与资源

已删除旧版 `/api/state`、`/api/state/meta` 和 `app-state.json` 整包写入逻辑。

SQLite 表：

- `app_meta`：schema version、data revision、迁移来源等。
- `global_settings`：全局设置逐项存储。
- `conversations`：会话元信息。
- `conversation_settings`：会话级设置逐项存储。
- `messages`：消息逐条存储。
- `resources`：Prompt 模板、破限预设、角色卡、世界书、正则脚本、reasoning 模板。

每个 WebSocket 写操作在一个 SQLite transaction 中完成；成功后递增 `app_meta.data_revision`，回复 `ack` 并向其它连接广播 `event`。

### 前端

`web/js/data-client.js` 负责：

- 连接 `/ws` 并维护 `connected / reconnecting / offline` 状态。
- 接收 bootstrap；bootstrap 只含设置、会话列表、资源，不一次性加载全部历史消息。
- 切换会话时发送 `conversation.load` 加载该会话消息。
- 把 UI 内存状态变更转换为最小 WebSocket op（设置、会话、消息、资源、备份替换）。
- 断线期间把 op 保存在内存队列，重连后按序重发。
- 接收其它标签页广播的 event 并更新当前内存状态。

浏览器不再使用 IndexedDB/localStorage 保存业务数据。

## 维护原则

1. **SQLite 是唯一权威数据源**：前端只保留 UI 内存状态。
2. **写入用最小 op**：正常编辑不上传整包状态；备份导入使用 `backup.replaceAll`。
3. **按需加载消息**：首屏加载会话列表，切换会话才加载消息。
4. **不引入前端构建工具**：保持浏览器原生 ES Modules。
5. **网络层和 UI 分离**：DeepSeek 请求逻辑放在 `deepseek-api.js`，数据同步放在 `data-client.js`。
