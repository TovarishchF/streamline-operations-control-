import { useState, type JSX, type ReactElement } from 'react';
import { App, Button, Popover, Radio, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { useSettings, useUpdateSettings } from '@/api/admin';
import { ApiError } from '@/api/client';
import { usePermission } from '@/shared/auth/session';

const SCALES = [1, 60, 600] as const;

/**
 * Панель управления модельным временем `[SPEC § 4.3]`.
 *
 * ADR-014: смещение и масштаб — **серверные**, они лежат в `core.Settings`
 * и применяются внутри `core.clock.now()`. Автопереходы выполняет Celery
 * по серверным часам, поэтому панель меняет настройки сервера
 * (`PATCH /settings`), а часы экрана догоняют их следующим запросом времени.
 * При `SAMPLE_DATA=false` панель не выводится, и изменение запрещено
 * на уровне сервиса. Менять время может администратор, остальные видят
 * текущее состояние.
 *
 * Открывается нажатием на часы в шапке: отдельной кнопки у панели нет.
 */
export function ModelClockPanel({ children }: { children: ReactElement }): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const isAdmin = usePermission('admin');
  const settings = useSettings(isAdmin && open);
  const update = useUpdateSettings();

  const apply = async (changes: { clockOffsetSeconds?: number; clockScale?: number }): Promise<void> => {
    try {
      await update.mutateAsync(changes);
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    }
  };

  const offset = settings.data?.clockOffsetSeconds ?? 0;
  const scale = settings.data?.clockScale ?? 1;

  const content = isAdmin ? (
    <Space direction="vertical" size={10} style={{ width: 260 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('clock.modelPanelHint')}
      </Typography.Text>

      <Space direction="vertical" size={4}>
        <Typography.Text style={{ fontSize: 12 }}>{t('clock.scale')}</Typography.Text>
        <Radio.Group
          size="small"
          value={scale}
          disabled={update.isPending || !settings.data}
          onChange={(e) => {
            void apply({ clockScale: e.target.value as number });
          }}
          optionType="button"
          options={SCALES.map((value) => ({ label: `×${String(value)}`, value }))}
        />
      </Space>

      <Space direction="vertical" size={4}>
        <Typography.Text style={{ fontSize: 12 }}>{t('clock.rewind')}</Typography.Text>
        <Space size={4} wrap>
          {[1, 6, 24].map((hours) => (
            <Button
              key={hours}
              size="small"
              disabled={update.isPending || !settings.data}
              onClick={() => {
                void apply({ clockOffsetSeconds: offset + hours * 3_600 });
              }}
            >
              {t('clock.plusHours', { hours })}
            </Button>
          ))}
          <Button
            size="small"
            disabled={update.isPending || !settings.data || (offset === 0 && scale === 1)}
            onClick={() => {
              void apply({ clockOffsetSeconds: 0, clockScale: 1 });
            }}
          >
            {t('clock.reset')}
          </Button>
        </Space>
      </Space>
    </Space>
  ) : (
    <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', width: 240 }}>
      {t('clock.adminOnly')}
    </Typography.Text>
  );

  return (
    <Popover
      content={content}
      title={t('clock.modelPanel')}
      trigger="click"
      open={open}
      onOpenChange={setOpen}
    >
      {children}
    </Popover>
  );
}
