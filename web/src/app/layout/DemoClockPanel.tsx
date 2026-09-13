import { useState, type JSX } from 'react';
import { Button, Popover, Radio, Space, Typography } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import { useClockStore } from '@/shared/clock/useClock';

/**
 * Панель управления модельным временем `[SPEC § 4.3]`.
 *
 * ADR-014: смещение и масштаб — **серверные**, они лежат в `core.Settings`
 * и применяются внутри `core.clock.now()`. Автопереходы выполняет Celery
 * по серверным часам, поэтому клиентская перемотка ничего бы не показала.
 *
 * На макетах панель меняет только клиентский стор — на M11 она начнёт
 * вызывать `PATCH /settings`. При `DEMO_DATA=false` панель не выводится
 * и изменение запрещено на уровне сервиса.
 */
export function DemoClockPanel(): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const scale = useClockStore((s) => s.scale);
  const nowUtc = useClockStore((s) => s.nowUtc);
  const sync = useClockStore((s) => s.sync);

  const shift = (hours: number): void => {
    const base = nowUtc ?? new Date(0);
    sync(new Date(base.getTime() + hours * 3_600_000).toISOString(), true, scale);
  };

  const content = (
    <Space direction="vertical" size={10} style={{ width: 240 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('clock.demoPanelHint')}
      </Typography.Text>

      <Space direction="vertical" size={4}>
        <Typography.Text style={{ fontSize: 12 }}>{t('clock.scale')}</Typography.Text>
        <Radio.Group
          size="small"
          value={scale}
          onChange={(e) => {
            const next = e.target.value as number;
            sync((nowUtc ?? new Date(0)).toISOString(), next !== 1, next);
          }}
          optionType="button"
          options={[
            { label: '×1', value: 1 },
            { label: '×60', value: 60 },
            { label: '×600', value: 600 },
          ]}
        />
      </Space>

      <Space direction="vertical" size={4}>
        <Typography.Text style={{ fontSize: 12 }}>{t('clock.rewind')}</Typography.Text>
        <Space size={4}>
          {[1, 6, 24].map((hours) => (
            <Button
              key={hours}
              size="small"
              onClick={() => {
                shift(hours);
              }}
            >
              +{hours} {t('clock.hoursShort')}
            </Button>
          ))}
        </Space>
      </Space>
    </Space>
  );

  return (
    <Popover
      content={content}
      title={t('clock.demoPanel')}
      trigger="click"
      open={open}
      onOpenChange={setOpen}
    >
      <Button size="small" icon={<ClockCircleOutlined />} aria-label={t('clock.demoPanel')} />
    </Popover>
  );
}
