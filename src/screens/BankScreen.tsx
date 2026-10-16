/**
 * 题库管理（多库）：先列出题库（名称 + 题目数），点进库里管理题目——
 * 浏览、补答案/编辑题干选项、删除（§F4：没有答案的题目提示补充）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import type { SQLiteDatabase } from 'expo-sqlite';
import { BankMaterialPicker } from '../components/BankMaterialPicker';
import type { QuestionDraft, QuestionType } from '../core/models';
import { f2ValidateQuestion } from '../core/validation/f2';
import { normalizeAnswer } from '../core/validation/normalize';
import { deleteBank, listBankMaterialIds, listBanks, renameBank, type BankSummary } from '../db/repo_banks';
import {
  deleteQuestion,
  listQuestions,
  rowToQuestion,
  setQuestionAnswer,
  setQuestionStatus,
  updateQuestionContent,
  type QuestionRow,
} from '../db/repo_questions';
import { extractQuestionNo, parseAnswerDoc, parseAnswerTable } from '../services/documents/answerTable';
import { extractDocument } from '../services/documents/extractors';

export interface BankScreenProps {
  db: SQLiteDatabase;
  onBack: () => void;
}

function answerToText(a: unknown): string {
  if (a === null || a === undefined) return '';
  if (a === true) return '对';
  if (a === false) return '错';
  if (Array.isArray(a)) return a.join(',');
  return String(a);
}

function hasAnswer(row: QuestionRow): boolean {
  try {
    return JSON.parse(row.answer_json) !== null;
  } catch {
    return false;
  }
}

function typeShort(t: string): string {
  return t === 'single' ? '单选' : t === 'multiple' ? '多选' : t === 'judge' ? '判断' : '填空';
}

export function BankScreen({ db, onBack }: BankScreenProps) {
  const [banks, setBanks] = useState<BankSummary[]>([]);
  const [selected, setSelected] = useState<BankSummary | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [materialTarget, setMaterialTarget] = useState<{ id: string; name: string } | null>(null);
  const [boundCount, setBoundCount] = useState(0);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [rows, setRows] = useState<QuestionRow[]>([]);
  const [filter, setFilter] = useState<'all' | 'noanswer'>('all');
  const [editing, setEditing] = useState<{ id: string; draft: QuestionDraft } | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [saving, setSaving] = useState(false);

  const refreshBanks = useCallback(async () => {
    try {
      setBanks(await listBanks(db));
    } catch {
      setBanks([]);
    }
  }, [db]);

  const refresh = useCallback(async () => {
    if (!selected) return;
    try {
      setRows(await listQuestions(db, selected.id, 500, 0));
    } catch {
      setRows([]);
    }
  }, [db, selected]);

  useEffect(() => {
    void refreshBanks();
  }, [refreshBanks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openBank = useCallback((b: BankSummary) => {
    setFilter('all');
    setRows([]);
    setSelected(b);
  }, []);

  const backToBankList = useCallback(() => {
    setSelected(null);
    void refreshBanks();
  }, [refreshBanks]);

  const refreshBound = useCallback(async () => {
    if (!selected) return;
    try {
      setBoundCount((await listBankMaterialIds(db, selected.id)).length);
    } catch {
      setBoundCount(0);
    }
  }, [db, selected]);

  useEffect(() => {
    void refreshBound();
  }, [refreshBound]);

  const confirmRename = useCallback(async () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) {
      Alert.alert('请输入题库名称');
      return;
    }
    try {
      await renameBank(db, renaming.id, name);
      setRenaming(null);
      await refreshBanks();
    } catch (e) {
      Alert.alert('重命名失败', String((e as Error)?.message ?? e));
    }
  }, [db, renaming, refreshBanks]);

  const removeBank = useCallback(
    (b: BankSummary) => {
      Alert.alert(
        `删除题库「${b.name}」？`,
        b.count > 0
          ? `库内 ${b.count} 道题目、相关错题与做题记录将一并删除，无法恢复。`
          : '该题库没有题目。',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '删除',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  await deleteBank(db, b.id);
                  await refreshBanks();
                } catch (e) {
                  Alert.alert('删除失败', String((e as Error)?.message ?? e));
                }
              })();
            },
          },
        ],
      );
    },
    [db, refreshBanks],
  );

  /**
   * 从答案文档补充答案：选择文件 → 本地解析"题号→答案" → 按题号匹配库内缺答案的题目
   * → 确认后批量写入（不覆盖已有答案；题号重复/类型不符的跳过）。
   */
  const importAnswers = useCallback(async () => {
    if (!selected || answerBusy) return;
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'application/vnd.ms-powerpoint',
          'application/msword',
          'text/plain',
          'text/markdown',
        ],
        copyToCacheDirectory: false,
        multiple: false,
      });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      setAnswerBusy(true);
      const r = await extractDocument(a.uri, a.name);
      let table = parseAnswerTable(r.text);
      if (table.size === 0) table = parseAnswerDoc(r.text);
      if (table.size === 0) {
        Alert.alert(
          '没识别到答案',
          '这份文档里没有解析出"题号→答案"的对应关系。\n\n支持：文末答案表（如"1.A 2.B 3.C"）、整份答案文档、区间连写（如"1-5 DCBAB"）。扫描版（图片型）文件请先转成文字版。',
        );
        return;
      }
      const rows = await listQuestions(db, selected.id, 500, 0);
      const byNo = new Map<string, QuestionRow[]>();
      for (const row of rows) {
        const no = extractQuestionNo(row.stem);
        if (!no) continue;
        const arr = byNo.get(no) ?? [];
        arr.push(row);
        byNo.set(no, arr);
      }
      const plan: { id: string; stem: string; answer: unknown }[] = [];
      let skipExisting = 0;
      let noMatch = 0;
      let dupNo = 0;
      for (const [no, ansText] of table) {
        const cands = byNo.get(no);
        if (!cands || cands.length === 0) {
          noMatch += 1;
          continue;
        }
        if (cands.length > 1) {
          dupNo += 1;
          continue;
        }
        const row = cands[0];
        let has = false;
        try {
          has = JSON.parse(row.answer_json) !== null;
        } catch {
          has = false;
        }
        if (has) {
          skipExisting += 1;
          continue;
        }
        let opts: { id: string }[] = [];
        try {
          opts = JSON.parse(row.options_json) as { id: string }[];
        } catch {
          opts = [];
        }
        const answer = normalizeAnswer(row.type as QuestionType, ansText, opts.map((o) => o.id)).answer;
        if (answer === null) {
          noMatch += 1;
          continue;
        }
        const valid = f2ValidateQuestion({ ...rowToQuestion(row), answer }, { normalize: false });
        if (valid.status === 'invalid') {
          noMatch += 1;
          continue;
        }
        plan.push({ id: row.id, stem: row.stem, answer });
      }
      if (plan.length === 0) {
        Alert.alert(
          '没有可补充的答案',
          `解析到 ${table.size} 条答案，但没有匹配到缺答案的题目。\n\n已有答案跳过 ${skipExisting} 题；未匹配到题目 ${noMatch} 条；题号重复未处理 ${dupNo} 条。`,
        );
        return;
      }
      Alert.alert(
        '确认导入答案？',
        `解析到 ${table.size} 条答案，将补充 ${plan.length} 题（已有答案跳过 ${skipExisting} 题${
          noMatch > 0 ? `、未匹配 ${noMatch} 条` : ''
        }${dupNo > 0 ? `、题号重复未处理 ${dupNo} 条` : ''}）。\n\n示例：${plan[0].stem.slice(0, 16)}… → ${JSON.stringify(plan[0].answer)}`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: `写入 ${plan.length} 题`,
            onPress: () => {
              void (async () => {
                try {
                  for (const p of plan) {
                    await setQuestionAnswer(db, p.id, p.answer);
                  }
                  await refresh();
                  Alert.alert('导入完成', `已补充 ${plan.length} 道题的答案。`);
                } catch (e) {
                  Alert.alert('写入失败', String((e as Error)?.message ?? e));
                }
              })();
            },
          },
        ],
      );
    } catch (e) {
      Alert.alert('导入答案失败', String((e as Error)?.message ?? e));
    } finally {
      setAnswerBusy(false);
    }
  }, [db, selected, refresh, answerBusy]);

  const openEdit = useCallback((row: QuestionRow) => {
    const d = rowToQuestion(row);
    setEditing({ id: row.id, draft: d });
    setAnswerText(answerToText(d.answer));
  }, []);

  const save = useCallback(async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const d = editing.draft;
      const ids = d.options.map((o) => o.id).filter(Boolean);
      const answer = normalizeAnswer(d.type, answerText, ids).answer;
      const withAnswer: QuestionDraft = { ...d, answer, analysis: (d.analysis ?? '').trim() || null };
      const r = f2ValidateQuestion(withAnswer, { normalize: false });
      const updated: QuestionDraft = { ...withAnswer, review_status: r.status, review_reasons: r.issues.map((x) => x.message) };
      await updateQuestionContent(db, editing.id, updated);
      if (answer !== null) {
        await setQuestionStatus(db, editing.id, 'approved');
      }
      setEditing(null);
      await refresh();
    } catch (e) {
      Alert.alert('保存失败', String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  }, [db, editing, answerText, refresh]);

  const remove = useCallback(
    (id: string) => {
      Alert.alert('删除这道题？', '同时会清理它的错题本记录与做题记录，无法恢复。', [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await deleteQuestion(db, id);
              setEditing(null);
              await refresh();
            })();
          },
        },
      ]);
    },
    [db, refresh],
  );

  // ---------------------------------------------------------------- 库列表视图
  if (!selected) {
    return (
      <View style={styles.page}>
        <View style={styles.header}>
          <Pressable onPress={onBack} hitSlop={8}>
            <Text style={styles.back}>← 返回</Text>
          </Pressable>
          <Text style={styles.title}>题库管理</Text>
          <Text style={styles.count}>{banks.length} 个库</Text>
        </View>
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {banks.length === 0 && <Text style={styles.empty}>还没有题库。</Text>}
          {banks.map((b) =>
            renaming?.id === b.id ? (
              <View key={b.id} style={styles.bankCard}>
                <TextInput
                  style={styles.renameInput}
                  value={renaming.name}
                  onChangeText={(t) => setRenaming({ id: b.id, name: t })}
                  autoFocus
                  placeholder="题库名称"
                />
                <Pressable style={styles.renameSave} onPress={() => void confirmRename()}>
                  <Text style={styles.renameSaveText}>保存</Text>
                </Pressable>
                <Pressable hitSlop={6} onPress={() => setRenaming(null)}>
                  <Text style={styles.cardCtrl}>取消</Text>
                </Pressable>
              </View>
            ) : (
              <View key={b.id} style={styles.bankCard}>
                <Pressable style={styles.bankMain} onPress={() => openBank(b)}>
                  <Text style={styles.bankName} numberOfLines={1}>
                    {b.name}
                  </Text>
                  <Text style={styles.bankCount}>{b.count} 题</Text>
                </Pressable>
                <Pressable hitSlop={6} onPress={() => setRenaming({ id: b.id, name: b.name })}>
                  <Text style={styles.cardCtrl}>重命名</Text>
                </Pressable>
                <Pressable hitSlop={6} onPress={() => removeBank(b)} style={styles.cardDangerWrap}>
                  <Text style={styles.cardDanger}>删除</Text>
                </Pressable>
              </View>
            ),
          )}
          {banks.length > 0 && (
            <Text style={styles.listHint}>点进题库可编辑题目、补充答案、删除题目。</Text>
          )}
          <View style={{ height: 24 }} />
        </ScrollView>
      </View>
    );
  }

  // ---------------------------------------------------------------- 编辑视图
  if (editing) {
    const d = editing.draft;
    return (
      <View style={styles.page}>
        <View style={styles.header}>
          <Pressable onPress={() => setEditing(null)} hitSlop={8}>
            <Text style={styles.back}>← 返回</Text>
          </Pressable>
          <Text style={styles.title}>编辑题目</Text>
          <View style={styles.spacer} />
        </View>
        <ScrollView style={styles.editBody} contentContainerStyle={styles.editContent}>
          <Text style={styles.label}>题干</Text>
          <TextInput
            style={styles.stemInput}
            value={d.stem}
            multiline
            onChangeText={(t) => setEditing({ ...editing, draft: { ...d, stem: t } })}
          />
          {d.options.map((o, i) => (
            <View key={`${o.id}-${i}`} style={styles.optRow}>
              <Text style={styles.optId}>{o.id || '?'}</Text>
              <TextInput
                style={styles.optInput}
                value={o.text}
                onChangeText={(t) => {
                  const options = d.options.map((x, xi) => (xi === i ? { ...x, text: t } : x));
                  setEditing({ ...editing, draft: { ...d, options } });
                }}
              />
            </View>
          ))}
          <Text style={styles.label}>答案（空 / 对 / 错 / A / A,C）</Text>
          <TextInput
            style={styles.answerInput}
            value={answerText}
            placeholder="例如：B 或 A,C 或 对"
            onChangeText={setAnswerText}
          />
          <Text style={styles.label}>解析（可选，题目自带解析）</Text>
          <TextInput
            style={styles.analysisInput}
            value={d.analysis ?? ''}
            multiline
            placeholder="试卷或教材里带的解析，可手动补充；AI 讲解是独立内容，不在此处"
            onChangeText={(t) => setEditing({ ...editing, draft: { ...d, analysis: t } })}
          />
          <Text style={styles.hint}>保存时会重新执行确定性校验；填写答案后题目状态变为"已确认"。</Text>
          <Pressable style={[styles.btn, saving && styles.btnDisabled]} onPress={() => void save()} disabled={saving}>
            <Text style={styles.btnText}>{saving ? '保存中…' : '保存'}</Text>
          </Pressable>
          <Pressable style={styles.btnDanger} onPress={() => remove(editing.id)}>
            <Text style={styles.btnDangerText}>删除这道题</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // ---------------------------------------------------------------- 列表视图
  const noAnswerCount = rows.filter((r) => !hasAnswer(r)).length;
  const shown = filter === 'all' ? rows : rows.filter((r) => !hasAnswer(r));

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={backToBankList} hitSlop={8}>
          <Text style={styles.back}>← 返回</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {selected.name}
        </Text>
        <Text style={styles.count}>{rows.length} 题</Text>
      </View>

      <Pressable
        style={styles.bindRow}
        onPress={() => setMaterialTarget({ id: selected.id, name: selected.name })}
      >
        <Text style={styles.bindLabel} numberOfLines={1}>
          教材：
          <Text style={styles.bindValue}>{boundCount > 0 ? `已绑定 ${boundCount} 本` : '未绑定'}</Text>
          <Text style={styles.bindHint}>{boundCount > 0 ? '（讲解只依据绑定教材）' : '（可选，未绑定则检索全部教材）'}</Text>
        </Text>
        <Text style={styles.bindAction}>设置</Text>
      </Pressable>

      <Pressable style={styles.bindRow} onPress={() => void importAnswers()} disabled={answerBusy}>
        <Text style={styles.bindLabel} numberOfLines={1}>
          答案：
          <Text style={styles.bindValue}>从文档补充答案</Text>
          <Text style={styles.bindHint}>（只填缺答案的题，题目需带题号）</Text>
        </Text>
        <Text style={styles.bindAction}>{answerBusy ? '处理中…' : '导入'}</Text>
      </Pressable>

      <View style={styles.filterRow}>
        <Pressable style={[styles.chip, filter === 'all' && styles.chipOn]} onPress={() => setFilter('all')}>
          <Text style={[styles.chipText, filter === 'all' && styles.chipTextOn]}>全部 {rows.length}</Text>
        </Pressable>
        <Pressable style={[styles.chip, filter === 'noanswer' && styles.chipOn]} onPress={() => setFilter('noanswer')}>
          <Text style={[styles.chipText, filter === 'noanswer' && styles.chipTextOn]}>无答案 {noAnswerCount}</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {shown.length === 0 && (
          <Text style={styles.empty}>
            {filter === 'noanswer' ? '没有缺答案的题目。' : '题库还没有题目，先去首页识别导入。'}
          </Text>
        )}
        {shown.map((r) => (
          <Pressable key={r.id} style={styles.card} onPress={() => openEdit(r)}>
            <View style={styles.cardTop}>
              <Text style={[styles.badgeSmall, hasAnswer(r) ? styles.badgeOk : styles.badgeWarn]}>
                {hasAnswer(r) ? '有答案' : '无答案'}
              </Text>
              <Text style={styles.typeSmall}>{typeShort(r.type)}</Text>
            </View>
            <Text style={styles.cardStem} numberOfLines={2}>
              {r.stem}
            </Text>
          </Pressable>
        ))}
        <View style={{ height: 24 }} />
      </ScrollView>

      <BankMaterialPicker
        db={db}
        visible={!!materialTarget}
        bankId={materialTarget?.id ?? null}
        bankName={materialTarget?.name}
        onClose={() => setMaterialTarget(null)}
        onSaved={() => void refreshBound()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f8fa', paddingTop: 64 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  back: { fontSize: 15, color: '#1c5cd6' },
  title: { flexShrink: 1, marginHorizontal: 8, fontSize: 18, fontWeight: '800', color: '#1a1a1a' },
  count: { fontSize: 13, color: '#66707f' },
  spacer: { width: 52 },
  listHint: { marginTop: 10, textAlign: 'center', color: '#98a2b3', fontSize: 12 },
  bankCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 16,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  bankMain: { flex: 1, marginRight: 10 },
  bankName: { fontSize: 16, fontWeight: '700', color: '#222' },
  bankCount: { marginTop: 3, fontSize: 13, color: '#66707f' },
  cardCtrl: { fontSize: 13, color: '#31518a', paddingVertical: 4 },
  cardDangerWrap: { marginLeft: 14 },
  cardDanger: { fontSize: 13, color: '#c0392b', paddingVertical: 4 },
  renameInput: {
    flex: 1,
    backgroundColor: '#f2f5fa',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: '#222',
  },
  renameSave: { backgroundColor: '#1c5cd6', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, marginLeft: 8 },
  renameSaveText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  bindRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    marginHorizontal: 16,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cfd9ea',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bindLabel: { flex: 1, fontSize: 13, color: '#66707f' },
  bindValue: { color: '#1c5cd6', fontWeight: '700' },
  bindHint: { color: '#98a2b3' },
  bindAction: { marginLeft: 10, fontSize: 13, color: '#31518a', fontWeight: '700' },
  filterRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, marginTop: 12 },
  chip: { borderRadius: 18, borderWidth: 1, borderColor: '#cfd9ea', paddingHorizontal: 14, paddingVertical: 7, backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#1c5cd6', borderColor: '#1c5cd6' },
  chipText: { fontSize: 13, color: '#31518a' },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  list: { flex: 1, marginTop: 10 },
  listContent: { paddingHorizontal: 12 },
  empty: { marginTop: 40, textAlign: 'center', color: '#98a2b3', fontSize: 13 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badgeSmall: { fontSize: 11, fontWeight: '700', borderRadius: 8, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 2 },
  badgeOk: { color: '#0a7d33', backgroundColor: '#eaf7ef' },
  badgeWarn: { color: '#b8860b', backgroundColor: '#fdf6e3' },
  typeSmall: { marginLeft: 'auto', fontSize: 12, color: '#8a94a6' },
  cardStem: { marginTop: 8, fontSize: 14, color: '#222', lineHeight: 20 },
  editBody: { flex: 1, marginTop: 12 },
  editContent: { paddingHorizontal: 16, paddingBottom: 30 },
  label: { marginTop: 14, fontSize: 13, color: '#66707f' },
  stemInput: { marginTop: 6, backgroundColor: '#fff', borderRadius: 10, padding: 12, fontSize: 15, color: '#222', lineHeight: 22, minHeight: 90 },
  optRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  optId: { width: 24, fontSize: 15, fontWeight: '700', color: '#31518a' },
  optInput: { flex: 1, backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: '#333' },
  answerInput: { marginTop: 6, backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: '#222' },
  analysisInput: {
    marginTop: 6,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    color: '#222',
    lineHeight: 21,
    minHeight: 80,
  },
  hint: { marginTop: 10, fontSize: 12, color: '#98a2b3', lineHeight: 18 },
  btn: { marginTop: 20, backgroundColor: '#1c5cd6', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  btnDanger: { marginTop: 12, borderRadius: 12, borderWidth: 1, borderColor: '#e3b4ae', paddingVertical: 13, alignItems: 'center', backgroundColor: '#fff' },
  btnDangerText: { color: '#c0392b', fontSize: 15, fontWeight: '700' },
});
