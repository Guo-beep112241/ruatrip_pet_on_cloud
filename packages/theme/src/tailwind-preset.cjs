/**
 * Tailwind 预设 —— 毛绒实木 (Plush x Birch Wood)
 * 颜色统一走 `hsl(var(--color-x) / <alpha-value>)`，
 * 这样既能用语义化工具类（bg-surface-base），也支持透明度修饰（bg-brand-primary/20）。
 */
const hsl = (name) => `hsl(var(--color-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      colors: {
        'surface-base': hsl('surface-base'),
        'surface-raised': hsl('surface-raised'),
        'surface-sunken': hsl('surface-sunken'),
        'surface-overlay': hsl('surface-overlay'),
        'brand-secondary': hsl('brand-secondary'),
        'brand-secondary-soft': hsl('brand-secondary-soft'),
        'brand-primary': hsl('brand-primary'),
        'brand-primary-deep': hsl('brand-primary-deep'),
        'text-primary': hsl('text-primary'),
        'text-secondary': hsl('text-secondary'),
        'text-muted': hsl('text-muted'),
        'text-inverse': hsl('text-inverse'),
        'state-success': hsl('state-success'),
        'state-warning': hsl('state-warning'),
        'state-danger': hsl('state-danger'),
        'border-subtle': hsl('border-subtle'),
        'border-strong': hsl('border-strong'),
      },
      borderRadius: {
        tight: 'var(--radius-tight)',
        card: 'var(--radius-card)',
        large: 'var(--radius-large)',
        pill: 'var(--radius-pill)',
      },
      spacing: {
        tight: 'var(--space-tight)',
        snug: 'var(--space-snug)',
        base: 'var(--space-base)',
        comfortable: 'var(--space-comfortable)',
        loose: 'var(--space-loose)',
        roomy: 'var(--space-roomy)',
      },
      fontSize: {
        'caption-sm': ['var(--text-caption-sm)', { lineHeight: 'var(--text-caption-sm--line-height)' }],
        caption: ['var(--text-caption)', { lineHeight: 'var(--text-caption--line-height)' }],
        'body-sm': ['var(--text-body-sm)', { lineHeight: 'var(--text-body-sm--line-height)' }],
        body: ['var(--text-body)', { lineHeight: 'var(--text-body--line-height)' }],
        'body-lg': ['var(--text-body-lg)', { lineHeight: 'var(--text-body-lg--line-height)' }],
        title: ['var(--text-title)', { lineHeight: 'var(--text-title--line-height)' }],
        'title-lg': ['var(--text-title-lg)', { lineHeight: 'var(--text-title-lg--line-height)' }],
        display: ['var(--text-display)', { lineHeight: 'var(--text-display--line-height)' }],
      },
      fontFamily: {
        en: ['Quicksand', 'ui-rounded', 'system-ui', 'sans-serif'],
        zh: ['jfOpenHuninn', 'Quicksand', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'sans-serif'],
      },
      boxShadow: {
        plush: 'var(--shadow-plush)',
        'plush-hover': 'var(--shadow-plush-hover)',
        'plush-inset': 'var(--shadow-plush-inset)',
        'glow-coral': 'var(--shadow-glow-coral)',
      },
      transitionTimingFunction: {
        spring: 'var(--ease-spring)',
      },
      animation: {
        breathe: 'var(--animate-breathe)',
        float: 'var(--animate-float)',
        blink: 'var(--animate-blink)',
        'tail-wag': 'var(--animate-tail-wag)',
        'pulse-soft': 'var(--animate-pulse-soft)',
        'drop-in': 'var(--animate-drop-in)',
        shimmer: 'var(--animate-shimmer)',
      },
      screens: {
        // 移动端优先；同时支持平板与桌面端
        xs: '420px',
        sm: '560px',
        md: '768px',
        lg: '1024px',
        xl: '1280px',
        '2xl': '1536px',
      },
    },
  },
};
