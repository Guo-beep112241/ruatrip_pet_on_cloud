import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

/**
 * 统一的数据请求 hook（审计 M7）。
 *
 * 修复前的状态：每个页面各写一份
 *   const [data, setData] = useState(null);
 *   const [loading, setLoading] = useState(false);
 *   useEffect(() => { try { ... } catch { toast(...) } }, [])
 * 结果是错误处理不一致（有的页面静默失败、有的弹 toast），
 * 卸载后 setState 的警告也随处可见。
 *
 * 这个 hook 统一解决四件事：
 *   1. loading / error / data 三态一致
 *   2. 组件卸载后不再 setState（避免内存泄漏与 React 警告）
 *   3. 请求竞态：后发的请求覆盖先发的（切页快时很常见）
 *   4. 手动 refetch（打卡后刷新列表这类场景）
 */

export interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** 手动重新拉取；返回最新数据（失败时返回 null） */
  refetch: () => Promise<T | null>;
  /** 本地乐观更新（例如先插入一条新记录，稍后 refetch 校正） */
  setData: (updater: T | ((prev: T | null) => T)) => void;
}

export interface UseApiOptions {
  /** false 时不自动拉取（例如缺少必要参数） */
  enabled?: boolean;
  /** 失败时是否抛出（默认吞掉并写入 error 字段，由页面决定怎么展示） */
  onError?: (message: string) => void;
  /** 依赖变化时重新拉取 */
  deps?: unknown[];
}

export function useApi<T>(path: string | null, options: UseApiOptions = {}): UseApiState<T> {
  const { enabled = true, onError, deps = [] } = options;

  const [data, setDataState] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 组件是否还挂载：卸载后不再 setState */
  const mounted = useRef(true);
  /** 请求序号：只接受最新一次请求的结果，避免旧响应覆盖新数据 */
  const seq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchNow = useCallback(async (): Promise<T | null> => {
    if (!path || !enabled) return null;
    const mySeq = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<T>(path);
      if (!mounted.current || mySeq !== seq.current) return null;
      setDataState(result);
      return result;
    } catch (e) {
      if (!mounted.current || mySeq !== seq.current) return null;
      const message = e instanceof Error ? e.message : '加载失败';
      setError(message);
      onError?.(message);
      return null;
    } finally {
      if (mounted.current && mySeq === seq.current) setLoading(false);
    }
  }, [path, enabled, onError]);

  useEffect(() => {
    void fetchNow();
    // deps 由调用方提供；path/enabled 变化也应重新拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled, ...deps]);

  const setData = useCallback((updater: T | ((prev: T | null) => T)) => {
    setDataState((prev) => (typeof updater === 'function' ? (updater as (p: T | null) => T)(prev) : updater));
  }, []);

  return { data, loading, error, refetch: fetchNow, setData };
}

/**
 * 写操作 hook：统一 loading 与错误提示。
 *
 * 用法：
 *   const { run, loading } = useApiAction();
 *   await run(() => api.post('/interact', body));
 */
export function useApiAction(): {
  run: <R>(fn: () => Promise<R>) => Promise<R | null>;
  loading: boolean;
  error: string | null;
} {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      return result;
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '操作失败');
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  return { run, loading, error };
}
