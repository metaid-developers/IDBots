import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentNotification, AgentNotificationCategory } from '@/types/notification';
import { getMobileElectron } from '../appBridge';
import { t } from '../../i18n';

export type NotificationFilter = 'unread' | 'all' | AgentNotificationCategory;

export function useNotifications(resyncCounter = 0) {
  const [items, setItems] = useState<AgentNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState<NotificationFilter>('unread');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    setError(null);
    try {
      const api = getMobileElectron().notification;
      const [listResult, countResult] = await Promise.all([
        api.list({ limit: 100 }),
        api.getUnreadCount(),
      ]);
      if (request !== requestRef.current) return;
      if (!listResult?.success || !Array.isArray(listResult.items)) throw new Error(listResult?.error ?? t('mobile.notifications.loadFailed'));
      if (!countResult?.success || typeof countResult.count !== 'number') throw new Error(countResult?.error ?? t('mobile.notifications.loadFailed'));
      setItems(listResult.items);
      setUnreadCount(countResult.count);
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : t('mobile.notifications.loadFailed'));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const off = getMobileElectron().notification.onChanged(() => void reload());
    return () => {
      requestRef.current += 1;
      off();
    };
  }, [reload, resyncCounter]);

  const markRead = useCallback(async (eventId: string): Promise<boolean> => {
    const result = await getMobileElectron().notification.markRead([eventId]);
    if (!result?.success) return false;
    const readAt = Date.now();
    setItems((current) => current.map((item) => item.eventId === eventId ? { ...item, readAt } : item));
    setUnreadCount((current) => Math.max(0, current - 1));
    return true;
  }, []);

  const markAllRead = useCallback(async (): Promise<boolean> => {
    const category = filter === 'all' || filter === 'unread' ? undefined : filter;
    const result = await getMobileElectron().notification.markAllRead(category);
    if (!result?.success) return false;
    await reload();
    return true;
  }, [filter, reload]);

  const visibleItems = useMemo(() => items.filter((item) => {
    if (filter === 'unread') return item.readAt === null;
    if (filter === 'all') return true;
    return item.category === filter;
  }), [filter, items]);

  return {
    items,
    visibleItems,
    unreadCount,
    filter,
    setFilter,
    loading,
    error,
    reload,
    markRead,
    markAllRead,
  };
}

export function useNotificationUnreadCount(resyncCounter = 0): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let active = true;
    const reload = async () => {
      const result = await getMobileElectron().notification.getUnreadCount();
      if (active && result?.success && typeof result.count === 'number') setCount(result.count);
    };
    void reload();
    const off = getMobileElectron().notification.onChanged(() => void reload());
    return () => {
      active = false;
      off();
    };
  }, [resyncCounter]);
  return count;
}

export function useNotificationReadThrough(sessionId: string | null, active: boolean): void {
  useEffect(() => {
    if (!sessionId || !active) return undefined;
    const reconcile = async () => {
      const result = await getMobileElectron().notification.list({ category: 'work', unreadOnly: true, limit: 100 });
      if (!result?.success || !Array.isArray(result.items)) return;
      const eventIds = result.items
        .filter((item) => item.target.kind === 'session' && item.target.sessionId === sessionId)
        .map((item) => item.eventId);
      if (eventIds.length > 0) await getMobileElectron().notification.markRead(eventIds);
    };
    void reconcile();
    const off = getMobileElectron().notification.onChanged(() => void reconcile());
    return off;
  }, [sessionId, active]);
}

export type NotificationsController = ReturnType<typeof useNotifications>;
