# visitor-logger

一个极简的访客信息收集网站。用户打开页面时，服务端记录其 IP、请求头、Client Hints 等，页面脚本再采集浏览器端可获取的信号（屏幕、时区、Canvas/WebGL/音频指纹、字体、WebRTC IP、电量、权限、WebAuthn、传感器、媒体查询等），合并后追加写入 `data/visits.jsonl`（每行一条 JSON，按大小轮转）。

零依赖，仅需 Node.js 18+。（GeoIP 为可选增强，见下。）

## 快速开始

```bash
cd visitor-logger
npm start            # 等价于 node server.js
```

浏览器打开 `http://localhost:3000`，访问记录即写入 `data/visits.jsonl`。启动时控制台会打印局域网地址 `reachable on http://<lan-ip>:<port>`，便于分享。Windows 也可双击 `start.bat`。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 绑定地址（本地专用设 `127.0.0.1`） |
| `VIEW_TOKEN` | 空 | 读取 `/logs` 的密钥；为空则该接口返回 404 |
| `TRUST_PROXY` | `0` | 信任的代理跳数。`0`=直连，限速与 IP 取 TCP 对端地址（不可伪造）；`>0`=部署在 Cloudflare/反代后，按 `cf-connecting-ip`/`X-Forwarded-For` 还原 |
| `MAX_LOG_BYTES` | `50MB` | 单文件上限，超出轮转为 `visits.jsonl.1` |

示例：

```bash
PORT=8080 VIEW_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))") \
  TRUST_PROXY=1 node server.js
```

## 读取日志

优先用 Bearer 头（避免 token 出现在 URL 日志里）：

```bash
curl -H 'Authorization: Bearer <TOKEN>' 'http://localhost:3000/logs?limit=10'
```

也可用查询参数：`curl 'http://localhost:3000/logs?token=<TOKEN>&limit=10'`。`limit` 上限 1000，默认 100；服务端只读文件尾部 ~512KB，避免大日志撑爆内存。

日志文件 `data/visits.jsonl` 可直接处理：

```bash
jq -s . data/visits.jsonl      # 转为 JSON 数组
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 返回首页（HTML 响应带 `Accept-CH`，触发前端采集并 POST 到 `/log`） |
| `POST` | `/log` | 仅接受 `application/json`；合并服务端+客户端数据写盘（写失败返回 500） |
| `GET` | `/logs?token=&limit=` | 读取最近记录（需 `VIEW_TOKEN`，Bearer 或 query） |
| `GET` | `/health` | 健康检查 |

## 采集的字段

**服务端（每条记录顶层）**
- `id`, `received_at`, `received_at_ms`
- `ip`（`TRUST_PROXY>0` 时按 `cf-connecting-ip`→`true-client-ip`→`x-real-ip`→`x-forwarded-for` 首项→套接字；否则套接字地址）
- `geo`（可选，见下；未启用为 `null`）
- `socket_address`, `method`, `url`, `path`, `query`, `http_version`
- 代理/CDN 头：`cf_connecting_ip`, `true_client_ip`, `x_real_ip`, `x_forwarded_for`, `cf_ipcountry/region/city`, `host`
- Client Hints：`sec_ch_ua`, `sec_ch_ua_full_version_list`, `sec_ch_ua_platform(_version)`, `sec_ch_ua_arch`, `sec_ch_ua_bitness`, `sec_ch_ua_model`, `sec_ch_ua_wow64`, `sec_ch_ua_mobile`
- `headers`：全部请求头（含 `user-agent`、`accept-language`、`referer`、`cookie` 等）

**客户端（`client` 字段下）**
- `page`：href、origin、path、search、hash、referrer、title、characterSet、`history_length`
- `time`：时区、偏移、locale、calendar、numberingSystem
- `navigator`：userAgent、platform、language/languages、hardwareConcurrency、deviceMemory、maxTouchPoints、webdriver、cookieEnabled、doNotTrack、vendor、`ua_data`（brands/mobile/platform）
- `screen`/`window`：分辨率、可用区、色深、devicePixelRatio、内外尺寸、orientation
- `touch`、`storage`（localStorage/sessionStorage/indexedDB/cookie）
- `connection`：effectiveType、downlink、rtt、saveData
- `plugins`、`mime_types`、`speech_voices`
- `performance`：navigation 类型、TTFB、domComplete、loadEnd、transferSize、encodedBodySize、JS 堆内存（`performance.memory`，Chrome）
- `worker`：Worker/SharedWorker/ServiceWorker 支持 + controller
- `sensors`：Accelerometer/Gyroscope/Magnetometer/AmbientLight 等可用性
- `gamepads`、`tab`（visibility/hidden/focus）、`media`（prefers-color-scheme/reduced-motion/forced-colors/pointer/hover/color-gamut/inverted）
- 指纹：`canvas_fingerprint`、`webgl`（vendor/renderer）、`fonts`、`audio`（OfflineAudioContext 哈希）
- `codecs`（hevc/av1/vp9/aac/opus 解码能力）、`storage_estimate`（quota/usage）
- `media_devices_count`、`permissions`（20+ 项权限状态）、`battery`、`webrtc_ips`（本机+公网 IP）、`adblock`
- `ua_data_high`（fullVersionList/platformVersion/architecture/bitness/model/wow64）
- `webauthn`（平台认证器可用性）

## 可选 GeoIP（归属地 / ASN）

```bash
npm install maxmind
# 将 MaxMind GeoLite2-City.mmdb / GeoLite2-ASN.mmdb 放进 data/
```

启用后每条记录的 `geo` 字段含 `country/region/city/lat/lon/asn/org`。未安装则保持零依赖、`geo` 为 `null`。

## 部署

- **反代/CDN**：部署在 Cloudflare 或 nginx 后时务必设 `TRUST_PROXY=1`（或对应跳数），否则限速会被伪造头绕过、且 IP 记为代理地址。
- **TLS 指纹（JA3/JA4）**：Node 应用层拿不到 ClientHello；要在反代层采集（如 nginx + ja3 模块，或 Cloudflare 的 `ja3`/`ja4` 透传头）。
- **常驻进程**：Linux 用 `pm2 start server.js --name visitor-logger` 或 systemd；Windows 用 `nssm` 注册服务或 `pm2`。
- **轮转**：默认 50MB 轮转一次；更大量级建议外挂 logrotate。

## 安全与合规

- `/log` 仅接受 `application/json`（阻断跨站表单 CSRF 注入）；按 TCP 对端地址限速 60 次/分钟（`TRUST_PROXY=0` 时不可伪造）。
- `/logs` 默认禁用；启用后需 Bearer/Token（`crypto.timingSafeEqual` 比对），尾部有界读取并限速。
- **注意**：`headers` 与 `client.storage.cookies` 会原文记录 Cookie / 可能的 `Authorization` 等敏感头。这是"尽可能多收集"的直接后果——日志文件本身需妥善保护（权限、加密、访问控制），避免凭据泄露。
- 仅在**你自己的站点**或**已告知访客**的情况下使用；公开部署前请加隐私说明/Cookie 横幅，并遵守适用法律（GDPR、PIPL 等）。
