import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

type ButtonVariant = 'primary' | 'quiet' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  block?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  block,
  className,
  children,
  ...rest
}: ButtonProps) {
  const sizeClass =
    size === 'lg' ? 'text-body-lg px-loose py-base' : size === 'sm' ? 'text-caption px-snug py-1.5' : '';
  const variantClass =
    variant === 'primary'
      ? 'rt-button'
      : variant === 'quiet'
        ? 'rt-button-quiet'
        : variant === 'danger'
          ? 'inline-flex items-center justify-center gap-2 rounded-pill bg-state-danger/90 px-snug py-1.5 text-caption font-semibold text-text-inverse transition-all duration-300 ease-spring hover:-translate-y-0.5 active:scale-[0.95]'
          : 'inline-flex items-center justify-center gap-2 rounded-pill px-snug py-1.5 text-caption font-medium text-text-secondary transition-colors hover:bg-surface-sunken active:scale-[0.97]';
  return (
    <button
      type="button"
      className={clsx(variantClass, sizeClass, block && 'w-full', 'rt-tap-target', className)}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  padded?: boolean;
}

export function Card({ interactive, padded = true, className, children, ...rest }: CardProps) {
  return (
    <div
      className={clsx(
        'rt-card',
        padded && 'p-comfortable',
        interactive && 'rt-card-hover rt-card-active cursor-pointer',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-base flex items-end justify-between gap-base">
      <div>
        <h2 className="rt-section-title">{title}</h2>
        {hint ? <p className="mt-1 text-body-sm text-text-muted">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Chip({
  active,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { active?: boolean }) {
  return (
    <span className={clsx('rt-chip', active && 'rt-chip-active', className)} {...rest}>
      {children}
    </span>
  );
}

export function ProgressBar({
  value,
  max = 100,
  tone = 'coral',
  className,
  label,
}: {
  value: number;
  max?: number;
  tone?: 'coral' | 'chestnut' | 'sage';
  className?: string;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const toneClass =
    tone === 'chestnut' ? 'bg-brand-secondary' : tone === 'sage' ? 'bg-state-success' : 'bg-brand-primary';
  return (
    <div className={clsx('w-full', className)}>
      {label ? <div className="mb-1 flex justify-between text-caption text-text-muted"><span>{label}</span><span>{Math.round(pct)}%</span></div> : null}
      <div className="h-2.5 w-full overflow-hidden rounded-pill bg-surface-sunken shadow-plush-inset">
        <div
          className={clsx('h-full rounded-pill transition-all duration-700 ease-spring', toneClass)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = 'bottom',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  side?: 'bottom' | 'center';
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="关闭"
        className="absolute inset-0 bg-text-primary/25 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        className={clsx(
          'rt-card animate-drop-in relative z-10 w-full max-w-phone border-border-subtle/60 p-comfortable shadow-plush-hover',
          side === 'bottom'
            ? 'mb-0 rounded-b-none rt-safe-bottom md:mb-comfortable md:rounded-card'
            : 'mb-roomy rounded-card',
        )}
      >
        <div className="mb-base flex items-start justify-between gap-base">
          <div>
            <h3 className="text-body-lg font-bold text-text-primary">{title}</h3>
            {description ? <p className="mt-1 text-body-sm text-text-muted">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rt-tap-target -mr-2 -mt-1 rounded-pill px-snug text-text-muted transition-colors hover:bg-surface-sunken"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="max-h-[60dvh] overflow-y-auto pr-1">{children}</div>
        {footer ? <div className="mt-base flex gap-snug">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('rt-skeleton', className)} />;
}

export function EmptyState({
  emoji,
  title,
  description,
  action,
}: {
  emoji: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-snug rounded-card bg-surface-sunken/60 px-comfortable py-loose text-center">
      <span className="text-4xl" aria-hidden>
        {emoji}
      </span>
      <h3 className="text-body-lg font-bold text-text-primary">{title}</h3>
      <p className="max-w-prose text-body-sm text-text-muted">{description}</p>
      {action}
    </div>
  );
}
