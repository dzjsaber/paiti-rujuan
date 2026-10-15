/**
 * 题库 ↔ 教材 多选弹层（题库管理 / 入库确认页共用）。
 * 保存即全量替换绑定；不勾选任何教材 = 不限定教材（讲解检索全部教材）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { listBankMaterialIds, setBankMaterials } from '../db/repo_banks';
import { listMaterials, type MaterialSummary } from '../db/repo_materials';

export interface BankMaterialPickerProps {
  db: SQLiteDatabase;
  visible: boolean;
  bankId: string | null;
  bankName?: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function BankMaterialPicker({ db, visible, bankId, bankName, onClose, onSaved }: BankMaterialPickerProps) {
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible || !bankId) return;
    void (async () => {
      try {
        const [list, bound] = await Promise.all([listMaterials(db), listBankMaterialIds(db, bankId)]);
        setMaterials(list);
        setChecked(new Set(bound));
      } catch {
        setMaterials([]);
        setChecked(new Set());
      }
    })();
  }, [visible, bankId, db]);

  const toggle = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    if (!bankId) return;
    setSaving(true);
    try {
      await setBankMaterials(db, bankId, [...checked]);
      onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  }, [db, bankId, checked, onClose, onSaved]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBg}>
        <View style={styles.sheet}>
          <Text style={styles.title} numberOfLines={1}>
            绑定教材{bankName ? ` · ${bankName}` : ''}
          </Text>
          <Text style={styles.hint}>讲解时只依据勾选的教材；不勾选则不限定教材。教材在首页"教材库"导入。</Text>
          <ScrollView style={styles.list}>
            {materials.length === 0 && <Text style={styles.empty}>教材库还是空的，先去导入一本教材。</Text>}
            {materials.map((m) => {
              const on = checked.has(m.id);
              return (
                <Pressable key={m.id} style={[styles.row, on && styles.rowOn]} onPress={() => toggle(m.id)}>
                  <View style={[styles.checkbox, on && styles.checkboxOn]}>
                    {on && <Text style={styles.checkMark}>✓</Text>}
                  </View>
                  <View style={styles.rowMain}>
                    <Text style={styles.name} numberOfLines={1}>
                      {m.name}
                    </Text>
                    <Text style={styles.meta}>{m.chunk_count} 段</Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable style={[styles.saveBtn, saving && styles.disabled]} onPress={() => void save()} disabled={saving}>
            <Text style={styles.saveText}>{saving ? '保存中…' : `保存（已选 ${checked.size} 本）`}</Text>
          </Pressable>
          <Pressable style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheetBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 26,
  },
  title: { fontSize: 16, fontWeight: '800', color: '#1a1a1a' },
  hint: { marginTop: 6, fontSize: 12, color: '#8a94a6', lineHeight: 18 },
  list: { maxHeight: 300, marginTop: 8 },
  empty: { marginTop: 20, marginBottom: 8, fontSize: 13, color: '#98a2b3', textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e3e8f0',
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginTop: 8,
  },
  rowOn: { borderColor: '#1c5cd6', backgroundColor: '#f3f7ff' },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: '#9aa7bd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: '#1c5cd6', borderColor: '#1c5cd6' },
  checkMark: { color: '#fff', fontSize: 14, fontWeight: '800' },
  rowMain: { flex: 1, marginLeft: 10 },
  name: { fontSize: 15, color: '#333' },
  meta: { marginTop: 3, fontSize: 12, color: '#8a94a6' },
  saveBtn: { marginTop: 16, backgroundColor: '#1c5cd6', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  disabled: { opacity: 0.6 },
  saveText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  cancel: { marginTop: 10, alignItems: 'center', paddingVertical: 10 },
  cancelText: { color: '#66707f', fontSize: 14 },
});
