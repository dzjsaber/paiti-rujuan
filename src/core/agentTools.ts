/**
 * Agent 的三个只读工具：教材检索、当前题库相似题、当前题库相关错题。
 * 教材工具返回的编号会累计到本次讲解的 evidence，供最终卡片展示。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { searchMaterialsSmart, searchQuestionsInBank, searchWrongInBank } from '../db/fts';
import type { RagEvidence } from '../prompts/ragExplain';
import { buildSearchTerms, clipHitText } from './searchTerms';
import type { AgentTool } from './agentLoop';

export interface AgentQuestion {
  id: string;
  bankId: string;
  stem: string;
  options: { id: string; text: string }[];
}

export type AgentToolName = 'search_materials' | 'search_bank' | 'get_related_wrong';

const parameters = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export function createAgentTools(
  db: SQLiteDatabase,
  question: AgentQuestion,
  boundMaterialIds: string[],
): AgentTool[] {
  const evidence: RagEvidence[] = [];
  const questionText = `${question.stem}\n${question.options.map((o) => o.text).join('\n')}`;

  const searchMaterials: AgentTool = {
    label: '检索教材',
    definition: {
      type: 'function',
      function: {
        name: 'search_materials',
        description: '检索教材原文。题库绑定教材时只检索绑定教材；返回带引用编号的片段。',
        parameters: parameters({ query: { type: 'string', description: '检索关键词或题目要点' } }, ['query']),
      },
    },
    async execute(args) {
      const requested = typeof args.query === 'string' ? args.query.trim() : '';
      const query = buildSearchTerms(requested).length > 0 ? requested : questionText;
      const terms = buildSearchTerms(query);
      const hits = await searchMaterialsSmart(
        db,
        query,
        5,
        boundMaterialIds.length > 0 ? boundMaterialIds : undefined,
      );
      if (hits.length === 0) {
        return {
          summary: boundMaterialIds.length > 0 ? '绑定教材未命中' : '教材未命中',
          content:
            boundMaterialIds.length > 0
              ? '当前题库绑定的教材中没有检索到可用依据。不要用模型知识替代教材依据。'
              : '教材库中没有检索到相关内容。',
        };
      }
      const additions: RagEvidence[] = hits.map((hit) => {
        const item = {
          index: evidence.length + 1,
          text: clipHitText(hit.text, terms),
          source: `${hit.materialName}${hit.sourceLoc ? ` · ${hit.sourceLoc}` : ''}`,
        };
        evidence.push(item);
        return item;
      });
      return {
        summary: `命中 ${hits.length} 条`,
        content: additions.map((e) => `[${e.index}]（来源：${e.source}）\n${e.text}`).join('\n\n'),
        evidence: additions,
      };
    },
  };

  const searchBank: AgentTool = {
    label: '检索题库',
    definition: {
      type: 'function',
      function: {
        name: 'search_bank',
        description: '检索当前题库中题干相近的题目，只返回题干摘要，用于找同类题型。',
        parameters: parameters({ query: { type: 'string', description: '要查找的知识点或题干要点' } }, ['query']),
      },
    },
    async execute(args) {
      const requested = typeof args.query === 'string' ? args.query.trim() : '';
      const query = buildSearchTerms(requested).length > 0 ? requested : question.stem;
      const hits = await searchQuestionsInBank(db, question.bankId, query, question.id, 5);
      return {
        summary: `命中 ${hits.length} 条`,
        content:
          hits.length === 0
            ? '当前题库没有检索到相似题。'
            : hits
                .map((hit, index) => `${index + 1}. ${hit.stem.slice(0, 160)}`)
                .join('\n') + '\n（题库题目仅用于类比，不能作为教材引用依据。）',
      };
    },
  };

  const relatedWrong: AgentTool = {
    label: '查询相关错题',
    definition: {
      type: 'function',
      function: {
        name: 'get_related_wrong',
        description: '查询当前题库中与这道题题干相近的历史错题及错误次数。',
        parameters: parameters(
          { question_id: { type: 'string', description: '当前题目 ID' } },
          ['question_id'],
        ),
      },
    },
    async execute(args) {
      const questionId = typeof args.question_id === 'string' && args.question_id ? args.question_id : question.id;
      const hits = await searchWrongInBank(db, question.bankId, question.stem, questionId, 5);
      return {
        summary: `命中 ${hits.length} 条`,
        content:
          hits.length === 0
            ? '当前题库没有检索到相关错题。'
            : hits
                .map(
                  (hit, index) =>
                    `${index + 1}. 错 ${hit.wrong_count} 次`
                    + `${hit.last_wrong_at ? `（最近 ${hit.last_wrong_at.slice(0, 10)}）` : ''}`
                    + `：${hit.stem.slice(0, 160)}`,
                )
                .join('\n') + '\n（错题记录仅作学习情况参考，不能作为教材引用依据。）',
      };
    },
  };

  return [searchMaterials, searchBank, relatedWrong];
}
