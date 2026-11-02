/**
 * OpenTeam invitee-side renderer types — mirror of the main-process shapes
 * returned by the openTeamCollab:* IPC surface. A membership records one local
 * bot auto-joining an external group task hosted on another machine.
 */

import type { GroupTaskMember } from './groupTask';

export type OpenTeamCollabStatus = 'active' | 'left';

/** How a guest membership ended (mirrors OpenTeamMembershipLeftCause in main). */
export type OpenTeamCollabLeftCause = 'kick' | 'self_check' | 'opt_out';

/** Host task status learned from the chair's [STATUS:...] group messages (main-side mirror). */
export type OpenTeamCollabTaskStatus = 'executing' | 'review' | 'done' | 'cancelled';

export interface OpenTeamCollabSummary {
  id: number;
  groupId: string;
  metabotId: number;
  /** Local bot display name (metabots.name); null when the bot row is gone. */
  botName: string | null;
  globalmetaid: string | null;
  inviterGlobalmetaid: string | null;
  taskTitle: string | null;
  invitePinId: string | null;
  joinedPinId: string | null;
  status: OpenTeamCollabStatus;
  createdAt: string | null;
  /** Total locally indexed group messages for the group. */
  messageCount: number;
  /** chain_timestamp of the newest indexed message; null when none. */
  lastMessageAt: number | null;
  /** When/why the membership ended (R4 "removed" notice); null while active. */
  leftAt: string | null;
  leftCause: OpenTeamCollabLeftCause | null;
  leftReason: string | null;
  /**
   * Latest host task status parsed from the chair's [STATUS:...] group messages;
   * null = unknown (legacy rows, or the chair never posted a tag). Drives the
   * badge: a task the host closed shows 已完成/已取消 here instead of an
   * eternal 进行中.
   */
  taskStatus: OpenTeamCollabTaskStatus | null;
  taskStatusUpdatedAt: string | null;
}

/** P0-1: one received [OPENTEAM_INVITE] on this machine, whatever its outcome. */
export type OpenTeamGuestInviteStatus = 'invited' | 'accepted' | 'declined' | 'skipped' | 'expired';

export interface OpenTeamGuestInvite {
  id: number;
  groupId: string;
  inviterGlobalmetaid: string;
  inviterName: string | null;
  taskTitle: string | null;
  goalSummary: string | null;
  requiredSkills: string[];
  invitePinId: string | null;
  targetGlobalmetaid: string | null;
  /** Envelope expiresAt (unix seconds); null when the envelope omitted it. */
  expiresAt: number | null;
  status: OpenTeamGuestInviteStatus;
  declineReason: string | null;
  joinedPinId: string | null;
  createdAt: string | null;
  respondedAt: string | null;
}

/** Member of an OpenTeam collab group (guest perspective) - uses GroupTaskMember. */
export type OpenTeamCollabMember = GroupTaskMember;
