import type { ThemeConfig } from 'antd';

/**
 * Тема Ant Design (`CLAUDE.md § 10`).
 *
 * Аудитория — диспетчеры, которые смотрят в экран по 12 часов, и финансисты,
 * которым нужна плотная таблица. Приоритет — плотность информации
 * и однозначность статусов, а не декоративность.
 *
 * Самописного CSS-фреймворка нет: база — тема через ConfigProvider.
 * Тёмная тема не требуется.
 */
export const socTheme: ThemeConfig = {
  token: {
    colorPrimary: '#1677ff',
    borderRadius: 4,
    fontSize: 13,
    // Моноширинный шрифт — только для номеров документов, кодов ИКАО
    // и колонок с суммами. Подключается точечно классом, не глобально.
    fontFamilyCode: "'JetBrains Mono', 'Consolas', monospace",
    // Анимации — только отклик на действие. Никаких въездов секций.
    motionDurationMid: '0.1s',
    motionDurationSlow: '0.15s',
  },
  components: {
    Table: { cellPaddingBlockSM: 4, cellPaddingInlineSM: 8 },
    Form: { itemMarginBottom: 12 },
    Card: { bodyPadding: 12 },
  },
};
