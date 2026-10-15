/**
 * 毛绒实木 (Plush x Birch Wood) 设计令牌 —— 唯一事实来源
 * 对应《RuaTrip 视觉设计规范》第 2 章 色彩系统。
 *
 * 这个文件由 scripts/build-tokens.mjs 读取，生成：
 *   - src/tokens.json            （供设计工具/文档消费）
 *   - apps/web/src/styles/tokens.css （CSS 变量）
 * 手工修改 token 请改这里，不要改生成物。
 */

export const color = {
  // 基础底色 60%：燕麦白，带轻微黄褐倾向
  'surface-base': 'hsl(36 33% 97%)',
  'surface-raised': 'hsl(38 42% 99%)',
  'surface-sunken': 'hsl(34 28% 93%)',
  'surface-overlay': 'hsl(30 25% 88%)',
  // 辅助材质 30%：暖栗棕
  'brand-secondary': 'hsl(20 35% 40%)',
  'brand-secondary-soft': 'hsl(22 30% 62%)',
  // 强调情绪 10%：珊瑚橘
  'brand-primary': 'hsl(10 100% 70%)',
  'brand-primary-deep': 'hsl(8 82% 58%)',
  // 文本层级：深棕木色，拒绝纯黑
  'text-primary': 'hsl(30 20% 24%)',
  'text-secondary': 'hsl(28 16% 42%)',
  'text-muted': 'hsl(28 14% 58%)',
  'text-inverse': 'hsl(38 42% 99%)',
  // 功能色（低饱和，避免科技感）
  'state-success': 'hsl(96 26% 52%)',
  'state-warning': 'hsl(38 78% 60%)',
  'state-danger': 'hsl(6 62% 60%)',
  // 边框
  'border-subtle': 'hsl(30 24% 84%)',
  'border-strong': 'hsl(24 22% 68%)',
} as const;

export const radius = {
  tight: '0.75rem',
  card: '1.5rem',   // 大圆角 24px
  large: '2rem',
  pill: '999px',
} as const;

/** Major Third (1.250) 音阶 */
export const fontSize = {
  'caption-sm': ['0.64rem', { lineHeight: '1.1rem', letterSpacing: '0.02em' }],
  caption: ['0.8rem', { lineHeight: '1.2rem' }],
  'body-sm': ['0.875rem', { lineHeight: '1.4rem' }],
  body: ['1rem', { lineHeight: '1.6rem' }],
  'body-lg': ['1.25rem', { lineHeight: '1.9rem' }],
  title: ['1.5625rem', { lineHeight: '2.2rem' }],
  'title-lg': ['1.953rem', { lineHeight: '2.6rem' }],
  display: ['2.441rem', { lineHeight: '3rem' }],
} as const;

export const spacing = {
  tight: '0.5rem',
  snug: '0.75rem',
  base: '1rem',
  comfortable: '1.5rem',
  loose: '2rem',
  roomy: '3rem',
} as const;

/** 毛绒软阴影：暖色、大扩散、零锐利高光 */
export const boxShadow = {
  plush: '0 10px 30px -12px hsl(24 40% 30% / 0.18), 0 2px 8px -4px hsl(24 40% 30% / 0.12)',
  'plush-hover': '0 22px 46px -16px hsl(24 40% 30% / 0.24), 0 4px 12px -6px hsl(24 40% 30% / 0.14)',
  'plush-inset': 'inset 0 2px 6px hsl(24 30% 40% / 0.10)',
  'glow-coral': '0 0 0 6px hsl(10 100% 70% / 0.18)',
} as const;

export const easing = {
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const;

export const animation = {
  /** 呼吸感：待机时宠物轻微起伏（说明书 3.3-2） */
  breathe: 'breathe 4s ease-in-out infinite',
  float: 'float 6s ease-in-out infinite',
  blink: 'blink 5.5s ease-in-out infinite',
  'tail-wag': 'tailWag 1.6s ease-in-out infinite',
  'pulse-soft': 'pulseSoft 2.6s ease-in-out infinite',
  'drop-in': 'dropIn 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both',
  shimmer: 'shimmer 2.4s linear infinite',
} as const;

export const keyframes = {
  breathe: {
    '0%, 100%': { transform: 'translateY(0) scale(1)' },
    '50%': { transform: 'translateY(-2.5%) scale(1.015)' },
  },
  float: {
    '0%, 100%': { transform: 'translateY(0)' },
    '50%': { transform: 'translateY(-8px)' },
  },
  blink: {
    '0%, 92%, 100%': { transform: 'scaleY(1)' },
    '95%': { transform: 'scaleY(0.08)' },
  },
  tailWag: {
    '0%, 100%': { transform: 'rotate(-8deg)' },
    '50%': { transform: 'rotate(10deg)' },
  },
  pulseSoft: {
    '0%, 100%': { opacity: '0.75' },
    '50%': { opacity: '1' },
  },
  dropIn: {
    '0%': { opacity: '0', transform: 'translateY(16px) scale(0.98)' },
    '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
  },
  shimmer: {
    '0%': { backgroundPosition: '-200% 0' },
    '100%': { backgroundPosition: '200% 0' },
  },
} as const;

/** 三个情感空间的明暗递进（说明书 九 情绪层次） */
export const mood3Space = {
  cabin: { name: '宠物舱', brightness: 1, saturation: 1, note: '温暖明亮' },
  hut: { name: '真心话小屋', brightness: 0.94, saturation: 0.92, note: '更私密、更暗一些' },
  capsule: { name: '时光胶囊', brightness: 0.88, saturation: 0.72, note: '最安静克制' },
} as const;

/** 字体族：西文 Quicksand（几何圆体），中文 jf open 粉圆 + 系统安全字体兜底 */
export const fontFamily = {
  en: ['Quicksand', 'ui-rounded', 'system-ui', 'sans-serif'],
  zh: ['jfOpenHuninn', 'Quicksand', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'sans-serif'],
} as const;

export const tokens = {
  color,
  radius,
  fontSize,
  spacing,
  boxShadow,
  easing,
  animation,
  keyframes,
  mood3Space,
  fontFamily,
} as const;

export type DesignTokens = typeof tokens;
export default tokens;
