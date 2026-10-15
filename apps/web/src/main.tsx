import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setUnauthorizedHandler } from './api/client';
import { useApp } from './store/app';
import './styles/global.css';

/**
 * 会话失效时回到登录页。
 * 在 client 里直接 import store 会形成循环依赖（store 依赖 client），
 * 所以用回调注册的方式解耦。
 */
setUnauthorizedHandler(() => {
  useApp.setState({ authRequired: true, error: null });
});

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

/**
 * 全局错误捕获与上报（审计 O3）。
 *
 * 只上报「结构与事件名」，不含用户输入内容与照片：
 *   面包屑记录的是「用户在哪个页面做了什么」，
 *   而不是「用户说了什么」——后者属于隐私，不该出现在日志里。
 */
const trail: string[] = [];
export function breadcrumb(event: string): void {
  trail.push(event);
  if (trail.length > 20) trail.shift();
}

function reportClientError(payload: { message: string; stack?: string }): void {
  // 忽略浏览器扩展注入的噪音错误
  if (/ResizeObserver loop|Extension context invalidated/i.test(payload.message)) return;
  try {
    const token = localStorage.getItem('ruatrip.token');
    void fetch(`${import.meta.env.VITE_API_BASE_URL ?? '/api'}/client-error`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        errorMessage: payload.message.slice(0, 500),
        trail,
        url: window.location.pathname,
        userAgent: navigator.userAgent,
        at: Date.now(),
      }),
      // 上报失败不能影响用户；keepalive 让页面卸载时也能发出去
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* 静默 */
  }
}

window.addEventListener('error', (e) => {
  reportClientError({ message: e.message || 'unknown error' });
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  reportClientError({ message: reason instanceof Error ? reason.message : String(reason) });
});

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
