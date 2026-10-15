/**
 * API 请求/响应类型（前后端共用契约）
 */
import type {
  AffectionAction,
  AffectionLogEntry,
  Badge,
  CapsuleProject,
  ChatLayer,
  ChatMessage,
  Checkin,
  Conversation,
  Destination,
  FosterRequest,
  GenerationJob,
  IntegrationStatus,
  JournalEntry,
  JournalTemplate,
  MemoryEntry,
  Pet,
  PetMood,
  Postcard,
  PreferenceAnswers,
  PreferenceQuestion,
  ProfileInference,
  ShopItem,
  SubscriptionTier,
  UserProfile,
  WishlistItem,
} from './index.ts';

export interface BootstrapResponse {
  user: UserProfile;
  pet: Pet | null;
  integration: IntegrationStatus[];
  scenes: { id: string; name: string; gradient: string; lightAngle: number; ambient: string }[];
  /** 首日引导步骤完成情况 */
  onboarding: { step: string; done: boolean }[];
}

export interface SurveyResponse {
  questions: PreferenceQuestion[];
  savedAnswers: PreferenceAnswers | null;
}

export interface SubmitSurveyRequest {
  answers: PreferenceAnswers;
}

export interface SubmitSurveyResponse {
  inference: ProfileInference;
  suggestedNames: string[];
  suggestedQuirks: string[];
  petDraft: {
    species: string;
    speciesEmoji: string;
    personalityPreview: { traits: string[]; speechRhythm: string; catchphrases: string[] };
    palette: string[];
    fur: string;
    bodySize: string;
  };
}

export interface CreatePetRequest {
  answers: PreferenceAnswers;
  name: string;
  callName?: string;
}

export interface CreatePetResponse {
  pet: Pet;
  job: GenerationJob;
}

export interface GenerationStatusResponse {
  job: GenerationJob;
  pet: Pet;
  /** 孵化过程中展示的文案流 */
  incubatingLines: string[];
}

export interface InteractRequest {
  petId: string;
  action: Extract<AffectionAction, 'feed' | 'bathe' | 'play'>;
  /** 陪玩时的玩具 id，用于单独计数 */
  toyId?: string;
}

export interface InteractResponse {
  pet: Pet;
  gain: number;
  cappedGain: number;
  /** 宠物即时反馈文案（即时层，零延迟） */
  reaction: string;
  reactionEmoji: string;
  /** 触发的动画 key */
  animation: string;
  animationMs: number;
  remainingToday: number;
  levelUp: boolean;
  streakReward: { gain: number; reward: string } | null;
  log: AffectionLogEntry;
}

export interface AffectionOverviewResponse {
  pet: Pet;
  todayGain: number;
  dailyCap: number;
  remainingByAction: Record<string, { used: number; limit: number; remaining: number }>;
  recent: AffectionLogEntry[];
  nextStreakMilestone: { day: number; reward: string; daysLeft: number } | null;
}

export interface ShopResponse {
  items: ShopItem[];
  affection: number;
  owned: string[];
}

export interface RedeemRequest {
  petId: string;
  itemId: string;
}

export interface RedeemResponse {
  pet: Pet;
  item: ShopItem;
  spent: number;
  message: string;
}

export interface ChatStartResponse {
  conversation: Conversation;
  messages: ChatMessage[];
  personality: Pet['personality'];
  /** 记忆回看（说明书 6.2 记忆层） */
  memories: MemoryEntry[];
}

export interface ChatSendRequest {
  petId: string;
  conversationId?: string;
  text: string;
  /** 强制分层：auto 时由服务端判定 */
  layer?: ChatLayer | 'auto';
  /** 语音输入转写结果标记 */
  viaVoice?: boolean;
}

export interface ChatSendResponse {
  conversation: Conversation;
  userMessage: ChatMessage;
  petMessage: ChatMessage;
  safety: { blocked: boolean; category?: string; showSupportResources: boolean };
  affectionGain: number;
  /** 本次是否调用大模型（成本观测） */
  modelUsed: boolean;
  /** 大模型不可用时的回落提示 */
  degraded: boolean;
  memories: MemoryEntry[];
}

export interface TtsRequest {
  petId: string;
  text: string;
}

export interface TtsResponse {
  audioUrl: string | null;
  /** 未接入 TTS 时前端用 Web Speech API 兜底 */
  useBrowserTts: boolean;
  voiceProfile: Pet['personality']['voiceProfile'];
  durationMsEstimate: number;
}

export interface TravelOverviewResponse {
  destinations: Destination[];
  wishlist: WishlistItem[];
  checkins: Checkin[];
  badges: Badge[];
  journals: JournalEntry[];
  postcards: Postcard[];
  /** 累计解锁城市数 → 完整旅途故事进度 */
  storyProgress: { unlockedCities: number; requiredCities: number; storyUnlocked: boolean; title: string };
}

export interface CheckinRequest {
  petId: string;
  destinationId: string;
  photoUrl?: string | null;
  lat?: number;
  lng?: number;
  note?: string;
}

export interface CheckinResponse {
  checkin: Checkin;
  pet: Pet;
  gain: number;
  storyChapter: { index: number; title: string; content: string } | null;
  badge: Badge | null;
  unlockedSkin: { id: string; name: string; emoji: string } | null;
  blindBox: { name: string; emoji: string; rarity: string } | null;
  /** 时光机：上次到访回忆（说明书 7.2-⑨） */
  revisitMemory: string | null;
  /** 自动生成的首篇/新一篇手账 */
  journal: JournalEntry;
  /** 宠物视角明信片文案 */
  postcard: Postcard;
  /** 出行前播报（说明书 7.2-⑩） */
  travelAlert: string;
}

export interface JournalListResponse {
  entries: JournalEntry[];
}

export interface GenerateJournalRequest {
  petId: string;
  checkinId?: string;
  template?: JournalTemplate;
  destinationName?: string;
  extraNote?: string;
}

export interface GenerateJournalResponse {
  entry: JournalEntry;
}

export interface GeneratePostcardRequest {
  petId: string;
  checkinId?: string;
  template?: Postcard['template'];
  to?: string;
}

export interface GeneratePostcardResponse {
  postcard: Postcard;
}

export interface MemoryListResponse {
  memories: MemoryEntry[];
  capacity: number;
}

export interface CapsuleListResponse {
  projects: CapsuleProject[];
}

export interface CapsuleCreateRequest {
  photoUrl: string;
  petName: string;
  letterTo?: string;
}

export interface CapsuleCreateResponse {
  project: CapsuleProject;
  /** 明确的预期管理文案（说明书 3.4-1） */
  disclaimer: string;
}

export interface CapsuleStatusResponse {
  project: CapsuleProject;
  disclaimer: string;
}

export interface FosterListResponse {
  requests: FosterRequest[];
  incomingLine: string | null;
}

export interface ProfileResponse {
  user: UserProfile;
  pet: Pet | null;
  stats: {
    daysTogether: number;
    checkinCount: number;
    journalCount: number;
    memoryCount: number;
    affectionTotal: number;
    cityCount: number;
  };
  integration: IntegrationStatus[];
}

export interface UpdateProfileRequest {
  nickname?: string;
  avatarEmoji?: string;
  minorGuardEnabled?: boolean;
  monthlySpendLimit?: number;
}

export interface SubscribeRequest {
  tier: SubscriptionTier;
  cycle: 'monthly' | 'yearly';
}

export interface SubscribeResponse {
  user: UserProfile;
  plan: { tier: SubscriptionTier; name: string; price: number };
  /** 是否走了真实支付：未接入时明确告知是模拟开通 */
  simulated: boolean;
}

export interface PetRenameRequest {
  petId: string;
  name: string;
  callName?: string;
}

export interface EquipRequest {
  petId: string;
  outfitId?: string | null;
  sceneId?: string;
}

export interface PetMoodResponse {
  petId: string;
  mood: PetMood;
  bubble: string;
  /** 侧边浮层的可用动作 */
  available: { id: string; label: string; emoji: string; locked: boolean; reason?: string }[];
}

/** 服务器推送到前端的「需要接入 API」清单 */
export interface IntegrationReportResponse {
  items: IntegrationStatus[];
  mode: 'mock-all' | 'partial' | 'live-all';
  summary: string;
}
