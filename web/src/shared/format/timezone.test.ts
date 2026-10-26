import { describe, expect, it } from 'vitest';

import { zoneAbbreviation } from './timezone';

// Момент передаётся явно: смещение зависит от даты (CLAUDE.md § 3 п. 2).
const AT = new Date('2026-10-23T08:13:00Z');

describe('zoneAbbreviation', () => {
  it('подписывает Москву как MSK+0', () => {
    expect(zoneAbbreviation('Europe/Moscow', AT)).toBe('MSK+0');
  });

  it('подписывает зоны России смещением от Москвы', () => {
    expect(zoneAbbreviation('Europe/Samara', AT)).toBe('MSK+1');
    expect(zoneAbbreviation('Asia/Yekaterinburg', AT)).toBe('MSK+2');
    expect(zoneAbbreviation('Asia/Kamchatka', AT)).toBe('MSK+9');
    expect(zoneAbbreviation('Europe/Kaliningrad', AT)).toBe('MSK-1');
  });

  it('прочие зоны подписывает смещением от UTC', () => {
    expect(zoneAbbreviation('Asia/Dubai', AT)).toBe('UTC+4');
    expect(zoneAbbreviation('UTC', AT)).toBe('UTC');
  });
});
