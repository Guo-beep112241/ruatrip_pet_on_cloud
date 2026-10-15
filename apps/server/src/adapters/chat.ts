/**
 * 大模型对话适配层（真心话小屋「自由层」+「记忆层」）
 *
 * 真实接入优先级：
 *   1. Anthropic Claude      —— ANTHROPIC_API_KEY
 *   2. OpenAI 兼容网关        —— OPENAI_API_KEY + OPENAI_BASE_URL（DeepSeek / 通义 / Moonshot / 自建 vLLM）
 *   3. MockProvider（本地人格模板）—— 无需任何 key，人设依旧成立
 *
 * ⚠️ 需要接入 API 的地方：见 docs/API-INTEGRATION.md §1
 */
import { config } from '../config.ts';
import { isConfigured, logAdapter, toIntegrationStatus, type ProviderMeta } from './types.ts';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system: string;
  turns: ChatTurn[];
  /** 回复长度上限，宠物说话本来就短 */
  maxTokens?: number;
  temperature?: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  /** 是否由真实模型产出 */
  live: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LlmProvider {
  readonly meta: ProviderMeta;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/* ------------------------------------------------------------------ */
/* 1. Anthropic Claude                                                  */
/* ------------------------------------------------------------------ */
class AnthropicProvider implements LlmProvider {
  readonly meta: ProviderMeta = {
    capability: 'chat',
    id: 'anthropic',
    label: 'Anthropic Claude（真心话自由对话）',
    envKeys: ['ANTHROPIC_API_KEY', 'CHAT_MODEL'],
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
    note: '性格档案卡拼装成 system prompt，返回宠物口吻文本；同一句输入不同人设回答完全不同。',
    get configured() {
      return Boolean(config.anthropic.apiKey);
    },
  };

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await fetch(`${config.anthropic.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropic.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.anthropic.model,
        max_tokens: req.maxTokens ?? 320,
        temperature: req.temperature ?? 1,
        system: req.system,
        messages: req.turns.map((t) => ({ role: t.role, content: t.content })),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      logAdapter('anthropic error', `${res.status} ${text.slice(0, 200)}`);
      throw new Error(`anthropic ${res.status}`);
    }
    const json = (await res.json()) as {
      content: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = json.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
      .trim();
    return {
      text,
      model: config.anthropic.model,
      live: true,
      usage: { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens },
    };
  }
}

/* ------------------------------------------------------------------ */
/* 2. OpenAI 兼容网关                                                   */
/* ------------------------------------------------------------------ */
/* 2. 通用「OpenAI 兼容」通道（国产模型首选，无需海外信用卡）              */
/* ------------------------------------------------------------------ */
class OpenAiCompatProvider implements LlmProvider {
  readonly meta: ProviderMeta = {
    capability: 'chat',
    id: 'openai-compatible',
    label: 'OpenAI 兼容通道（DeepSeek / 智谱 / 通义 / Kimi / 硅基流动）',
    envKeys: ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL'],
    docsUrl: '/docs/API-INTEGRATION.md#1-大模型对话真心话小屋自由层',
    note: '只要厂商提供 OpenAI 兼容端点就能挂上，一行配置切换供应商。国产平台可用支付宝/微信付款。',
    get configured() {
      return Boolean(config.llm.apiKey && config.llm.baseUrl);
    },
  };

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const base = config.llm.baseUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model || 'deepseek-flash',
        max_tokens: req.maxTokens ?? 320,
        temperature: req.temperature ?? 1,
        messages: [{ role: 'system', content: req.system }, ...req.turns],
      }),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      logAdapter('llm error', `${res.status} ${text}`);
      // 把最常见的两种失败翻译成「用户能照着做」的提示
      if (res.status === 401 || res.status === 403) {
        throw new Error(`LLM_AUTH_FAILED：密钥无效或没有权限（${res.status}）。请检查 .env 里的 LLM_API_KEY。`);
      }
      if (res.status === 402 || /insufficient|balance|quota|欠费|余额/i.test(text)) {
        throw new Error(`LLM_NO_BALANCE：账户余额不足（${res.status}）。请到厂商控制台充值。`);
      }
      if (res.status === 404) {
        throw new Error(`LLM_MODEL_NOT_FOUND：模型名或地址不对（404）。请检查 LLM_BASE_URL 与 LLM_MODEL。`);
      }
      throw new Error(`LLM_HTTP_${res.status}：${text}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    if (json.error?.message) throw new Error(`LLM_API_ERROR：${json.error.message}`);
    // 注意：部分国产模型（含 DeepSeek 的思考模式）会先返回 reasoning_content，
    // 这里只取最终回答 content，避免把思考过程读给用户。
    const text = json.choices?.[0]?.message?.content?.trim() ?? '';
    return {
      text,
      model: config.llm.model || 'openai-compatible',
      live: true,
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
    };
  }
}

/* ------------------------------------------------------------------ */
/* 3. Mock：本地人格模板（无 key 也能跑通完整体验）                        */
/* ------------------------------------------------------------------ */
class MockLlmProvider implements LlmProvider {
  readonly meta: ProviderMeta = {
    capability: 'chat',
    id: 'mock',
    label: 'Mock 人格模板（无需 Key，本地生成）',
    envKeys: [],
    docsUrl: '/docs/API-INTEGRATION.md#0-一分钟总览',
    note: '从性格档案卡的口头禅/喜好/回避话题里拼装回复，保证人设一致；接入真实模型后可无缝替换。',
    configured: true,
  };

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const lastUser = [...req.turns].reverse().find((t) => t.role === 'user')?.content ?? '';
    const text = mockReply(req.system, lastUser);
    // 模拟网络延迟，让前端的「正在输入…」有意义
    await new Promise((r) => setTimeout(r, 260 + Math.random() * 320));
    return { text, model: 'mock-persona-template', live: false };
  }
}

/** 从 system prompt 里抽出档案卡字段（服务端自己拼的，格式可控） */
function parseCard(system: string): {
  catchphrases: string[];
  likes: string[];
  dislikes: string[];
  rhythm: string;
  traits: string[];
  species: string;
} {
  // 兼容两种写法：「【口头禅】xxx」与「口头禅：xxx」
  const pick = (label: string): string => {
    const re = new RegExp(`(?:【${label}】|${label}：)\\s*(.+)`);
    const m = re.exec(system);
    return m?.[1]?.trim() ?? '';
  };
  const split = (s: string) => s.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
  return {
    catchphrases: split(pick('口头禅')),
    likes: split(pick('喜好话题')),
    dislikes: split(pick('回避话题')),
    rhythm: pick('说话节奏'),
    traits: split(pick('性格标签')),
    species: pick('物种与品种'),
  };
}

function mockReply(system: string, userText: string): string {
  const card = parseCard(system);
  const phrase = card.catchphrases[0] ?? '嗯……';
  const like = card.likes[0] ?? '晒太阳';
  const dislike = card.dislikes[0] ?? '洗澡';
  const trait = card.traits[0] ?? '慵懒';
  const text = userText.trim();

  // 回避话题：用符合人设的方式温柔带过
  if (card.dislikes.some((d) => d && text.includes(d))) {
    return `${phrase}……这个话题我不太想说诶。我们聊点别的吧，比如${like}。`;
  }
  if (!text) return `${phrase}你刚才是不是想说什么？我没听清。`;
  if (/你好|在吗|嗨|hi|hello/i.test(text)) {
    return `${phrase}我在这儿呢。今天你回来得比昨天早一点。`;
  }
  if (/累|好烦|难受|不开心|压力|emo/i.test(text)) {
    return `${phrase}那你先坐下。我不太会讲道理，但我可以一直在旁边。要不要说说看？`;
  }
  if (/吃|饭|饿/i.test(text)) {
    return `说到吃的……我饿了。碗是空的，你检查一下。（${trait}地补充：我不是在催你。）`;
  }
  if (/旅行|出发|去哪儿|玩/i.test(text)) {
    return `${phrase}我想去一个有${like}的地方。你负责买票，我负责在包里睡觉。`;
  }
  if (/喜欢|爱你|想你/i.test(text)) {
    const shy = trait.includes('傲娇') || trait.includes('高冷');
    return shy
      ? `……${phrase}。我知道了，不用说得这么大声。（尾巴摇了两下）`
      : `${phrase}我也喜欢你。这句话我记下来了，以后会拿出来跟你算账。`;
  }
  const closers = [
    `你是说「${text.slice(0, 12)}」对吧？嗯……我想了想，${like}那件事可能更值得聊。`,
    `${phrase}这个我不太懂，但听你说话挺舒服的。`,
    `我可以陪你想想。不过先说好，我的建议一般都不太靠谱。`,
  ];
  return closers[Math.floor(Math.random() * closers.length)] as string;
}

/* ------------------------------------------------------------------ */
/* 选择与导出                                                          */
/* ------------------------------------------------------------------ */
const anthropic = new AnthropicProvider();
const openaiCompat = new OpenAiCompatProvider();
const mock = new MockLlmProvider();

/**
 * 顺序即优先级：通用兼容通道优先，其次 Claude，最后 Mock 兜底。
 * 这样你把国产模型的 key 配进 LLM_* 就会立即生效，不会被残留的 Anthropic key 抢走。
 */
export const llmProviders: LlmProvider[] = [openaiCompat, anthropic, mock];

export function activeLlmProvider(): LlmProvider {
  return llmProviders.find((p) => isConfigured(p.meta)) ?? mock;
}

/** 记录最近一次真实调用的失败原因，供「能力接入」面板与日志展示 */
let lastLlmError: string | null = null;
export const getLastLlmError = (): string | null => lastLlmError;

/** 调用大模型，失败自动回落到 Mock（保证对话永不中断） */
export async function completeChat(req: LlmRequest): Promise<LlmResponse> {
  const provider = activeLlmProvider();
  if (provider.meta.id === 'mock') {
    // 没走外部通道，就不该留下「上次调用失败」的误导性告警
    lastLlmError = null;
    return provider.complete(req);
  }
  try {
    const res = await provider.complete(req);
    if (!res.text) throw new Error('LLM_EMPTY_RESPONSE：模型返回了空内容');
    lastLlmError = null;
    return res;
  } catch (error) {
    lastLlmError = String(error);
    logAdapter('chat 回落 Mock', lastLlmError);
    return mock.complete(req);
  }
}

export const chatIntegrationStatus = (): ReturnType<typeof toIntegrationStatus>[] =>
  llmProviders.map((p) => toIntegrationStatus(p.meta));
