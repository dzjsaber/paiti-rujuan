/** 设置页：API Key 配置（SecureStore）、技术自检入口、隐私说明。 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { clearApiKey, getApiKey, maskKey, saveApiKey } from '../services/apiKey';
import {
  EXPLAIN_MODES,
  getExplainMode,
  getModelTier,
  MODEL_TIERS,
  saveExplainMode,
  saveModelTier,
  type ExplainMode,
  type ModelTier,
} from '../services/modelPrefs';

export interface SettingsScreenProps {
  onBack: () => void;
  onOpenSelfTest: () => void;
  onOpenBackup: () => void;
}

export function SettingsScreen({ onBack, onOpenSelfTest, onOpenBackup }: SettingsScreenProps) {
  const [current, setCurrent] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [tier, setTier] = useState<ModelTier>('free');
  const [explainMode, setExplainMode] = useState<ExplainMode>('inapp');

  const refresh = useCallback(async () => {
    setCurrent(await getApiKey());
    setTier(await getModelTier());
    setExplainMode(await getExplainMode());
  }, []);

  const chooseTier = useCallback(async (t: ModelTier) => {
    setTier(t);
    await saveModelTier(t);
  }, []);

  const chooseExplain = useCallback(async (m: ExplainMode) => {
    setExplainMode(m);
    await saveExplainMode(m);
  }, []);

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

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>设置</Text>
        <View style={styles.spacer} />
      </View>

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

      <Text style={styles.section}>讲解方式</Text>
      {(Object.keys(EXPLAIN_MODES) as ExplainMode[]).map((m) => {
        const info = EXPLAIN_MODES[m];
        const active = explainMode === m;
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
          </Pressable>
        );
      })}

      <Pressable style={styles.btnGhost} onPress={onOpenSelfTest}>
        <Text style={styles.btnGhostText}>运行技术自检（SQLite / 图片压缩）</Text>
      </Pressable>

      <Pressable style={styles.btnGhost} onPress={onOpenBackup}>
        <Text style={styles.btnGhostText}>数据备份与恢复</Text>
      </Pressable>

    </View>
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
