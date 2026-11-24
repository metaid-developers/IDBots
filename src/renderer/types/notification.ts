export type AgentNotificationCategory = 'work' | 'action' | 'report' | 'system';
export type AgentNotificationPriority = 'normal' | 'high';

export type AgentNotificationTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'scheduled_run'; taskId: string; runId: string; sessionId: string | null }
  | { kind: 'bot_automation'; metabotId: number; section: 'surf' | 'daily_report'; runId?: string }
  /**
   * N1/N2 (owner approval 2026-11-24 17:23): a 承办 bot's HTML 摘要件. The
   * click opens the session, brings its SHOWCASE tab to the digest, and puts
   * the caret back in the composer (态3). `sessionId` may be null when the
   * digest outlives its conversation — the row then degrades to text-only.
   */
  | { kind: 'artifact'; artifactUri: string; sessionId: string | null; taskId?: string | null };

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
