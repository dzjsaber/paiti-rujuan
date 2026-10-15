/**
 * F4 刷题模式：
 * - 顺序/随机；single/judge 点选即判，multiple 需提交判定；
 * - 答对/答错立即反馈并显示正确答案；答错自动进入错题本；
 * - 错题本模式重刷答对 → 自动移出错题本（历史记录保留）；
 * - answer 为 null 的题不自动判定，提示"暂无答案"并允许跳过。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { searchMaterialsSmart } from '../db/fts';
import { listBankMaterialIds, listBanks, type BankSummary } from '../db/repo_banks';
import { listPracticeQuestions, markWrong, recordAiFeedback, recordAnswer, removeFromWrongBook, shuffleInPlace } from '../db/repo_practice';
import { setQuestionAnalysis, type QuestionRow } from '../db/repo_questions';
import { renderExplainPrompt } from '../prompts/explain';
import { renderRagPrompt, type RagEvidence } from '../prompts/ragExplain';
import { TEXT_MODEL, type LLMService } from '../services/llm/LLMService';
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
  type: string;
  stem: string;
  options: { id: string; text: string }[];
  answer: unknown;
  answerText: string;
  analysis: string | null;
  sourceImage: string | null;
  questionImage: string | null;
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
    type: row.type,
    stem: row.stem,
    options: Array.isArray(options) ? options : [],
    answer,
    answerText,
    analysis: row.analysis,
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
  const [result, setResult] = useState<{ correct: boolean | null } | null>(null);
  const [session, setSession] = useState({ right: 0, wrong: 0, skipped: 0 });
  const [showImage, setShowImage] = useState(false);
  const [showFigure, setShowFigure] = useState(false);
  const [orderState, setOrderState] = useState<'seq' | 'random'>(order);
  const [explain, setExplain] = useState<{
    loading: boolean;
    text: string | null;
    error: string | null;
    evidence: RagEvidence[];
    usedLibrary: boolean;
    /** 题库已绑定教材但检索无命中：等待用户确认是否降级（联网/模型知识） */
    noEvidence: boolean;
    /** 非空表示本次讲解未依据教材（用户确认后的降级方式） */
    fallback: 'web' | 'model' | null;
  } | null>(null);
  const [adopted, setAdopted] = useState(false);
  const [explainProvider, setExplainProvider] = useState<ExplainProviderId>('zhipu_free');
  const [bankId, setBankId] = useState<string | null>(null);
  const [bankName, setBankName] = useState<string | null>(null);
  const [banks, setBanks] = useState<BankSummary[]>([]);
  const scrollRef = useRef<ScrollView>(null);

  const loadQuestions = useCallback(
    async (ord: 'seq' | 'random') => {
      setStage('loading');
      try {
        const rows = await listPracticeQuestions(db, mode, bankId ?? undefined);
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
    [db, mode, bankId],
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
    setChosen([]);
    setResult(null);
    setExplain(null);
    setAdopted(false);
    if (idx + 1 >= questions.length) {
      setStage('finished');
      return;
    }
    setIdx((i) => i + 1);
    setStage('answering');
  }, [idx, questions.length]);

  const submit = useCallback(
    async (choice: string[]) => {
      if (!q || stage !== 'answering') return;
      const correct = evaluate(q, choice);
      setChosen(choice);
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
    [db, q, stage, mode],
  );

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

  /**
   * F7/F9b：AI 讲解。
   * 题库绑定了教材时只检索绑定教材，且必须依据教材回答；检索无命中不自动降级，
   * 由用户确认后走联网/模型知识（见 onFallbackPress）。未绑定教材则维持"命中用教材、未命中普通讲解"。
   */
  const runExplain = useCallback(
    async (target: { url: string; model: string; apiKey: string }) => {
      if (!q) return;
      setExplain({ loading: true, text: null, error: null, evidence: [], usedLibrary: false, noEvidence: false, fallback: null });
      try {
        const input = { stem: q.stem, options: q.options, answerText: q.answerText };
        const boundIds = await listBankMaterialIds(db, q.bankId);
        const hits = await searchMaterialsSmart(
          db,
          `${q.stem}\n${q.options.map((o) => o.text).join('\n')}`,
          5,
          boundIds.length > 0 ? boundIds : undefined,
        );
        const evidence: RagEvidence[] = hits.map((h, i) => ({
          index: i + 1,
          text: h.text.slice(0, 300),
          source: `${h.materialName}${h.sourceLoc ? ` · ${h.sourceLoc}` : ''}`,
        }));
        if (evidence.length === 0 && boundIds.length > 0) {
          setExplain({ loading: false, text: null, error: null, evidence: [], usedLibrary: false, noEvidence: true, fallback: null });
          return;
        }
        const prompt = evidence.length > 0 ? renderRagPrompt(input, evidence) : renderExplainPrompt(input);
        const r = await llm.complete(prompt, {
          model: target.model,
          endpoint: { url: target.url, apiKey: target.apiKey },
          temperature: 0.3,
          maxTokens: 1024,
          timeoutMs: 60000,
        });
        if (!r.ok || !r.content || !r.content.trim()) {
          setExplain({
            loading: false,
            text: null,
            error: r.error?.userMessage ?? '生成失败',
            evidence: [],
            usedLibrary: evidence.length > 0,
            noEvidence: false,
            fallback: null,
          });
          return;
        }
        setExplain({
          loading: false,
          text: r.content.trim(),
          error: null,
          evidence,
          usedLibrary: evidence.length > 0,
          noEvidence: false,
          fallback: null,
        });
      } catch (e) {
        setExplain({
          loading: false,
          text: null,
          error: String((e as Error)?.message ?? e),
          evidence: [],
          usedLibrary: false,
          noEvidence: false,
          fallback: null,
        });
      }
    },
    [db, llm, q],
  );

  /** 教材未命中、经用户确认后的降级讲解：智谱联网搜索 / 其他提供商模型知识 */
  const runFallbackExplain = useCallback(
    async (target: { url: string; model: string; apiKey: string }, mode: 'web' | 'model') => {
      if (!q) return;
      setExplain({ loading: true, text: null, error: null, evidence: [], usedLibrary: false, noEvidence: false, fallback: mode });
      try {
        const r = await llm.complete(renderExplainPrompt({ stem: q.stem, options: q.options, answerText: q.answerText }), {
          model: target.model,
          endpoint: { url: target.url, apiKey: target.apiKey },
          temperature: 0.3,
          maxTokens: 1024,
          timeoutMs: 90000,
          webSearch: mode === 'web',
        });
        if (!r.ok || !r.content || !r.content.trim()) {
          setExplain({ loading: false, text: null, error: r.error?.userMessage ?? '生成失败', evidence: [], usedLibrary: false, noEvidence: false, fallback: mode });
          return;
        }
        setExplain({ loading: false, text: r.content.trim(), error: null, evidence: [], usedLibrary: false, noEvidence: false, fallback: mode });
      } catch (e) {
        setExplain({ loading: false, text: null, error: String((e as Error)?.message ?? e), evidence: [], usedLibrary: false, noEvidence: false, fallback: mode });
      }
    },
    [llm, q],
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

  const adopt = useCallback(async () => {
    if (!q || !explain?.text) return;
    try {
      await setQuestionAnalysis(db, q.id, explain.text);
      setAdopted(true);
      Alert.alert('已采纳', '讲解已写入该题解析（标记为用户确认）。');
    } catch (e) {
      Alert.alert('采纳失败', String((e as Error)?.message ?? e));
    }
  }, [db, q, explain]);

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
            <Pressable
              key={b.id}
              style={styles.bankCard}
              onPress={() => {
                setBankId(b.id);
                setBankName(b.name);
              }}
            >
              <Text style={styles.bankCardName} numberOfLines={1}>
                {b.name}
              </Text>
              <Text style={styles.bankCardCount}>{b.count} 题</Text>
            </Pressable>
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

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={onDone} hitSlop={8}>
          <Text style={styles.back}>← 退出</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {mode === 'wrong' ? '错题重刷' : bankName ?? '刷题'}
        </Text>
        <Pressable onPress={() => setOrderState((o) => (o === 'seq' ? 'random' : 'seq'))} hitSlop={6}>
          <Text style={styles.counter}>
            {idx + 1}/{questions.length} · {orderState === 'random' ? '随机 ⇄' : '顺序 ⇄'}
          </Text>
        </Pressable>
      </View>

      <ScrollView ref={scrollRef} style={styles.body} contentContainerStyle={styles.bodyContent}>
        <View style={styles.stemCard}>
          <Text style={styles.stemText}>{q.stem}</Text>
        </View>

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

        {judged && (
          <View style={styles.feedback}>
            {result?.correct === true && <Text style={styles.okText}>✔ 答对了</Text>}
            {result?.correct === false && <Text style={styles.badText}>✘ 答错了，正确答案：{q.answerText}</Text>}
            {result?.correct === null && (
              <Text style={styles.warnText}>该题暂无答案，无法自动判定（可在"导入历史"里补充答案后重新校验）</Text>
            )}
            {q.analysis ? <Text style={styles.analysisText}>解析：{q.analysis}</Text> : null}
            {explain === null && (
              <Pressable style={styles.explainBtn} onPress={() => void onExplainPress()}>
                <Text style={styles.explainBtnText}>{explainProvider === 'external' ? '发给豆包讲解' : 'AI 讲解'}</Text>
              </Pressable>
            )}
            {explain?.loading && (
              <View style={styles.explainLoading}>
                <ActivityIndicator size="small" />
                <Text style={styles.explainLoadingText}>正在生成讲解…</Text>
              </View>
            )}
            {explain?.noEvidence && (
              <>
                <Text style={styles.warnText}>当前导入教材未覆盖该知识点。</Text>
                <Pressable style={styles.explainBtn} onPress={() => void onFallbackPress()}>
                  <Text style={styles.explainBtnText}>
                    {explainProvider === 'zhipu_free' || explainProvider === 'zhipu_pro'
                      ? '联网搜索答案'
                      : '用模型知识回答'}
                  </Text>
                </Pressable>
              </>
            )}
            {explain?.error ? (
              <>
                <Text style={styles.explainError}>讲解生成失败：{explain.error}</Text>
                <Pressable style={styles.explainBtn} onPress={() => void onExplainPress()}>
                  <Text style={styles.explainBtnText}>重试讲解</Text>
                </Pressable>
              </>
            ) : null}
            {explain?.text ? (
              <View style={styles.explainCard}>
                <Text style={styles.explainText}>{explain.text}</Text>
                {explain.evidence.length > 0 ? (
                  <View style={styles.evidenceBox}>
                    <Text style={styles.evidenceTitle}>教材依据</Text>
                    {explain.evidence.map((e) => (
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
                ) : explain.fallback ? null : (
                  <Text style={styles.noLibrary}>（未引用教材：教材库为空或没有命中内容）</Text>
                )}
                {explain.fallback ? (
                  <Text style={styles.aiWarn}>
                    未依据教材（{explain.fallback === 'web' ? '联网搜索结果' : '模型自身知识'}），仅供参考
                  </Text>
                ) : (
                  <Text style={styles.aiWarn}>AI 生成内容，仅供参考</Text>
                )}
                <View style={styles.explainActions}>
                  <Pressable style={styles.smallBtn} onPress={() => void feedbackWrong()}>
                    <Text style={styles.smallBtnText}>反馈有误</Text>
                  </Pressable>
                  {!adopted ? (
                    <Pressable style={styles.smallBtn} onPress={() => void adopt()}>
                      <Text style={styles.smallBtnText}>采纳为解析</Text>
                    </Pressable>
                  ) : (
                    <Text style={styles.adoptedTag}>已采纳为解析</Text>
                  )}
                </View>
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
        {judged && (
          <Pressable style={styles.primaryBtnSmall} onPress={next}>
            <Text style={styles.primaryBtnText}>{idx + 1 >= questions.length ? '完成' : '下一题'}</Text>
          </Pressable>
        )}
      </View>

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
  counter: { fontSize: 13, color: '#66707f' },
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
  bankCardName: { flex: 1, fontSize: 16, fontWeight: '700', color: '#222' },
  bankCardCount: { marginLeft: 10, fontSize: 13, color: '#66707f' },
  body: { flex: 1, marginTop: 12 },
  bodyContent: { paddingHorizontal: 16, paddingBottom: 20 },
  stemCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 14 },
  stemText: { fontSize: 16, color: '#222', lineHeight: 24 },
  questionFigure: { width: '100%', height: 180, borderRadius: 12, backgroundColor: '#fff', marginBottom: 14 },
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
  explainActions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  smallBtn: { borderRadius: 8, borderWidth: 1, borderColor: '#cfd9ea', backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 7 },
  smallBtnText: { color: '#31518a', fontSize: 12 },
  adoptedTag: { fontSize: 12, color: '#0a7d33', fontWeight: '700' },
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
});
