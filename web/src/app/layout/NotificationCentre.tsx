import type { JSX } from 'react';
import { Button, Drawer, Empty, List, Space, Spin, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useMarkNotificationRead, useNotifications } from '@/api/comms';
import { UtcTime } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const SEVERITY_TOKEN = {
  info: 'progress',
  warning: 'warning',
  critical: 'critical',
} as const;

/**
 * Центр уведомлений `[ТЗ 3.5.1]`. События — из `SPEC.md § 8.1`.
 *
 * Уведомление адресное: сервер отдаёт только свои, и фильтровать чужие
 * на клиенте не приходится.
 */
export function NotificationCentre({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const notifications = useNotifications();
  const markRead = useMarkNotificationRead();

  const items = notifications.data?.data ?? [];

  return (
    <Drawer
      title={t('nav.notifications')}
      placement="right"
      width={420}
      open={open}
      onClose={onClose}
    >
      <Spin spinning={notifications.isLoading}>
        {items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('notifications.empty')} />
        ) : (
          <List
            dataSource={items}
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
                    {item.body ? (
                      <Typography.Text type="secondary">{item.body}</Typography.Text>
                    ) : null}
                    <Space size={8} wrap>
                      <UtcTime value={item.createdAt} withDate />
                      {item.link ? (
                        <Link to={item.link} onClick={onClose}>
                          {t('notifications.open')}
                        </Link>
                      ) : null}
                      {item.readAt ? null : (
                        <Button
                          size="small"
                          type="link"
                          style={{ padding: 0 }}
                          onClick={() => {
                            markRead.mutate(item.id);
                          }}
                        >
                          {t('notifications.markRead')}
                        </Button>
                      )}
                    </Space>
                  </Space>
                </List.Item>
              );
            }}
          />
        )}
      </Spin>
    </Drawer>
  );
}
