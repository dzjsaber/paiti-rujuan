/** 设置页：API Key 配置（SecureStore）、技术自检入口、隐私说明。 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { clearApiKey, getApiKey, maskKey, saveApiKey } from '../services/apiKey';
import {
  getExplainProvider,
  getModelTier,
  MODEL_TIERS,
  saveExplainProvider,
  saveModelTier,
  type ModelTier,
} from '../services/modelPrefs';
import {
  EXPLAIN_PROVIDERS,
  getCustomConfig,
  getDeepseekKey,
  saveCustomConfig,
  saveDeepseekKey,
  type CustomConfig,
  type ExplainProviderId,
} from '../services/llm/providers';

type SectionKey = 'apikey' | 'model' | 'explain' | 'advanced' | 'data';

export interface SettingsScreenProps {
  onBack: () => void;
  onOpenSelfTest: () => void;
  onOpenBackup: () => void;
}

export function SettingsScreen({ onBack, onOpenSelfTest, onOpenBackup }: SettingsScreenProps) {
  const [current, setCurrent] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [tier, setTier] = useState<ModelTier>('free');
  const [explainProvider, setExplainProvider] = useState<ExplainProviderId>('zhipu_free');
  const [dsKey, setDsKey] = useState<string | null>(null);
  const [dsInput, setDsInput] = useState('');
  const [custom, setCustom] = useState<CustomConfig>({ url: '', model: '', apiKey: '' });
  const [customInput, setCustomInput] = useState<CustomConfig>({ url: '', model: '', apiKey: '' });
  const [section, setSection] = useState<SectionKey | null>(null);

  const refresh = useCallback(async () => {
    setCurrent(await getApiKey());
    setTier(await getModelTier());
    setExplainProvider(await getExplainProvider());
    setDsKey(await getDeepseekKey());
    const c = await getCustomConfig();
    setCustom(c);
    setCustomInput(c);
  }, []);

  const chooseTier = useCallback(async (t: ModelTier) => {
    setTier(t);
    await saveModelTier(t);
  }, []);

  const chooseExplain = useCallback(async (m: ExplainProviderId) => {
    setExplainProvider(m);
    await saveExplainProvider(m);
  }, []);

  const saveDs = useCallback(async () => {
    await saveDeepseekKey(dsInput);
    setDsInput('');
    setDsKey(await getDeepseekKey());
    Alert.alert('已保存');
  }, [dsInput]);

  const saveCustom = useCallback(async () => {
    await saveCustomConfig(customInput);
    const c = await getCustomConfig();
    setCustom(c);
    setCustomInput(c);
    Alert.alert('已保存', '自定义接口配置已保存到本机。');
  }, [customInput]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async () => {
    const v = input.trim();
    if (!v) {
      Alert.alert('请输入 API Key');
      return;
    }
    await saveApiKey(v);
    setInput('');
    await refresh();
    Alert.alert('已保存', 'API Key 已保存到本机安全存储。');
  }, [input, refresh]);

  const clear = useCallback(async () => {
    await clearApiKey();
    await refresh();
  }, [refresh]);

  const groups: { key: SectionKey; title: string; summary: string }[] = [
    {
      key: 'apikey',
      title: 'API Key',
      summary: `智谱${current ? '已配置' : '未配置'} · DeepSeek ${dsKey ? '已配置' : '未配置'}`,
    },
    { key: 'model', title: '识别模型', summary: MODEL_TIERS[tier].label },
    { key: 'explain', title: '讲解方式', summary: EXPLAIN_PROVIDERS[explainProvider].label },
    { key: 'advanced', title: '附加配置', summary: custom.url ? '自定义接口已配置' : '自定义接口未配置' },
    { key: 'data', title: '数据', summary: '备份与恢复 · 技术自检' },
  ];

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.scrollContent}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>设置</Text>
        <View style={styles.spacer} />
      </View>

      {section === null ? (
        <>
          {groups.map((g) => (
            <Pressable key={g.key} style={styles.groupBtn} onPress={() => setSection(g.key)}>
              <View style={styles.groupMain}>
                <Text style={styles.groupTitle}>{g.title}</Text>
                <Text style={styles.groupSummary}>{g.summary}</Text>
              </View>
              <Text style={styles.groupArrow}>›</Text>
            </Pressable>
          ))}
        </>
      ) : (
        <>
          <Pressable onPress={() => setSection(null)} hitSlop={8} style={styles.groupBack}>
            <Text style={styles.back}>← 返回设置</Text>
          </Pressable>

          {section === 'apikey' && (
            <>
      <Text style={styles.section}>智谱 API Key（自带，仅存本机）</Text>
      <Text style={styles.hint}>当前：{maskKey(current)}</Text>
      <TextInput
        style={styles.input}
        value={input}
        onChangeText={setInput}
        placeholder="粘贴你的 API Key"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
      <Pressable style={styles.btn} onPress={() => void save()}>
        <Text style={styles.btnText}>保存 Key</Text>
      </Pressable>
      {!!current && (
        <Pressable style={styles.btnGhost} onPress={() => void clear()}>
          <Text style={styles.btnGhostText}>清除已保存的 Key</Text>
        </Pressable>
      )}

      <Text style={styles.section}>DeepSeek API Key（可选，用于讲解）</Text>
      <Text style={styles.hint}>当前：{maskKey(dsKey)}</Text>
      <TextInput
        style={styles.input}
        value={dsInput}
        onChangeText={setDsInput}
        placeholder="粘贴 DeepSeek API Key（留空保存可清除）"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
      <Pressable style={styles.btn} onPress={() => void saveDs()}>
        <Text style={styles.btnText}>保存 DeepSeek Key</Text>
      </Pressable>

            </>
          )}

          {section === 'advanced' && (
            <>
      <Text style={styles.section}>自定义接口（可选，OpenAI 兼容）</Text>
      <Text style={styles.hint}>
        当前：{custom.url ? `${custom.model || '（未填模型）'} @ ${custom.url}` : '（未配置）'}
      </Text>
      <TextInput
        style={styles.input}
        value={customInput.url}
        onChangeText={(t) => setCustomInput((p) => ({ ...p, url: t }))}
        placeholder="接口地址，如 https://api.moonshot.cn/v1/chat/completions"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={styles.input}
        value={customInput.model}
        onChangeText={(t) => setCustomInput((p) => ({ ...p, model: t }))}
        placeholder="模型名，如 moonshot-v1-8k"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={styles.input}
        value={customInput.apiKey}
        onChangeText={(t) => setCustomInput((p) => ({ ...p, apiKey: t }))}
        placeholder="该接口的 API Key"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
      <Pressable style={styles.btn} onPress={() => void saveCustom()}>
        <Text style={styles.btnText}>保存自定义配置</Text>
      </Pressable>

            </>
          )}

          {section === 'model' && (
            <>
      <Text style={styles.section}>识别模型</Text>
      {(Object.keys(MODEL_TIERS) as ModelTier[]).map((t) => {
        const info = MODEL_TIERS[t];
        const active = tier === t;
        return (
          <Pressable
            key={t}
            style={[styles.tierCard, active && styles.tierCardActive]}
            onPress={() => void chooseTier(t)}
          >
            <View style={styles.tierHeader}>
              <Text style={[styles.tierLabel, active && styles.tierLabelActive]}>{info.label}</Text>
              <Text style={styles.tierTag}>{info.tagline}</Text>
            </View>
            <Text style={styles.tierDetail}>{info.detail}</Text>
            <Text style={styles.tierModel}>模型：{info.id}</Text>
          </Pressable>
        );
      })}
      <Text style={styles.hint}>高级档按量计费（从智谱账户扣费），使用前请确认余额。</Text>

            </>
          )}

          {section === 'explain' && (
            <>
      <Text style={styles.section}>讲解方式</Text>
      {(Object.keys(EXPLAIN_PROVIDERS) as ExplainProviderId[]).map((m) => {
        const info = EXPLAIN_PROVIDERS[m];
        const active = explainProvider === m;
        return (
          <Pressable
            key={m}
            style={[styles.tierCard, active && styles.tierCardActive]}
            onPress={() => void chooseExplain(m)}
          >
            <View style={styles.tierHeader}>
              <Text style={[styles.tierLabel, active && styles.tierLabelActive]}>{info.label}</Text>
              <Text style={styles.tierTag}>{info.tagline}</Text>
            </View>
            <Text style={styles.tierDetail}>{info.detail}</Text>
            <Text style={styles.tierModel}>
              {info.supportsRag ? '✓ 支持教材引用' : '× 不支持教材引用（分享模式）'}
            </Text>
          </Pressable>
        );
      })}

            </>
          )}

          {section === 'data' && (
            <>
      <Pressable style={styles.btnGhost} onPress={onOpenSelfTest}>
        <Text style={styles.btnGhostText}>运行技术自检（SQLite / 图片压缩）</Text>
      </Pressable>

      <Pressable style={styles.btnGhost} onPress={onOpenBackup}>
        <Text style={styles.btnGhostText}>数据备份与恢复</Text>
      </Pressable>

            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f8fa', paddingTop: 64, paddingHorizontal: 20 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { fontSize: 16, color: '#1c5cd6' },
  title: { fontSize: 20, fontWeight: '800', color: '#1a1a1a' },
  spacer: { width: 52 },
  section: { marginTop: 28, fontSize: 15, fontWeight: '700', color: '#333' },
  hint: { marginTop: 8, fontSize: 13, color: '#777' },
  groupBtn: {
    marginTop: 14,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#dbe1ec',
    paddingVertical: 15,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  groupMain: { flex: 1 },
  groupTitle: { fontSize: 16, fontWeight: '700', color: '#222' },
  groupSummary: { marginTop: 4, fontSize: 12, color: '#777' },
  groupArrow: { fontSize: 24, color: '#98a2b3', marginLeft: 10 },
  groupBack: { marginTop: 20 },
  input: {
    marginTop: 10,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#dbe1ec',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  btn: { marginTop: 12, backgroundColor: '#1c5cd6', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  btnGhost: { marginTop: 10, borderRadius: 10, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#cfd9ea', backgroundColor: '#fff' },
  btnGhostText: { color: '#31518a', fontSize: 14 },
  scrollContent: { paddingBottom: 60 },
  tierCard: {
    marginTop: 10,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#dbe1ec',
    padding: 12,
  },
  tierCardActive: { borderColor: '#1c5cd6', backgroundColor: '#f3f7ff' },
  tierHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tierLabel: { fontSize: 15, fontWeight: '700', color: '#333' },
  tierLabelActive: { color: '#1c5cd6' },
  tierTag: { fontSize: 12, color: '#66707f' },
  tierDetail: { marginTop: 6, fontSize: 12, color: '#556', lineHeight: 18 },
  tierModel: { marginTop: 6, fontSize: 11, color: '#98a2b3' },
});
