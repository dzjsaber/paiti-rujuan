/** F6 备份校验与参数映射的离线验证。运行：npx tsx tests/backup.verify.ts */
import { BACKUP_VERSION, questionRowToParams, validateBackup } from '../src/db/backup';
import type { QuestionRow } from '../src/db/repo_questions';

let passed = 0;
const fails: string[] = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
  } catch (e) {
    fails.push(`${name}: ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const QUESTION: QuestionRow = {
  id: 'q1',
  bank_id: 'bank_default',
  type: 'single',
  stem: '题干',
  options_json: '[]',
  answer_json: 'null',
  analysis: null,
  tags_json: '[]',
  confidence: null,
  review_reasons_json: '[]',
  visual_features_json: '[]',
  source_image_path: null,
  source_page: null,
  source_hash: null,
  question_image_path: null,
  source_engine: 'zhipu',
  status: 'pending',
  review_status: 'passed',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

function makeBackup(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    app: 'paiti-rujuan',
    version: BACKUP_VERSION,
    exportedAt: '2026-10-16T00:00:00.000Z',
    counts: { questions: 1, wrongBook: 0, practiceLog: 0, settings: 0 },
    data: {
      banks: [{ id: 'bank_default', name: '默认题库', created_at: '2026-01-01' }],
      questions: [QUESTION],
      wrongBook: [],
      practiceLog: [],
      settings: [],
    },
    ...overrides,
  });
}

check('合法备份通过校验', () => {
  const v = validateBackup(makeBackup());
  assert(v.ok, '应通过');
  if (v.ok) assert(v.backup.counts.questions === 1, '计数应解析');
});

check('非 JSON → 明确错误', () => {
  const v = validateBackup('not json at all');
  assert(!v.ok && v.error.includes('JSON'), '应提示 JSON 错误');
});

check('非本应用备份 → 拒绝', () => {
  const v = validateBackup(makeBackup({ app: 'other' }));
  assert(!v.ok && v.error.includes('本应用'), '应提示来源不符');
});

check('版本过高 → 拒绝', () => {
  const v = validateBackup(makeBackup({ version: BACKUP_VERSION + 1 }));
  assert(!v.ok && v.error.includes('版本'), '应提示版本');
});

check('data.questions 缺失 → 拒绝', () => {
  const v = validateBackup(makeBackup({ data: { wrongBook: [], practiceLog: [] } }));
  assert(!v.ok, '应拒绝');
});

check('题目关键字段缺失 → 拒绝', () => {
  const bad = { ...QUESTION, stem: 42 };
  const v = validateBackup(makeBackup({ data: { questions: [bad], wrongBook: [], practiceLog: [], settings: [] } }));
  assert(!v.ok, '应拒绝损坏数据');
});

check('counts 缺失时自动补齐', () => {
  const v = validateBackup(makeBackup({ counts: undefined }));
  assert(v.ok, '应通过');
  if (v.ok) assert(v.backup.counts.questions === 1, '计数应自动计算');
});

check('v2 备份解析出题库名字', () => {
  const v = validateBackup(makeBackup());
  assert(v.ok, '应通过');
  if (v.ok) assert(v.backup.data.banks[0]?.name === '默认题库', 'banks 应解析');
});

check('v1 旧备份（无 banks 字段）兼容通过并补空数组', () => {
  const raw = JSON.parse(makeBackup()) as { version: number; data: Record<string, unknown> };
  raw.version = 1;
  delete raw.data.banks;
  const v = validateBackup(JSON.stringify(raw));
  assert(v.ok, 'v1 备份应通过（向后兼容）');
  if (v.ok) assert(Array.isArray(v.backup.data.banks) && v.backup.data.banks.length === 0, 'banks 应补为空数组');
});

check('超大文本 → 拒绝', () => {
  const v = validateBackup('x'.repeat(21 * 1024 * 1024));
  assert(!v.ok && v.error.includes('过大'), '应提示过大');
});

check('questionRowToParams 列序与数量（20 列）', () => {
  const p = questionRowToParams(QUESTION);
  assert(p.length === 20, `应 20 个参数，实际 ${p.length}`);
  assert(p[0] === 'q1' && p[1] === 'bank_default' && p[3] === '题干', '前四列应为 id/bank_id/type/stem');
  assert(p[14] === null, '第 15 列（question_image_path）应为 null');
  assert(p[15] === 'zhipu', '第 16 列应为 source_engine');
});

const total = passed + fails.length;
if (fails.length > 0) {
  console.log(`BACKUP VERIFY FAILED：${passed}/${total} 通过`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`BACKUP VERIFY PASSED：${total}/${total} 用例全部符合预期`);
