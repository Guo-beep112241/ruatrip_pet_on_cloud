import { useEffect, useState } from 'react';

/** 响应式断点：桌面端 = md(768px) 以上 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export const useIsDesktop = (): boolean => useMediaQuery('(min-width: 768px)');

/** 本地时间问候语 */
export function greetingByHour(): string {
  const h = new Date().getHours();
  if (h < 6) return '还没睡';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  if (h < 22) return '晚上好';
  return '夜深了';
}


/* ============================================================
 * 运行环境能力探测（审计 F9：微信内置浏览器兼容）
 * ============================================================ */

export interface Capabilities {
  /** 微信内置浏览器 */
  isWeChat: boolean;
  /** 支持按住说话（浏览器语音识别） */
  speechRecognition: boolean;
  /** 支持语音合成 */
  speechSynthesis: boolean;
  /** 支持定位（需要 HTTPS） */
  geolocation: boolean;
  /** 支持调用摄像头拍照 */
  cameraCapture: boolean;
  /** 支持 Web Push（微信内完全不支持） */
  webPush: boolean;
  /** 是否 HTTPS（定位、麦克风、摄像头都要求安全上下文） */
  secureContext: boolean;
}

/**
 * 探测当前环境的能力。
 *
 * 为什么需要：微信内置浏览器是国内的主要入口，但它
 *   - 没有 SpeechRecognition（按住说话必须降级为文字输入或服务端 ASR）
 *   - 没有 Notification/Web Push
 *   - 定位与摄像头需要 HTTPS 且常被拒绝
 * 与其让功能静默失效，不如提前探测并给出明确的降级提示。
 */
export function detectCapabilities(): Capabilities {
  if (typeof window === 'undefined') {
    return {
      isWeChat: false,
      speechRecognition: false,
      speechSynthesis: false,
      geolocation: false,
      cameraCapture: false,
      webPush: false,
      secureContext: false,
    };
  }
  const ua = navigator.userAgent;
  const w = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return {
    isWeChat: /MicroMessenger/i.test(ua),
    speechRecognition: Boolean(w.SpeechRecognition || w.webkitSpeechRecognition),
    speechSynthesis: 'speechSynthesis' in window,
    geolocation: 'geolocation' in navigator,
    // 有 capture 属性的 input 即可调用摄像头；微信内一般可用
    cameraCapture: 'capture' in document.createElement('input'),
    webPush: 'serviceWorker' in navigator && 'PushManager' in window,
    secureContext: window.isSecureContext,
  };
}

/** 给定能力，给出「哪些功能会降级」的可读说明，供设置页展示与自查 */
export function capabilityNotes(c: Capabilities): { feature: string; status: string; fallback: string }[] {
  return [
    {
      feature: '按住说话',
      status: c.speechRecognition ? '可用' : '不可用',
      fallback: c.speechRecognition ? '浏览器识别' : '改为文字输入（或配置服务端 ASR）',
    },
    {
      feature: '宠物语音朗读',
      status: c.speechSynthesis ? '可用' : '不可用',
      fallback: c.speechSynthesis ? '系统语音' : '仅文字（或配置云 TTS）',
    },
    {
      feature: '定位打卡',
      status: c.geolocation && c.secureContext ? '可用' : '受限',
      fallback: c.secureContext ? '手动选择目的地' : '需要 HTTPS，改为手动选择',
    },
    {
      feature: '拍照打卡',
      status: c.cameraCapture ? '可用' : '受限',
      fallback: c.cameraCapture ? '直接调用相机' : '从相册选择',
    },
    {
      feature: '离线提醒',
      status: c.webPush ? '可用' : '不可用',
      fallback: c.webPush ? '浏览器推送' : '应用内通知（微信内不支持系统推送）',
    },
  ];
}
