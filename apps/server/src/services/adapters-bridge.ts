/**
 * TTS 适配层的转出点。
 * （独立成一个文件是为了让 index.ts 的依赖图更清晰，也便于单测 mock。）
 */
export { activeTtsProvider, ttsIntegrationStatus, VOICE_PRESETS } from '../adapters/tts.ts';
export type { TtsProvider, TtsResult } from '../adapters/tts.ts';
