/**
 * Общие компоненты представления.
 *
 * `CLAUDE.md § 10`: плотность информации и однозначность статусов. Моноширинный
 * шрифт — только для номеров документов, кодов ИКАО и колонок с суммами.
 * Цвет несёт только смысл статуса.
 *
 * `CLAUDE.md § 3` п. 16: доменных расчётов здесь нет. Эти компоненты **отображают**
 * готовые значения; маржа, цены и рейтинги приходят с сервера.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Alert, Empty, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import type { Money } from '@/api/types';
import {
  FLIGHT_STATUS_TOKENS,
  SERVICE_ORDER_STATUS_TOKENS,
  STATUS_TOKENS,
  statusToken,
  type StatusToken,
} from './status-tokens';

const MONO: CSSProperties = {
  fontFamily: "'JetBrains Mono', 'Consolas', monospace",
  fontVariantNumeric: 'tabular-nums',
};

/** Моноширинный фрагмент: номер документа, код ИКАО, регистрация борта. */
export function Mono({ children, ...rest }: { children: ReactNode } & { title?: string }) {
  return (
    <span style={MONO} {...rest}>
      {children}
    </span>
  );
}

// ─────────────────────────────── Деньги ───────────────────────────────

const CURRENCY_SIGN: Record<string, string> = { RUB: '₽', USD: '$', EUR: '€' };

/**
 * Денежная сумма.
 *
 * Сумма приходит **строкой** из API (`CLAUDE.md § 3` п. 1) и здесь только
 * форматируется до двух знаков. Никакой арифметики: два `MoneyText` нельзя
 * сложить на экране, суммы считает сервер.
 *
 * Отрицательное значение (например, отрицательная маржа) отображается, а не
 * скрывается и не обнуляется — `DOMAIN.md § 7.3`.
 */
export function MoneyText({
  value,
  strong,
  colorBySign,
  showCurrency = true,
}: {
  value: Money | null | undefined;
  strong?: boolean;
  colorBySign?: boolean;
  showCurrency?: boolean;
}) {
  if (!value) return <Typography.Text type="secondary">—</Typography.Text>;

  const numeric = Number.parseFloat(value.amount);
  const negative = numeric < 0;
  const formatted = Math.abs(numeric).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const color = colorBySign
    ? negative
      ? STATUS_TOKENS.critical.color
      : STATUS_TOKENS.done.color
    : undefined;

  return (
    <span style={{ ...MONO, color, fontWeight: strong ? 600 : undefined, whiteSpace: 'nowrap' }}>
      {negative ? '−' : ''}
      {formatted}
      {showCurrency ? ` ${CURRENCY_SIGN[value.currency] ?? value.currency}` : ''}
    </span>
  );
}

/** Процент. `null` означает «не определён» (нулевая выручка), а не ноль. */
export function PercentText({
  value,
  colorBySign,
  threshold,
}: {
  value: string | null | undefined;
  colorBySign?: boolean;
  threshold?: number;
}) {
  const { t } = useTranslation();
  if (value === null || value === undefined) {
    return (
      <Tooltip title={t('finance.percentUndefined')}>
        <Typography.Text type="secondary">—</Typography.Text>
      </Tooltip>
    );
  }

  const numeric = Number.parseFloat(value);
  let color: string | undefined;
  if (colorBySign) {
    if (numeric < 0) color = STATUS_TOKENS.critical.color;
    else if (threshold !== undefined && numeric < threshold) color = STATUS_TOKENS.warning.color;
    else color = STATUS_TOKENS.done.color;
  }

  return (
    <span style={{ ...MONO, color, whiteSpace: 'nowrap' }}>{numeric.toFixed(1)}&nbsp;%</span>
  );
}

// ─────────────────────────────── Время ───────────────────────────────

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Время в UTC. **Подпись зоны обязательна всегда** (`CLAUDE.md § 10`):
 * `12:40Z`. Неподписанное время в диспетчерской — источник ошибок.
 */
export function UtcTime({
  value,
  withDate,
  local,
}: {
  value: string | null | undefined;
  withDate?: boolean;
  /** Локальное время аэропорта и его смещение — показывается рядом с UTC. */
  local?: { time: string; offset: string };
}) {
  if (!value) return <Typography.Text type="secondary">—</Typography.Text>;

  const date = new Date(value);
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`;
  const day = `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}`;

  return (
    <span style={{ ...MONO, whiteSpace: 'nowrap' }}>
      {withDate ? `${day} ` : ''}
      {time}
      {local ? (
        <Typography.Text type="secondary" style={{ ...MONO, marginLeft: 6 }}>
          {local.time} LT ({local.offset})
        </Typography.Text>
      ) : null}
    </span>
  );
}

/** Дата без времени: сроки контрактов, даты документов. */
export function DateText({ value }: { value: string | null | undefined }) {
  if (!value) return <Typography.Text type="secondary">—</Typography.Text>;
  const date = new Date(value);
  return (
    <span style={MONO}>
      {pad(date.getUTCDate())}.{pad(date.getUTCMonth() + 1)}.{date.getUTCFullYear()}
    </span>
  );
}

// ─────────────────────────────── Статусы ───────────────────────────────

function TokenTag({ token, label }: { token: StatusToken; label: string }) {
  const style = STATUS_TOKENS[token];
  return (
    <Tag
      style={{
        color: style.color,
        background: style.background,
        borderColor: style.border,
        margin: 0,
        fontWeight: 500,
      }}
    >
      {label}
    </Tag>
  );
}

export function FlightStatusTag({ status }: { status: string }) {
  const { t } = useTranslation();
  return (
    <TokenTag
      token={FLIGHT_STATUS_TOKENS[status] ?? 'neutral'}
      label={t(`flightStatus.${status}`, status)}
    />
  );
}

export function ServiceStatusTag({ status }: { status: string }) {
  const { t } = useTranslation();
  return (
    <TokenTag
      token={SERVICE_ORDER_STATUS_TOKENS[status] ?? 'neutral'}
      label={t(`serviceStatus.${status}`, status)}
    />
  );
}

/** Статус произвольной сущности: документ, контракт, заявка на оплату. */
export function GenericStatusTag({ token, label }: { token: StatusToken; label: string }) {
  return <TokenTag token={token} label={label} />;
}

export { statusToken, STATUS_TOKENS };

// ─────────────────────── Состояния загрузки и пустоты ───────────────────────

/**
 * `CLAUDE.md § 9`: у каждого экрана нарисованы пустое состояние, загрузка
 * и ошибка. Экран, у которого есть только «всё хорошо», не считается готовым.
 */

export function LoadingState({ rows = 4 }: { rows?: number }) {
  return <Skeleton active paragraph={{ rows }} />;
}

export function EmptyState({ description, action }: { description?: string; action?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={description ?? t('common.empty')}
      style={{ padding: '24px 0' }}
    >
      {action}
    </Empty>
  );
}

export function ErrorState({ code, onRetry }: { code?: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert
      type="error"
      showIcon
      message={t('common.error')}
      description={code ? t(`errors.${code}`, t('errors.INTERNAL_ERROR')) : undefined}
      action={
        onRetry ? (
          <Typography.Link onClick={onRetry}>{t('common.retry')}</Typography.Link>
        ) : null
      }
    />
  );
}

// ─────────────────────────── Прочее ───────────────────────────

/** Подпись «источник данных» — честность происхождения (`CLAUDE.md § 4`). */
export function DataSourceTag({ source }: { source: string | undefined }) {
  const { t } = useTranslation();
  if (source !== 'synthetic') return null;
  return (
    <Tooltip title={t('demo.syntheticHint')}>
      <Tag color="purple" style={{ margin: 0 }}>
        {t('demo.synthetic')}
      </Tag>
    </Tooltip>
  );
}

/** Пара «подпись — значение» для карточек и сводок. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Space direction="vertical" size={0}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      <span>{children}</span>
    </Space>
  );
}
