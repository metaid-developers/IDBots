import { BUILTIN_AVATARS, type BuiltinAvatar } from './builtinAvatarCatalog';

export { BUILTIN_AVATARS, type BuiltinAvatar };

export function getBuiltinAvatarByReference(reference: string | null | undefined): BuiltinAvatar | undefined {
  const normalized = typeof reference === 'string' ? reference.trim() : '';
  return BUILTIN_AVATARS.find((avatar) => avatar.metafileUri === normalized);
}

export function builtinAvatarSrc(avatar: BuiltinAvatar): string {
  return `${import.meta.env?.BASE_URL ?? './'}${avatar.src}`;
}
