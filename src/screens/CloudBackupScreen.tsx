/**
 * 云端备份：账号登录、上传当前备份、下载后按稳定 ID 合并恢复。
 * 云端只保存最新一份 JSON；恢复前必须确认，且不会覆盖本机已有数据。
 */
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { SQLiteDatabase } from 'expo-sqlite';
import { buildBackup, MAX_BACKUP_BYTES, restoreBackup, validateBackup } from '../db/backup';
import {
  clearCloudSession,
  downloadBackup,
  getCloudServer,
  getCloudSession,
  requestLoginCode,
  saveCloudServer,
  saveCloudSession,
  uploadBackup,
  verifyLoginCode,
} from '../services/cloud';

export interface CloudBackupScreenProps {
  db: SQLiteDatabase;
  onBack: () => void;
}

function errorText(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

export function CloudBackupScreen({ db, onBack }: CloudBackupScreenProps) {
  const [server, setServer] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [savedServer, session] = await Promise.all([getCloudServer(), getCloudSession()]);
      if (cancelled) return;
      setServer(savedServer);
      setToken(session.token);
      setAccount(session.email);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const sendCode = async () => {
    if (!email.trim()) {
      Alert.alert('请填写邮箱');
      return;
    }
    setBusy(true);
    try {
      const savedServer = await saveCloudServer(server);
      setServer(savedServer);
      const expiresIn = await requestLoginCode(savedServer, email.trim());
      setCooldown(60);
      setLastResult(`验证码已发送，${Math.round(expiresIn / 60)} 分钟内有效`);
    } catch (e) {
      Alert.alert('发送失败', errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const auth = async () => {
    if (!email.trim() || !/^\d{6}$/.test(code.trim())) {
      Alert.alert('请填写邮箱和 6 位验证码');
      return;
    }
    setBusy(true);
    try {
      const savedServer = await saveCloudServer(server);
      setServer(savedServer);
      const newToken = await verifyLoginCode(savedServer, email.trim(), code.trim());
      const accountEmail = email.trim().toLowerCase();
      await saveCloudSession(newToken, accountEmail);
      setToken(newToken);
      setAccount(accountEmail);
      setCode('');
      setLastResult('登录成功；首次验证的邮箱会自动创建账号');
    } catch (e) {
      Alert.alert('登录失败', errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const pasteCode = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      const match = text.match(/(?:^|\D)(\d{6})(?=\D|$)/);
      if (!match?.[1]) {
        Alert.alert('剪贴板里没有 6 位验证码', '请先复制邮件里的验证码数字');
        return;
      }
      setCode(match[1]);
    } catch {
      Alert.alert('无法读取剪贴板');
    }
  };

  const upload = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const savedServer = await saveCloudServer(server);
      setServer(savedServer);
      const backup = await buildBackup(db);
      const text = JSON.stringify(backup);
      if (text.length > MAX_BACKUP_BYTES) {
        Alert.alert('备份过大', '当前备份超过 20MB，云端备份只上传题库 JSON，不包含图片与教材原文件。');
        return;
      }
      const result = await uploadBackup(savedServer, token, text);
      setLastResult(
        `已上传 v${result.version} · ${result.updatedAt.slice(0, 16).replace('T', ' ')}\n` +
          `${backup.counts.questions} 题 · ${backup.counts.wrongBook} 条错题 · ${backup.counts.practiceLog} 条做题记录`,
      );
    } catch (e) {
      Alert.alert('上传失败', errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const savedServer = await saveCloudServer(server);
      setServer(savedServer);
      const text = await downloadBackup(savedServer, token);
      const checked = validateBackup(text);
      if (!checked.ok) {
        Alert.alert('云端备份无法恢复', checked.error);
        return;
      }
      const counts = checked.backup.counts;
      Alert.alert(
        '从云端恢复？',
        `云端导出时间：${checked.backup.exportedAt.slice(0, 16).replace('T', ' ')}\n` +
          `含 ${counts.questions} 题 · ${counts.wrongBook} 条错题 · ${counts.practiceLog} 条做题记录\n\n` +
          '恢复按 ID 合并，不会覆盖本机已有数据；已存在的题目和做题记录会跳过。',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '恢复',
            onPress: () => {
              void (async () => {
                setBusy(true);
                try {
                  const stats = await restoreBackup(db, checked.backup);
                  setLastResult(
                    `云端恢复完成：新增 ${stats.questionsAdded} 题（跳过已有 ${stats.questionsSkipped}）· ` +
                      `错题 +${stats.wrongMerged} · 做题记录 +${stats.logsAdded}`,
                  );
                } catch (e) {
                  Alert.alert('恢复失败（已回滚）', errorText(e));
                } finally {
                  setBusy(false);
                }
              })();
            },
          },
        ],
      );
    } catch (e) {
      Alert.alert('下载失败', errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await clearCloudSession();
    setToken(null);
    setAccount(null);
    setLastResult('已退出登录');
  };

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>云端备份</Text>
        <View style={styles.spacer} />
      </View>

      <Text style={styles.section}>备份服务器</Text>
      <Text style={styles.hint}>手机与电脑需在同一局域网；IP 变化后在这里修改。</Text>
      <TextInput
        style={styles.input}
        value={server}
        onChangeText={setServer}
        placeholder="http://192.168.0.104:8000"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onEndEditing={() => void saveCloudServer(server).catch(() => undefined)}
      />

      {!token ? (
        <>
          <Text style={styles.section}>邮箱验证码登录</Text>
          <Text style={styles.hint}>首次验证会自动创建账号；不保存密码，账号只用于区分个人云端备份。</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="邮箱"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          <TextInput
            style={styles.input}
            value={code}
            onChangeText={setCode}
            placeholder="6 位邮箱验证码"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="number-pad"
            maxLength={6}
          />
          <Pressable onPress={() => void pasteCode()} hitSlop={8} style={styles.pasteLink}>
            <Text style={styles.pasteLinkText}>从剪贴板粘贴验证码</Text>
          </Pressable>
          <Pressable
            style={[styles.ghostBtn, (busy || cooldown > 0) && styles.disabled]}
            onPress={() => void sendCode()}
            disabled={busy || cooldown > 0}
          >
            <Text style={styles.ghostBtnText}>
              {cooldown > 0 ? `${cooldown} 秒后可重新发送` : '获取验证码'}
            </Text>
          </Pressable>
          <Pressable style={[styles.primaryBtn, busy && styles.disabled]} onPress={() => void auth()} disabled={busy}>
            <Text style={styles.primaryBtnText}>验证并登录</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.section}>当前账号</Text>
          <View style={styles.accountCard}>
            <Text style={styles.account}>{account ?? '已登录'}</Text>
            <Pressable onPress={() => void logout()} hitSlop={8}>
              <Text style={styles.logout}>退出登录</Text>
            </Pressable>
          </View>

          <Pressable style={[styles.primaryBtn, busy && styles.disabled]} onPress={() => void upload()} disabled={busy}>
            <Text style={styles.primaryBtnText}>上传当前备份</Text>
          </Pressable>
          <Pressable style={[styles.ghostBtn, busy && styles.disabled]} onPress={() => void download()} disabled={busy}>
            <Text style={styles.ghostBtnText}>从云端恢复</Text>
          </Pressable>
          <Text style={styles.note}>
            上传会覆盖该账号在云端的上一份备份。恢复按 ID 合并，不会覆盖本机已有数据；图片与教材文件不包含在备份中。
          </Text>
        </>
      )}

      {busy && <ActivityIndicator style={styles.busy} />}
      {lastResult && <Text style={styles.result}>{lastResult}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f8fa', paddingTop: 64, paddingHorizontal: 20 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { fontSize: 15, color: '#1c5cd6' },
  title: { fontSize: 18, fontWeight: '800', color: '#1a1a1a' },
  spacer: { width: 52 },
  section: { marginTop: 26, fontSize: 15, fontWeight: '700', color: '#333' },
  hint: { marginTop: 8, fontSize: 13, color: '#777', lineHeight: 19 },
  note: { marginTop: 14, fontSize: 12, color: '#66707f', lineHeight: 19 },
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
  accountCard: {
    marginTop: 10,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#dbe1ec',
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  account: { flexShrink: 1, fontSize: 14, color: '#222' },
  logout: { marginLeft: 14, fontSize: 13, color: '#c02a2a' },
  primaryBtn: { marginTop: 20, backgroundColor: '#1c5cd6', borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  ghostBtn: { marginTop: 12, borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#cfd9ea', backgroundColor: '#fff' },
  ghostBtnText: { color: '#31518a', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.6 },
  pasteLink: { marginTop: 8, alignSelf: 'flex-start' },
  pasteLinkText: { fontSize: 13, color: '#1c5cd6' },
  busy: { marginTop: 18 },
  result: { marginTop: 18, fontSize: 13, color: '#0a7d33', lineHeight: 20 },
  scrollContent: { paddingBottom: 60 },
});
