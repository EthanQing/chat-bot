# 个人公网 IP 部署指南：无域名，使用 12321 端口

本指南只针对你的当前需求：

1. **不使用 8000 端口**
2. **公网访问端口使用 12321**
3. **没有域名，只用服务器公网 IP**
4. **个人使用，只是不想电脑一直开着**

最终访问地址类似：

```text
https://你的服务器公网IP:12321
```

浏览器会提示“证书不受信任”，这是因为没有域名时只能用自签 HTTPS 证书。个人使用可以接受，或者手动信任证书。

---

## 最终架构

```text
手机/电脑浏览器
   │
   │ https://公网IP:12321
   │ Basic Auth 密码保护
   ▼
Nginx 监听公网 12321
   │
   │ 反向代理到本机内部端口
   ▼
Python 服务 127.0.0.1:12322
   │
   ▼
/opt/chat-bot/data/app-state.json
```

为什么 Python 用 `12322`？

- `12321` 给 Nginx 对公网监听。
- Python 服务只在服务器内部监听 `127.0.0.1:12322`。
- 这样公网只暴露 Nginx，不直接暴露 Python 服务。
- 整个方案完全不使用 `8000`。

---

## 0. 腾讯云安全组

在腾讯云控制台安全组放行：

```text
TCP 22      SSH 登录
TCP 12321   浏览器访问
```

不需要开放：

```text
80
443
8000
12322
```

其中 `12322` 只给服务器本机内部使用，不能开放到公网。

---

## 1. 安装依赖

登录服务器后执行：

```bash
sudo apt update
sudo apt install -y git python3 nginx apache2-utils openssl
```

---

## 2. 放置项目

推荐放在：

```text
/opt/chat-bot
```

如果还没拉代码：

```bash
sudo mkdir -p /opt/chat-bot
sudo chown -R "$USER":"$USER" /opt/chat-bot
cd /opt/chat-bot
git clone <你的仓库地址> .
```

如果代码已经在 `/opt/chat-bot`，跳过这一步。

确认文件存在：

```bash
ls -la /opt/chat-bot/main.py
```

---

## 3. 配置 systemd：Python 内部服务 12322

先把运行参数和 DeepSeek API Key 放到服务器环境变量文件里。这样前端不需要填写 API Key，也不会把 Key 存到共享状态文件里。

```bash
sudo vim /etc/chat-bot.env
```

写入：

```ini
DEEPSEEK_API_KEY=sk-你的真实Key
HOST=127.0.0.1
PORT=12322
CHATBOT_DATA_DIR=/opt/chat-bot/data
```

限制权限：

```bash
sudo chmod 600 /etc/chat-bot.env
```

编辑服务文件：

```bash
sudo vim /etc/systemd/system/chat-bot.service
```

写入：

```ini
[Unit]
Description=Personal Chat Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/chat-bot
EnvironmentFile=/etc/chat-bot.env
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

测试 Python 内部服务：

```bash
curl http://127.0.0.1:12322/health
curl http://127.0.0.1:12322/api/config
```

看到类似下面内容说明 Python 服务正常，且服务端 API Key 已生效：

```json
{"ok": true}
```

```json
{"serverApiKeyConfigured": true, "maxStateBodyBytes": 83886080}
```

如果不正常，看日志：

```bash
sudo journalctl -u chat-bot -n 80 --no-pager
```

---

## 4. 创建访问密码

创建 Basic Auth 用户名和密码：

```bash
sudo htpasswd -c /etc/nginx/.chatbot.htpasswd 你的用户名
```

之后浏览器访问时，会先要求输入这个用户名和密码。

如果以后要改密码：

```bash
sudo htpasswd /etc/nginx/.chatbot.htpasswd 你的用户名
```

---

## 5. 生成自签 HTTPS 证书

把下面命令里的 `你的服务器公网IP` 换成真实公网 IP。

例如你的 IP 是 `1.2.3.4`，就把两处都改成 `1.2.3.4`。

```bash
sudo mkdir -p /etc/nginx/self-signed
sudo openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/nginx/self-signed/chat-bot.key \
  -out /etc/nginx/self-signed/chat-bot.crt \
  -subj "/CN=你的服务器公网IP" \
  -addext "subjectAltName = IP:你的服务器公网IP"
```

---

## 6. 配置 Nginx：公网监听 12321

编辑 Nginx 配置：

```bash
sudo vim /etc/nginx/sites-available/chat-bot
```

写入：

```nginx
server {
    listen 12321 ssl default_server;
    server_name _;

    ssl_certificate /etc/nginx/self-signed/chat-bot.crt;
    ssl_certificate_key /etc/nginx/self-signed/chat-bot.key;

    client_max_body_size 100m;

    auth_basic "Private Chat Bot";
    auth_basic_user_file /etc/nginx/.chatbot.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:12322;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 流式回复/SSE 必须关闭缓冲
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

启用配置：

```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/chat-bot /etc/nginx/sites-enabled/chat-bot
sudo nginx -t
sudo systemctl reload nginx
```

---

## 7. 访问

浏览器打开：

```text
https://你的服务器公网IP:12321
```

首次访问会出现证书警告：

```text
此连接不是私密连接
证书不受信任
```

这是自签证书的正常现象。个人使用可以选择继续访问。

然后浏览器会弹出用户名/密码窗口，输入第 4 步创建的 Basic Auth 账号。

进入应用后，设置里的 API Key 输入框应该显示为：

```text
已使用服务器环境变量 DEEPSEEK_API_KEY
```

此时前端 API Key 留空即可。

---

## 8. 检查命令

检查 Python 服务：

```bash
sudo systemctl status chat-bot
curl http://127.0.0.1:12322/health
curl http://127.0.0.1:12322/api/config
```

检查 Nginx：

```bash
sudo nginx -t
sudo systemctl status nginx
```

检查端口监听：

```bash
sudo ss -lntp | grep -E '12321|12322'
```

正常应该看到：

```text
nginx   0.0.0.0:12321
python  127.0.0.1:12322
```

如果公网访问失败，检查腾讯云安全组是否放行了 `TCP 12321`。

---

## 9. 日常维护

查看应用日志：

```bash
sudo journalctl -u chat-bot -f
```

重启应用：

```bash
sudo systemctl restart chat-bot
```

重载 Nginx：

```bash
sudo systemctl reload nginx
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

---

## 10. 重要提醒

这个方案是个人自用方案，不是多用户 SaaS。

安全边界是：

- 公网只开放 `12321`
- Nginx 使用 HTTPS
- Nginx 使用 Basic Auth 密码
- Python 服务只监听 `127.0.0.1:12322`
- 不开放 `8000`
- 不开放 `12322`

如果你以后买了域名，可以再换成正式域名证书；目前不需要。
