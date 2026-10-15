/**
 * 文本作答判定（填空题/简答题）：规范化后精确匹配。
 * 规范化：全角转半角（NFKC）、忽略大小写、去除空白与常见标点。
 * shortcut: 不处理同义词与编辑距离；判为"错"时界面显示参考答案，由用户自行核对。
 */

export function normalizeTextAnswer(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s，。、；：""''（）()【】《》·,.;:?!？！\-—_~～/\\|]+/g, '');
}

export function isTextAnswerCorrect(user: string, reference: string): boolean {
  const a = normalizeTextAnswer(user);
  const b = normalizeTextAnswer(reference);
  return a.length > 0 && b.length > 0 && a === b;
}
