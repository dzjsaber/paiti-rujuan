# 拍题入卷 M0 工作区

本目录只用于 M0 技术验证，不属于 App 项目代码。

## 目录

- `samples/` — 放你的试卷样本图片（jpg / jpeg / png）
- `secrets/` — 放 API Key（`zhipu_api_key.txt`，内容只有一行 Key）
- `results/` — 每次运行自动生成 `run_<时间>/`（明细、原始输出、报告）
- `work/` — 自动生成的压缩图与上下半页图
- `m0_check.py` — 验证脚本（ResponseParser + F2 + 真实识别调用）

## 一、放样本

把图片放进 `samples/`。建议命名：`01_普通页.jpg`、`02_双栏.jpg`、`03_公式.jpg`、
`04_表格.jpg`、`05_图形.jpg`、`06_低清晰度.jpg`、`07_手写批注.jpg` 等。
要求：长边建议 2000px 以上（脚本自动压缩到 2000px），单张原图不超过 5MB，
覆盖普通、双栏、公式、表格、图形、低清晰度、手写批注各类型，共 10-12 张。

## 二、放 API Key

任选一种：

1. 文件方式（推荐）：把 Key 写入 `secrets/zhipu_api_key.txt`（一行，无引号）。
2. 环境变量方式：`$env:ZHIPU_API_KEY = "你的Key"`（仅当前窗口有效）。

注意：不要把 Key 提交到任何 Git 仓库、不要贴到聊天或公开渠道。

## 三、运行

离线自测（不需要 Key）：

```
E:\anaconda\python.exe m0_check.py --selftest
```

真实识别（需要 Key，会消耗免费额度）：

```
E:\anaconda\python.exe m0_check.py --limit 2          # 先跑 2 张试通
E:\anaconda\python.exe m0_check.py                     # 全部整页
E:\anaconda\python.exe m0_check.py --halves            # 整页 + 上下半页
E:\anaconda\python.exe m0_check.py --no-thinking       # 关闭思考模式对比
```

失败排查：如果报参数类错误码（1213/1214），可加 `--data-uri` 再试一次。

## 四、结果

每次运行输出 `results/run_<时间>/`：

- `report.md` — 汇总统计（耗时、可解析率、F2 分布、逐条明细）
- `detail.jsonl` — 每条的机器可读记录
- `raw/` — 模型原始输出（本地保存，供人工核对）
- `drafts/` — 解析后的结构化草稿 + F2 校验结果

召回率、字段准确率需要人工对照原图计数后填入，脚本不代为判断。
