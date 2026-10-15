/**
 * 应用入口：数据库初始化 + 轻量页面导航（M1-C 阶段不引入路由库，页面用状态机切换）。
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SQLite from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { openAppDatabase } from './src/db/database';
import { getApiKey } from './src/services/apiKey';
import { LLMService } from './src/services/llm/LLMService';
import { HomeScreen, type ReviewParams } from './src/screens/HomeScreen';
import { HistoryScreen } from './src/screens/HistoryScreen';
import { BankScreen } from './src/screens/BankScreen';
import { ImportDocScreen } from './src/screens/ImportDocScreen';
import { MaterialScreen } from './src/screens/MaterialScreen';
import { PracticeScreen } from './src/screens/PracticeScreen';
import { ReviewScreen } from './src/screens/ReviewScreen';
import { SelfTestScreen } from './src/screens/SelfTestScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { WrongBookScreen } from './src/screens/WrongBookScreen';

type Screen =
  | { name: 'home' }
  | { name: 'review'; mode: 'new'; params: ReviewParams }
  | { name: 'review'; mode: 'resume'; batchId: string }
  | { name: 'history' }
  | { name: 'bank' }
  | { name: 'importdoc' }
  | { name: 'materials' }
  | { name: 'practice'; mode: 'bank' | 'wrong'; order: 'seq' | 'random' }
  | { name: 'wrongbook' }
  | { name: 'settings' }
  | { name: 'selftest' };

export default function App() {
  const [db, setDb] = useState<SQLiteDatabase | null>(null);
  const [llm, setLlm] = useState<LLMService | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [homeKey, setHomeKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const database = await SQLite.openDatabaseAsync('paiti.db');
        await openAppDatabase(database);
        if (cancelled) return;
        setDb(database);
        setLlm(new LLMService(getApiKey));
      } catch (e) {
        if (!cancelled) setInitError(String((e as Error)?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const goHome = useCallback(() => {
    setHomeKey((k) => k + 1);
    setScreen({ name: 'home' });
  }, []);

  if (initError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errTitle}>初始化失败</Text>
        <Text style={styles.errText}>{initError}</Text>
      </View>
    );
  }

  if (!db || !llm) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.loadingText}>正在初始化数据库…</Text>
      </View>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      {screen.name === 'home' && (
        <HomeScreen
          key={homeKey}
          db={db}
          onOpenReview={(p) => setScreen({ name: 'review', mode: 'new', params: p })}
          onOpenSettings={() => setScreen({ name: 'settings' })}
          onOpenHistory={() => setScreen({ name: 'history' })}
          onOpenBank={() => setScreen({ name: 'bank' })}
          onOpenDocImport={() => setScreen({ name: 'importdoc' })}
          onOpenMaterials={() => setScreen({ name: 'materials' })}
          onOpenPractice={() => setScreen({ name: 'practice', mode: 'bank', order: 'seq' })}
          onOpenWrongBook={() => setScreen({ name: 'wrongbook' })}
        />
      )}
      {screen.name === 'review' && screen.mode === 'new' && (
        <ReviewScreen
          db={db}
          llm={llm}
          imagePath={screen.params.imagePath}
          imageWidth={screen.params.imageWidth}
          imageHeight={screen.params.imageHeight}
          sourceType={screen.params.sourceType}
          onDone={goHome}
        />
      )}
      {screen.name === 'review' && screen.mode === 'resume' && (
        <ReviewScreen db={db} llm={llm} resumeBatchId={screen.batchId} onDone={goHome} />
      )}
      {screen.name === 'history' && (
        <HistoryScreen
          db={db}
          onBack={goHome}
          onOpenBatch={(batchId) => setScreen({ name: 'review', mode: 'resume', batchId })}
        />
      )}
      {screen.name === 'bank' && <BankScreen db={db} onBack={goHome} />}
      {screen.name === 'importdoc' && (
        <ImportDocScreen
          db={db}
          llm={llm}
          onBack={goHome}
          onOpenReview={(batchId) => setScreen({ name: 'review', mode: 'resume', batchId })}
        />
      )}
      {screen.name === 'materials' && <MaterialScreen db={db} onBack={goHome} />}
      {screen.name === 'practice' && (
        <PracticeScreen db={db} mode={screen.mode} order={screen.order} onDone={goHome} />
      )}
      {screen.name === 'wrongbook' && (
        <WrongBookScreen
          db={db}
          onBack={goHome}
          onPractice={(order) => setScreen({ name: 'practice', mode: 'wrong', order })}
        />
      )}
      {screen.name === 'settings' && (
        <SettingsScreen onBack={goHome} onOpenSelfTest={() => setScreen({ name: 'selftest' })} />
      )}
      {screen.name === 'selftest' && <SelfTestScreen onBack={() => setScreen({ name: 'settings' })} />}
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f7f8fa', paddingHorizontal: 28 },
  loadingText: { marginTop: 14, fontSize: 14, color: '#66707f' },
  errTitle: { fontSize: 18, fontWeight: '700', color: '#c02a2a' },
  errText: { marginTop: 12, fontSize: 13, color: '#444', lineHeight: 20, textAlign: 'center' },
});
