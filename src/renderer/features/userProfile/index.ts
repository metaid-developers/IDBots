/**
 * Public surface of the user profile feature (D line, owner ruling 2026-11-09
 * 10:05). Everything a caller outside this directory may use.
 */
export { default as UserProfileAvatarButton } from './UserProfileAvatarButton';
export { default as UserProfilePage } from './UserProfilePage';
export { default as UserProfileMovedNotice } from './UserProfileMovedNotice';
export { default as MeCreditsPanel } from './MeCreditsPanel';
export {
  closeUserProfile,
  getUserProfileIdentity,
  getUserProfileOpen,
  openUserProfile,
  refreshUserProfileIdentity,
  subscribeUserProfileIdentity,
  subscribeUserProfileOpen,
} from './userProfileStore';
export type { UserProfileIdentity, UserProfileIdentitySnapshot } from './userProfileStore';
export {
  formatUserProfileCount,
  formatUserProfileFrozen,
  getUserProfileCopy,
  normalizeUserProfileLanguage,
  useUserProfileCopy,
} from './i18n';
export type { UserProfileCopy, UserProfileLanguage } from './i18n';
