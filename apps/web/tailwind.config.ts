/** @type {import('tailwindcss').Config} */
export default {
  presets: [require('../../packages/theme/src/tailwind-preset.cjs')],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      // 版面约束：移动端优先，桌面端做双栏沉浸布局
      maxWidth: {
        phone: '430px',   // 手机容器
        content: '1180px', // 桌面内容区
        prose: '68ch',
      },
      gridTemplateColumns: {
        cabin: 'minmax(0,1.15fr) minmax(0,1fr)',
      },
    },
  },
  plugins: [],
};
