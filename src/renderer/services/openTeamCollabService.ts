import type { GroupChatTranscriptMessage } from '../types/groupTask';
import type { OpenTeamCollabSummary, OpenTeamGuestInvite, OpenTeamCollabMember } from '../types/openTeamCollab';

/**
 * Renderer-side wrapper for the openTeamCollab:* IPC surface (invitee-side
 * traceability). No redux slice — the Group Tasks view keeps this data in
 * component-local state, like the group-task detail transcript.
 */
class OpenTeamCollabService {
  async list(): Promise<OpenTeamCollabSummary[]> {
    const api = window.electron?.openTeamCollab;
    if (!api) return [];
    const result = await api.list();
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to load external collaborations');
    }
    return (result.items ?? []) as OpenTeamCollabSummary[];
  }

  async listMessages(
    groupId: string,
    opts?: { beforeId?: number; limit?: number },
  ): Promise<GroupChatTranscriptMessage[]> {
    const api = window.electron?.openTeamCollab;
    if (!api) throw new Error('OpenTeam collab API unavailable');
    const result = await api.listMessages({ groupId, ...opts });
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to load messages');
    }
    return (result.messages ?? []) as GroupChatTranscriptMessage[];
  }

  // P0-1: received-invite history (every [OPENTEAM_INVITE] on this machine,
  // joined or not), newest first.
  async listGuestInvites(): Promise<OpenTeamGuestInvite[]> {
    const api = window.electron?.openTeamCollab;
    if (!api) return [];
    const result = await api.listGuestInvites();
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to load received OpenTeam invites');
    }
    return (result.items ?? []) as OpenTeamGuestInvite[];
  }

  async getMembers(groupId: string): Promise<OpenTeamCollabMember[]> {
    const api = window.electron?.openTeamCollab;
    if (!api) throw new Error('OpenTeam collab API unavailable');
    const result = await api.getMembers({ groupId });
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to load members');
    }
    return (result.members ?? []) as OpenTeamCollabMember[];
  }
}

export const openTeamCollabService = new OpenTeamCollabService();
