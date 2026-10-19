# dist-new · 构建验证产物

- **添加于**：2026-10-20
- **对应改动**：新增可选云端备份；认证采用免密码邮箱验证码（SMTP + JWT），支持从剪贴板粘贴验证码。
- **验证**：`npx tsc --noEmit`、全部客户端离线测试、后端 pytest 与本地 uvicorn 冒烟均通过。
- **内容**：Expo Android 导出产物（`.hbc` JS bundle + `metadata.json`）；仅用于确认该次代码变更可正常构建，与应用运行、数据备份无关，可安全忽略。
