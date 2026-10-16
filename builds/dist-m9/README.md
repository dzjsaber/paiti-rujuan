# dist-m9 · 构建验证产物

- **添加于**：2026-10-16（提交 `5e0d5c1`）
- **对应改动**：AI 讲解与题目自带解析分开存储（schema v7 加 ai_explanation 列）：讲解自动保存/删除/重新生成只影响 ai_explanation，自带解析永不被覆盖；…
- **内容**：Expo Android 导出产物（`.hbc` JS bundle + `metadata.json`）；仅用于确认该次代码变更可正常构建，与应用运行、数据备份无关，可安全忽略。

