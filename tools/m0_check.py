#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拍题入卷 M0 验证脚本（独立于 App 项目）。

模式：
  --selftest   离线验证 ResponseParser + F2 校验逻辑，不需要 API Key。
  默认         读取 samples/ 下的试卷图片，调用智谱 glm-4.6v-flash 做识别，
               走 ResponseParser + F2 校验，输出统计报告。需要 API Key。

API Key 读取顺序：
  1) 环境变量 ZHIPU_API_KEY
  2) <脚本目录>/secrets/zhipu_api_key.txt（文件内容仅一行 Key）

输出目录：results/run_<时间戳>/（detail.jsonl、raw/、drafts/、report.md）
"""

import argparse
import base64
import hashlib
import json
import os
import re
import socket
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
VISION_MODEL = "glm-4.6v-flash"
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 6000 * 6000
TARGET_LONG_EDGE = 2000

RECOGNITION_PROMPT = """你是专业的试卷结构化引擎。请从输入的试卷图片中提取所有能够辨认的题目，严格输出 JSON 数组，不输出解释性文字。

每道题格式：
{"type": "single | multiple | judge", "stem": "题干原文", "options": [{"id": "A", "text": "选项文本"}], "answer": "单选为选项ID字符串 / 多选为选项ID数组 / 判断为布尔值 / 未知为 null", "confidence": 0.0, "review_reasons": [], "visual_features": []}

规则：
1. 不要推测试卷上未提供的正确答案。未印答案时 answer 为 null。
2. judge 题 options 输出空数组；answer 只能是布尔值 true、false 或 null。multiple 题的 answer 必须是选项 ID 数组，不得输出 "ACD" 之类字符串。
3. 只提取题目本身，避免把页眉、页脚、页码、解答过程和非题目内容混入题目。
4. 尽可能保留题干、选项、编号、单位、标点和原始顺序，不要擅自改写。
5. 对公式、图形、表格、双栏、文字不清、手写批注、选项边界不确定、共用材料或疑似跨页题目，在 visual_features / review_reasons 中标记；不要仅因包含图形就丢弃整道题。手写答案不得直接认定为标准答案。
6. confidence 是模型对本次提取结果的自评，仅供排序和人工复核使用，不代表经验证的真实准确率。
7. 无法辨认的内容不得编造，明确标记 review_reasons。
8. 一道题的选项不完整时仍可返回草稿，但必须标记复核原因。
9. 不要因为输出长度限制而悄悄截断；如果无法输出全部题目，应明确返回可检测的失败状态或由调用方按策略重新处理。
10. 图片中未发现可识别题目时返回 []。
11. 输出必须是可解析的 JSON 数组，不要使用 Markdown 代码围栏。"""


# ---------------------------------------------------------------- ResponseParser

def _sanitize_json(body):
    """有限修复字符串值，处理实测遇到的两类模型输出问题：

    1) 裸控制字符（字面换行，多行公式）。
    2) 未转义的 LaTeX 反斜杠（\\( \\frac \\left \\begin \\tan ...）：
       非法转义会让 json.loads 报错；而 \\b \\t \\r \\f 这类合法转义紧跟字母时
       会被静默解析成控制字符（如 \\frac 变成换页符 + "rac"），必须转义成
       字面反斜杠，避免产生错误数据。
    """
    out = []
    in_str = False
    table = {"\n": "\\n", "\r": "\\r", "\t": "\\t"}
    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if not in_str:
            out.append(ch)
            if ch == '"':
                in_str = True
            i += 1
            continue
        if ch == '"':
            out.append(ch)
            in_str = False
            i += 1
            continue
        if ch in table:
            out.append(table[ch])
            i += 1
            continue
        if ord(ch) < 0x20:
            out.append("\\u%04x" % ord(ch))
            i += 1
            continue
        if ch == "\\":
            nxt = body[i + 1] if i + 1 < n else ""
            if nxt in ("b", "f", "n", "r", "t"):
                after = body[i + 2] if i + 2 < n else ""
                if after.isascii() and after.isalpha():
                    out.append("\\\\")  # 疑似 LaTeX 命令（\frac \begin ...）
                    i += 1
                    continue
                out.append(ch)
                out.append(nxt)
                i += 2
                continue
            if nxt in ('"', "\\", "/"):
                out.append(ch)
                out.append(nxt)
                i += 2
                continue
            if nxt == "u" and re.match(r"[0-9a-fA-F]{4}$", body[i + 2:i + 6]):
                out.append(body[i:i + 6])
                i += 6
                continue
            out.append("\\\\")  # 其余为非法转义（\( \% \_ \left \sin ...）
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _try_parse_array(body):
    """返回 (obj|None, repaired|None)。先严格解析，再做控制字符修复。"""
    try:
        obj = json.loads(body)
        if isinstance(obj, list):
            return obj, False
    except Exception:
        pass
    try:
        obj = json.loads(_sanitize_json(body))
        if isinstance(obj, list):
            return obj, True
    except Exception:
        pass
    return None, None


def _find_matching(text, start):
    """返回 text[start] 处 '[' 的配对 ']' 下标；找不到返回 None。"""
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    return i
    return None


def _iter_top_level_arrays(text):
    """依次产出顶层平衡的 [...] 候选。

    解析失败的候选整体跳过（pos 移到其结尾之后），避免退化为匹配内层片段
    —— 实测踩过的坑：外层 JSON 修复失败后曾把某题的 options 数组当成题目列表。
    """
    pos = 0
    while True:
        start = text.find("[", pos)
        if start == -1:
            return
        end = _find_matching(text, start)
        if end is None:
            pos = start + 1
            continue
        yield text[start:end + 1]
        pos = end + 1


def parse_model_text(text):
    """返回 (drafts|None, parse_mode, error)。

    parse_mode: strict / fenced / extracted（带 _repaired 后缀表示做过有限修复）/ failed
    有限修复仅包括：去 Markdown 围栏、字符串内裸控制字符转义、从说明文字中
    提取顶层平衡的 JSON 数组。不做"截取首尾方括号"式修复，也不会把嵌套片段
    当成结果返回。
    """
    if text is None:
        return None, "failed", "空响应"
    t = text.strip()
    t = re.sub(r"<think>.*?</think>", "", t, flags=re.S | re.I).strip()
    if not t:
        return None, "failed", "空文本"
    obj, repaired = _try_parse_array(t)
    if obj is not None:
        return obj, ("strict_repaired" if repaired else "strict"), None
    m = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if m:
        obj, repaired = _try_parse_array(m.group(1).strip())
        if obj is not None:
            return obj, ("fenced_repaired" if repaired else "fenced"), None
    for cand in _iter_top_level_arrays(t):
        obj, repaired = _try_parse_array(cand)
        if obj is not None:
            return obj, ("extracted_repaired" if repaired else "extracted"), None
    return None, "failed", "未找到可解析的 JSON 数组（含有限修复）"


# ---------------------------------------------------------------- F2 简化校验层

def _norm_stem(stem):
    return re.sub(r"\s+", "", stem).lower()


def f2_validate(q):
    """单题确定性校验。返回 (status, issues)。

    status: passed / needs_review / invalid
    覆盖 V1 结构、V2 题型一致性、V3 选项完整性、V4 题干有效性、
    V6 置信度分级、V7 视觉特征、V8 答案缺失（V5 去重在页面层处理）。
    """
    if not isinstance(q, dict):
        return "invalid", ["V1: 题目不是对象"]
    qtype = q.get("type")
    if qtype not in ("single", "multiple", "judge"):
        return "invalid", ["V1/V2: type 非法 %r" % (qtype,)]
    stem = q.get("stem")
    if not isinstance(stem, str) or not stem.strip():
        return "invalid", ["V4: 题干为空或非文本"]
    soft = []
    if len(stem.strip()) < 5:
        soft.append("V4: 题干过短(<5字符)")
    options = q.get("options")
    if options is None:
        options = []
    if not isinstance(options, list):
        return "invalid", ["V1: options 不是数组"]
    ids = []
    for i, o in enumerate(options):
        if not isinstance(o, dict):
            return "invalid", ["V1: 选项[%d] 不是对象" % i]
        oid, otxt = o.get("id"), o.get("text")
        if not isinstance(oid, str) or not oid.strip():
            return "invalid", ["V3: 选项[%d] id 为空" % i]
        if not isinstance(otxt, str) or not otxt.strip():
            return "invalid", ["V3: 选项[%d] 文本为空" % i]
        oid = oid.strip()
        if oid in ids:
            return "invalid", ["V3: 选项 id 重复 %s" % oid]
        ids.append(oid)
    answer = q.get("answer")
    if qtype in ("single", "multiple"):
        if len(ids) < 2:
            return "invalid", ["V3: 选择题有效选项不足 2 个"]
        if answer is None:
            soft.append("V8: 答案缺失(null)")
        elif qtype == "single":
            if not isinstance(answer, str) or answer not in ids:
                return "invalid", ["V2: 单选答案非法或越界 %r" % (answer,)]
        else:
            if not isinstance(answer, list):
                return "invalid", ["V2: 多选答案必须是数组（实际 %s）" % type(answer).__name__]
            uniq = []
            for a in answer:
                if not isinstance(a, str) or a not in ids:
                    return "invalid", ["V2: 多选答案元素非法或越界 %r" % (a,)]
                if a not in uniq:
                    uniq.append(a)
            if len(uniq) < 2:
                return "invalid", ["V2: 多选答案有效项不足 2 个"]
            if len(uniq) != len(answer):
                soft.append("V2: 多选答案含重复项")
    else:  # judge
        if answer is None:
            soft.append("V8: 答案缺失(null)")
        elif not isinstance(answer, bool):
            return "invalid", ["V2: 判断题答案必须是布尔值（实际 %r）" % (answer,)]
    conf = q.get("confidence")
    if not isinstance(conf, (int, float)) or isinstance(conf, bool):
        soft.append("V6: confidence 缺失或非数值")
    elif conf < 0.7:
        soft.append("V6: confidence 低(%s)" % conf)
    vf = q.get("visual_features")
    if isinstance(vf, list) and vf:
        soft.append("V7: visual_features=%s" % ",".join(str(x) for x in vf))
    rr = q.get("review_reasons")
    if isinstance(rr, list) and rr:
        soft.append("V7: 模型自报复核原因=%s" % ",".join(str(x) for x in rr))
    return ("needs_review" if soft else "passed"), soft


def f2_validate_page(drafts):
    """整页校验：逐题 + V5 页面内疑似重复提示。"""
    results = []
    seen = {}
    for idx, q in enumerate(drafts):
        status, issues = f2_validate(q)
        stem = q.get("stem") if isinstance(q, dict) else None
        if isinstance(stem, str) and stem.strip():
            key = _norm_stem(stem)
            if key in seen:
                if status == "passed":
                    status = "needs_review"
                issues = list(issues) + ["V5: 与第 %d 题题干疑似重复" % (seen[key] + 1)]
            else:
                seen[key] = idx
        results.append({"index": idx, "status": status, "issues": issues})
    return results


def f2_summary(page_results):
    summary = {"passed": 0, "needs_review": 0, "invalid": 0}
    for r in page_results:
        summary[r["status"]] += 1
    return summary


# ---------------------------------------------------------------- 图片准备

def load_pillow():
    try:
        from PIL import Image  # noqa
        return Image
    except Exception:
        return None


def prepare_image(path, work_dir, Image):
    """检查并（必要时）压缩图片。返回 info dict。"""
    raw = path.read_bytes()
    info = {
        "source": str(path),
        "orig_bytes": len(raw),
        "prepared": str(path),
        "bytes": len(raw),
        "pixels": None,
        "resized": False,
        "over_limit_original": len(raw) > MAX_IMAGE_BYTES,
    }
    if Image is None:
        return info
    with Image.open(path) as im:
        w, h = im.size
        info["pixels"] = "%dx%d" % (w, h)
        fmt = (im.format or "").upper()
        need_resize = max(w, h) > TARGET_LONG_EDGE or w * h > MAX_PIXELS or len(raw) > MAX_IMAGE_BYTES
        need_convert = fmt != "JPEG" or im.mode not in ("RGB", "L")
        if need_resize or need_convert:
            scale = min(1.0, float(TARGET_LONG_EDGE) / max(w, h))
            nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
            im2 = im.convert("RGB")
            if (nw, nh) != (w, h):
                im2 = im2.resize((nw, nh), Image.LANCZOS)
            out = work_dir / (path.stem + "__prepared.jpg")
            im2.save(out, "JPEG", quality=85)
            info["prepared"] = str(out)
            info["bytes"] = out.stat().st_size
            info["pixels"] = "%dx%d" % (nw, nh)
            info["resized"] = (nw, nh) != (w, h)
            info["converted_jpeg"] = True
    return info


def make_halves(path, work_dir, Image):
    """生成本地上下半页图片，返回 [(标签, 路径), ...]；无 Pillow 时返回空。"""
    if Image is None:
        return []
    out = []
    with Image.open(path) as im:
        w, h = im.size
        half = h // 2
        for label, box in (("top", (0, 0, w, half)), ("bottom", (0, half, w, h))):
            im2 = im.crop(box)
            if max(im2.size) > TARGET_LONG_EDGE:
                scale = float(TARGET_LONG_EDGE) / max(im2.size)
                im2 = im2.resize((int(im2.size[0] * scale), int(im2.size[1] * scale)), Image.LANCZOS)
            p = work_dir / ("%s__%s.jpg" % (path.stem, label))
            im2.convert("RGB").save(p, "JPEG", quality=85)
            out.append((label, p))
    return out


# ---------------------------------------------------------------- API 调用

def load_api_key(root, explicit_file=None):
    env = os.environ.get("ZHIPU_API_KEY", "").strip()
    if env:
        return env, "环境变量 ZHIPU_API_KEY"
    candidate = Path(explicit_file) if explicit_file else (root / "secrets" / "zhipu_api_key.txt")
    if candidate.exists():
        key = candidate.read_text(encoding="utf-8").strip()
        if key:
            return key, str(candidate)
    return None, None


def call_vision(api_key, image_bytes, prompt, model=VISION_MODEL, thinking="enabled",
                temperature=0.1, max_tokens=8192, timeout=120, data_uri=False):
    """返回 (content, meta)。meta 含 http/biz_code/message/usage/latency。"""
    b64 = base64.b64encode(image_bytes).decode("ascii")
    url = ("data:image/jpeg;base64," + b64) if data_uri else b64
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": url}},
                {"type": "text", "text": prompt},
            ],
        }],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "thinking": {"type": thinking},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        API_URL, data=data, method="POST",
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
    )
    t0 = time.time()
    meta = {"http": None, "biz_code": None, "message": None, "usage": None}
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            meta["http"] = resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        meta["http"] = e.code
        try:
            meta["retry_after"] = e.headers.get("Retry-After")
        except Exception:
            pass
        try:
            err = (json.loads(body) or {}).get("error") or {}
            meta["biz_code"] = err.get("code")
            meta["message"] = err.get("message")
        except Exception:
            meta["message"] = body[:300]
        meta["latency"] = round(time.time() - t0, 2)
        return None, meta
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as e:
        meta["message"] = "网络错误: %s" % e
        meta["latency"] = round(time.time() - t0, 2)
        return None, meta
    meta["latency"] = round(time.time() - t0, 2)
    try:
        j = json.loads(body)
        choices = j.get("choices") or []
        content = choices[0].get("message", {}).get("content") if choices else None
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        meta["usage"] = j.get("usage")
    except Exception as e:
        meta["message"] = "响应 JSON 解析失败: %s" % e
        return None, meta
    return content, meta


RETRYABLE_BIZ = {"1302", "1305"}
RETRYABLE_HTTP = {500, 502, 503, 504}


def call_with_one_retry(api_key, image_bytes, prompt, args):
    attempts = []
    for attempt in (1, 2):
        content, meta = call_vision(
            api_key, image_bytes, prompt, model=args.model,
            thinking=("disabled" if args.no_thinking else "enabled"),
            temperature=args.temperature, max_tokens=args.max_tokens,
            timeout=args.timeout, data_uri=args.data_uri,
        )
        attempts.append(meta)
        if content is not None:
            return content, meta, attempts
        retryable = (meta.get("http") in RETRYABLE_HTTP) or (str(meta.get("biz_code")) in RETRYABLE_BIZ) \
            or (meta.get("http") is None)
        if attempt == 1 and retryable:
            wait = 20.0
            ra = meta.get("retry_after")
            if ra:
                try:
                    wait = min(60.0, max(5.0, float(ra)))
                except Exception:
                    pass
            time.sleep(wait)
            continue
        break
    return None, attempts[-1], attempts


# ---------------------------------------------------------------- 离线自测

OK_SINGLE = ('{"type":"single","stem":"下列关于函数的说法正确的是","options":'
             '[{"id":"A","text":"选项一"},{"id":"B","text":"选项二"}],"answer":"A",'
             '"confidence":0.9,"review_reasons":[],"visual_features":[]}')

SELFTEST_CASES = [
    ("strict_ok", "[%s]" % OK_SINGLE, "strict", ["passed"]),
    ("fenced", "```json\n[%s]\n```" % OK_SINGLE, "fenced", ["passed"]),
    ("prefix_text", "好的，结果如下：\n[%s]\n以上。" % OK_SINGLE, "extracted", ["passed"]),
    ("truncated", '[{"type":"single","stem":"题目', "failed", None),
    ("not_array", '{"a":1}', "failed", None),
    ("multi_string", '[{"type":"multiple","stem":"下列说法正确的有","options":'
     '[{"id":"A","text":"甲"},{"id":"B","text":"乙"},{"id":"C","text":"丙"}],"answer":"AC",'
     '"confidence":0.8,"review_reasons":[],"visual_features":[]}]', "strict", ["invalid"]),
    ("multi_ok", '[{"type":"multiple","stem":"下列说法正确的有","options":'
     '[{"id":"A","text":"甲"},{"id":"B","text":"乙"},{"id":"C","text":"丙"}],'
     '"answer":["A","C"],"confidence":0.8,"review_reasons":[],"visual_features":[]}]',
     "strict", ["passed"]),
    ("judge_no_options", '[{"type":"judge","stem":"该说法是否正确？","options":[],'
     '"answer":true,"confidence":0.9,"review_reasons":[],"visual_features":[]}]',
     "strict", ["passed"]),
    ("answer_out_of_range", '[{"type":"single","stem":"下列说法正确的是","options":'
     '[{"id":"A","text":"甲"},{"id":"B","text":"乙"}],"answer":"D",'
     '"confidence":0.9,"review_reasons":[],"visual_features":[]}]', "strict", ["invalid"]),
    ("low_confidence", '[{"type":"single","stem":"下列关于函数的说法正确的是","options":'
     '[{"id":"A","text":"甲"},{"id":"B","text":"乙"}],"answer":"A",'
     '"confidence":0.5,"review_reasons":[],"visual_features":[]}]', "strict", ["needs_review"]),
    ("answer_null", '[{"type":"single","stem":"下列关于函数的说法正确的是","options":'
     '[{"id":"A","text":"甲"},{"id":"B","text":"乙"}],"answer":null,'
     '"confidence":0.9,"review_reasons":[],"visual_features":[]}]', "strict", ["needs_review"]),
    ("empty_stem", '[{"type":"single","stem":"","options":'
     '[{"id":"A","text":"甲"},{"id":"B","text":"乙"}],"answer":"A",'
     '"confidence":0.9,"review_reasons":[],"visual_features":[]}]', "strict", ["invalid"]),
    ("short_stem", '[{"type":"single","stem":"abc","options":'
     '[{"id":"A","text":"甲"},{"id":"B","text":"乙"}],"answer":"A",'
     '"confidence":0.9,"review_reasons":[],"visual_features":[]}]', "strict", ["needs_review"]),
    ("dup_option_ids", '[{"type":"single","stem":"下列关于函数的说法正确的是","options":'
     '[{"id":"A","text":"甲"},{"id":"A","text":"乙"}],"answer":"A",'
     '"confidence":0.9,"review_reasons":[],"visual_features":[]}]', "strict", ["invalid"]),
    ("dup_stem_page", "[%s,%s]" % (OK_SINGLE, OK_SINGLE), "strict", ["passed", "needs_review"]),
    ("fenced_with_literal_newline",
     '```json\n[{"type":"single","stem":"第一行\n第二行公式","options":'
     '[{"id":"A","text":"甲"},{"id":"B","text":"乙"}],"answer":"A",'
     '"confidence":0.9,"review_reasons":[],"visual_features":[]}]\n```',
     "fenced_repaired", ["passed"]),
    ("nested_after_broken_array",
     '[{"type":"single","stem":"题目文本足够长","options":["A","B"]}, oops]',
     "failed", None),
    ("latex_backslash_repair",
     '```json\n[{"type":"single","stem":"已知 \\( y = x \\ln \\left( e + \\frac{1}{x-1} \\right) \\)","options":'
     '[{"id":"A","text":"甲"},{"id":"B","text":"乙"}],"answer":"A",'
     '"confidence":0.9,"review_reasons":[],"visual_features":[]}]\n```',
     "fenced_repaired", ["passed"]),
    ("think_then_fenced",
     '<think>先读图再排版</think>\n```json\n[%s]\n```' % OK_SINGLE,
     "fenced", ["passed"]),
]


def run_selftest():
    failures = []
    for name, text, exp_mode, exp_status in SELFTEST_CASES:
        drafts, mode, err = parse_model_text(text)
        if mode != exp_mode:
            failures.append("%s: parse_mode=%s 期望 %s（err=%s）" % (name, mode, exp_mode, err))
            continue
        if exp_status is None:
            continue
        page = f2_validate_page(drafts)
        got = [r["status"] for r in page]
        if got != exp_status:
            failures.append("%s: F2=%s 期望 %s" % (name, got, exp_status))
    total = len(SELFTEST_CASES)
    if failures:
        print("SELFTEST FAILED (%d/%d 通过)" % (total - len(failures), total))
        for f in failures:
            print("  - " + f)
        return 1
    print("SELFTEST PASSED：%d/%d 用例全部符合预期（ResponseParser + F2）" % (total, total))
    return 0


# ---------------------------------------------------------------- 真实运行

def iter_images(input_dir):
    exts = {".jpg", ".jpeg", ".png"}
    for p in sorted(input_dir.rglob("*")):
        if p.is_file() and p.suffix.lower() in exts:
            yield p


def run_live(args):
    root = Path(__file__).resolve().parent
    input_dir = Path(args.input_dir).resolve() if args.input_dir else (root / "samples")
    work_dir = root / "work"
    work_dir.mkdir(exist_ok=True)
    api_key, key_src = load_api_key(root, args.api_key_file)
    if not api_key:
        print("未找到 API Key。请设置环境变量 ZHIPU_API_KEY，或把 Key 写入 "
              "%s" % (root / "secrets" / "zhipu_api_key.txt"))
        return 2
    Image = load_pillow()
    if Image is None:
        print("提示：未安装 Pillow，将跳过像素检查、自动压缩与切半功能。")
    images = list(iter_images(input_dir)) if input_dir.exists() else []
    if args.limit:
        images = images[:args.limit]
    if not images:
        print("samples 目录中没有图片：%s" % input_dir)
        return 2
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = root / "results" / ("run_" + ts)
    (out_dir / "raw").mkdir(parents=True, exist_ok=True)
    (out_dir / "drafts").mkdir(parents=True, exist_ok=True)
    detail_path = out_dir / "detail.jsonl"
    records = []
    print("Key 来源：%s；样本数：%d；模式：%s" % (
        key_src, len(images), "整页+上下半页" if args.halves else "整页"))

    def process(label, image_path, file_bytes, prep_info, mode):
        content, meta, attempts = call_with_one_retry(api_key, file_bytes, RECOGNITION_PROMPT, args)
        rec = {
            "sample": label, "mode": mode,
            "prepared": prep_info.get("prepared"), "bytes": len(file_bytes),
            "pixels": prep_info.get("pixels"), "resized": prep_info.get("resized"),
            "attempts": len(attempts), "http": meta.get("http"), "biz_code": meta.get("biz_code"),
            "latency_s": meta.get("latency"), "usage": meta.get("usage"),
            "error": meta.get("message"), "parse": None, "n_drafts": 0, "f2": None,
        }
        if content is not None:
            (out_dir / "raw" / ("%s__%s.txt" % (label, mode))).write_text(content, encoding="utf-8")
            drafts, p_mode, p_err = parse_model_text(content)
            rec["parse"] = p_mode
            if drafts is not None:
                rec["n_drafts"] = len(drafts)
                page = f2_validate_page(drafts)
                rec["f2"] = f2_summary(page)
                (out_dir / "drafts" / ("%s__%s.json" % (label, mode))).write_text(
                    json.dumps({"drafts": drafts, "f2": page}, ensure_ascii=False, indent=2),
                    encoding="utf-8")
            else:
                rec["error"] = (rec["error"] or "") + " | parser: " + str(p_err)
        print("  [%s/%s] http=%s biz=%s %.1fs parse=%s drafts=%s" % (
            label, mode, rec["http"], rec["biz_code"], rec["latency_s"] or 0,
            rec["parse"], rec["n_drafts"]))
        return rec

    for img in images:
        prep = prepare_image(img, work_dir, Image)
        data = Path(prep["prepared"]).read_bytes()
        if len(data) > MAX_IMAGE_BYTES:
            records.append({"sample": img.name, "mode": "full", "error": "压缩后仍超过 5MB，已跳过",
                            "http": None, "biz_code": None, "latency_s": None, "parse": None,
                            "n_drafts": 0, "f2": None, "pixels": prep.get("pixels"),
                            "bytes": len(data), "attempts": 0, "usage": None})
            continue
        records.append(process(img.name, img, data, prep, "full"))
        if args.halves and Image is not None:
            for label, hpath in make_halves(Path(prep["prepared"]), work_dir, Image):
                hprep = {"prepared": str(hpath), "pixels": None, "resized": True}
                records.append(process(img.name, hpath, hpath.read_bytes(), hprep, "half_" + label))
        time.sleep(args.sleep)
    with detail_path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    write_report(out_dir, records, args)
    print("完成。报告：%s" % (out_dir / "report.md"))
    return 0


def _fmt(v):
    return "-" if v is None else v


def write_report(out_dir, records, args):
    full = [r for r in records if r.get("mode") == "full"]
    lat = [r["latency_s"] for r in records if r.get("latency_s")]
    ok_modes = ("strict", "fenced", "extracted",
                "strict_repaired", "fenced_repaired", "extracted_repaired")
    ok = [r for r in records if r.get("parse") in ok_modes]
    strict = [r for r in records if r.get("parse") in ("strict", "strict_repaired")]
    f2_tot = {"passed": 0, "needs_review": 0, "invalid": 0}
    for r in records:
        for k, v in (r.get("f2") or {}).items():
            f2_tot[k] += v
    lines = []
    lines.append("# M0 识别验证报告（%s）" % datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    lines.append("")
    lines.append("- 模型：%s（thinking=%s，temperature=%s，data_uri=%s）" % (
        args.model, "disabled" if args.no_thinking else "enabled",
        args.temperature, args.data_uri))
    lines.append("- 请求记录：%d 条（其中整页 %d 条）" % (len(records), len(full)))
    lines.append("- 请求成功（拿到模型文本）：%d/%d" % (
        len([r for r in records if r.get("latency_s") and r.get("parse") is not None]), len(records)))
    if lat:
        lines.append("- 耗时：平均 %.1fs / 中位 %.1fs / 最大 %.1fs" % (
            statistics.mean(lat), statistics.median(lat), max(lat)))
    lines.append("- JSON 严格可解析：%d/%d；含有限修复后：%d/%d" % (
        len(strict), len(records), len(ok), len(records)))
    lines.append("- 草稿总数：%d；F2 分布：passed=%d / needs_review=%d / invalid=%d" % (
        sum(r.get("n_drafts") or 0 for r in records),
        f2_tot["passed"], f2_tot["needs_review"], f2_tot["invalid"]))
    lines.append("")
    lines.append("## 逐条明细")
    lines.append("")
    lines.append("| 样本 | 模式 | 字节 | 像素 | 耗时s | HTTP | 业务码 | 解析 | 草稿 | passed | review | invalid | 备注 |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in records:
        f2 = r.get("f2") or {}
        lines.append("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
            r.get("sample"), r.get("mode"), _fmt(r.get("bytes")), _fmt(r.get("pixels")),
            _fmt(r.get("latency_s")), _fmt(r.get("http")), _fmt(r.get("biz_code")),
            _fmt(r.get("parse")), _fmt(r.get("n_drafts")),
            _fmt(f2.get("passed")), _fmt(f2.get("needs_review")), _fmt(f2.get("invalid")),
            (r.get("error") or "").replace("|", "/")[:120]))
    lines.append("")
    lines.append("> 说明：召回率与字段准确率需要人工对照原图计数后才能得出，请在此基础上填写统计口径。")
    (out_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------- 入口

def main():
    ap = argparse.ArgumentParser(description="拍题入卷 M0 验证脚本")
    ap.add_argument("--selftest", action="store_true", help="离线验证 Parser+F2，不调用 API")
    ap.add_argument("--input-dir", default=None, help="样本目录，默认 <脚本目录>/samples")
    ap.add_argument("--model", default=VISION_MODEL, help="视觉模型 ID，默认 %s" % VISION_MODEL)
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 张图（0=全部）")
    ap.add_argument("--halves", action="store_true", help="每张图额外识别上下半页")
    ap.add_argument("--no-thinking", action="store_true", help="关闭思考模式")
    ap.add_argument("--data-uri", action="store_true", help="Base64 使用 data URI 前缀")
    ap.add_argument("--temperature", type=float, default=0.1)
    ap.add_argument("--max-tokens", type=int, default=8192)
    ap.add_argument("--timeout", type=int, default=120)
    ap.add_argument("--sleep", type=float, default=1.0, help="请求间隔秒数")
    ap.add_argument("--api-key-file", default=None)
    args = ap.parse_args()
    if args.selftest:
        return run_selftest()
    return run_live(args)


if __name__ == "__main__":
    sys.exit(main())
