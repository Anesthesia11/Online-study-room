# Online-study-room-
包含 FastAPI WebSocket 后端与纯静态前端，可在本地演示“多人在线 + 音视频 + 个人番茄钟 + 聊天”体验。

## 目录结构

- `backend/app.py`：FastAPI 应用，提供房间管理 REST 接口与 `/ws/rooms/{room_id}` WebSocket。
- `backend/requirements.txt`：后端依赖。
- `frontend/join.html`、`join.css`：登录/进入房间页面。
- `frontend/index.html`、`style.css`、`main.js`：主控制台与音视频界面。

## 运行后端

```powershell
cd c:\study_room\backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

接口说明：

- `POST /rooms` 创建/配置房间（提交 `room_id`、目标、番茄/休息时长）。
- `GET /rooms`/`GET /rooms/{id}` 查询实时状态。
- `POST /rooms/{id}/reset` 快速重置定时器。
- `WS /ws/rooms/{id}` 订阅状态、广播聊天/事件，支持 `join`、`chat`、`timer:*` 等消息。

## 运行前端

方式 1：本地静态服务器（推荐）。

```powershell
cd C:\study_room\frontend
python -m http.server 5500
```

然后访问 `http://127.0.0.1:5500/join.html`，填写房间与昵称后跳转到 `index.html`（主界面会根据 URL/Session 信息自动连接 `ws://127.0.0.1:8000`）。加入页和主界面都提供“切换暗夜模式”按钮，主题选择会自动同步。

方式 2：直接双击 `index.html`。若浏览器提示跨域，可改用方式 1 或用 VS Code Live Server 等轻量 HTTP 服务。

> **外网/自定义部署**：如需让前端连接其它主机，请编辑 `frontend/main.js` 顶部的 `const wsBase = "ws://~.~.~.~:8000"`，换成你的公网 IP 或域名（若走 HTTPS，需要改成 `wss://`），然后重新刷新页面（包括 `join.html` 与 `index.html`）。

## 功能点

- 个人番茄钟：每位用户本地维护专注/休息时长（分钟可调），计时以秒刷新，不再依赖服务器同步；每次专注完成或手动重置都会累积到“番茄钟时长排行”，排行榜仅在本地浏览器保存。
- 房间目标：任何成员可更新当日目标，客户端立即同步。
- 聊天 + 事件流：简单文本聊天与系统事件（加入、离开、计时事件）展示。
- 音视频/屏幕共享：可独立控制麦克风、摄像头及屏幕分享，画面在前端实时拼接，可点击放大。
- 暗夜模式：加入页与主界面均可切换主题，偏好存储于浏览器 LocalStorage 并在两个页面互通。
- 多房间：不同 `room_id` 互不干扰，音视频与聊天状态维护在内存中，方便后续接数据库。

## 音视频控制使用方法

1. 连接房间成功后，页面底部的麦克风/摄像头/屏幕按钮会解锁。首次开启会弹出浏览器授权提示，请选择"允许"。
2. 按钮点亮即表示正在推流：  
   - 麦克风：语音同步到房间内所有成员。  
   - 摄像头：把本地摄像头画面推送到媒体网格。  
   - 屏幕：通过系统选择窗口/屏幕，结束选择或再次点击即可关闭。
3. 媒体网格会为每位成员生成一个卡片（屏幕分享会显示在同一卡片中），点击任意画面可放大查看但不会强制全屏。
4. 关闭浏览器标签页或点击"离开"按钮会自动关闭所有设备并通知其他成员。

## 公网访问（Cloudflare Tunnel 示例）

> WebRTC 设备权限只会在 https/wss 或 localhost 环境生效。以下步骤把本地 5500/8000 通过 Cloudflare Tunnel 暴露成公网域名。

1. **把域名托管到 Cloudflare**  
   - 在 Cloudflare 控制台点击 “Add site” 填入你的 `` 域名。  
   - Cloudflare 会给出两条 NS（如 `hattie.ns.cloudflare.com`、`michael.ns.cloudflare.com`），到域名注册商后台把原 NS（`alioth.dnspod.net`、`information.dnspod.net`）替换掉，等待状态变成 `Active`。若之前启用了 DNSSEC，记得先关闭。  
2. **安装 cloudflared 并登录**  
   ```powershell
   cloudflared tunnel login
   ```  
   浏览器里选择你的域名授权。
3. **创建隧道并配置**  
   ```powershell
   cloudflared tunnel create study-room
   ```  
   在 `%USERPROFILE%\.cloudflared\config.yml` 写入：
   ```yaml
   tunnel: study-room
   credentials-file: C:\Users\(你的用户名))\.cloudflared\study-room.json
   protocol: http2

   ingress:
     - hostname: study.（你的域名）
       service: http://localhost:5500
     - hostname: api.(你的域名)
       service: http://localhost:8000
     - service: http_status:404
   ```
4. **生成 DNS 记录**  
   ```powershell
   cloudflared.exe tunnel route dns study-room study.(你的域名)
   cloudflared.exe tunnel route dns study-room api.（你的域名）
   ```  
   Cloudflare 会自动创建两条 CNAME 指向 `<tunnel-id>.cfargotunnel.com`（橙色云必须开启）。`nslookup -type=ns （你的域名）1.1.1.1` 应显示 Cloudflare NS，`nslookup study.（你的域名）` 能解析到 104/172/188 段 IP。
5. **启动本地服务 & 更新前端**  
   - `backend`：`uvicorn app:app --host 0.0.0.0 --port 8000`  
   - `frontend`：`python -m http.server 5500 --bind 127.0.0.1`  
   - 修改 `frontend/main.js` 顶部为 `const wsBase = "wss://api.（你的域名）";`
6. **运行隧道并访问**  
   ```powershell
   cloudflared.exe tunnel --loglevel debug run study-room
   ```  
   浏览器访问 `https://study.（你的域名）`，即可在公网使用并保持麦克风/摄像头/屏幕分享可用。

## 常见问题排查

- `navigator.mediaDevices` 为空：必须通过 https/wss 或 `http://localhost` 访问页面。  
- `cloudflared` 命令找不到：在 PowerShell 使用 `.\cloudflared.exe ...`，或把 exe 目录加入 PATH。  
- 访问域名出现 `HTTP ERROR 502`：  
  1. 确认域名 NS 已指向 Cloudflare（`nslookup -type=ns 域名 1.1.1.1`）。  
  2. `study`/`api` CNAME 要指向 `<tunnel-id>.cfargotunnel.com`，必要时重新执行 `cloudflared tunnel route dns ...`。  
  3. 后端与静态服务器必须在本地运行，可用 `Invoke-WebRequest http://127.0.0.1:5500/index.html`、`http://127.0.0.1:8000/rooms` 自测。  
  4. `cloudflared --loglevel debug run ...` 日志里若没有 `Proxying request to http://localhost:5500`，说明请求还没进隧道，多半是 DNS 缓存未刷新（`ipconfig /flushdns`）或 NS 未修改。  
- `failed to dial to edge with quic`：网络限制了 QUIC，可在 `config.yml` 加 `protocol: http2` 或换网络。
