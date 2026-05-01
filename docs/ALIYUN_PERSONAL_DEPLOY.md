# 阿里云 ECS 个人单用户部署指南

本项目适合按“个人单用户服务”方式部署：一台 ECS、一份服务端状态文件、一个访问密码。

> 重要：`data/app-state.json` 里可能保存 API Key、角色卡、世界书、破限词和聊天记录。不要把 8000 端口直接暴露到公网，建议只开放 Nginx 的 80/443，并开启 HTTPS + Basic Auth。

## 推荐架构

```text
浏览器/手机
   │ HTTPS + 密码
   ▼
Nginx :443
   │ 反向代理
   ▼
Python 服务 127.0.0.1:8000
   │
   └── data/app-state.json
```

## 1. 准备 ECS

推荐系统：Ubuntu 24.04 LTS。

阿里云安全组只开放：

- `22`：SSH，仅建议限制为你的 IP
- `80`：申请证书用
- `443`：正式访问

不要开放 `8000`。

## 2. 安装依赖

```bash
sudo apt update
sudo apt install -y git python3 nginx apache2-utils certbot python3-certbot-nginx
```

## 3. 上传或拉取项目

示例目录：

```bash
sudo mkdir -p /opt/chat-bot
sudo chown -R "$USER":"$USER" /opt/chat-bot
cd /opt/chat-bot
```

如果你用 Git：

```bash
git clone <你的仓库地址> .
```

如果不用 Git，可以从本机上传：

```bash
scp -r /path/to/chat-bot user@你的服务器IP:/opt/chat-bot
```

## 4. 创建 systemd 服务

创建服务文件：

```bash
sudo nano /etc/systemd/system/chat-bot.service
```

写入：

```ini
[Unit]
Description=Personal Chat Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/chat-bot
Environment=HOST=127.0.0.1
Environment=PORT=8000
Environment=CHATBOT_DATA_DIR=/opt/chat-bot/data
ExecStart=/usr/bin/python3 /opt/chat-bot/main.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now chat-bot
sudo systemctl status chat-bot
```

确认本机服务正常：

```bash
curl http://127.0.0.1:8000/health
```

## 5. 配置 Nginx + 密码

创建访问密码：

```bash
sudo htpasswd -c /etc/nginx/.chatbot.htpasswd 你的用户名
```

创建站点配置：

```bash
sudo nano /etc/nginx/sites-available/chat-bot
```

如果你有域名，写入并替换 `chat.example.com`：

```nginx
server {
    listen 80;
    server_name chat.example.com;

    client_max_body_size 100m;

    auth_basic "Private Chat Bot";
    auth_basic_user_file /etc/nginx/.chatbot.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 流式输出/SSE 需要关闭代理缓冲
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

启用站点：

```bash
sudo ln -s /etc/nginx/sites-available/chat-bot /etc/nginx/sites-enabled/chat-bot
sudo nginx -t
sudo systemctl reload nginx
```

## 6. 配置 HTTPS

确保域名 A 记录已经指向 ECS 公网 IP，然后执行：

```bash
sudo certbot --nginx -d chat.example.com
```

完成后访问：

```text
https://chat.example.com
```

手机和电脑访问同一个域名，就会共享同一份服务端状态。

## 7. 日常维护

查看日志：

```bash
sudo journalctl -u chat-bot -f
```

重启服务：

```bash
sudo systemctl restart chat-bot
```

备份数据：

```bash
cp /opt/chat-bot/data/app-state.json /opt/chat-bot/data/app-state.$(date +%F-%H%M%S).json
```

更新代码：

```bash
cd /opt/chat-bot
git pull
sudo systemctl restart chat-bot
```

## 个人使用的安全建议

- 只开放 `80/443/22`，不要开放 `8000`。
- 一定要给 Nginx 加 Basic Auth。
- 尽量使用 HTTPS，不建议在公网 HTTP 下输入 API Key。
- 定期备份 `data/app-state.json`。
- 如果只是临时外网访问，也可以考虑 Tailscale / ZeroTier / WireGuard，不把网站公开到公网。
