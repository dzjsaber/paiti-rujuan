# dist-agent · 构建验证产物

- **添加于**：2026-10-20
- **对应改动**：轻量 Agent 化讲解（教材 / 题库 / 错题三个只读工具、最多 3 轮、Skill 路由和过程状态展示）。
- **验证**：`npx tsc --noEmit`、8 套客户端离线测试（126 项）、后端 pytest 均通过。
- **EAS APK**：`4b2b2109-f896-4d2c-ad62-d6906a81b0db`（提交 `679ac08`），
  下载：https://expo.dev/artifacts/eas/2MTfcVjgtUL6QNOos6sbGV-FbBpzZ6eLNLhCghGZRPY.apk
- **内容**：Expo Android 导出产物（`.hbc` JS bundle + `metadata.json`）；仅用于确认该次代码变更可正常构建，与应用运行、数据备份无关，可安全忽略。
