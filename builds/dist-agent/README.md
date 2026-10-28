# dist-agent · 构建验证产物

- **添加于**：2026-10-20
- **对应改动**：轻量 Agent 化讲解（教材 / 题库 / 错题三个只读工具、最多 3 轮、Skill 路由、有限追问和过程状态展示）。
- **验证**：`npx tsc --noEmit`、8 套客户端离线测试（126 项）、后端 pytest 均通过。
- **EAS APK**：`f63eecdd-c706-44ca-805c-51b22735909c`（versionCode 3，提交 `7f34ea2`），
  下载：https://expo.dev/artifacts/eas/JCNfIM6eXBO4kz7MO8vGVhfAV2FtlH1SQ2Z65PgepPQ.apk
- **GitHub Release APK**：
  https://github.com/dzjsaber/paiti-rujuan/releases/download/%E6%8B%8D%E9%A2%98%E5%85%A5%E5%8D%B7/paiti-rujuan-v3-7f34ea2.apk
- **内容**：Expo Android 导出产物（`.hbc` JS bundle + `metadata.json`）；仅用于确认该次代码变更可正常构建，与应用运行、数据备份无关，可安全忽略。
