import { pickTwinBotAvatar } from '../../renderer/assets/twinBotAvatar';

export function resolveNewBotAvatar(
  avatar: string | null | undefined,
  random: () => number = Math.random,
): string | null {
  return avatar === undefined ? pickTwinBotAvatar(random) : avatar;
}
