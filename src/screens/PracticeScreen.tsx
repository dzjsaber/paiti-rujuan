/**
 * F4 刷题模式：
 * - 顺序/随机；single/judge 点选即判，multiple 需提交判定；
 * - 答对/答错立即反馈并显示正确答案；答错自动进入错题本；
 * - 错题本模式重刷答对 → 自动移出错题本（历史记录保留）；
 * - answer 为 null 的题不自动判定，提示"暂无答案"并允许跳过。
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { DEFAULT_BANK_ID } from '../db/database';
import { listPracticeQuestions, markWrong, recordAnswer, removeFromWrongBook, shuffleInPlace } from '../db/repo_practice';
import type { QuestionRow } from '../db/repo_questions';

export interface PracticeScreenProps {
  db: SQLiteDatabase;
  mode: 'bank' | 'wrong';
  order: 'seq' | 'random';
  onDone: () => void;
}

type Stage = 'loading' | 'answering' | 'judged' | 'finished' | 'empty';

interface ParsedQuestion {
  id: string;
  type: string;
  stem: string;
  options: { id: string; text: string }[];
  answer: unknown;
  answerText: string;
  analysis: string | null;
  sourceImage: string | null;
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
    type: row.type,
    stem: row.stem,
    options: Array.isArray(options) ? options : [],
    answer,
    answerText,
    analysis: row.analysis,
    sourceImage: row.source_image_path,
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

export function PracticeScreen({ db, mode, order, onDone }: PracticeScreenProps) {
  const [stage, setStage] = useState<Stage>('loading');
  const [questions, setQuestions] = useState<ParsedQuestion[]>([]);
  const [idx, setIdx] = useState(0);
  const [chosen, setChosen] = useState<string[]>([]);
  const [result, setResult] = useState<{ correct: boolean | null } | null>(null);
  const [session, setSession] = useState({ right: 0, wrong: 0, skipped: 0 });
  const [showImage, setShowImage] = useState(false);
  const [orderState, setOrderState] = useState<'seq' | 'random'>(order);

  const loadQuestions = useCallback(
    async (ord: 'seq' | 'random') => {
      setStage('loading');
      try {
        const rows = await listPracticeQuestions(db, DEFAULT_BANK_ID, mode);
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
    [db, mode],
  );

  useEffect(() => {
    void loadQuestions(orderState);
  }, [loadQuestions, orderState]);

  const q = questions[idx];

  const next = useCallback(() => {
    setChosen([]);
    setResult(null);
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
          {mode === 'wrong' ? '错题本是空的。刷题时答错的题目会自动进来。' : '题库还没有题目，先去首页识别导入一些吧。'}
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
        <Text style={styles.title}>{mode === 'wrong' ? '错题重刷' : '刷题'}</Text>
        <Pressable onPress={() => setOrderState((o) => (o === 'seq' ? 'random' : 'seq'))} hitSlop={6}>
          <Text style={styles.counter}>
            {idx + 1}/{questions.length} · {orderState === 'random' ? '随机 ⇄' : '顺序 ⇄'}
          </Text>
        </Pressable>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        <View style={styles.stemCard}>
          <Text style={styles.stemText}>{q.stem}</Text>
        </View>

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
  title: { fontSize: 18, fontWeight: '800', color: '#1a1a1a' },
  counter: { fontSize: 13, color: '#66707f' },
  body: { flex: 1, marginTop: 12 },
  bodyContent: { paddingHorizontal: 16, paddingBottom: 20 },
  stemCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 14 },
  stemText: { fontSize: 16, color: '#222', lineHeight: 24 },
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
