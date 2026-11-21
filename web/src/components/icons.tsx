// SF-Symbols-style glyphs from Framework7 Icons (MIT), the same set as the Figma
// "Icons" section. Apple's own SF Symbols can't be used on the web, so these
// stand in. Each import is one file, so only the icons used end up in the build.
// The components size to 1em; pass className="h-6 w-6" (or a text size) as usual.
import type { ReactElement, SVGProps } from 'react';
import ArrowDownToLine from 'framework7-icons/react/esm/ArrowDownToLine.js';
import ArrowUpArrowDown from 'framework7-icons/react/esm/ArrowUpArrowDown.js';
import Bell from 'framework7-icons/react/esm/Bell.js';
import Checkmark from 'framework7-icons/react/esm/Checkmark.js';
import CheckmarkCircleFill from 'framework7-icons/react/esm/CheckmarkCircleFill.js';
import ChevronDown from 'framework7-icons/react/esm/ChevronDown.js';
import ChevronLeft from 'framework7-icons/react/esm/ChevronLeft.js';
import ChevronRight from 'framework7-icons/react/esm/ChevronRight.js';
import Clock from 'framework7-icons/react/esm/Clock.js';
import Ellipsis from 'framework7-icons/react/esm/Ellipsis.js';
import ExclamationmarkTriangle from 'framework7-icons/react/esm/ExclamationmarkTriangle.js';
import Film from 'framework7-icons/react/esm/Film.js';
import LineHorizontal3Decrease from 'framework7-icons/react/esm/LineHorizontal3Decrease.js';
import Lock from 'framework7-icons/react/esm/Lock.js';
import Minus from 'framework7-icons/react/esm/Minus.js';
import PlayRectangle from 'framework7-icons/react/esm/PlayRectangle.js';
import Plus from 'framework7-icons/react/esm/Plus.js';
import Rosette from 'framework7-icons/react/esm/Rosette.js';
import Search from 'framework7-icons/react/esm/Search.js';
import Sparkles from 'framework7-icons/react/esm/Sparkles.js';
import StarFill from 'framework7-icons/react/esm/StarFill.js';
import Tv from 'framework7-icons/react/esm/Tv.js';
import Xmark from 'framework7-icons/react/esm/Xmark.js';
import XmarkCircleFill from 'framework7-icons/react/esm/XmarkCircleFill.js';

export type Icon = (props: SVGProps<SVGSVGElement>) => ReactElement;
const icon = (C: unknown): Icon => C as Icon;

export const Icons = {
  sparkles: icon(Sparkles), film: icon(Film), tv: icon(Tv), rosette: icon(Rosette), search: icon(Search),
  chevronRight: icon(ChevronRight), chevronDown: icon(ChevronDown), chevronLeft: icon(ChevronLeft),
  sort: icon(ArrowUpArrowDown), filter: icon(LineHorizontal3Decrease), check: icon(Checkmark), checkCircle: icon(CheckmarkCircleFill),
  clock: icon(Clock), bell: icon(Bell), minus: icon(Minus), xmark: icon(Xmark), xmarkCircle: icon(XmarkCircleFill),
  download: icon(ArrowDownToLine), ellipsis: icon(Ellipsis), star: icon(StarFill), trailer: icon(PlayRectangle), plus: icon(Plus),
  warning: icon(ExclamationmarkTriangle), lock: icon(Lock),
};
