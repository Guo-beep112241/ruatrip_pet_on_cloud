/**
 * 全局状态（zustand）。
 * 只保存「跨页面共享」的状态：用户、宠物、接入清单、引导步骤、轻提示。
 */
import { create } from 'zustand';
import type {
  BootstrapResponse,
  ChatMessage,
  Conversation,
  GenerationJob,
  IntegrationStatus,
  MemoryEntry,
  Pet,
  PetMood,
  PreferenceAnswers,
  SubmitSurveyResponse,
  UserProfile,
} from '../api/types';
import { api, withQuery } from '../api/client';

export type Screen = 'onboarding' | 'cabin' | 'hut' | 'travel' | 'checkin' | 'capsule' | 'profile';

export interface Toast {
  id: string;
  text: string;
  tone: 'warm' | 'warning' | 'plain';
  emoji?: string;
}

interface AppState {
  ready: boolean;
  loading: boolean;
  error: string | null;

  user: UserProfile | null;
  pet: Pet | null;
  integration: IntegrationStatus[];
  onboarding: { step: string; done: boolean }[];
  scenes: BootstrapResponse['scenes'];

  screen: Screen;

  /** 生成任务（孵化动效） */
  job: GenerationJob | null;
  incubatingLines: string[];
  surveyDraft: PreferenceAnswers;
  surveyResult: SubmitSurveyResponse | null;

  /** 小屋 */
  conversation: Conversation | null;
  messages: ChatMessage[];
  memories: MemoryEntry[];
  thinking: boolean;

  toasts: Toast[];
  /** 抚摸/互动的临时反馈（驱动 Q 弹动画与情绪气泡） */
  reaction: { text: string; emoji: string; animation: string; ms: number; key: number } | null;
  atmosphere: number;
}

interface AppActions {
  bootstrap: () => Promise<void>;
  navigate: (screen: Screen) => void;
  setSurveyAnswer: (dimension: string, values: string[]) => void;
  submitSurvey: () => Promise<SubmitSurveyResponse | null>;
  createPet: (name: string, callName?: string) => Promise<void>;
  pollGeneration: () => Promise<void>;
  finishOnboarding: () => void;

  interact: (action: 'feed' | 'bathe' | 'play', toyId?: string) => Promise<void>;
  touchPet: (part: 'head' | 'chin' | 'tail', gesture?: 'tap' | 'long' | 'double') => Promise<void>;
  equip: (patch: { outfitId?: string | null; sceneId?: string }) => Promise<void>;
  rename: (name: string, callName?: string) => Promise<void>;
  redeem: (itemId: string) => Promise<boolean>;

  loadChat: () => Promise<void>;
  sendChat: (text: string, layer?: string) => Promise<void>;
  speak: (text: string) => Promise<void>;

  refreshProfile: () => Promise<void>;
  subscribe: (tier: 'free' | 'plus' | 'pro', cycle: 'monthly' | 'yearly') => Promise<void>;
  updateUser: (patch: Partial<UserProfile>) => Promise<void>;

  pushToast: (text: string, tone?: Toast['tone'], emoji?: string) => void;
  dismissToast: (id: string) => void;
  setReaction: (reaction: { text: string; emoji: string; animation: string; ms: number } | null) => void;
  clearError: () => void;
}

const initialDraft: PreferenceAnswers = {};

export const useApp = create<AppState & AppActions>((set, get) => ({
  ready: false,
  loading: false,
  error: null,
  user: null,
  pet: null,
  integration: [],
  onboarding: [],
  scenes: [],
  screen: 'cabin',
  job: null,
  incubatingLines: [],
  surveyDraft: initialDraft,
  surveyResult: null,
  conversation: null,
  messages: [],
  memories: [],
  thinking: false,
  toasts: [],
  reaction: null,
  atmosphere: 1,

  async bootstrap() {
    set({ loading: true, error: null });
    try {
      const data = await api.get<BootstrapResponse>('/bootstrap');
      const hasPet = Boolean(data.pet);
      set({
        ready: true,
        loading: false,
        user: data.user,
        pet: data.pet,
        integration: data.integration,
        onboarding: data.onboarding,
        scenes: data.scenes,
        screen: hasPet ? (get().screen === 'onboarding' ? 'cabin' : get().screen) : 'onboarding',
      });
      if (hasPet) {
        const generationDone = data.pet?.stage !== 'egg';
        if (!generationDone) await get().pollGeneration();
      }
    } catch (error) {
      set({
        ready: true,
        loading: false,
        error: error instanceof Error ? error.message : '初始化失败',
      });
    }
  },

  navigate(screen) {
    set({ screen });
  },

  setSurveyAnswer(dimension, values) {
    set((state) => ({ surveyDraft: { ...state.surveyDraft, [dimension]: values } }));
  },

  async submitSurvey() {
    set({ loading: true });
    try {
      const result = await api.post<SubmitSurveyResponse>('/survey', { answers: get().surveyDraft });
      set({ surveyResult: result, loading: false });
      return result;
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '提交失败' });
      return null;
    }
  },

  async createPet(name, callName) {
    set({ loading: true });
    try {
      const data = await api.post<{ pet: Pet; job: GenerationJob }>('/pet', {
        answers: get().surveyDraft,
        name,
        ...(callName ? { callName } : {}),
      });
      set({ pet: data.pet, job: data.job, loading: false, screen: 'cabin' });
      void get().pollGeneration();
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '生成失败' });
    }
  },

  async pollGeneration() {
    const job = get().job ?? (get().pet ? await api.get<{ job: GenerationJob; pet: Pet; incubatingLines: string[] }>(
      `/pet/generation/${get().pet!.id}`,
    ).catch(() => null) : null);
    if (!job) return;
    const jobId = (job as GenerationJob).id;
    const tick = async (): Promise<void> => {
      try {
        const data = await api.get<{ job: GenerationJob; pet: Pet; incubatingLines: string[] }>(
          `/pet/generation/${jobId}`,
        );
        set({ job: data.job, pet: data.pet, incubatingLines: data.incubatingLines });
        if (data.job.stage === 'ready' || data.job.stage === 'fallback_used' || data.job.stage === 'failed') {
          get().pushToast('它出来了。去打个招呼吧。', 'warm', '🐾');
          void get().loadChat();
          return;
        }
      } catch {
        /* 轮询失败不打断体验 */
      }
      setTimeout(() => void tick(), 900);
    };
    await tick();
  },

  finishOnboarding() {
    set({ screen: 'cabin', onboarding: get().onboarding.map((s) => ({ ...s, done: true })) });
  },

  async interact(action, toyId) {
    const pet = get().pet;
    if (!pet) return;
    try {
      const data = await api.post<{
        pet: Pet;
        gain: number;
        cappedGain: number;
        reaction: string;
        reactionEmoji: string;
        animation: string;
        animationMs: number;
        streakReward: { gain: number; reward: string } | null;
        levelUp: boolean;
      }>('/interact', { petId: pet.id, action, ...(toyId ? { toyId } : {}) });
      set({
        pet: data.pet,
        reaction: {
          text: data.reaction,
          emoji: data.reactionEmoji,
          animation: data.animation,
          ms: data.animationMs,
          key: Date.now(),
        },
      });
      if (data.gain > 0) {
        get().pushToast(`好感度 +${data.gain}`, 'warm', data.reactionEmoji);
      } else if (data.cappedGain > 0) {
        get().pushToast('今天的好感度到上限了，超出部分不再计入。', 'plain', '🌙');
      }
      if (data.levelUp) get().pushToast(`亲密度升到 Lv.${data.pet.level} 了`, 'warm', '✨');
      if (data.streakReward) {
        get().pushToast(`连续陪伴奖励：${data.streakReward.reward}`, 'warm', '🔥');
      }
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : '互动失败', 'warning', '😿');
    }
  },

  async touchPet(part, gesture = 'tap') {
    const pet = get().pet;
    if (!pet) return;
    try {
      const data = await api.post<{ pet: Pet; reaction: string; animation: string; animationMs: number }>(
        '/interact/pet',
        { petId: pet.id, part, gesture },
      );
      set({
        pet: data.pet,
        reaction: {
          text: data.reaction,
          emoji: gesture === 'double' ? '💗' : '🫶',
          animation: data.animation,
          ms: data.animationMs,
          key: Date.now(),
        },
      });
    } catch {
      /* 抚摸是纯情绪反馈，失败静默 */
    }
  },

  async equip(patch) {
    const pet = get().pet;
    if (!pet) return;
    try {
      const data = await api.patch<{ pet: Pet }>('/pet', { petId: pet.id, ...patch });
      set({ pet: data.pet });
      get().pushToast('换好了。', 'warm', '✨');
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : '换装失败', 'warning', '🧣');
    }
  },

  async rename(name, callName) {
    const pet = get().pet;
    if (!pet) return;
    const data = await api.patch<{ pet: Pet }>('/pet', { petId: pet.id, name, callName });
    set({ pet: data.pet });
  },

  async redeem(itemId) {
    const pet = get().pet;
    if (!pet) return false;
    try {
      const data = await api.post<{ pet: Pet; spent: number; message: string }>('/shop/redeem', {
        petId: pet.id,
        itemId,
      });
      set({ pet: data.pet });
      get().pushToast(data.message, 'warm', '🎁');
      return true;
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : '兑换失败', 'warning', '🪙');
      return false;
    }
  },

  async loadChat() {
    const pet = get().pet;
    if (!pet) return;
    try {
      const data = await api.get<{
        conversation: Conversation;
        messages: ChatMessage[];
        memories: MemoryEntry[];
      }>(withQuery('/chat', { petId: pet.id }));
      set({ conversation: data.conversation, messages: data.messages, memories: data.memories });
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : '小屋打不开', 'warning', '🚪');
    }
  },

  async sendChat(text, layer = 'auto') {
    const pet = get().pet;
    if (!pet || !text.trim()) return;
    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      conversationId: get().conversation?.id ?? 'local',
      petId: pet.id,
      role: 'user',
      content: text,
      layer: 'free',
      fromModel: false,
      createdAt: new Date().toISOString(),
    };
    set({ messages: [...get().messages, optimistic], thinking: true });
    try {
      const data = await api.post<{
        conversation: Conversation;
        userMessage: ChatMessage;
        petMessage: ChatMessage;
        affectionGain: number;
        degraded: boolean;
        memories: MemoryEntry[];
      }>('/chat', {
        petId: pet.id,
        ...(get().conversation ? { conversationId: get().conversation!.id } : {}),
        text,
        layer,
      });
      set({
        conversation: data.conversation,
        messages: [...get().messages.filter((m) => m.id !== optimistic.id), data.userMessage, data.petMessage],
        memories: data.memories,
        thinking: false,
      });
    } catch (error) {
      set({ thinking: false });
      get().pushToast(error instanceof Error ? error.message : '它没听清', 'warning', '😿');
    }
  },

  async speak(text) {
    const pet = get().pet;
    if (!pet) return;
    try {
      const data = await api.post<{ audioUrl: string | null; useBrowserTts: boolean }>('/tts', {
        petId: pet.id,
        text,
      });
      if (data.audioUrl) {
        const audio = new Audio(data.audioUrl);
        void audio.play();
        return;
      }
      // 未接入云 TTS → 浏览器语音合成兜底
      if (data.useBrowserTts && 'speechSynthesis' in window) {
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'zh-CN';
        utter.rate = pet.personality.voiceProfile === 'lively-treble' ? 1.15 : 0.92;
        utter.pitch = pet.personality.voiceProfile === 'lazy-bass' ? 0.85 : 1.1;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utter);
      }
    } catch {
      get().pushToast('语音通道暂时不可用', 'plain', '🔇');
    }
  },

  async refreshProfile() {
    try {
      const data = await api.get<{
        user: UserProfile;
        pet: Pet | null;
        integration: IntegrationStatus[];
      }>('/profile');
      set({ user: data.user, pet: data.pet, integration: data.integration });
    } catch {
      /* noop */
    }
  },

  async subscribe(tier, cycle) {
    try {
      const data = await api.post<{ user: UserProfile; simulated: boolean }>('/subscribe', { tier, cycle });
      set({ user: data.user });
      get().pushToast('已切换档位（当前为模拟开通，未接支付通道）', 'plain', '🧾');
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : '开通失败', 'warning', '🧾');
    }
  },

  async updateUser(patch) {
    try {
      const data = await api.patch<{ user: UserProfile }>('/profile', patch);
      set({ user: data.user });
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : '保存失败', 'warning', '⚙️');
    }
  },

  pushToast(text, tone = 'warm', emoji) {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    set({ toasts: [...get().toasts, { id, text, tone, ...(emoji ? { emoji } : {}) }] });
    setTimeout(() => get().dismissToast(id), 3600);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  setReaction(reaction) {
    set({ reaction: reaction ? { ...reaction, key: Date.now() } : null });
  },
  clearError() {
    set({ error: null });
  },
}));

/** 情绪/心情派生（用 shared 的口径，保证与后端一致） */
export function moodLabel(mood: PetMood): { label: string; emoji: string } {
  const map: Record<PetMood, { label: string; emoji: string }> = {
    happy: { label: '满足', emoji: '😊' },
    sleepy: { label: '困倦', emoji: '😴' },
    hungry: { label: '饿了', emoji: '🍚' },
    dirty: { label: '想洗澡', emoji: '🫧' },
    playful: { label: '想玩', emoji: '🎾' },
    lonely: { label: '想你了', emoji: '🥺' },
    proud: { label: '得意', emoji: '😼' },
    shy: { label: '害羞', emoji: '😳' },
  };
  return map[mood] ?? map.happy;
}
