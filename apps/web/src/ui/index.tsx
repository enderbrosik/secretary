import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { AlertTriangle, Check, ChevronDown, ExternalLink, Info, Loader2, RefreshCw, X } from 'lucide-react';
import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { openExternal } from '../lib/platform';
import { errorMessage } from '../lib/api';

export function cn(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 active:brightness-95 shadow-card',
  secondary: 'bg-surface text-ink border border-line hover:border-line-strong hover:bg-surface-2 shadow-card',
  ghost: 'text-ink-2 hover:bg-bg-subtle hover:text-ink',
  subtle: 'bg-bg-subtle text-ink-2 hover:text-ink hover:bg-line/60',
  danger: 'bg-danger text-white hover:brightness-110',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-[background,border,filter,color] duration-150 disabled:opacity-50 select-none',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-9 px-3.5 text-[13.5px]',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' }>(function IconButton(
  { label, className, children, size = 'md', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center rounded-lg text-muted hover:text-ink hover:bg-bg-subtle transition-colors disabled:opacity-40',
        size === 'sm' ? 'size-7' : 'size-9',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ className, children, as: As = 'section', ...rest }: { className?: string; children: ReactNode; as?: 'section' | 'div' | 'article' } & Record<string, unknown>) {
  return (
    <As className={cn('bg-surface border border-line rounded-[var(--radius-card)] shadow-card', className)} {...rest}>
      {children}
    </As>
  );
}

export function CardHeader({ title, subtitle, icon, actions, className }: { title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn('flex items-start justify-between gap-3 px-5 pt-4 pb-3', className)}>
      <div className="flex items-start gap-2.5 min-w-0">
        {icon && <span className="mt-0.5 text-muted shrink-0">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
          {subtitle && <p className="text-[12.5px] text-muted mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
    </header>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-6">
      <div className="min-w-0">
        {eyebrow && <div className="text-[12px] font-medium uppercase tracking-[0.08em] text-faint mb-1.5">{eyebrow}</div>}
        <h1 className="font-display text-[30px] leading-[1.15] tracking-[-0.01em] text-ink">{title}</h1>
        {subtitle && <p className="text-muted mt-1.5 max-w-2xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges & labels
// ---------------------------------------------------------------------------

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';
const TONES: Record<Tone, string> = {
  neutral: 'bg-bg-subtle text-ink-2 border-line',
  accent: 'bg-accent-soft text-accent-text border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
};

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 h-[20px] text-[11.5px] font-medium whitespace-nowrap', TONES[tone], className)}>
      {children}
    </span>
  );
}

/** Makes the source of every statement visible: fact from a connected source, AI inference, or suggestion. */
export function ProvenanceBadge({ kind }: { kind: 'fact' | 'inference' | 'suggestion' }) {
  const map = {
    fact: { tone: 'neutral' as Tone, label: 'From your data', title: 'Comes directly from a connected source or your own input' },
    inference: { tone: 'info' as Tone, label: 'AI summary', title: 'Interpreted by your AI provider from the linked records' },
    suggestion: { tone: 'accent' as Tone, label: 'Suggestion', title: 'A recommendation — not a deadline or commitment' },
  }[kind];
  return (
    <Badge tone={map.tone} title={map.title}>
      {map.label}
    </Badge>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex items-center rounded border border-line bg-surface-2 px-1 h-[18px] text-[11px] font-medium text-muted font-sans">{children}</kbd>;
}

export function Avatar({ label, className }: { label: string; className?: string }) {
  let h = 0;
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span
      aria-hidden
      className={cn('inline-flex items-center justify-center rounded-full size-7 text-[11px] font-semibold shrink-0', className)}
      style={{ background: `hsl(${h} 45% 88% / var(--av-a, 1))`, color: `hsl(${h} 35% 28%)` }}
    >
      {label}
    </span>
  );
}

const SOURCE_LABEL: Record<string, string> = { google: 'Google', microsoft: 'Microsoft', slack: 'Slack', todoist: 'Todoist', demo: 'Demo', internal: 'Secretary' };

/** A link back to the original record, or a clear label when no link exists (demo data). */
export function SourceChip({ source, url, label }: { source: string; url: string | null; label?: string }) {
  const text = label ?? SOURCE_LABEL[source] ?? source;
  if (!url)
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-faint" title={source === 'demo' ? 'Sample record — no original to open' : undefined}>
        {text}
      </span>
    );
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void openExternal(url);
      }}
      className="inline-flex items-center gap-1 text-[12px] text-accent-text hover:underline underline-offset-2"
    >
      {text}
      <ExternalLink className="size-3" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const control =
  'w-full rounded-lg border border-line bg-surface px-3 text-[13.5px] text-ink placeholder:text-faint shadow-[inset_0_1px_0_rgb(0_0_0/0.02)] transition-colors hover:border-line-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(control, 'h-9', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(control, 'py-2 min-h-[84px] leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <div className="relative">
      <select ref={ref} className={cn(control, 'h-9 appearance-none pr-8', className)} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-muted" />
    </div>
  );
});

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[12.5px] font-medium text-ink-2">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-[12px] text-danger">{error}</p> : hint ? <p className="text-[12px] text-muted">{hint}</p> : null}
    </div>
  );
}

export function Switch({ checked, onCheckedChange, label, description, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <div className="text-[13.5px] text-ink">{label}</div>
        {description && <div className="text-[12.5px] text-muted mt-0.5">{description}</div>}
      </label>
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-50"
      >
        <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </SwitchPrimitive.Root>
    </div>
  );
}

export function Checkbox({ checked, onCheckedChange, label, className, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; className?: string; disabled?: boolean }) {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      aria-label={label}
      disabled={disabled}
      className={cn(
        'flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-line-strong transition-colors hover:border-accent data-[state=checked]:border-ok data-[state=checked]:bg-ok',
        className,
      )}
    >
      <CheckboxPrimitive.Indicator>
        <Check className="size-3 text-white" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; className?: string }) {
  return (
    <div role="tablist" className={cn('inline-flex flex-wrap gap-1 rounded-xl bg-bg-subtle p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-7 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors inline-flex items-center gap-1.5',
            o.value === value ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="tabular text-faint">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

export function Dialog({ open, onOpenChange, title, description, children, footer, wide }: { open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] data-[state=open]:animate-[fade_150ms_ease-out]" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-[8vh] z-50 w-[calc(100vw-24px)] -translate-x-1/2 rounded-2xl border border-line bg-surface shadow-pop focus:outline-none max-h-[84vh] flex flex-col',
            wide ? 'max-w-2xl' : 'max-w-lg',
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div>
              <DialogPrimitive.Title className="text-[16px] font-semibold tracking-[-0.01em]">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="text-[13px] text-muted mt-1">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">Dialog</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton label="Close" size="sm">
                <X className="size-4" />
              </IconButton>
            </DialogPrimitive.Close>
          </div>
          <div className="px-5 py-4 overflow-y-auto scrollbar-thin">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content sideOffset={6} className="z-50 max-w-xs rounded-lg bg-ink px-2.5 py-1.5 text-[12px] text-bg shadow-pop">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
export const TooltipProvider = TooltipPrimitive.Provider;

export function Expandable({ summary, children, defaultOpen }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <CollapsiblePrimitive.Root defaultOpen={defaultOpen} className="group">
      <CollapsiblePrimitive.Trigger className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-ink">
        <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
        {summary}
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="pt-2">{children}</CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-bg-subtle', className)} />;
}

export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 p-5" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-7 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, body, action, className }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center px-6 py-10', className)}>
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-bg-subtle text-muted">{icon}</div>}
      <div className="text-[14px] font-medium text-ink">{title}</div>
      {body && <div className="mt-1 max-w-sm text-[13px] text-muted">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const msg = errorMessage(error);
  const rate = (error as { status?: number })?.status === 429;
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center text-center px-6 py-8', className)}>
      <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-danger-soft text-danger">
        <AlertTriangle className="size-5" />
      </div>
      <div className="text-[14px] font-medium">{rate ? 'Slow down a little' : 'Couldn’t load this'}</div>
      <div className="mt-1 max-w-sm text-[13px] text-muted">{msg}</div>
      {onRetry && (
        <Button className="mt-4" size="sm" icon={<RefreshCw className="size-3.5" />} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Banner({ tone = 'info', title, children, action, icon }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div role="status" className={cn('flex flex-col gap-2 rounded-xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between', TONES[tone])}>
      <div className="flex items-start gap-2.5 min-w-0">
        <span className="mt-0.5 shrink-0">{icon ?? (tone === 'warn' || tone === 'danger' ? <AlertTriangle className="size-4" /> : <Info className="size-4" />)}</span>
        <div className="min-w-0 text-[13px]">
          {title && <div className="font-semibold">{title}</div>}
          {children && <div className={cn(!!title && 'opacity-90')}>{children}</div>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-muted', className)} aria-label="Loading" />;
}
