import { useEffect, useState, type JSX } from 'react';
import { Alert, App, Button, Drawer, Space, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import { useBuildScr, type SlotRow } from '@/api/slots';
import { Mono } from '@/shared/ui/primitives';

/**
 * Черновик сообщения SCR `[ТЗ 4.2]` (ADR-026).
 *
 * Сообщение не отправляется отсюда: публичного интерфейса слот-координации
 * не существует (`INTEGRATIONS § 5.1`). Диспетчер копирует текст, правит
 * и отправляет письмом координатору — это и есть заявленный инструмент
 * подготовки переписки, и назвать его подключением было бы неправдой.
 */
export function ScrDrawer({
  slot,
  onClose,
}: {
  slot: SlotRow | null;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const buildScr = useBuildScr();
  const [text, setText] = useState('');

  useEffect(() => {
    if (slot === null) {
      setText('');
      return;
    }
    buildScr.mutate(slot.id, { onSuccess: (result) => { setText(result.text); } });
    // Сборка запускается на открытие конкретного слота; мутация в зависимости
    // не идёт — она меняется на каждом рендере и зациклила бы эффект.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot?.id]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      void message.success(t('slots.copied'));
    } catch {
      // Буфер обмена недоступен вне защищённого контекста: текст виден
      // на экране, и выделить его можно руками.
      void message.warning(t('slots.copyFailed'));
    }
  };

  return (
    <Drawer
      open={slot !== null}
      width={620}
      title={t('slots.buildScr')}
      onClose={onClose}
      extra={
        <Button
          icon={<CopyOutlined />}
          disabled={!text}
          onClick={() => {
            void copy();
          }}
        >
          {t('slots.copy')}
        </Button>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert type="info" showIcon message={t('slots.scrNotice')} />

        {buildScr.isError ? (
          <Alert type="error" showIcon message={t('slots.scrFailed')} />
        ) : null}

        {buildScr.data ? (
          <Typography.Text type="secondary">
            {t('slots.messageRef')}: <Mono>{buildScr.data.messageRef}</Mono>
          </Typography.Text>
        ) : null}

        <Input value={text} onChange={setText} loading={buildScr.isPending} />

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('slots.scrDraftHint')}
        </Typography.Text>
      </Space>
    </Drawer>
  );
}

/** Правимый текст сообщения: черновик правится до отправки. */
function Input({
  value,
  onChange,
  loading,
}: {
  value: string;
  onChange: (next: string) => void;
  loading: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <textarea
      value={loading && !value ? t('common.loading') : value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      rows={14}
      spellCheck={false}
      style={{
        width: '100%',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.5,
        padding: 12,
        borderRadius: 6,
        border: '1px solid #d9d9d9',
        resize: 'vertical',
      }}
    />
  );
}
