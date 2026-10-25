import type { AgentToolName } from './agentTools';

export type AgentSkillId = 'quick_explain' | 'grounded_explain' | 'wrongbook_review';

export interface AgentSkill {
  id: AgentSkillId;
  label: string;
  tools: AgentToolName[];
  instructions: string;
}

export const AGENT_SKILLS: Record<AgentSkillId, AgentSkill> = {
  quick_explain: {
    id: 'quick_explain',
    label: '快速讲解',
    tools: [],
    instructions:
      '这是快速讲解场景：不要调用工具，直接用简洁、准确的模型知识回答；不要声称引用了教材。',
  },
  grounded_explain: {
    id: 'grounded_explain',
    label: '教材依据讲解',
    tools: ['search_materials', 'search_bank'],
    instructions:
      '这是教材依据场景：必须先调用 search_materials；有依据时在正文标注实际编号，检索无依据时回复固定句并等待用户选择降级方式。',
  },
  wrongbook_review: {
    id: 'wrongbook_review',
    label: '错题复盘',
    tools: ['get_related_wrong', 'search_materials', 'search_bank'],
    instructions:
      '这是错题复盘场景：先调用 get_related_wrong，结合错误次数和最近时间给出复习建议；需要知识点时再检索教材或题库。',
  },
};

const WRONGBOOK_REVIEW_UNBOUND: AgentSkill = {
  id: 'wrongbook_review',
  label: '错题复盘（未绑定教材）',
  tools: ['get_related_wrong', 'search_bank'],
  instructions:
    '这是错题复盘场景：先调用 get_related_wrong，结合错误次数和最近时间给出复习建议；当前题库未绑定教材，禁止检索或引用教材。',
};

export function selectAgentSkill(input: {
  mode: 'bank' | 'wrong';
  hasBoundMaterials: boolean;
  stem: string;
}): AgentSkill {
  if (input.mode === 'wrong' || /错题|错误|复习|同类/.test(input.stem)) {
    return input.hasBoundMaterials ? AGENT_SKILLS.wrongbook_review : WRONGBOOK_REVIEW_UNBOUND;
  }
  if (input.hasBoundMaterials) return AGENT_SKILLS.grounded_explain;
  return AGENT_SKILLS.quick_explain;
}
