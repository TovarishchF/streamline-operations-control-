import type { JSX } from 'react';
import { Drawer, Empty, List, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { NOTIFICATIONS } from '@/mocks/comms';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const SEVERITY_TOKEN = {
  info: 'progress',
  warning: 'warning',
  critical: 'critical',
} as const;

/** Центр уведомлений `[ТЗ 3.5.1]`. События — из `SPEC.md § 8.1`. */
export function NotificationCentre({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();

  return (
    <Drawer
      title={t('nav.notifications')}
      placement="right"
      width={420}
      open={open}
      onClose={onClose}
    >
      {NOTIFICATIONS.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('notifications.empty')} />
      ) : (
        <List
          dataSource={NOTIFICATIONS}
          renderItem={(item) => {
            const token = STATUS_TOKENS[SEVERITY_TOKEN[item.severity]];
            return (
              <List.Item
                style={{
                  borderInlineStart: `3px solid ${token.color}`,
                  paddingInlineStart: 12,
                  background: item.readAt ? undefined : token.background,
                }}
              >
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space size={6} wrap>
                    <Typography.Text strong>{item.title}</Typography.Text>
                    <Tag
                      style={{
                        color: token.color,
                        background: 'transparent',
                        borderColor: token.border,
                        margin: 0,
                      }}
                    >
                      {t(`notificationKind.${item.kind}`)}
                    </Tag>
                  </Space>
                  <Typography.Text type="secondary">{item.body}</Typography.Text>
                  {item.link ? (
                    <Link to={item.link} onClick={onClose}>
                      {t('notifications.open')}
                    </Link>
                  ) : null}
                </Space>
              </List.Item>
            );
          }}
        />
      )}
    </Drawer>
  );
}
