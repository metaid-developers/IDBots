export function filterMetaApps(apps, query) {
  const normalized = String(query ?? '').trim().toLowerCase();
  if (!normalized) {
    return [...apps];
  }

  return apps.filter((app) => {
    const name = String(app?.name ?? '').toLowerCase();
    const description = String(app?.description ?? '').toLowerCase();
    return name.includes(normalized) || description.includes(normalized);
  });
}

export function buildUseMetaAppPrompt(app) {
  const name = String(app?.name ?? '').trim() || 'MetaApp';
  return `请帮我使用本地元应用 ${name}。如果需要，请直接打开它，并基于这个应用继续协助我完成任务。`;
}

export function getRecommendedMetaAppsEmptyState(language = 'zh') {
  if (language === 'zh') {
    return {
      title: '推荐元应用即将开放',
      description: '这里将展示推荐安装的 MetaApp。当前版本先支持本地已安装元应用。',
    };
  }

  return {
    title: 'Recommended MetaApps Coming Soon',
    description: 'Recommended MetaApps will appear here. The current version focuses on locally installed MetaApps first.',
  };
}
