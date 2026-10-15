import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';

/**
 * 字体非阻塞加载的第二步。
 *
 * index.html 里 Quicksand 的 <link> 带 media="print"，浏览器不会为它阻塞渲染；
 * 这里在应用挂载后把它切换成 media="all" 才会真正生效。
 * 这样做的原因：Google Fonts 在国内可能很慢甚至超时，
 * 阻塞式加载会让首屏白屏，而非阻塞加载失败时只是字形退化为系统圆体。
 */
function activateDeferredFonts(): void {
  const link = document.getElementById('quicksand-stylesheet') as HTMLLinkElement | null;
  if (!link) return;
  link.media = 'all';
  // 加载失败不报错、不重试：系统字体兜底已经在 Tailwind 的 fontFamily 里配好
  link.addEventListener('error', () => {
    link.remove();
  });
}

activateDeferredFonts();

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
