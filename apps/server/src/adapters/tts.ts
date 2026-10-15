/**
 * 语音层适配（说明书 4.5 语音层 / 6.2 语音对话）
 *  - TTS：MiniMax（中文情感表现佳）→ ElevenLabs（准确率与速度）→ 浏览器 Web Speech 兜底
 *  - ASR：前端优先用 Web Speech Recognition（零成本）；服务端 ASR 通道用于方言/口音容错场景
 */
import { config } from '../config.ts';
import { logAdapter, toIntegrationStatus, type ProviderMeta } from './types.ts';

export interface TtsRequest {
  text: string;
  voiceProfile: 'lazy-bass' | 'lively-treble' | 'soft' | 'husky';
  /** 情绪，用于调整语速与语调 */
  emotion?: string;
}

export interface TtsResult {
  audioUrl: string | null;
  /** 未接入 TTS 时，前端应使用浏览器语音合成兜底 */
  useBrowserTts: boolean;
  provider: string;
  live: boolean;
  durationMsEstimate: number;
}

export interface TtsProvider {
  readonly meta: ProviderMeta;
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

/** 音色档案：把宠物性格映射到具体音色参数 */
export const VOICE_PRESETS: Record<
  TtsRequest['voiceProfile'],
  { label: string; speed: number; pitch: number; minimaxVoice: string; elevenVoiceId: string }
> = {
  'lazy-bass': { label: '慵懒低音', speed: 0.86, pitch: 0.85, minimaxVoice: 'male-qn-qingse', elevenVoiceId: 'onwK4e9ZLuTAKqWW03F9' },
  'lively-treble': { label: '活泼高音', speed: 1.18, pitch: 1.25, minimaxVoice: 'female-shaonv', elevenVoiceId: 'EXAVITQu4vr4xnSDxMaL' },
  soft: { label: '软糯', speed: 0.95, pitch: 1.1, minimaxVoice: 'female-yujie', elevenVoiceId: 'Xb7hH8MSUJpSbSDYk0k2' },
  husky: { label: '沙哑', speed: 0.9, pitch: 0.92, minimaxVoice: 'male-qn-jingying', elevenVoiceId: 'TX3LPaxmHKxFdv7VOQHJ' },
};

class MiniMaxTtsProvider implements TtsProvider {
  readonly meta: ProviderMeta = {
    capability: 'tts',
    id: 'minimax',
    label: 'MiniMax 语音合成（宠物专属音色）',
    envKeys: ['MINIMAX_API_KEY', 'MINIMAX_GROUP_ID'],
    docsUrl: 'https://www.minimax.io/platform/document/T2A%20V2',
    note: '中文情绪表现好，按性格分配音色（慵懒低音/活泼高音/软糯/沙哑）。',
    configured: Boolean(config.minimax.apiKey),
  };

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const preset = VOICE_PRESETS[req.voiceProfile];
    const res = await fetch(`${config.minimax.baseUrl}/t2a_v2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.minimax.apiKey}` },
      body: JSON.stringify({
        model: 'speech-02-hd',
        text: req.text,
        stream: false,
        voice_setting: { voice_id: preset.minimaxVoice, speed: preset.speed, pitch: preset.pitch, vol: 1 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3' },
      }),
    });
    if (!res.ok) throw new Error(`minimax tts ${res.status}`);
    const json = (await res.json()) as { data?: { audio?: string } };
    const hex = json.data?.audio;
    if (!hex) throw new Error('minimax tts: empty audio');
    // MiniMax 返回 hex 编码音频，转成 data URL 直接给前端播放
    const buffer = Buffer.from(hex, 'hex');
    return {
      audioUrl: `data:audio/mpeg;base64,${buffer.toString('base64')}`,
      useBrowserTts: false,
      provider: 'minimax',
      live: true,
      durationMsEstimate: Math.round((req.text.length / 4.2) * 1000),
    };
  }
}

class ElevenLabsTtsProvider implements TtsProvider {
  readonly meta: ProviderMeta = {
    capability: 'tts',
    id: 'elevenlabs',
    label: 'ElevenLabs 语音合成（备选通道）',
    envKeys: ['ELEVENLABS_API_KEY'],
    docsUrl: 'https://elevenlabs.io/docs/api-reference/text-to-speech',
    note: '准确率与速度优秀，适合作为 MiniMax 的备份链路。',
    configured: Boolean(config.elevenlabs.apiKey),
  };

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const preset = VOICE_PRESETS[req.voiceProfile];
    const res = await fetch(`${config.elevenlabs.baseUrl}/text-to-speech/${preset.elevenVoiceId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': config.elevenlabs.apiKey },
      body: JSON.stringify({ text: req.text, model_id: 'eleven_multilingual_v2' }),
    });
    if (!res.ok) throw new Error(`elevenlabs tts ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      audioUrl: `data:audio/mpeg;base64,${buf.toString('base64')}`,
      useBrowserTts: false,
      provider: 'elevenlabs',
      live: true,
      durationMsEstimate: Math.round((req.text.length / 4.2) * 1000),
    };
  }
}

class BrowserTtsFallback implements TtsProvider {
  readonly meta: ProviderMeta = {
    capability: 'tts',
    id: 'browser-web-speech',
    label: '浏览器语音合成兜底（Web Speech API）',
    envKeys: [],
    docsUrl: 'https://developer.mozilla.org/docs/Web/API/SpeechSynthesis',
    note: '未接入云 TTS 时，前端用系统语音朗读宠物回复；音色不如云服务，但链路完整。',
    configured: true,
  };

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    logAdapter('tts fallback → browser');
    return {
      audioUrl: null,
      useBrowserTts: true,
      provider: 'browser-web-speech',
      live: false,
      durationMsEstimate: Math.round((req.text.length / 4.2) * 1000),
    };
  }
}

const providers: TtsProvider[] = [new MiniMaxTtsProvider(), new ElevenLabsTtsProvider(), new BrowserTtsFallback()];
export const ttsProviders = () => providers;
export function activeTtsProvider(): TtsProvider {
  return providers.find((p) => p.meta.configured) ?? providers[providers.length - 1]!;
}
export const ttsIntegrationStatus = () => providers.map((p) => toIntegrationStatus(p.meta));

/* ------------------------------------------------------------------ */
/* ASR 通道（服务端，可选）                                              */
/* ------------------------------------------------------------------ */
export const asrMeta: ProviderMeta = {
  capability: 'asr',
  id: 'server-asr',
  label: '语音识别（按住说话 · 服务端通道）',
  envKeys: ['ASR_API_KEY', 'ASR_BASE_URL', 'ASR_MODEL'],
  docsUrl: '/docs/API-INTEGRATION.md',
  note: '前端默认使用浏览器 SpeechRecognition（零成本、低延迟）；配置服务端通道是为了方言与口音容错。',
  configured: Boolean(config.asr.apiKey && config.asr.baseUrl),
};
export const asrIntegrationStatus = () => [toIntegrationStatus(asrMeta)];
