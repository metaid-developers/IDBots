export async function openSelectedMetaApp({ app, metaAppService }) {
  const result = await metaAppService.openMetaApp(app.id, app.entry);
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to open MetaApp');
  }
  return result;
}

export async function openMetaAppDirectory({ app, shell }) {
  const appRoot = String(app?.appRoot || '').trim();
  if (!appRoot) {
    throw new Error('MetaApp local directory is missing');
  }

  const result = await shell.openPath(appRoot);
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to open MetaApp directory');
  }
  return result;
}
