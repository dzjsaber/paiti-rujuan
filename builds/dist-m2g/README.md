# dist-m2g · 构建验证产物

- **添加于**：2026-10-16（提交 `f543be4`）
- **对应改动**：修复文档导入读取失败：Android content:// 地址改用 legacy ContentResolver 读取（兼容微信/文件管理来源）
- **内容**：Expo Android 导出产物（`.hbc` JS bundle + `metadata.json`）；仅用于确认该次代码变更可正常构建，与应用运行、数据备份无关，可安全忽略。

