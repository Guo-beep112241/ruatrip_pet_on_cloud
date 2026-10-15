/**
 * RuaTrip 领域模型（前后端共享的唯一事实来源）
 * 对应《RuaTrip 产品详细说明书 v2.0》第五～八章。
 */

/* ============================================================
 * 一、偏好问卷与画像（说明书 5.1 / 5.3）
 * ============================================================ */

/** 问卷维度 id */
export type PreferenceDimensionId =
  | 'species'      // 物种倾向
  | 'bodySize'     // 体型偏好
  | 'fur'          // 毛感偏好
  | 'palette'      // 配色偏好
  | 'personality'  // 性格期待
  | 'rhythm'       // 相处节奏
  | 'travel'       // 旅行偏好
  | 'photoHabit';  // 拍照习惯

export interface PreferenceOption {
  id: string;
  label: string;
  /** 选项对应的形象/人格参数增量 */
  value: string;
  emoji?: string;
  hint?: string;
}

export interface PreferenceQuestion {
  id: PreferenceDimensionId;
  /** 题目文案（要有趣、不枯燥） */
  question: string;
  helper?: string;
  /** 多选时的最多可选数量 */
  maxSelect?: number;
  options: PreferenceOption[];
}

/** 用户提交的问卷答案：维度 → 选项 id 数组 */
export type PreferenceAnswers = Partial<Record<PreferenceDimensionId, string[]>>;

/** 多维偏好向量（说明书 2.2 ①） */
export interface PreferenceVector {
  /** 物种倾向 → 生成模型物种提示词 */
  species: string;
  /** 体型与比例 */
  bodySize: 'tiny' | 'small' | 'medium' | 'large';
  /** 材质与渲染参数 */
  fur: 'fluffy' | 'silky' | 'short' | 'curly';
  /** 毛色与花纹掩码 */
  palette: string[];
  /** 动画权重 / 待机动作 / 对话人格 */
  personality: string[];
  /** 互动频率与留存机制 */
  rhythm: 'clingy' | 'balanced' | 'independent';
  /** 首推场景与首批徽章 */
  travelPreference: string[];
  /** 手账功能引导强度 */
  photoHabit: 'heavy' | 'normal' | 'light';
  /** 冷启动补全的维度（说明书 5.2 预测补位） */
  inferred: PreferenceDimensionId[];
}

/** 置信度 + 预测补位结果，便于前端提示「已根据相似画像补全」 */
export interface ProfileInference {
  vector: PreferenceVector;
  /** 0~1，问卷完整度 */
  confidence: number;
  /** 被补齐的维度 */
  inferredDimensions: PreferenceDimensionId[];
}

/* ============================================================
 * 二、宠物（说明书 4.x / 6.x）
 * ============================================================ */

export type SpeciesId =
  | 'ragdoll' | 'corgi' | 'shiba' | 'bunny' | 'hamster'
  | 'fox' | 'fawn' | 'capybara' | 'alpaca' | 'bird' | 'chimera';

export interface Species {
  id: SpeciesId;
  name: string;
  emoji: string;
  /** 物种大类，决定自动绑定兜底骨架 */
  family: 'feline' | 'canine' | 'rodent' | 'cervid' | 'avian' | 'hybrid';
  /** 兜底骨架模板（说明书 4.3 稀有物种兜底） */
  fallbackRig: 'quadruped' | 'biped' | 'avian';
}

/** 生成任务状态机（说明书 4.2 / 3.2「生成全异步」） */
export type GenerationStage =
  | 'queued'
  | 'generating_mesh'
  | 'texturing'
  | 'rigging'
  | 'ready'
  | 'failed'
  | 'fallback_used';

export interface GenerationJob {
  id: string;
  petId: string;
  stage: GenerationStage;
  /** 0~100 */
  progress: number;
  provider: string;
  /** 孵化文案，用于掩盖等待（说明书 3.2-2） */
  incubatingLine: string;
  /** 实际使用的骨骼模板，fallback 时非空 */
  rigFallbackUsed?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** 3D 资产母版（说明书 3.2-1「资产母版唯一化」） */
export interface PetAssetMaster {
  /** 唯一母版 id，后续所有场景都从它派生，禁止重新生成 */
  masterId: string;
  meshUrl: string;
  /** 本地可渲染的占位/降级资产（无外部 3D 服务时使用） */
  fallbackRenderUrl: string;
  pbrTextures: { baseColor?: string; normal?: string; roughness?: string };
  rigged: boolean;
  rigTemplate: string;
  /** 面数（说明书 4.7 模型控制） */
  triangleCount: number;
  /** 资产版本号，用于按需加载与版本化分发 */
  version: string;
  provider: string;
  createdAt: string;
}

/** 性格档案卡（说明书 6.2 核心机制） */
export interface PersonalityCard {
  species: string;
  /** 2-3 个核心性格 */
  traits: string[];
  /** 说话节奏 */
  speechRhythm: string;
  /** 2-3 个专属用语 */
  catchphrases: string[];
  /** 喜好话题 */
  likes: string[];
  /** 回避话题 */
  dislikes: string[];
  /** 记忆锚点 */
  memoryAnchors: string[];
  /** 音色预设 */
  voiceProfile: 'lazy-bass' | 'lively-treble' | 'soft' | 'husky';
}

export type PetStage = 'egg' | 'hatching' | 'young' | 'adult';

export interface Pet {
  id: string;
  ownerId: string;
  name: string;
  species: SpeciesId;
  /** 主人给它起的称呼 */
  callName: string;
  vector: PreferenceVector;
  personality: PersonalityCard;
  asset: PetAssetMaster;
  /** 好感度（不可购买，说明书 11 价值观红线） */
  affection: number;
  /** 亲密度等级 */
  level: number;
  /** 当前等级区间内的经验进度 0~1 */
  levelProgress: number;
  /** 想念值：长时间不登录会下降（说明书 3.1-2） */
  longing: number;
  /** 小毛病，让它更好玩（说明书 3.1-4） */
  quirks: string[];
  stage: PetStage;
  /** 已解锁服装 */
  unlockedOutfits: string[];
  /** 已解锁场景 */
  unlockedScenes: string[];
  equippedOutfit: string | null;
  activeScene: string;
  /** 当前情绪，驱动情绪气泡 */
  mood: PetMood;
  createdAt: string;
  lastInteractionAt: string;
  lastVisitAt: string;
}

export type PetMood =
  | 'happy' | 'sleepy' | 'hungry' | 'dirty' | 'playful' | 'lonely' | 'proud' | 'shy';

/* ============================================================
 * 三、好感度体系（说明书 6.1）
 * ============================================================ */

export type AffectionAction =
  | 'feed'        // 每日喂饭，每日 2 次
  | 'bathe'       // 洗澡清洁，每日 1 次
  | 'play'        // 陪玩互动，每日 3 次（每种玩具单独计数）
  | 'chat'        // 真心话对话，每日上限
  | 'checkin'     // 旅行打卡，每地点一次
  | 'streak'      // 连续陪伴，按连续天数
  | 'reunion';    // 重逢补偿

export interface AffectionRule {
  action: AffectionAction;
  label: string;
  /** 单次好感度 */
  gain: number;
  /** 每日次数上限 */
  dailyLimit: number;
  /** 递减衰减系数：超出后收益按次衰减 */
  decayAfterLimit: number;
  description: string;
  emoji: string;
}

/** 每日收益上限（防刷，说明书 6.1） */
export const DAILY_AFFECTION_CAP = 120;

/** 连击里程碑（第 3、7、14、30 天） */
export const STREAK_MILESTONES: { day: number; gain: number; reward: string }[] = [
  { day: 3, gain: 30, reward: '专属撒娇动画' },
  { day: 7, gain: 60, reward: '限定围巾' },
  { day: 14, gain: 120, reward: '老书房场景' },
  { day: 30, gain: 260, reward: '纪念相框' },
];

export interface AffectionLogEntry {
  id: string;
  petId: string;
  action: AffectionAction;
  gain: number;
  /** 被上限截断的部分 */
  cappedGain: number;
  createdAt: string;
  note?: string;
}

/** 好感度兑换项（消耗方式，说明书 6.1） */
export type ShopItemKind = 'outfit' | 'scene' | 'prop' | 'extra-interaction';
export type ShopItemTier = 'starter' | 'seasonal' | 'limited' | 'collab';

export interface ShopItem {
  id: string;
  kind: ShopItemKind;
  tier: ShopItemTier;
  name: string;
  description: string;
  /** 好感度价格（不可用现实货币购买） */
  price: number;
  /** 是否只能靠好感度兑换，禁止直购 */
  affectionOnly: boolean;
  emoji: string;
  previewColor: string;
  /** 订阅权益是否可提前解锁 */
  subscriberEarlyAccess?: boolean;
}

/* ============================================================
 * 四、真心话小屋（说明书 6.2）
 * ============================================================ */

/** 对话能力分层：即时层 / 场景层 / 自由层 / 记忆层 */
export type ChatLayer = 'instant' | 'scene' | 'free' | 'memory';

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'pet';
  content: string;
  layer: ChatLayer;
  /** 是否走了大模型（用于成本观测） */
  fromModel: boolean;
  /** 表情/口型驱动提示 */
  expression?: string;
  /** 语音输出地址（接入 TTS 后非空） */
  audioUrl?: string | null;
  /** 命中的本地预设池 key */
  presetKey?: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  petId: string;
  userId: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 记忆条目（说明书 6.2 记忆系统） */
export interface MemoryEntry {
  id: string;
  petId: string;
  kind: 'summary' | 'key-event';
  content: string;
  /** 重要性，超出容量上限时按此淘汰 */
  importance: number;
  /** 触发主动提及的场景标签 */
  tags: string[];
  happenedAt: string;
  createdAt: string;
}

/** 内容安全：前置过滤话题（说明书 3.4-3） */
export type SafetyCategory =
  | 'self-awareness'  // 「你是 AI 吗」
  | 'medical'         // 医疗建议
  | 'adult'
  | 'political'
  | 'self-harm';      // 高风险，触发现实支持渠道提示

export interface SafetyVerdict {
  blocked: boolean;
  category?: SafetyCategory;
  /** 用符合人设的方式温柔带过 */
  deflection?: string;
  /** 是否展示现实支持渠道 */
  showSupportResources: boolean;
}

/* ============================================================
 * 五、旅行模块（说明书 7.x）
 * ============================================================ */

export type DestinationScene = 'mountain' | 'seaside' | 'city' | 'foreign-alley' | 'snow' | 'desert';

export interface Destination {
  id: string;
  name: string;
  region: string;
  country: string;
  lat: number;
  lng: number;
  scene: DestinationScene;
  /** 城市剧情副本 */
  storyTitle: string;
  storyChapters: StoryChapter[];
  /** 城市限定皮肤（说明书 7.2-⑧） */
  exclusiveSkin?: { id: string; name: string; emoji: string };
  /** 旅行盲盒纪念品池（说明书 7.2-⑥） */
  souvenirPool: { id: string; name: string; emoji: string; rarity: 'common' | 'rare' | 'epic' }[];
  emoji: string;
}

export interface StoryChapter {
  index: number;
  title: string;
  /** 打卡后解锁的剧情文本 */
  content: string;
}

/** 天气快照（出行前播报 / 手账记录） */
export interface WeatherSnapshot {
  condition: string;
  /** 摄氏度 */
  temperature: number;
  advice: string;
  emoji: string;
}

export interface WishlistItem {
  id: string;
  petId: string;
  destinationId: string;
  destinationName: string;
  /** 宠物用第一人称说出心愿 */
  petQuote: string;
  /** 解锁奖励描述 */
  reward: string;
  status: 'wishing' | 'unlocked';
  createdAt: string;
  unlockedAt?: string;
}

export interface Checkin {
  id: string;
  petId: string;
  userId: string;
  destinationId: string;
  destinationName: string;
  /** 用户上传的实景照片（可为空 → 使用合成图） */
  photoUrl?: string | null;
  /** 宠物出镜的合成图 */
  composedPhotoUrl?: string;
  /** 宠物视角文案（说明书 7.2-⑦） */
  petCaption: string;
  /** 是否解锁了限定皮肤/纪念品 */
  unlockedSkinId?: string | null;
  souvenirId?: string | null;
  /** 旅行盲盒结果 */
  blindBox?: { name: string; emoji: string; rarity: string } | null;
  /** 时光机：上次到访记录（说明书 7.2-⑨） */
  revisitMemory?: string | null;
  visitedAt: string;
  lat?: number;
  lng?: number;
}

export interface Badge {
  id: string;
  petId: string;
  destinationId: string;
  name: string;
  emoji: string;
  unlocked: boolean;
  unlockedAt?: string;
  /** 累计到 3 个城市解锁完整旅途故事（说明书 7.2-②） */
  requiredCities?: number;
}

/* ============================================================
 * 六、手账 / 明信片（说明书 7.3）
 * ============================================================ */

export type JournalTemplate = 'warm-paper' | 'polaroid' | 'magazine' | 'minimal';

export interface JournalEntry {
  id: string;
  petId: string;
  checkinId: string | null;
  title: string;
  /** 宠物口吻的正文，由文案引擎生成 */
  body: string;
  /** 排版模板 */
  template: JournalTemplate;
  blocks: JournalBlock[];
  destinationName: string;
  tags: string[];
  createdAt: string;
}

export type JournalBlock =
  | { type: 'photo'; url: string; caption: string; petInFrame: boolean }
  | { type: 'text'; content: string }
  | { type: 'quote'; content: string; author: string }
  | { type: 'badge'; badgeId: string; label: string; emoji: string };

export interface Postcard {
  id: string;
  petId: string;
  checkinId: string | null;
  /** 宠物第一人称文案 */
  text: string;
  /** 收件人称呼 */
  to: string;
  /** 手写体签名 */
  signature: string;
  scene: DestinationScene;
  template: 'postcard-classic' | 'instagram-grid' | 'wechat-moments';
  createdAt: string;
}

/* ============================================================
 * 七、时光胶囊（说明书 3.4-1 / 八）
 * ============================================================ */

export type CapsuleStage = 'uploaded' | 'analyzing' | 'restoring' | 'done' | 'failed';

export interface CapsuleProject {
  id: string;
  userId: string;
  /** 旧照地址 */
  photoUrl: string;
  petName: string;
  /** 主人想说的话 */
  letterTo: string;
  stage: CapsuleStage;
  progress: number;
  /** 复原出的形象（毛绒化复刻，非一模一样） */
  restoredImageUrl?: string;
  createdAt: string;
  updatedAt: string;
}

/* ============================================================
 * 八、云代养 / 双宠同行（说明书 7.2-④⑤，第三阶段）
 * ============================================================ */

export interface FosterRequest {
  id: string;
  petId: string;
  ownerId: string;
  friendName: string;
  /** 代养天数 */
  days: number;
  status: 'pending' | 'active' | 'completed';
  /** 好友代养期间的互动次数 */
  friendInteractions: number;
  /** 回来后的台词 */
  returnLine?: string;
  createdAt: string;
}

/* ============================================================
 * 九、用户与订阅（说明书 十一）
 * ============================================================ */

export type SubscriptionTier = 'free' | 'plus' | 'pro';

export interface UserProfile {
  id: string;
  nickname: string;
  avatarEmoji: string;
  tier: SubscriptionTier;
  /** 宠物位上限 */
  petSlots: number;
  streakDays: number;
  /** 连续陪伴里程碑 */
  claimedMilestones: number[];
  /** 是否开启未成年人消费限额（说明书 2.5-7） */
  minorGuardEnabled: boolean;
  monthlySpendLimit: number;
  createdAt: string;
}

export interface SubscriptionPlan {
  tier: SubscriptionTier;
  name: string;
  priceMonthly: number;
  priceYearly: number;
  highlights: string[];
  /** 保证完整体验（说明书 十一 免费层） */
  guaranteedExperience: boolean;
}

/* ============================================================
 * 十、统一 API 封装
 * ============================================================ */

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    /** 是否因为外部服务未配置而回落 Mock */
    fallback?: boolean;
    detail?: unknown;
  };
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/** 供前端展示「哪些能力还在 Mock 模式」 */
export interface IntegrationStatus {
  key: string;
  label: string;
  category: 'chat' | 'threed' | 'rigging' | 'tts' | 'asr' | 'image' | 'payment' | 'storage' | 'push' | 'analytics';
  configured: boolean;
  provider: string;
  envKeys: string[];
  docsUrl: string;
  note: string;
}
