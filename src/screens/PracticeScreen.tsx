/**
 * F4 刷题模式：
 * - 顺序/随机；single/judge 点选即判，multiple 需提交判定；
 * - 答对/答错立即反馈并显示正确答案；答错自动进入错题本；
 * - 错题本模式重刷答对 → 自动移出错题本（历史记录保留）；
 * - answer 为 null 的题不自动判定，提示"暂无答案"并允许跳过。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Modal, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { isTextAnswerCorrect } from '../core/answerCheck';
import { buildSearchTerms, clipHitText } from '../core/searchTerms';
import { searchMaterialsSmart } from '../db/fts';
import { listBankMaterialIds, listBanks, type BankSummary } from '../db/repo_banks';
import { listPracticeQuestions, markWrong, recordAiFeedback, recordAnswer, removeFromWrongBook, shuffleInPlace } from '../db/repo_practice';
import { setQuestionExplanation, setQuestionFavorite, type QuestionRow } from '../db/repo_questions';
import { renderExplainPrompt } from '../prompts/explain';
import { isNoEvidenceAnswer, renderRagPrompt, type RagEvidence } from '../prompts/ragExplain';
import type { LLMService } from '../services/llm/LLMService';
import { getExplainProvider } from '../services/modelPrefs';
import {
  getCustomConfig,
  getDeepseekKey,
  resolveExplainTarget,
  ZHIPU_URL,
  type ExplainProviderId,
} from '../services/llm/providers';
import { getApiKey } from '../services/apiKey';

export interface PracticeScreenProps {
  db: SQLiteDatabase;
  llm: LLMService;
  mode: 'bank' | 'wrong';
  order: 'seq' | 'random';
  onDone: () => void;
}

type Stage = 'pickBank' | 'loading' | 'answering' | 'judged' | 'finished' | 'empty';

interface ParsedQuestion {
  id: string;
  bankId: string;
  favorite: boolean;
  type: string;
  stem: string;
  options: { id: string; text: string }[];
  answer: unknown;
  answerText: string;
  analysis: string | null;
  /** 已保存的 AI 讲解（与自带解析分开） */
  explanation: string | null;
  sourceImage: string | null;
  questionImage: string | null;
}

interface ExplainState {
  loading: boolean;
  text: string | null;
  error: string | null;
  evidence: RagEvidence[];
  usedLibrary: boolean;
  /** 题库已绑定教材但检索无命中：等待用户确认是否降级（联网/模型知识） */
  noEvidence: boolean;
  /** 非空表示本次讲解未依据教材（用户确认后的降级方式） */
  fallback: 'web' | 'model' | null;
  /** 生成后自动保存（写入题目解析）的结果 */
  saved: 'ok' | 'fail' | null;
}

function parseRow(row: QuestionRow): ParsedQuestion {
  const options = JSON.parse(row.options_json) as { id: string; text: string }[];
  const answer = JSON.parse(row.answer_json) as unknown;
  let answerText = '';
  if (answer === true) answerText = '正确';
  else if (answer === false) answerText = '错误';
  else if (Array.isArray(answer)) answerText = answer.join('、');
  else if (typeof answer === 'string') answerText = answer;
  return {
    id: row.id,
    bankId: row.bank_id,
    favorite: row.favorite === 1,
    type: row.type,
    stem: row.stem,
    options: Array.isArray(options) ? options : [],
    answer,
    answerText,
    analysis: row.analysis,
    explanation: row.ai_explanation,
    sourceImage: row.source_image_path,
    questionImage: row.question_image_path,
  };
}

function isOptionCorrect(q: ParsedQuestion, optId: string): boolean {
  const a = q.answer;
  if (a === null || a === undefined) return false;
  if (q.type === 'judge') return (optId === 'T') === a;
  if (Array.isArray(a)) return (a as string[]).includes(optId);
  return a === optId;
}

function evaluate(q: ParsedQuestion, chosen: string[]): boolean | null {
  const a = q.answer;
  if (a === null || a === undefined) return null;
  if (q.type === 'single') return chosen.length === 1 && chosen[0] === a;
  if (q.type === 'multiple') {
    if (!Array.isArray(a)) return null;
    const sa = [...(a as string[])].sort();
    const sc = [...chosen].sort();
    return sa.length === sc.length && sa.every((x, i) => x === sc[i]);
  }
  if (q.type === 'judge') {
    if (chosen.length !== 1) return false;
    return (chosen[0] === 'T') === a;
  }
  return null;
}

export function PracticeScreen({ db, llm, mode, order, onDone }: PracticeScreenProps) {
  // 题库模式先选题库（F4 多库）：进入刷题前停留在选择页
  const [stage, setStage] = useState<Stage>(mode === 'bank' ? 'pickBank' : 'loading');
  const [questions, setQuestions] = useState<ParsedQuestion[]>([]);
  const [idx, setIdx] = useState(0);
  const [chosen, setChosen] = useState<string[]>([]);
  /** 填空/简答题的文本作答 */
  const [textAnswer, setTextAnswer] = useState('');
  const [result, setResult] = useState<{ correct: boolean | null } | null>(null);
  const [session, setSession] = useState({ right: 0, wrong: 0, skipped: 0 });
  const [showImage, setShowImage] = useState(false);
  const [showFigure, setShowFigure] = useState(false);
  const [orderState, setOrderState] = useState<'seq' | 'random'>(order);
  const [explain, setExplain] = useState<ExplainState | null>(null);
  /** 教材依据默认收起，避免讲解卡片带出一大串 */
  const [showEvidence, setShowEvidence] = useState(false);
  /** 讲解请求序号：翻页/重新生成后让在途结果作废，避免显示到别的题上 */
  const explainSeqRef = useRef(0);
  const [explainProvider, setExplainProvider] = useState<ExplainProviderId>('zhipu_free');
  const [bankId, setBankId] = useState<string | null>(null);
  const [bankName, setBankName] = useState<string | null>(null);
  const [banks, setBanks] = useState<BankSummary[]>([]);
  /** 只刷收藏（题库模式下由库选择页入口决定） */
  const [favOnly, setFavOnly] = useState(false);
  /** 题目列表（跳转任意一题） */
  const [showList, setShowList] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const loadQuestions = useCallback(
    async (ord: 'seq' | 'random') => {
      setStage('loading');
      try {
        const rows = await listPracticeQuestions(db, mode === 'bank' && favOnly ? 'fav' : mode, bankId ?? undefined);
        let qs = rows.map(parseRow);
        if (ord === 'random') qs = shuffleInPlace(qs);
        setQuestions(qs);
        setIdx(0);
        setChosen([]);
        setResult(null);
        setStage(qs.length ? 'answering' : 'empty');
      } catch {
        setStage('empty');
      }
    },
    [db, mode, bankId, favOnly],
  );

  useEffect(() => {
    if (mode === 'bank' && !bankId) {
      setStage('pickBank');
      void listBanks(db)
        .then(setBanks)
        .catch(() => setBanks([]));
      return;
    }
    void loadQuestions(orderState);
  }, [loadQuestions, orderState, mode, bankId, db]);

  useEffect(() => {
    void getExplainProvider().then(setExplainProvider);
  }, []);

  const q = questions[idx];

  const next = useCallback(() => {
    explainSeqRef.current += 1;
    setChosen([]);
    setTextAnswer('');
    setResult(null);
    setExplain(null);
    setShowEvidence(false);
    if (idx + 1 >= questions.length) {
      setStage('finished');
      return;
    }
    setIdx((i) => i + 1);
    setStage('answering');
  }, [idx, questions.length]);

  /** 判定并落库（选择题与填空/简答共用；correct=null 表示无答案不判定） */
  const applyResult = useCallback(
    async (correct: boolean | null) => {
      if (!q) return;
      setResult({ correct });
      setStage('judged');
      // 判定反馈区在选项下方，自动滚动到可见位置（否则小屏看不到讲解入口）
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
      if (correct === null) return;
      try {
        await recordAnswer(db, q.id, correct);
        if (!correct) {
          await markWrong(db, q.id);
        } else if (mode === 'wrong') {
          await removeFromWrongBook(db, q.id);
        }
      } catch {
        /* 记录失败不阻塞刷题 */
      }
      setSession((s) => ({
        right: correct ? s.right + 1 : s.right,
        wrong: correct ? s.wrong : s.wrong + 1,
        skipped: s.skipped,
      }));
    },
    [db, q, mode],
  );

  const submit = useCallback(
    async (choice: string[]) => {
      if (!q || stage !== 'answering') return;
      setChosen(choice);
      await applyResult(evaluate(q, choice));
    },
    [q, stage, applyResult],
  );

  /** 填空/简答提交：规范化文本精确匹配（判错时界面显示参考答案供核对） */
  const submitText = useCallback(async () => {
    if (!q || stage !== 'answering') return;
    const noRef = q.answer === null || q.answer === undefined;
    await applyResult(noRef ? null : isTextAnswerCorrect(textAnswer, q.answerText));
  }, [q, stage, textAnswer, applyResult]);

  /** 收藏/取消收藏本题（"只刷收藏"模式的数据来源） */
  const toggleFavorite = useCallback(async () => {
    if (!q) return;
    const next = !q.favorite;
    try {
      await setQuestionFavorite(db, q.id, next);
      setQuestions((prev) => prev.map((x) => (x.id === q.id ? { ...x, favorite: next } : x)));
    } catch (e) {
      Alert.alert('操作失败', String((e as Error)?.message ?? e));
    }
  }, [db, q]);

  /** 从题目列表跳到任意一题（重置本题作答状态） */
  const jumpTo = useCallback((i: number) => {
    explainSeqRef.current += 1;
    setShowList(false);
    setChosen([]);
    setTextAnswer('');
    setResult(null);
    setExplain(null);
    setShowEvidence(false);
    setIdx(i);
    setStage('answering');
  }, []);

  const pickOption = useCallback(
    (optId: string) => {
      if (!q || stage !== 'answering') return;
      if (q.type === 'multiple') {
        setChosen((prev) => (prev.includes(optId) ? prev.filter((x) => x !== optId) : [...prev, optId]));
        return;
      }
      void submit([optId]);
    },
    [q, stage, submit],
  );

  const skip = useCallback(() => {
    setSession((s) => ({ ...s, skipped: s.skipped + 1 }));
    next();
  }, [next]);

  /** 讲解生成后自动保存为该题 AI 讲解（独立字段，不覆盖自带解析） */
  const saveExplanation = useCallback(
    async (questionId: string, text: string): Promise<'ok' | 'fail'> => {
      try {
        await setQuestionExplanation(db, questionId, text);
        setQuestions((prev) => prev.map((x) => (x.id === questionId ? { ...x, explanation: text } : x)));
        return 'ok';
      } catch {
        return 'fail';
      }
    },
    [db],
  );

  /**
   * F7/F9b：AI 讲解。
   * 题库绑定了教材时只检索绑定教材，且必须依据教材回答；检索无命中不自动降级，
   * 由用户确认后走联网/模型知识（见 onFallbackPress）。未绑定教材则维持"命中用教材、未命中普通讲解"。
   * 生成成功后自动保存为该题解析（无用户确认步骤）。
   */
  const runExplain = useCallback(
    async (target: { url: string; model: string; apiKey: string }) => {
      if (!q) return;
      const seq = ++explainSeqRef.current;
      const apply = (s: ExplainState) => {
        if (explainSeqRef.current === seq) setExplain(s);
      };
      apply({ loading: true, text: null, error: null, evidence: [], usedLibrary: false, noEvidence: false, fallback: null, saved: null });
      try {
        const input = { stem: q.stem, options: q.options, answerText: q.answerText };
        const searchText = `${q.stem}\n${q.options.map((o) => o.text).join('\n')}`;
        const terms = buildSearchTerms(searchText);
        const boundIds = await listBankMaterialIds(db, q.bankId);
        const hits = await searchMaterialsSmart(
          db,
          searchText,
          // 取 10 段：3 字滑窗召回宽，正确段落可能排在 5 名之后（实测真实课件最差第 9 名）
          10,
          boundIds.length > 0 ? boundIds : undefined,
        );
        const evidence: RagEvidence[] = hits.map((h, i) => ({
          index: i + 1,
          text: clipHitText(h.text, terms),
          source: `${h.materialName}${h.sourceLoc ? ` · ${h.sourceLoc}` : ''}`,
        }));
        if (evidence.length === 0 && boundIds.length > 0) {
          apply({ loading: false, text: null, error: null, evidence: [], usedLibrary: false, noEvidence: true, fallback: null, saved: null });
          return;
        }
        const prompt = evidence.length > 0 ? renderRagPrompt(input, evidence) : renderExplainPrompt(input);
        let acc = '';
        let lastFlush = 0;
        const r = await llm.completeStream(
          prompt,
          {
            model: target.model,
            endpoint: { url: target.url, apiKey: target.apiKey },
            temperature: 0.3,
            maxTokens: 2048,
            timeoutMs: 180000,
            // glm-4.7 默认强制思考、会占满配额导致正文为空；讲解不需要思考（仅智谱端点生效）
            thinking: 'disabled',
          },
          (d) => {
            acc += d;
            // 节流刷新：流式内容边生成边显示（完成时统一收尾）
            const now = Date.now();
            if (now - lastFlush >= 80) {
              lastFlush = now;
              if (explainSeqRef.current === seq) setExplain((prev) => (prev ? { ...prev, text: acc } : prev));
            }
          },
        );
        if (!r.ok || !r.content || !r.content.trim()) {
          apply({
            loading: false,
            text: null,
            error: r.error?.userMessage ?? '生成失败',
            evidence: [],
            usedLibrary: evidence.length > 0,
            noEvidence: false,
            fallback: null,
            saved: null,
          });
          return;
        }
        const text = acc.trim();
        // 教材模式下模型回复"未覆盖"固定句：视为无结果，转为联网/模型知识确认入口（不保存）
        if (evidence.length > 0 && isNoEvidenceAnswer(text)) {
          apply({ loading: false, text: null, error: null, evidence: [], usedLibrary: false, noEvidence: true, fallback: null, saved: null });
          return;
        }
        const saved = await saveExplanation(q.id, text);
        apply({
          loading: false,
          text,
          error: null,
          evidence,
          usedLibrary: evidence.length > 0,
          noEvidence: false,
          fallback: null,
          saved,
        });
      } catch (e) {
        apply({
          loading: false,
          text: null,
          error: String((e as Error)?.message ?? e),
          evidence: [],
          usedLibrary: false,
          noEvidence: false,
          fallback: null,
          saved: null,
        });
      }
    },
    [db, llm, q, saveExplanation],
  );

  /** 教材未命中、经用户确认后的降级讲解：智谱联网搜索 / 其他提供商模型知识 */
  const runFallbackExplain = useCallback(
    async (target: { url: string; model: string; apiKey: string }, mode: 'web' | 'model') => {
      if (!q) return;
      const seq = ++explainSeqRef.current;
      const apply = (s: ExplainState) => {
        if (explainSeqRef.current === seq) setExplain(s);
      };
      apply({ loading: true, text: null, error: null, evidence: [], usedLibrary: false, noEvidence: false, fallback: mode, saved: null });
      try {
        let acc = '';
        let lastFlush = 0;
        const r = await llm.completeStream(
          renderExplainPrompt({ stem: q.stem, options: q.options, answerText: q.answerText }),
          {
            model: target.model,
            endpoint: { url: target.url, apiKey: target.apiKey },
            temperature: 0.3,
            maxTokens: 2048,
            timeoutMs: 180000,
            webSearch: mode === 'web',
            thinking: 'disabled',
          },
          (d) => {
            acc += d;
            const now = Date.now();
            if (now - lastFlush >= 80) {
              lastFlush = now;
              if (explainSeqRef.current === seq) setExplain((prev) => (prev ? { ...prev, text: acc } : prev));
            }
          },
        );
        if (!r.ok || !r.content || !r.content.trim()) {
          apply({ loading: false, text: null, error: r.error?.userMessage ?? '生成失败', evidence: [], usedLibrary: false, noEvidence: false, fallback: mode, saved: null });
          return;
        }
        const text = acc.trim();
        const saved = await saveExplanation(q.id, text);
        apply({ loading: false, text, error: null, evidence: [], usedLibrary: false, noEvidence: false, fallback: mode, saved });
      } catch (e) {
        apply({ loading: false, text: null, error: String((e as Error)?.message ?? e), evidence: [], usedLibrary: false, noEvidence: false, fallback: mode, saved: null });
      }
    },
    [llm, q, saveExplanation],
  );

  const feedbackWrong = useCallback(async () => {
    if (!q) return;
    try {
      await recordAiFeedback(db, q.id);
      Alert.alert('已记录', '感谢反馈。');
    } catch {
      Alert.alert('记录失败');
    }
  }, [db, q]);

  /** 删除这道题已保存的 AI 讲解（自带解析不受影响，可重新生成） */
  const removeExplain = useCallback(() => {
    if (!q) return;
    Alert.alert('删除这道题的 AI 讲解？', '之后可以重新生成；题目自带解析不受影响。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await setQuestionExplanation(db, q.id, null);
              setQuestions((prev) => prev.map((x) => (x.id === q.id ? { ...x, explanation: null } : x)));
              setExplain(null);
            } catch (e) {
              Alert.alert('删除失败', String((e as Error)?.message ?? e));
            }
          })();
        },
      },
    ]);
  }, [db, q]);

  const resolveTarget = useCallback(async () => {
    return resolveExplainTarget(explainProvider, {
      zhipuApiKey: await getApiKey(),
      deepseekApiKey: await getDeepseekKey(),
      custom: await getCustomConfig(),
    });
  }, [explainProvider]);

  /** 讲解入口：应用内生成 或 分享到豆包等外部应用 */
  const onExplainPress = useCallback(async () => {
    if (!q) return;
    const target = await resolveTarget();
    if (target.kind === 'missing_config') {
      Alert.alert('需要先配置', target.message);
      return;
    }
    if (target.kind === 'share') {
      const text =
        `请讲解这道题：\n${q.stem}\n` +
        (q.options.length > 0 ? q.options.map((o) => `${o.id}. ${o.text}`).join('\n') + '\n' : '') +
        (q.answerText ? `正确答案：${q.answerText}` : '');
      try {
        await Share.share({ message: text });
      } catch (e) {
        Alert.alert('分享失败', String((e as Error)?.message ?? e));
      }
      return;
    }
    await runExplain({ url: target.url, model: target.model, apiKey: target.apiKey });
  }, [q, resolveTarget, runExplain]);

  /** 教材未命中：用户确认后联网搜索（仅智谱端点）或改用模型知识 */
  const onFallbackPress = useCallback(async () => {
    const target = await resolveTarget();
    if (target.kind !== 'api') {
      Alert.alert(
        '无法在应用内讲解',
        target.kind === 'missing_config' ? target.message : '当前为分享模式，请先切换到应用内讲解。',
      );
      return;
    }
    const canWeb = target.url === ZHIPU_URL;
    Alert.alert(
      '教材中未找到依据',
      canWeb
        ? '是否改用联网搜索回答？将额外消耗智谱额度，回答不再依据教材。'
        : '是否改用模型自身知识回答？回答不再依据教材，可能不准确。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: canWeb ? '联网搜索' : '用模型知识回答',
          onPress: () =>
            void runFallbackExplain(
              { url: target.url, model: target.model, apiKey: target.apiKey },
              canWeb ? 'web' : 'model',
            ),
        },
      ],
    );
  }, [resolveTarget, runFallbackExplain]);

  /** 重新生成讲解（生成成功后自动覆盖保存） */
  const regenerateExplain = useCallback(async () => {
    const target = await resolveTarget();
    if (target.kind !== 'api') {
      Alert.alert(
        '无法生成',
        target.kind === 'missing_config' ? target.message : '当前为分享模式，请先在设置里切换到应用内讲解。',
      );
      return;
    }
    await runExplain({ url: target.url, model: target.model, apiKey: target.apiKey });
  }, [resolveTarget, runExplain]);

  if (stage === 'pickBank') {
    return (
      <View style={styles.page}>
        <View style={styles.header}>
          <Pressable onPress={onDone} hitSlop={8}>
            <Text style={styles.back}>← 退出</Text>
          </Pressable>
          <Text style={styles.title}>选择题库</Text>
          <View style={styles.spacer} />
        </View>
        <ScrollView style={styles.pickList} contentContainerStyle={styles.pickListContent}>
          <Text style={styles.pickHint}>选择要在哪个题库刷题</Text>
          {banks.length === 0 && <Text style={styles.emptyText}>还没有题库。</Text>}
          {banks.map((b) => (
            <View key={b.id} style={styles.bankCard}>
              <Pressable
                style={styles.bankMain}
                onPress={() => {
                  setBankId(b.id);
                  setBankName(b.name);
                  setFavOnly(false);
                }}
              >
                <Text style={styles.bankCardName} numberOfLines={1}>
                  {b.name}
                </Text>
                <Text style={styles.bankCardCount}>{b.count} 题</Text>
              </Pressable>
              <Pressable
                style={[styles.favEntry, b.fav_count === 0 && styles.favEntryDisabled]}
                disabled={b.fav_count === 0}
                onPress={() => {
                  setBankId(b.id);
                  setBankName(b.name);
                  setFavOnly(true);
                }}
              >
                <Text style={styles.favEntryText}>★ 收藏 {b.fav_count}</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      </View>
    );
  }

  if (stage === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (stage === 'empty') {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>
          {mode === 'wrong'
            ? '错题本是空的。刷题时答错的题目会自动进来。'
            : favOnly
              ? '这个题库还没有收藏的题目。刷题时点题目下方的"☆ 收藏本题"，之后在选择题库时点"★ 收藏"即可只刷收藏。'
              : bankName
                ? `「${bankName}」还没有题目，先去首页识别导入，或返回换一个题库。`
                : '题库还没有题目，先去首页识别导入一些吧。'}
        </Text>
        <Pressable style={styles.primaryBtn} onPress={onDone}>
          <Text style={styles.primaryBtnText}>返回首页</Text>
        </Pressable>
      </View>
    );
  }

  if (stage === 'finished') {
    const total = session.right + session.wrong;
    return (
      <View style={styles.center}>
        <Text style={styles.doneTitle}>本轮完成</Text>
        <Text style={styles.centerText}>
          答对 {session.right} / 答错 {session.wrong}
          {session.skipped > 0 ? ` / 跳过 ${session.skipped}` : ''}
        </Text>
        {total > 0 && (
          <Text style={styles.centerHint}>正确率 {Math.round((session.right / total) * 100)}%</Text>
        )}
        <Pressable style={styles.primaryBtn} onPress={onDone}>
          <Text style={styles.primaryBtnText}>返回首页</Text>
        </Pressable>
      </View>
    );
  }

  if (!q) {
    return (
      <View style={styles.center}>
        <Pressable style={styles.primaryBtn} onPress={onDone}>
          <Text style={styles.primaryBtnText}>返回首页</Text>
        </Pressable>
      </View>
    );
  }

  const judged = stage === 'judged';
  const noAnswer = q.answer === null || q.answer === undefined;
  const opts = q.type === 'judge' ? [{ id: 'T', text: '正确' }, { id: 'F', text: '错误' }] : q.options;
  /** 展示用讲解：本次生成的优先；无本次结果时回放已保存的 AI 讲解 */
  const shownExplain: ExplainState | null =
    explain ??
    (q.explanation
      ? isNoEvidenceAnswer(q.explanation)
        ? // 历史保存的"未覆盖"固定句不再展示为讲解，直接给联网/模型知识入口
          { loading: false, text: null, error: null, evidence: [], usedLibrary: false, noEvidence: true, fallback: null, saved: null }
        : { loading: false, text: q.explanation, error: null, evidence: [], usedLibrary: false, noEvidence: false, fallback: null, saved: 'ok' }
      : null);

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={onDone} hitSlop={8}>
          <Text style={styles.back}>← 退出</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {mode === 'wrong' ? '错题重刷' : favOnly ? `${bankName ?? '刷题'} · 收藏` : bankName ?? '刷题'}
        </Text>
        <View style={styles.headerRight}>
          <Pressable onPress={() => setShowList(true)} hitSlop={6}>
            <Text style={styles.counter}>
              {idx + 1}/{questions.length} ☰
            </Text>
          </Pressable>
          <Pressable onPress={() => setOrderState((o) => (o === 'seq' ? 'random' : 'seq'))} hitSlop={6}>
            <Text style={styles.counter}>{orderState === 'random' ? '随机 ⇄' : '顺序 ⇄'}</Text>
          </Pressable>
          {mode === 'bank' && (
            <Pressable onPress={() => setFavOnly((v) => !v)} hitSlop={6}>
              <Text style={[styles.counter, favOnly && styles.counterOn]}>{favOnly ? '★ 收藏 ⇄' : '☆ 收藏'}</Text>
            </Pressable>
          )}
        </View>
      </View>

      <ScrollView ref={scrollRef} style={styles.body} contentContainerStyle={styles.bodyContent}>
        <View style={styles.stemCard}>
          <Text style={styles.stemText}>{q.stem}</Text>
        </View>

        <Pressable style={styles.favRow} onPress={() => void toggleFavorite()}>
          <Text style={[styles.favText, q.favorite && styles.favTextOn]}>
            {q.favorite ? '★ 已收藏（点击取消）' : '☆ 收藏本题'}
          </Text>
        </Pressable>

        {q.questionImage ? (
          <Pressable onPress={() => setShowFigure(true)}>
            <Image source={{ uri: q.questionImage }} style={styles.questionFigure} resizeMode="contain" />
          </Pressable>
        ) : null}

        {opts.map((o) => {
          const picked = chosen.includes(o.id);
          const correctOpt = judged && isOptionCorrect(q, o.id);
          const wrongPick = judged && picked && !correctOpt;
          return (
            <Pressable
              key={o.id}
              style={[styles.optBtn, picked && styles.optPicked, correctOpt && styles.optCorrect, wrongPick && styles.optWrong]}
              onPress={() => pickOption(o.id)}
              disabled={judged}
            >
              <Text style={[styles.optText, (correctOpt || wrongPick) && styles.optTextStrong]}>
                {q.type === 'judge' ? o.text : `${o.id}. ${o.text}`}
              </Text>
            </Pressable>
          );
        })}

        {q.type === 'fill' && (
          <TextInput
            style={styles.fillInput}
            value={textAnswer}
            onChangeText={setTextAnswer}
            placeholder="输入你的答案"
            editable={stage === 'answering'}
            autoCorrect={false}
          />
        )}

        {judged && (
          <View style={styles.feedback}>
            {result?.correct === true && <Text style={styles.okText}>✔ 答对了</Text>}
            {result?.correct === false && <Text style={styles.badText}>✘ 答错了，正确答案：{q.answerText}</Text>}
            {result?.correct === null && (
              <Text style={styles.warnText}>
                该题暂无答案，无法自动判定。可点下方"AI 讲解"获取答案与解析，或在题库管理里补充答案。
              </Text>
            )}
            {q.analysis ? <Text style={styles.analysisText}>解析：{q.analysis}</Text> : null}
            {shownExplain === null && (
              <Pressable style={styles.explainBtn} onPress={() => void onExplainPress()}>
                <Text style={styles.explainBtnText}>{explainProvider === 'external' ? '发给豆包讲解' : 'AI 讲解'}</Text>
              </Pressable>
            )}
            {shownExplain?.loading && (
              <View style={styles.explainLoading}>
                <ActivityIndicator size="small" />
                <Text style={styles.explainLoadingText}>正在生成讲解…</Text>
              </View>
            )}
            {shownExplain?.noEvidence && (
              <>
                <Text style={styles.warnText}>教材中未找到能讲这道题的内容（可能是措辞差异或教材未覆盖）。</Text>
                <Pressable style={styles.explainBtn} onPress={() => void onFallbackPress()}>
                  <Text style={styles.explainBtnText}>
                    {explainProvider === 'zhipu_free' || explainProvider === 'zhipu_pro'
                      ? '联网搜索答案'
                      : '用模型知识回答'}
                  </Text>
                </Pressable>
              </>
            )}
            {shownExplain?.error ? (
              <>
                <Text style={styles.explainError}>讲解生成失败：{shownExplain.error}</Text>
                <Pressable style={styles.explainBtn} onPress={() => void onExplainPress()}>
                  <Text style={styles.explainBtnText}>重试讲解</Text>
                </Pressable>
              </>
            ) : null}
            {shownExplain?.text ? (
              <View style={styles.explainCard}>
                <Text style={styles.explainText}>{shownExplain.text}</Text>
                {shownExplain.evidence.length > 0 ? (
                  <View style={styles.evidenceBox}>
                    <Pressable onPress={() => setShowEvidence((v) => !v)} hitSlop={6}>
                      <Text style={styles.evidenceTitle}>
                        教材依据 {shownExplain.evidence.length} 条{showEvidence ? ' ▾' : ' ▸'}
                      </Text>
                    </Pressable>
                    {showEvidence &&
                      shownExplain.evidence.map((e) => (
                        <View key={e.index} style={styles.evidenceItem}>
                          <Text style={styles.evidenceSource}>
                            [{e.index}] {e.source}
                          </Text>
                          <Text style={styles.evidenceText} numberOfLines={3}>
                            {e.text}
                          </Text>
                        </View>
                      ))}
                  </View>
                ) : shownExplain.fallback ? null : (
                  <Text style={styles.noLibrary}>（未引用教材：教材库为空或没有命中内容）</Text>
                )}
                {shownExplain.fallback ? (
                  <Text style={styles.aiWarn}>
                    未依据教材（{shownExplain.fallback === 'web' ? '联网搜索结果' : '模型自身知识'}），仅供参考
                  </Text>
                ) : (
                  <Text style={styles.aiWarn}>AI 生成内容，仅供参考</Text>
                )}
                {shownExplain.saved === 'ok' && <Text style={styles.savedTag}>✓ 讲解已保存</Text>}
                {shownExplain.saved === 'fail' && (
                  <Text style={styles.savedFail}>自动保存失败（不影响查看，重新生成会再试）</Text>
                )}
                {!shownExplain.loading && (
                <View style={styles.explainActions}>
                  <Pressable style={styles.smallBtn} onPress={() => void feedbackWrong()}>
                    <Text style={styles.smallBtnText}>反馈有误</Text>
                  </Pressable>
                  <Pressable style={styles.smallBtn} onPress={() => void regenerateExplain()}>
                    <Text style={styles.smallBtnText}>重新生成</Text>
                  </Pressable>
                  <Pressable style={styles.smallDeleteBtn} onPress={removeExplain}>
                    <Text style={styles.smallDeleteText}>删除讲解</Text>
                  </Pressable>
                </View>
                )}
              </View>
            ) : null}
            {q.sourceImage ? (
              <Pressable style={styles.srcBtn} onPress={() => setShowImage(true)}>
                <Text style={styles.srcBtnText}>查看来源图</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        {stage === 'answering' && noAnswer && (
          <Pressable style={styles.ghostBtn} onPress={skip}>
            <Text style={styles.ghostBtnText}>跳过（无答案）</Text>
          </Pressable>
        )}
        {stage === 'answering' && q.type === 'multiple' && (
          <Pressable
            style={[styles.primaryBtnSmall, chosen.length === 0 && styles.disabledBtn]}
            onPress={() => void submit(chosen)}
            disabled={chosen.length === 0}
          >
            <Text style={styles.primaryBtnText}>提交答案</Text>
          </Pressable>
        )}
        {stage === 'answering' && q.type === 'fill' && (
          <Pressable
            style={[styles.primaryBtnSmall, !textAnswer.trim() && styles.disabledBtn]}
            onPress={() => void submitText()}
            disabled={!textAnswer.trim()}
          >
            <Text style={styles.primaryBtnText}>提交答案</Text>
          </Pressable>
        )}
        {judged && (
          <Pressable style={styles.primaryBtnSmall} onPress={next}>
            <Text style={styles.primaryBtnText}>{idx + 1 >= questions.length ? '完成' : '下一题'}</Text>
          </Pressable>
        )}
      </View>

      <Modal visible={showList} transparent animationType="slide" onRequestClose={() => setShowList(false)}>
        <View style={styles.sheetBg}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>选择题目（{questions.length} 题）</Text>
            <ScrollView style={styles.sheetList}>
              {questions.map((item, i) => (
                <Pressable key={item.id} style={[styles.sheetRow, i === idx && styles.sheetRowOn]} onPress={() => jumpTo(i)}>
                  <Text style={[styles.sheetRowName, i === idx && styles.sheetRowNameOn]} numberOfLines={1}>
                    {i + 1}. {item.stem}
                  </Text>
                  {item.favorite && <Text style={styles.listStar}>★</Text>}
                </Pressable>
              ))}
            </ScrollView>
            <Pressable style={styles.sheetClose} onPress={() => setShowList(false)}>
              <Text style={styles.sheetCloseText}>关闭</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={showImage} transparent onRequestClose={() => setShowImage(false)}>
        <View style={styles.modalBg}>
          {q.sourceImage ? <Image source={{ uri: q.sourceImage }} style={styles.modalImage} resizeMode="contain" /> : null}
          <Pressable style={styles.modalClose} onPress={() => setShowImage(false)}>
            <Text style={styles.modalCloseText}>关闭</Text>
          </Pressable>
        </View>
      </Modal>

      <Modal visible={showFigure} transparent onRequestClose={() => setShowFigure(false)}>
        <View style={styles.modalBg}>
          {q.questionImage ? (
            <Image source={{ uri: q.questionImage }} style={styles.modalImage} resizeMode="contain" />
          ) : null}
          <Pressable style={styles.modalClose} onPress={() => setShowFigure(false)}>
            <Text style={styles.modalCloseText}>关闭</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f8fa', paddingTop: 56 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f7f8fa', paddingHorizontal: 28 },
  emptyText: { fontSize: 14, color: '#66707f', textAlign: 'center', lineHeight: 21 },
  doneTitle: { fontSize: 22, fontWeight: '800', color: '#1c5cd6' },
  centerText: { marginTop: 14, fontSize: 16, color: '#333' },
  centerHint: { marginTop: 8, fontSize: 13, color: '#66707f' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  back: { fontSize: 15, color: '#1c5cd6' },
  title: { flexShrink: 1, marginHorizontal: 8, fontSize: 18, fontWeight: '800', color: '#1a1a1a' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  counter: { fontSize: 13, color: '#66707f' },
  counterOn: { color: '#b8860b', fontWeight: '700' },
  spacer: { width: 52 },
  pickList: { flex: 1, marginTop: 12 },
  pickListContent: { paddingHorizontal: 16, paddingBottom: 30 },
  pickHint: { fontSize: 13, color: '#66707f', marginBottom: 10 },
  bankCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 16,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  bankMain: { flex: 1 },
  bankCardName: { fontSize: 16, fontWeight: '700', color: '#222' },
  bankCardCount: { marginTop: 3, fontSize: 13, color: '#66707f' },
  favEntry: {
    marginLeft: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#f0c36d',
    backgroundColor: '#fffaf0',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  favEntryDisabled: { opacity: 0.4 },
  favEntryText: { fontSize: 13, color: '#b8860b', fontWeight: '700' },
  favRow: { alignSelf: 'flex-start', marginBottom: 10, paddingVertical: 4 },
  favText: { fontSize: 13, color: '#8a94a6' },
  favTextOn: { color: '#b8860b', fontWeight: '700' },
  body: { flex: 1, marginTop: 12 },
  bodyContent: { paddingHorizontal: 16, paddingBottom: 20 },
  stemCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 14 },
  stemText: { fontSize: 16, color: '#222', lineHeight: 24 },
  questionFigure: { width: '100%', height: 180, borderRadius: 12, backgroundColor: '#fff', marginBottom: 14 },
  fillInput: {
    marginTop: 4,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#dbe1ec',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#333',
  },
  optBtn: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1.5, borderColor: '#dbe1ec', paddingVertical: 13, paddingHorizontal: 14, marginBottom: 10 },
  optPicked: { borderColor: '#1c5cd6', backgroundColor: '#f3f7ff' },
  optCorrect: { borderColor: '#0a7d33', backgroundColor: '#eaf7ef' },
  optWrong: { borderColor: '#c02a2a', backgroundColor: '#fdecea' },
  optText: { fontSize: 15, color: '#333', lineHeight: 21 },
  optTextStrong: { fontWeight: '700' },
  feedback: { marginTop: 6, backgroundColor: '#fff', borderRadius: 12, padding: 14 },
  okText: { fontSize: 16, fontWeight: '800', color: '#0a7d33' },
  badText: { fontSize: 16, fontWeight: '800', color: '#c02a2a' },
  warnText: { fontSize: 14, color: '#b8860b', lineHeight: 20 },
  analysisText: { marginTop: 10, fontSize: 14, color: '#444', lineHeight: 21 },
  explainBtn: { marginTop: 12, alignSelf: 'flex-start', backgroundColor: '#eef3fb', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 },
  explainBtnText: { color: '#31518a', fontSize: 13, fontWeight: '700' },
  explainLoading: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  explainLoadingText: { fontSize: 13, color: '#66707f' },
  explainError: { marginTop: 12, fontSize: 13, color: '#c02a2a', lineHeight: 19 },
  explainCard: { marginTop: 12, backgroundColor: '#f8fafd', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#dbe5f3' },
  explainText: { fontSize: 14, color: '#333', lineHeight: 22 },
  evidenceBox: { marginTop: 12, borderTopWidth: 1, borderTopColor: '#e3ebf7', paddingTop: 10 },
  evidenceTitle: { fontSize: 12, color: '#66707f', fontWeight: '700' },
  evidenceItem: { marginTop: 8, backgroundColor: '#fff', borderRadius: 8, padding: 10 },
  evidenceSource: { fontSize: 11, color: '#31518a' },
  evidenceText: { marginTop: 4, fontSize: 12, color: '#555', lineHeight: 18 },
  noLibrary: { marginTop: 10, fontSize: 11, color: '#98a2b3' },
  aiWarn: { marginTop: 10, fontSize: 11, color: '#b8860b' },
  savedTag: { marginTop: 10, fontSize: 11, color: '#0a7d33', fontWeight: '700' },
  savedFail: { marginTop: 10, fontSize: 11, color: '#c02a2a' },
  explainActions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  smallBtn: { borderRadius: 8, borderWidth: 1, borderColor: '#cfd9ea', backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 7 },
  smallBtnText: { color: '#31518a', fontSize: 12 },
  smallDeleteBtn: { borderRadius: 8, borderWidth: 1, borderColor: '#e3b4ae', backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 7 },
  smallDeleteText: { color: '#c0392b', fontSize: 12 },
  srcBtn: { marginTop: 12, alignSelf: 'flex-start', backgroundColor: '#e8f0ff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  srcBtnText: { color: '#1c5cd6', fontSize: 13, fontWeight: '700' },
  footer: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingBottom: 26, paddingTop: 8 },
  ghostBtn: { flex: 1, borderRadius: 12, borderWidth: 1, borderColor: '#cfd9ea', backgroundColor: '#fff', alignItems: 'center', paddingVertical: 14 },
  ghostBtnText: { color: '#31518a', fontSize: 15 },
  primaryBtn: { marginTop: 24, backgroundColor: '#1c5cd6', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 40 },
  primaryBtnSmall: { flex: 1, backgroundColor: '#1c5cd6', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  disabledBtn: { opacity: 0.5 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  modalImage: { width: '100%', height: '85%' },
  modalClose: { marginTop: 16, paddingVertical: 10, paddingHorizontal: 32, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)' },
  modalCloseText: { color: '#fff', fontSize: 15 },
  sheetBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 26,
  },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: '#1a1a1a' },
  sheetList: { maxHeight: 420, marginTop: 8 },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e3e8f0',
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginTop: 8,
  },
  sheetRowOn: { borderColor: '#1c5cd6', backgroundColor: '#f3f7ff' },
  sheetRowName: { flex: 1, fontSize: 14, color: '#333' },
  sheetRowNameOn: { color: '#1c5cd6', fontWeight: '700' },
  listStar: { marginLeft: 8, fontSize: 14, color: '#f0a500' },
  sheetClose: { marginTop: 14, alignItems: 'center', paddingVertical: 12 },
  sheetCloseText: { color: '#66707f', fontSize: 14 },
});
