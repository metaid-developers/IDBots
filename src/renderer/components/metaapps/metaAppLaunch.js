export async function openSelectedMetaApp({ app, metaAppService }) {
  const result = await metaAppService.openMetaApp(app.id, app.entry);
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to open MetaApp');
  }
  return result;
}
