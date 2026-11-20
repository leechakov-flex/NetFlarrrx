import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { BellIcon, CheckIcon, ClockIcon, MinusSmallIcon } from '@heroicons/react/20/solid';
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

// Seerr Common/Button (md and lg sizes)
const buttonTypes = {
  primary: 'text-white border border-indigo-500 bg-indigo-600/80 hover:bg-indigo-600 active:bg-indigo-700',
  default: 'text-gray-200 bg-gray-800/80 border-gray-600 hover:text-white hover:bg-gray-700',
  ghost: 'text-white bg-transparent border-gray-600 hover:border-gray-200',
};
export function Button({ buttonType = 'default', size = 'md', className = '', children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { buttonType?: keyof typeof buttonTypes; size?: 'md' | 'lg' }) {
  const sizes = { md: 'px-4 py-2 text-sm', lg: 'px-6 py-3 text-base' };
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-md border font-medium leading-5 transition duration-150 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-not-allowed disabled:opacity-50 ${buttonTypes[buttonType]} ${sizes[size]} ${className}`}
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
    <span title={label} aria-label={label} className={`flex h-5 w-5 items-center justify-center rounded-full border shadow-md [&>svg]:h-3.5 [&>svg]:w-3.5 ${cls}`}>
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
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm leading-snug ring-1 ring-inset transition ${
        selected ? 'bg-indigo-600/80 font-medium text-white ring-indigo-500 hover:bg-indigo-600' : 'bg-gray-800 text-gray-200 ring-gray-600 hover:bg-gray-700'
      }`}
    >
      {children}
      {removable && <span aria-hidden className="ml-0.5 text-gray-400">✕</span>}
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
      {' '}This product uses the TMDB API but is not endorsed or certified by TMDB.
    </p>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="mb-4 mt-6 truncate text-2xl font-bold leading-7 text-gray-100 sm:text-4xl sm:leading-9"><span className="text-overseerr">{children}</span></h1>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="mt-24 w-full text-center text-xl text-gray-400">{children}</div>;
}
