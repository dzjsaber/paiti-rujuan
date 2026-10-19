# 拍题入卷备份服务

可选的个人云端备份后端：邮箱验证码登录（免密码） + JWT，每个账号只保存最新一份客户端导出的 JSON 备份。服务端不解析题库，客户端恢复仍按稳定 ID 合并。

## 本地启动

需要 Python 3.10+。PowerShell：

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
# 在 .env 里填写 JWT_SECRET 与 SMTP 配置
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

QQ 邮箱示例：在 QQ 邮箱设置中开启 SMTP 服务并生成授权码，然后填写：

```dotenv
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USERNAME=your-mail@qq.com
SMTP_PASSWORD=your-smtp-authorization-code
SMTP_FROM=your-mail@qq.com
```

`SMTP_PASSWORD` 填邮箱授权码，不是登录密码。授权码只放本机 `server/.env`，不要提交或发到聊天中。

用 `Get-NetIPAddress -AddressFamily IPv4` 查电脑的局域网 IP，手机与电脑连同一 Wi-Fi 后，把客户端里的服务器地址填成 `http://<该IP>:8000`。Windows 防火墙首次可能询问是否允许 Python 入站。

接口文档：`http://127.0.0.1:8000/docs`；健康检查：`http://127.0.0.1:8000/api/health`。

## 测试

```powershell
cd server
.\.venv\Scripts\python -m pytest -q
```

测试使用内存 SQLite 并替换邮件发送函数，覆盖验证码登录、首次建号、验证码复用/过期/错误/锁定、发送冷却、邮件配置缺失、JWT 鉴权、上传下载一致、超限和用户隔离。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:///./paiti.db` | SQLAlchemy 连接串；换 Postgres 时改这里 |
| `JWT_SECRET` | 本地开发占位值 | **部署前必须换成长随机值**，否则 token 可被伪造 |
| `MAX_UPLOAD_MB` | `20` | 与客户端 `MAX_BACKUP_BYTES` 对应的请求体上限 |
| `SMTP_HOST` | 空 | SMTP 服务器，如 `smtp.qq.com` |
| `SMTP_PORT` | `465` | 465 使用 SSL，其他端口使用 STARTTLS |
| `SMTP_USERNAME` | 空 | SMTP 登录账号 |
| `SMTP_PASSWORD` | 空 | 邮箱 SMTP 授权码，不是邮箱密码 |
| `SMTP_FROM` | 同 `SMTP_USERNAME` | 发件人地址 |
| `ENV` | `development` | 设为 `production` 时不注册开发 CORS |
| `CORS_ORIGINS` | Expo Web 开发地址 | 逗号分隔 |

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/request-code` | `{email}`；发送 6 位验证码，10 分钟有效 |
| POST | `/api/auth/verify-code` | `{email, code}` → `{token}`；首次验证自动建号 |
| PUT | `/api/backup` | Bearer JWT；保存最新备份，返回 `{version, updatedAt}` |
| GET | `/api/backup` | Bearer JWT；返回备份原文，没有则 404 |
| GET | `/api/health` | `{ok: true}` |

## 部署前注意

- 备份 JSON 含题库与做题记录，SQLite 中为明文；只应部署在可信的个人服务器上，并自行做好磁盘备份和访问控制。
- 公网使用 HTTPS 反向代理；不要把开发服务器直接暴露到公网。
- 当前只保留每个账号最新一份备份，上传会覆盖上一份。多设备同时上传时以最后一次为准。
- 验证码只存 HMAC 哈希，一次性使用；同邮箱 60 秒冷却、每小时最多 5 次，同 IP 每小时最多 30 次，单码最多尝试 5 次。
