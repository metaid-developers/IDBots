// Official skill from MetaWeb (sync status)
export type OfficialSkillStatus = 'download' | 'update' | 'installed' | 'conflict';

export interface OfficialSkillItem {
  name: string;
  remoteVersion: string;
  skillFileUri: string;
  remoteCreator: string;
  description?: string;
  status: OfficialSkillStatus;
  localVersion?: string;
  localCreator?: string;
}

// Skill type definition
export interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;       // Whether visible in popover
  isOfficial: boolean;    // "官方" badge
  isBuiltIn: boolean;     // Bundled with app, cannot be deleted
  updatedAt: number;      // Timestamp
  prompt: string;         // System prompt content
  skillPath: string;      // Absolute path to SKILL.md
}
