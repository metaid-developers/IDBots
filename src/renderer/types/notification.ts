export type AgentNotificationCategory = 'work' | 'action' | 'report' | 'system';
export type AgentNotificationPriority = 'normal' | 'high';

export type AgentNotificationTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'scheduled_run'; taskId: string; runId: string; sessionId: string | null }
  | { kind: 'bot_automation'; metabotId: number; section: 'surf' | 'daily_report'; runId?: string };

export interface AgentNotification {
  eventId: string;
  type: string;
  category: AgentNotificationCategory;
  createdAt: number;
  metabotId: number | null;
  sessionId: string | null;
  taskId: string | null;
  runId: string | null;
  title: string;
  body: string;
  priority: AgentNotificationPriority;
  target: AgentNotificationTarget;
  readAt: number | null;
}

export interface AgentNotificationInput extends Omit<AgentNotification, 'createdAt' | 'readAt'> {
  createdAt?: number;
}

export interface AgentNotificationCursor {
  createdAt: number;
  eventId: string;
}

export interface AgentNotificationListOptions {
  category?: AgentNotificationCategory;
  unreadOnly?: boolean;
  limit?: number;
  before?: AgentNotificationCursor | null;
}

export interface AgentNotificationListResult {
  items: AgentNotification[];
  nextCursor: AgentNotificationCursor | null;
}

export interface AgentNotificationChangedEvent {
  eventId: string;
}
