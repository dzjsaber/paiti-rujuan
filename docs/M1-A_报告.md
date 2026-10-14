# 拍题入卷 M1-A 报告：项目骨架与依赖方案确认

- 日期：2026-10-15（Asia/Shanghai）
- 范围：项目骨架、工具链核实、高风险依赖验证、目录结构与数据流方案
- 状态：真机 FTS5 自检已完成（2026-10-15，结果见 3.1）；图片压缩自检待补（不阻塞）

## 1. 阶段目标与验收标准

目标：确认技术栈可落地（Expo/Android 工具链、SQLite FTS5、图片压缩、文档解析、
模型接口集成），给出目录结构、关键文件职责、数据流与依赖清单，等用户确认后进入 M1-B。

验收标准：

1. 工具链在本机可跑通（create → install → typecheck → doctor → bundle）。
2. 高风险点有明确结论：哪些本机已验证、哪些需真机、哪些有限制。
3. 目录结构覆盖文档要求的全部组件位置（RecognitionEngine、LLMService、
   ResponseParser、F2、数据库层、导入草稿持久化层）。
4. 依赖清单含许可证与实测状态，npm audit 如实报告。

## 2. 环境与工具链核实（实测）

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| Node.js | 本机原无 → 已用户级安装 v24.22.0 | 官方 zip 解压到 `%LOCALAPPDATA%\Programs\nodejs`，用户级 PATH；无 UAC、可回滚 |
| npm | 11.19.1 | 随 Node 安装 |
| 项目初始化 | `create-expo-app`（blank-typescript）成功 | 项目位于 `D:\86177\Documents\paiti-rujuan` |
| Expo SDK | 57.0.29 / React Native 0.86.3 / React 19.2.3 / TS 6.0.3 | 当前最新稳定 |
| 原生模块安装 | `npx expo install` 6 个模块成功 | expo-sqlite / expo-camera / expo-image-picker / expo-document-picker / expo-secure-store / expo-image-manipulator |
| TypeScript | `npx tsc --noEmit` 通过（0 错误） | 含自检页与验证模块 |
| 依赖兼容性 | `npx expo-doctor` 21/21 通过 | 无版本冲突 |
| Hermes 打包 | `npx expo export --platform android` 成功 | 基线 621 模块 1.6MB；含解析库后 709 模块 2.6MB |
| JDK / Android SDK | 本机为旧 Java 8、无 Android SDK | 一期真机调试走 Expo Go（无需 JDK/SDK）；本地打 APK 需另装 JDK 17+ 与 SDK，或用 EAS 云构建（涉及账号，需用户确认） |

## 3. 高风险点验证结果

### 3.1 expo-sqlite FTS5 / trigram（真机已验证，2026-10-15）

- 官方文档（已核验）：`enableFTS` 默认 true，含 FTS3/4/5。
- 本机：模块可打包进 Hermes bundle（见第 2 节）。
- 真机（iQOO 11 / Expo Go）实测结果：
  - SQLite 版本：**3.50.3**
  - FTS5 trigram 建表：**成功**
  - `trigram MATCH「细胞膜」(3字)` → 1 条 ✓
  - `trigram MATCH「函数」(2字)` → 0 条（不报错，但无法命中）
  - `LIKE 回退「函数」` → 1 条 ✓
  - `LIKE「DNA」` → 1 条 ✓
- 结论：**短于 3 字符的查询必须走 LIKE 回退**——文档 §3.3 的策略获得真机证据。
- 待补：图片压缩真机自检（自检页第二个按钮），不阻塞 M1-B。

### 3.2 图片压缩（真机待验证）

- 采用 expo-image-manipulator 新 API（`ImageManipulator.manipulate → resize →
  renderAsync → saveAsync`，JPEG q0.85，长边 2000）。
- 自检页提供按钮：选图 → 压缩 → 显示前后尺寸；真机执行即可确认。

### 3.3 文档解析依赖（已完成，结论明确）

| 库 | 版本 | 结论 |
| --- | --- | --- |
| mammoth（DOCX） | 1.13.0 | **可打包**。BSD-2-Clause（用户已批准选项 A）。运行时解析留待 M2 实测 |
| pdfjs-dist | 6.4.299 | **打包失败**：`await import(/*webpackIgnore*/ ...)` 触发 hermesc "Invalid expression encountered"（默认与 legacy 构建均失败） |
| pdfjs-dist | 4.2.67（安全修复版） | **打包失败**：同类动态 import（worker/canvas/path2d） |
| pdfjs-dist | 3.11.174 | **可打包**（当前选用）。但受 GHSA-wgrm-67xf-hhpq 影响（≤4.1.392，CVE-2024-4367 类：解析恶意 PDF 可触发 JS 执行） |

pdfjs-dist 处理决定（已写入代码注释，M2 实现必须遵守）：

1. 使用 3.11.174，`getDocument` 时设置 `isEvalSupported: false`（官方缓解）；
2. 只调用 `getTextContent()`，不渲染页面、不执行 PDF 内嵌脚本；
3. 升级路径记入技术债：等 pdfjs-dist 修复 Hermes 兼容或 RN 侧出现可行 polyfill 后升级。

### 3.4 模型接口集成方式（M0 已验证协议，RN 侧实现方案）

- RN 侧用内置 `fetch` + 手写 base64（Expo 无 Node Buffer 依赖）调用
  `https://open.bigmodel.cn/api/paas/v4/chat/completions`。
- 关键参数：`model: glm-4.6v-flash`（视觉）/ `glm-4.7-flash`（文本）、
  低 temperature、`max_tokens` 8192、`thinking` 开关；图片 ≤5MB、≤6000×6000、JPEG。
- 重试策略：仅对超时/网络瞬断/5xx/1302/1305 退避重试 1 次（间隔 ≥20s），
  永久性错误（1211/1213/1214/1113/1001 等）不重试。
- API Key：用户自带，存 SecureStore；不内置于源码。

## 4. 建议目录结构与关键文件职责

```
paiti-rujuan/
├── App.tsx                     # 入口（当前为 M1-A 自检页，M1-C 起替换为导航壳）
├── app.json / package.json / tsconfig.json
├── src/
│   ├── core/                   # 纯逻辑，不依赖 RN 运行时（可单测）
│   │   ├── models.ts           # QuestionDraft、ImportBatch/Page/Item、状态枚举
│   │   ├── validation/
│   │   │   ├── f2.ts           # F2 确定性校验（V1-V10）
│   │   │   └── normalize.ts    # 答案归一化（多选数组化、判断题布尔化）
│   │   └── dedupe.ts           # source_hash、标准化题干哈希（V5）
│   ├── services/
│   │   ├── llm/
│   │   │   ├── LLMService.ts   # 统一调用入口（超时/重试/错误码映射）
│   │   │   ├── ResponseParser.ts # 严格 JSON + 有限修复 + Schema（移植 M0 逻辑）
│   │   │   └── errors.ts       # 错误码语义与可重试判定
│   │   ├── recognition/
│   │   │   ├── RecognitionEngine.ts # 薄接口（一期仅 ZhipuVisionEngine）
│   │   │   └── zhipuVision.ts
│   │   └── documents/          # F8/F9：pdfjs(3.11.174)/mammoth 解析与分块
│   ├── db/
│   │   ├── database.ts         # 打开数据库、迁移机制（schema_version 表）
│   │   ├── migrations/         # 001_init.sql 等
│   │   ├── repo_questions.ts   # 题库读写（独立事务）
│   │   ├── repo_imports.ts     # 导入草稿持久化（batches/pages/items）
│   │   ├── repo_materials.ts   # 教材与 chunk
│   │   └── fts.ts              # FTS5 建表/查询 + 短查询 LIKE 回退
│   ├── state/                  # 导入任务状态机（有界串行队列、取消、恢复）
│   ├── screens/                # F1 拍照 / F3 确认 / F4 刷题 / F5 错题 / 设置 等
│   ├── prompts/                # 四类 prompt 常量（含版本与变更记录）
│   └── ui/                     # 通用组件与主题
└── tests/                      # F2 / Parser / 归一化的自动化测试
```

## 5. 数据流

```
拍照/相册 ──► 压缩(长边2000/JPEG) ──► base64 ──► RecognitionEngine
   │                                                    │
   │                                        LLMService（超时/重试/错误映射）
   │                                                    ▼
   │                                          ResponseParser（有限修复）
   │                                                    ▼
   └──────────► 原图存应用私有目录                 F2 确定性校验
                                                        ▼
                              import_items 草稿持久化（含编辑/状态）
                                                        ▼
                                          F3 批量确认页（原图对照）
                                                        ▼
                                   入库 questions（单题独立事务）──► F4/F5
                                                        ▼
                              F7/F9b 讲解（文本模型，仅发送必要文本）
```

## 6. 依赖清单（本机实测于 2026-10-15）

| 包 | 版本 | 许可 | 用途 | 状态 |
| --- | --- | --- | --- | --- |
| expo | ~57.0.29 | MIT | 框架 | 已装 |
| react-native / react | 0.86.3 / 19.2.3 | MIT | 运行时 | 已装 |
| expo-sqlite | ~57.0.4 | MIT | 本地数据库（FTS5） | 已装，真机待验证 |
| expo-camera | ~57.0.6 | MIT | F1 拍照 | 已装 |
| expo-image-picker | ~57.0.20 | MIT | 相册选择 | 已装 |
| expo-document-picker | ~57.0.3 | MIT | F8/F9 文档选择 | 已装 |
| expo-secure-store | ~57.0.4 | MIT | API Key 存储 | 已装 |
| expo-image-manipulator | ~57.0.21 | MIT | 压缩/裁切/旋转 | 已装，真机待验证 |
| mammoth | 1.13.0 | BSD-2-Clause（已批准） | DOCX 解析 | 可打包 |
| pdfjs-dist | 3.11.174 | Apache-2.0 | PDF 文本提取 | 可打包；漏洞+缓解（见 3.3） |
| typescript | ~6.0.3 | Apache-2.0 | 开发 | 已装 |

## 7. npm audit（如实报告）

最终结果：**28 项（1 critical / 17 high / 10 moderate）**。

- 绝大多数集中在**构建工具链**（metro 系列、@expo/cli、node-forge、braces/micromatch、
  tar 经 node-pre-gyp），不进入 App 运行时 bundle。
- **运行时相关**：
  - `pdfjs-dist [high]`：见 3.3，已定缓解措施；
  - `mammoth [moderate]`：来自其依赖 argparse，非解析主路径；
  - `react-native [high]`：来自 @react-native/community-cli-plugin（开发工具）。
- npm audit 不是完整安全证明，也不能替代真机测试；audit 的自动修复建议
  多数是降级误导（如 expo→44），不予采纳。

## 8. M1 阶段计划（时间盒：每个子阶段 ≤4 天）

| 子阶段 | 内容 | 产出 | 验收 |
| --- | --- | --- | --- |
| M1-B（2-3 天） | 领域模型 + F2 + ResponseParser + 归一化（纯 TS，可离线测） | `src/core/`、`src/services/llm/` | 全部单测通过（移植并扩展 M0 的 19 个用例） |
| M1-C（3-4 天） | 单页识别闭环：拍照/相册→压缩→识别→解析→F2→F3→入库；草稿持久化 | `screens/`、`services/recognition/`、`db/` | 真机跑通一页 5-10 题导入；草稿可恢复 |
| M1-D（2-3 天） | 切半重试、手动框选、进程被杀恢复、失败补跑 | 兜底链路 + 恢复机制 | 回归集 10 张重跑达标；杀进程重启不重复入库 |

## 9. 待用户确认与真机自检步骤

请确认：本目录结构、依赖清单、pdfjs-dist 处理决定（3.11.174 + isEvalSupported:false）、
M1-B/C/D 计划。确认后进入 M1-B（先写领域模型与 F2，纯逻辑不碰真机）。

真机自检步骤（M1-A 的收尾验证，需要你的手机）：

1. 手机应用商店安装 **Expo Go**（免费，无需注册）。
2. 手机与电脑连接**同一 Wi-Fi**。
3. 告诉我"开始自检"，我会在本机启动开发服务器并把连接方式发给你。
4. 在 Expo Go 中打开项目，按屏幕提示查看：
   - SQLite 版本与 FTS5 trigram 建表是否成功；
   - 「细胞膜」(3字) MATCH 是否命中、「函数」(2字) 是否必须走 LIKE 回退；
   - 点按钮选一张试卷照片，确认压缩输出尺寸（长边 ≤2000）。
5. 把屏幕上的自检结果（或截图）发我，我据此确认 FTS5 策略并进入 M1-B。
