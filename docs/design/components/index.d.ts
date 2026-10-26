/**
 * Streamline Contrail v3: the React surface the web client should expose.
 * Documentation only. Implement in web/src/shared/ui/ on top of Ant Design 5.
 */
import type { ReactNode } from 'react';

/** The eight status semantics. Keys match `token` in shared/state-machines/*.json. */
export type StatusToken = 'neutral' | 'progress' | 'ready' | 'active' | 'done' | 'cancelled' | 'critical' | 'warning';

/** StatusPill: the only way to render a domain status. */
export interface StatusPillProps {
  token: StatusToken;
  /** Translated status word; required, colour never carries status alone. */
  label: string;
  /** md = 22px (default), sm = 18px for tables and dense lists. */
  size?: 'md' | 'sm';
}

/** Route: two ICAO codes with the arc glyph. */
export interface RouteProps { from: string; to: string; plain?: boolean }

/** UtcTime: ISO UTC in, `12:40Z` or `15:40 LT UTC+3` out. */
export interface UtcTimeProps { value: string; mode?: 'utc' | 'local' | 'both'; withDate?: boolean }

/** MoneyText: Decimal string from the server, formatted only. */
export interface MoneyTextProps { amount: string; currency: string; signed?: boolean }

/** KpiTile: label, value, optional sparkline and context line. */
export interface KpiTileProps {
  label: string;
  value: string;
  unit?: string;
  trend?: number[];
  delta?: { value: string; direction: 'up' | 'down'; period: string };
  tone?: 'default' | 'warning' | 'critical';
  footnote?: ReactNode;
  extra?: ReactNode;
}

/** FlightStrip: one flight as a flight-progress strip. */
export interface FlightStripProps {
  flightNo: string;
  tail: string;
  typeCode: string;
  dep: { icao: string; etd: string };
  arr: { icao: string; eta: string };
  status: { token: StatusToken; label: string };
  /** Minutes to ETD; under 240 the countdown turns warning. */
  minutesToEtd?: number;
  onOpen?: () => void;
}

/** PageHeader: title, meta line, actions, optional section tabs. */
export interface PageHeaderProps {
  title: ReactNode;
  /** Render the title in the mono family (record pages: flight, invoice). */
  identifierTitle?: boolean;
  meta?: ReactNode;
  actions?: ReactNode;
  tabs?: { key: string; label: string; count?: number; path: string }[];
  activeTab?: string;
}

/** Banner: inline notice above the content it concerns. */
export interface BannerProps {
  kind: 'info' | 'warning' | 'critical';
  title: string;
  items?: ReactNode[];
  note?: string;
  action?: ReactNode;
}

/** CommandPalette: Ctrl K / Cmd K. */
export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  search: (query: string) => Promise<{ group: 'flights' | 'aircraft' | 'clients' | 'airports' | 'actions'; id: string; title: string; context?: string; status?: { token: StatusToken; label: string }; run: () => void }[]>;
}

/** DemoBadge renders only when DEMO_DATA=true. SeedTag marks source='seed' records. */
export interface DemoBadgeProps { visible: boolean }
