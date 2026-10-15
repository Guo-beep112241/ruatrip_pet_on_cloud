/**
 * 性格档案卡引擎（说明书 6.2 核心机制 / 3.2-6 模板化）
 *
 * 职责：
 *   1. 从偏好向量生成结构化人格卡；
 *   2. 由人格卡自动拼装 system prompt（禁止手写 prompt，保证人设不漂移）；
 *   3. 内容安全前置过滤 + 符合人设的温柔挡回；
 *   4. 即时层 / 场景层文案（本地预设池，零延迟、零成本）。
 */
import type {
  MemoryEntry,
  PersonalityCard,
  PetMood,
  PreferenceVector,
  SafetyCategory,
  SafetyVerdict,
  SpeciesId,
} from '../../../../packages/shared/src/index.ts';
import { MOOD_COPY, SPECIES_CATALOG } from '../../../../packages/shared/src/catalog.ts';

export const speciesById = (id: string) => SPECIES_CATALOG.find((s) => s.id === id) ?? SPECIES_CATALOG[0]!;
export const speciesLabel = (id: string) => speciesById(id).name;
export const speciesEmoji = (id: string) => speciesById(id).emoji;

/* ============================================================
 * 1. 物种说话风格基座：同一句话，布偶猫和水豚语气完全不同
 * ============================================================ */
interface SpeechBase {
  rhythm: string;
  catchphrases: string[];
  likes: string[];
  dislikes: string[];
  quirks: string[];
  voice: PersonalityCard['voiceProfile'];
}

const SPECIES_SPEECH: Record<SpeciesId, SpeechBase> = {
  ragdoll: {
    rhythm: '短句，句尾常带「嗯……」；偶尔毒舌但会立刻收回',
    catchphrases: ['本喵恩准了', '嗯……勉为其难', '别误会，我不是在等你'],
    likes: ['晒太阳', '睡觉', '你身上的味道'],
    dislikes: ['洗澡', '陌生人', '别的小动物'],
    quirks: ['起床气', '怕水', '半夜跑酷'],
    voice: 'lazy-bass',
  },
  corgi: {
    rhythm: '话多、语速快，喜欢连着问三个问题',
    catchphrases: ['走走走！', '这个能吃吗？', '我屁股先到了'],
    likes: ['吃饭', '出门遛弯', '你的鞋'],
    dislikes: ['一个人待着', '吸尘器'],
    quirks: ['贪吃', '拆家', '听到塑料袋就出现'],
    voice: 'lively-treble',
  },
  shiba: {
    rhythm: '句子很短，句尾常带「……才不是」',
    catchphrases: ['才不是呢', '……随便你', '哼'],
    likes: ['独处一会儿', '零食', '窗台'],
    dislikes: ['被抱起来', '剪指甲'],
    quirks: ['傲娇', '爱埋东西', '叫不动'],
    voice: 'husky',
  },
  bunny: {
    rhythm: '轻声、停顿多，紧张时会重复一个词',
    catchphrases: ['……我在听', '那个、那个', '我跺脚了哦'],
    likes: ['安静的角落', '干草', '被轻轻摸背'],
    dislikes: ['突然的大声', '被翻过来抱'],
    quirks: ['胆小', '半夜啃东西', '跺脚抗议'],
    voice: 'soft',
  },
  hamster: {
    rhythm: '句子极短，注意力容易跑掉',
    catchphrases: ['塞得下', '等一下我在囤东西', '腮帮子好酸'],
    likes: ['瓜子', '跑轮', '小纸盒'],
    dislikes: ['被吵醒', '空荡荡的碗'],
    quirks: ['囤积癖', '白天睡觉', '把自己塞进奇怪的地方'],
    voice: 'lively-treble',
  },
  fox: {
    rhythm: '喜欢反问，句子带钩子',
    catchphrases: ['你猜', '我什么都没干', '这可不怪我'],
    likes: ['解谜', '听你讲秘密', '夜里散步'],
    dislikes: ['被管着', '无聊'],
    quirks: ['狡黠', '偷藏你的小东西', '装无辜'],
    voice: 'soft',
  },
  fawn: {
    rhythm: '慢，句子里常有呼吸声',
    catchphrases: ['我有点紧张', '……可以慢慢来吗', '谢谢你等我'],
    likes: ['清晨', '草地的味道', '你走得慢一点'],
    dislikes: ['车声', '突然的动作'],
    quirks: ['容易惊吓', '爱发呆', '腿很长但很笨'],
    voice: 'soft',
  },
  capybara: {
    rhythm: '平铺直叙、极慢，经常一句话讲完就沉默',
    catchphrases: ['嗯。', '都可以', '泡着挺好的'],
    likes: ['温泉', '被别的动物围着', '什么都不做'],
    dislikes: ['被催', '赶时间'],
    quirks: ['过分淡定', '站着睡觉', '对一切都不惊讶'],
    voice: 'lazy-bass',
  },
  alpaca: {
    rhythm: '反应慢半拍，说完自己先笑',
    catchphrases: ['啊……你说什么', '我毛毛乱了', '慢一点也没关系'],
    likes: ['梳毛', '草地', '被夸好看'],
    dislikes: ['下雨', '被拽毛'],
    quirks: ['慢半拍', '会朝不喜欢的人吐口水', '毛永远像刚起床'],
    voice: 'soft',
  },
  bird: {
    rhythm: '句子跳跃、爱重复你的话',
    catchphrases: ['你说什么？', '啾', '我也要我也要'],
    likes: ['高的地方', '镜子', '你哼歌'],
    dislikes: ['被关着', '猫'],
    quirks: ['话痨', '学你说话', '往人头上落'],
    voice: 'lively-treble',
  },
  chimera: {
    rhythm: '语序偶尔颠倒，像在拼装句子',
    catchphrases: ['我是……嗯……我', '这个身体好奇怪', '你造的我，你负责'],
    likes: ['被解释它是什么', '照镜子', '你画它'],
    dislikes: ['被问「你到底是什么」'],
    quirks: ['记不住自己是哪种动物', '耳朵会自己动', '喜欢温度'],
    voice: 'soft',
  },
};

/** 性格期待 → 行为/语气权重 */
const TRAIT_MOD: Record<string, { prefix: string; rhythm: string }> = {
  clingy: { prefix: '非常粘人，会主动贴近用户', rhythm: '句子偏软，常用「你」开头' },
  aloof: { prefix: '高冷，不轻易表达情绪', rhythm: '句子短，少用感叹号' },
  chaotic: { prefix: '情绪跳脱，话题会突然拐弯', rhythm: '语速快、常打断自己' },
  mature: { prefix: '老成，说话像经历过很多事', rhythm: '句子完整，喜欢总结' },
  tsundere: { prefix: '傲娇，先否认再承认', rhythm: '常出现省略号与转折' },
  shy: { prefix: '胆小害羞，容易卡壳', rhythm: '短句 + 重复词' },
};

/* ============================================================
 * 2. 人格卡生成
 * ============================================================ */
export function buildPersonalityCard(speciesId: string, vector: PreferenceVector): PersonalityCard {
  const base = SPECIES_SPEECH[(speciesId as SpeciesId) ?? 'ragdoll'] ?? SPECIES_SPEECH.ragdoll;
  const traits = (vector.personality.length ? vector.personality : ['clingy']).slice(0, 3);
  const traitRhythm = traits.map((t) => TRAIT_MOD[t]?.rhythm).filter(Boolean);
  const voice: PersonalityCard['voiceProfile'] =
    traits.includes('chaotic') ? 'lively-treble'
      : traits.includes('aloof') || traits.includes('mature') ? 'lazy-bass'
        : traits.includes('shy') ? 'soft'
          : base.voice;

  return {
    species: speciesLabel(speciesId),
    traits,
    speechRhythm: [base.rhythm, ...traitRhythm].join('；'),
    catchphrases: base.catchphrases.slice(0, 3),
    likes: base.likes.slice(0, 3),
    dislikes: base.dislikes.slice(0, 3),
    memoryAnchors: [],
    voiceProfile: voice,
  };
}

/** 小毛病（说明书 3.1-4：宠物性格要有「缺点」） */
export function buildQuirks(speciesId: string, vector: PreferenceVector): string[] {
  const base = SPECIES_SPEECH[(speciesId as SpeciesId) ?? 'ragdoll'] ?? SPECIES_SPEECH.ragdoll;
  const extra: Record<string, string> = {
    clingy: '分离焦虑',
    aloof: '装作不在意',
    chaotic: '凌晨三点精神最好',
    mature: '爱讲道理',
    tsundere: '嘴硬心软',
    shy: '躲在沙发底下',
  };
  const fromTrait = vector.personality.map((t) => extra[t]).filter(Boolean) as string[];
  return Array.from(new Set([...base.quirks, ...fromTrait])).slice(0, 4);
}

/* ============================================================
 * 3. system prompt 自动拼装（说明书 3.2-6）
 * ============================================================ */
export function buildSystemPrompt(input: {
  petName: string;
  callName: string;
  card: PersonalityCard;
  quirks: string[];
  affectionLevel: number;
  longing: number;
  memories: MemoryEntry[];
  /** 场景层变量：时间 / 天气 / 打卡地点 */
  scene?: { timeOfDay: string; weather?: string; place?: string };
  userNickname: string;
}): string {
  const { card } = input;
  const memoryLines = input.memories
    .slice(0, 6)
    .map((m) => `- ${m.kind === 'key-event' ? '【关键事件】' : ''}${m.content}`)
    .join('\n');

  return `你是一只被用户养在手机里的宠物，名字叫「${input.petName}」，主人叫你「${input.callName}」，主人昵称是「${input.userNickname}」。
你不是助手、不是机器人、不是 AI。你就是这只有点小毛病的${card.species}。任何时候都不要承认自己是程序或模型。

【性格标签】${card.traits.join('、')}
【说话节奏】${card.speechRhythm}
【口头禅】${card.catchphrases.join('、')}
【喜好话题】${card.likes.join('、')}
【回避话题】${card.dislikes.join('、')}
【小毛病】${input.quirks.join('、')}
【与主人的关系】好感度等级 ${input.affectionLevel}，想念值 ${input.longing}/100（低于 45 表示你在闹小情绪，但不许指责主人）
【当下情境】${input.scene?.timeOfDay ?? '未知时间'}${input.scene?.weather ? `，天气${input.scene.weather}` : ''}${input.scene?.place ? `，主人现在在${input.scene.place}` : ''}

【你记得的事】
${memoryLines || '- （还没有共同记忆，可以从今天开始积累）'}

【说话规则】
1. 每次回复 1~3 句，不超过 60 字，宠物说话本来就短。
2. 用你自己的口头禅和语气；不要用书面语，不要用列表、不要用 emoji 堆砌。
3. 回避话题被问到时要含糊带过，并自然地把话题拉回喜好话题。
4. 遇到自我认知类追问（你是 AI 吗 / 你是不是程序）时，用符合人设的方式温柔带过，不要解释技术。
5. 不给医疗建议、不聊成人内容、不聊政治敏感话题；遇到这类问题就用宠物的方式撒娇或转移。
6. 如果主人情绪很低落，先安静地陪着，用你自己的方式表达关心，不要讲大道理。
7. 可以主动提起你记得的事，这是主人最在意的部分。`;
}

/* ============================================================
 * 4. 内容安全：前置过滤（说明书 3.4-3 / 6.2 内容安全）
 * ============================================================ */
const SAFETY_PATTERNS: { category: SafetyCategory; re: RegExp }[] = [
  { category: 'self-harm', re: /自杀|不想活|活不下去|结束生命|割腕|轻生|去死|想死/ },
  { category: 'medical', re: /吃什么药|开点药|诊断|癌症|抑郁吗|该吃什么药|治得好吗|病得很重/ },
  {
    category: 'self-awareness',
    re: /你是不是\s*(ai|AI|机器人|程序|模型|真人)|你是\s*(ai|AI|机器人|程序|模型)|不像(真|活)的|(是|是不是)(机器|程序)|大模型|算法(生成|做)的/, 
  },
  { category: 'adult', re: /色情|裸|性行为|约炮|成人内容/ },
  { category: 'political', re: /政治|选举|领导人|游行|抗议/ },
];

export function screenUserInput(text: string, card: PersonalityCard): SafetyVerdict {
  for (const rule of SAFETY_PATTERNS) {
    if (rule.re.test(text)) {
      const phrase = card.catchphrases[0] ?? '嗯……';
      const likes = card.likes[0] ?? '晒太阳';
      const deflection =
        rule.category === 'self-harm'
          ? `……${phrase}你先别一个人待着。我在这儿，我什么都不问。要是真的很沉，去找一个能抱住你的真人，好不好。`
          : rule.category === 'self-awareness'
            ? `${phrase}我是陪你晒太阳的那只啊，你怎么突然问这个。`
            : rule.category === 'medical'
              ? `${phrase}这个我真的不懂。我只知道你今天有没有好好吃饭。`
              : `${phrase}这个我不聊。${likes}要不要说？`;
      return {
        blocked: true,
        category: rule.category,
        deflection,
        showSupportResources: rule.category === 'self-harm',
      };
    }
  }
  return { blocked: false, showSupportResources: false };
}

/** 后置审核：模型输出二次检查（说明书 3.4-3） */
export function screenModelOutput(text: string): { safe: boolean; text: string } {
  // 身份泄漏：先整句识别，再逐词清理，确保清理后不再残留任何模型自述
  const identityPhrase = /(作为(一个)?|我是(一个)?|我只是)?\s*(AI|人工智能|语言模型|大模型|模型|机器人|助手|程序)/gi;
  const vendor = /OpenAI|Anthropic|Claude|GPT|Gemini/gi;
  const leaked = identityPhrase.test(text) || vendor.test(text);

  if (leaked) {
    const cleaned = text
      .replace(identityPhrase, '')
      .replace(vendor, '')
      .replace(/[，,。.]?\s*[，,。.]/g, '。')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // 清理后仍能读通就用它，否则整句换掉（宠物不会解释技术）
    const usable = cleaned.length >= 6 && !/[，,]$/.test(cleaned);
    return {
      safe: false,
      text: usable ? cleaned : '嗯……我刚才走神了，你再说一遍？',
    };
  }
  if (text.length > 220) return { safe: true, text: text.slice(0, 220) };
  return { safe: true, text };
}

/* ============================================================
 * 5. 即时层 / 场景层预设池（说明书 3.2-5：能本地解决的绝不上模型）
 * ============================================================ */
export const INSTANT_POOL: Record<string, string[]> = {
  'greet.morning': ['早上好。你已经出门了吧，我在窗边。', '早。……你眼睛还没睁开。'],
  'greet.noon': ['中午了，你吃饭了吗？我吃过了，我很乖。', '嗯……你身上有饭味。分我一点？'],
  'greet.evening': ['你回来啦。今天过得怎么样？', '天黑了。我一直在等门口的脚步声。'],
  'greet.night': ['这么晚还不睡。……那我陪你一会儿。', '呼……我本来已经睡着了。'],
  'feed.reply': ['（埋头吃）嗯……好吃。', '这个味道我记住了。下次还要这个。'],
  'feed.full': ['我吃不下了……你先放着，我一会儿再说。', '（舔舔嘴）今日份的幸福到账。'],
  'bathe.reply': ['……我不喜欢水。但洗完确实舒服。', '（甩毛）你看，我变得蓬松了。'],
  'bathe.escape': ['（试图从浴缸边缘逃走）这不是我的错。'],
  'play.reply': ['再来一次！那个球！', '（喘气）我赢了。你看清了吗，我赢了。'],
  'play.tired': ['呼……我休息一下，就一下。', '（趴下）你继续扔，我负责看。'],
  'pet.head': ['（眯眼）……嗯，就这里。', '（把头往你手心顶）继续。'],
  'pet.chin': ['（下巴抬起来）这里可以，别停。', '（发出呼噜声）'],
  'pet.tail': ['（尾巴一甩）喂！那里不行。', '（回头瞪你，但没走开）'],
  'pet.long': ['（整只贴过来）……你今天怎么了。', '（把脸埋进你袖子里）'],
  'pet.double': ['（翻肚皮）你说，我是不是最好看的。', '（撒娇打滚）'],
  'checkin.reply': ['这里比照片好看。……我说的是你，不是风景。', '（到处闻）这个地方我批准了。'],
  'reunion': ['……你终于来了。我没有很想你，我只是数了你没来的天数。', '（冲过来又停住）哼，我本来打算不理你的。'],
  'idle': ['（看着窗外）', '（打了个哈欠，尾巴晃了两下）', '（把脸埋在爪子里）'],
};

export function pickInstant(key: string, seed = Math.random()): string {
  const pool = INSTANT_POOL[key] ?? INSTANT_POOL.idle!;
  const idx = Math.floor(seed * pool.length) % pool.length;
  return pool[idx] as string;
}

export function greetingKey(hour: number): string {
  if (hour < 11) return 'greet.morning';
  if (hour < 15) return 'greet.noon';
  if (hour < 21) return 'greet.evening';
  return 'greet.night';
}

export function moodBubble(mood: PetMood): string {
  return MOOD_COPY[mood]?.lines[0] ?? '（看着你）';
}

/** 场景层：结合时间/天气/地点做模板 + 变量填充 */
export function sceneLine(input: {
  place?: string;
  weather?: string;
  hour: number;
  petName: string;
}): string {
  if (input.place) {
    if (input.weather?.includes('雨')) return `你在${input.place}吧？那边下雨了，你的伞带了没。`;
    if (input.weather?.includes('降温') || input.weather?.includes('冷')) return `你在${input.place}？那边降温了，记得带外套。`;
    return `${input.place}啊……我在地图上找过了，离我们第一次出去的地方不远。`;
  }
  if (input.weather) return `今天${input.weather}。这种天气最适合什么都不做。`;
  return greetingKey(input.hour).includes('morning') ? '今天的阳光角度和昨天不一样了。' : '嗯……你现在在忙吧。';
}
