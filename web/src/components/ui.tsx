import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icons } from './icons';
const BellIcon = Icons.bell, CheckIcon = Icons.check, ClockIcon = Icons.clock, MinusSmallIcon = Icons.minus;
import type { SeerrState } from '../lib/api';

// Seerr Common/Badge
const badgeStyles = {
  default: 'bg-gray-700 !text-gray-300',
  primary: 'bg-indigo-500/80 border border-indigo-500 !text-indigo-100',
  success: 'bg-green-500/80 border border-green-500 !text-green-100',
  warning: 'bg-yellow-500/80 border border-yellow-500 !text-yellow-100',
  dark: 'bg-gray-900/80 border border-gray-600 !text-gray-200',
};
export function Badge({ type = 'default', children, className = '' }: { type?: keyof typeof badgeStyles; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex cursor-default whitespace-nowrap rounded-full px-2 text-xs font-semibold leading-5 ${badgeStyles[type]} ${className}`}>
      {children}
    </span>
  );
}

// Figma "Button": a pill, 10px x 16px padding, Label/Default, 20px icons 8px from the label.
// Primary is the white button; Default is outlined on black; Ghost is outlined and transparent.
const buttonTypes = {
  primary: 'text-ink-inverse border-app bg-inverse hover:bg-white active:bg-gray-200',
  inverse: 'text-ink-inverse border-app bg-inverse hover:bg-white active:bg-gray-200',   // same as primary (older name)
  default: 'text-ink-secondary bg-app border-line-strong hover:text-ink-primary hover:bg-raised',
  ghost: 'text-ink-primary bg-transparent border-line-strong hover:border-line-muted',
  success: 'text-ink-primary border-green-500 bg-success/80 hover:bg-success',
  warning: 'text-ink-primary border-yellow-500 bg-yellow-500/80 hover:bg-yellow-500 active:bg-yellow-700',
};
export function Button({ buttonType = 'default', size = 'md', className = '', children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { buttonType?: keyof typeof buttonTypes; size?: 'md' | 'lg' }) {
  const sizes = { md: 'px-4 py-2.5', lg: 'px-6 py-3' };
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-full border type-label-default transition duration-150 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-not-allowed disabled:opacity-50 ${buttonTypes[buttonType]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// Seerr Common/StatusBadgeMini (shrink)
const statusStyle: Record<Exclude<SeerrState, null>, [string, ReactNode, string]> = {
  available: ['bg-green-500/80 border-green-400 text-green-100', <CheckIcon key="i" />, 'Available'],
  partial: ['bg-green-500/80 border-green-400 text-green-100', <MinusSmallIcon key="i" />, 'Partially available'],
  requested: ['bg-yellow-500/80 border-yellow-400 text-yellow-100', <BellIcon key="i" />, 'Requested'],
  processing: ['bg-indigo-500/80 border-indigo-400 text-indigo-100', <ClockIcon key="i" />, 'Processing'],
};
export function StatusBadgeMini({ state }: { state: SeerrState }) {
  if (!state) return null;
  const [cls, icon, label] = statusStyle[state];
  return (
    <span title={label} aria-label={label} className={`flex h-5 w-5 items-center justify-center rounded-full border shadow-md [&>svg]:h-3 [&>svg]:w-3 ${cls}`}>
      {icon}
    </span>
  );
}

export function statusBadge(state: SeerrState) {
  if (!state) return null;
  const [type, label] = ({
    available: ['success', 'Available'], partial: ['success', 'Partially available'],
    requested: ['warning', 'Requested'], processing: ['primary', 'Processing'],
  } as const)[state];
  return <Badge type={type}>{label}</Badge>;
}

// Seerr Common/Tag, with a selected state for filter choices.
export function Tag({ children, selected = false, onClick, removable = false }:
  { children: ReactNode; selected?: boolean; onClick?: () => void; removable?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      // Figma FilterChip: Off = outlined, On = white. Removable (active filter) chips use Body/Default with an ✕.
      className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 transition ${removable ? 'type-body-default' : 'type-label-default'} ${
        selected ? 'bg-inverse text-ink-inverse' : 'bg-app text-ink-secondary ring-1 ring-inset ring-line-strong hover:bg-raised'
      }`}
    >
      {children}
      {removable && <Icons.xmark aria-hidden className="h-4 w-4 text-ink-muted" />}
    </button>
  );
}

export function Spinner({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg className={`animate-spin text-indigo-400 ${className}`} viewBox="0 0 24 24" fill="none" aria-label="Loading">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  );
}

export function Credits() {
  return (
    <p className="mt-10 text-xs text-gray-500">
      Data from <a className="underline hover:text-gray-300" href="https://www.watchmode.com" target="_blank" rel="noreferrer">Watchmode</a> and{' '}
      <a className="underline hover:text-gray-300" href="https://www.themoviedb.org" target="_blank" rel="noreferrer">TMDB</a>.
      {' '}Prime Video, rent or buy and coming soon from <a className="underline hover:text-gray-300" href="https://www.justwatch.com" target="_blank" rel="noreferrer">JustWatch</a> via TMDB.
      {' '}This product uses the TMDB API but is not endorsed or certified by TMDB.
    </p>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  // Figma Heading/Page, text/primary; the page's content starts 16px below.
  return <h1 className="mb-4 mt-4 truncate type-heading-page text-ink-primary">{children}</h1>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="mt-24 w-full text-center text-xl text-gray-400">{children}</div>;
}
