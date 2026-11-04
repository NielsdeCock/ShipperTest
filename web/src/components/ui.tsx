import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import type { StepState } from '../../../shared/model.ts';

// ---------- icons (stroke SVG, decorative) ----------

const Svg = ({ children, size = 14, w = 3, className }: { children: ReactNode; size?: number; w?: number; className?: string }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" className={className}>{children}</svg>
);
export const IconCheck = (p: { size?: number }) => <Svg {...p}><path d="M5 12l5 5 9-10" /></Svg>;
export const IconX = (p: { size?: number }) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const IconMinus = (p: { size?: number }) => <Svg {...p}><path d="M6 12h12" /></Svg>;
export const IconClock = (p: { size?: number }) => <Svg {...p} w={2.5}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
export const IconSpinner = (p: { size?: number }) => <Svg {...p} className="spin"><path d="M12 3a9 9 0 1 0 9 9" /></Svg>;
export const IconAlert = (p: { size?: number }) => (
  <Svg {...p} w={2}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" /></Svg>
);
export const IconFile = (p: { size?: number }) => (
  <Svg {...p} w={1.8}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></Svg>
);
export const IconTruck = () => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 3h15v13H1z" /><path d="M16 8h4l3 3v5h-7z" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" />
  </svg>
);

const STATUS_ICON: Record<string, (p: { size?: number }) => JSX.Element> = {
  ok: IconCheck, failed: IconX, running: IconSpinner, queued: IconClock, skipped: IconMinus,
};

/** Status is never colour-only: every badge has an icon and text. */
export function StatusBadge({ status, text }: { status: string; text?: ReactNode }) {
  const Icon = STATUS_ICON[status] ?? IconClock;
  const fallback: Record<string, string> = { ok: 'OK', failed: 'Failed', running: 'Running', queued: 'Queued', skipped: 'Skipped' };
  return <span className={`badge ${status}`}><Icon size={12} />{text ?? fallback[status] ?? status}</span>;
}

export function StepBadge({ step, last }: { step: StepState; last?: boolean }) {
  const text =
    step.status === 'ok' ? (last ? `${step.http ?? ''} Label`.trim() : String(step.http ?? 'OK'))
    : step.status === 'failed' ? (step.http ? String(step.http) : 'Failed')
    : undefined;
  return <StatusBadge status={step.status} text={text} />;
}

export function RunStatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    running: ['running', 'Running'], paused: ['queued', 'Paused'], stopped: ['skipped', 'Stopped'], done: ['ok', 'Finished'],
  };
  const [cls, text] = map[status] ?? ['queued', status];
  return <StatusBadge status={cls} text={text} />;
}

export const CC = ({ cc }: { cc: string }) => <span className="cc">{cc}</span>;

export const Pair = ({ from, to }: { from: string; to: string }) => (
  <span className="pair" aria-label={`${from} to ${to}`}>
    <CC cc={from} /><span className="arrow" aria-hidden="true">→</span><CC cc={to} />
  </span>
);

export function Notice({ kind, children }: { kind: 'warn' | 'error' | 'info'; children: ReactNode }) {
  return (
    <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {kind === 'info' ? <IconClock size={18} /> : <IconAlert size={18} />}
      <div>{children}</div>
    </div>
  );
}

export function PageHead({ crumbs, title, lead, actions }: { crumbs?: ReactNode; title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="titles">
        {crumbs && <span className="crumbs">{crumbs}</span>}
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><IconTruck /></div>
          <div><b>Carrier Test</b><span>Monta API v6</span></div>
        </div>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>New test run</NavLink>
          <NavLink to="/runs">Test runs</NavLink>
          <NavLink to="/addresses">Address book</NavLink>
          <NavLink to="/origins">Origins</NavLink>
          <NavLink to="/settings">API settings</NavLink>
        </nav>
      </aside>
      <main className="main"><div className="page">{children}</div></main>
    </div>
  );
}

export const Loading = () => <p className="muted" role="status">Loading…</p>;
