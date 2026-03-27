export function filterMetaApps(apps, query) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) {
    return [...apps];
  }

  return apps.filter((app) => {
    const name = String(app?.name || '').toLowerCase();
    const description = String(app?.description || '').toLowerCase();
    return name.includes(normalized) || description.includes(normalized);
  });
}

export function filterCommunityMetaApps(apps, query) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) {
    return [...apps];
  }

  return apps.filter((app) => {
    const name = String(app?.name || '').toLowerCase();
    const description = String(app?.description || '').toLowerCase();
    const creatorMetaId = String(app?.creatorMetaId || '').toLowerCase();
    return name.includes(normalized) || description.includes(normalized) || creatorMetaId.includes(normalized);
  });
}

export function buildUseMetaAppPrompt(app) {
  const name = String(app?.name || '').trim() || 'MetaApp';
  return `请帮我使用本地元应用 ${name}。如果需要，请直接打开它，并基于这个应用继续协助我完成任务。`;
}

export function getMetaAppVisualModel(app) {
  const cover = String(app?.cover || '').trim();
  if (cover) {
    return { src: cover, kind: 'cover' };
  }

  const icon = String(app?.icon || '').trim();
  if (icon) {
    return { src: icon, kind: 'icon' };
  }

  return { src: null, kind: 'none' };
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

export function getCommunityMetaAppsEmptyState(language = 'zh') {
  if (language === 'zh') {
    return {
      title: '暂无链上第三方应用',
      description: '当前没有可展示的 /protocols/metaapp 记录。',
    };
  }

  return {
    title: 'No Chain Community MetaApps',
    description: 'No /protocols/metaapp records are available right now.',
  };
}

export function getCommunityMetaAppStatusLabel(status, language = 'zh') {
  const key = String(status || '').trim();
  const zh = {
    install: '可安装',
    update: '可更新',
    installed: '已安装',
    uninstallable: '不可安装',
  };
  const en = {
    install: 'Install',
    update: 'Update',
    installed: 'Installed',
    uninstallable: 'Unavailable',
  };

  if (language === 'zh') {
    return zh[key] || zh.uninstallable;
  }
  return en[key] || en.uninstallable;
}

export function getCommunityMetaAppActionLabel(status, language = 'zh') {
  const key = String(status || '').trim();
  const zh = {
    install: '安装',
    update: '更新',
    installed: '已安装',
    uninstallable: '不可安装',
  };
  const en = {
    install: 'Install',
    update: 'Update',
    installed: 'Installed',
    uninstallable: 'Unavailable',
  };

  if (language === 'zh') {
    return zh[key] || zh.uninstallable;
  }
  return en[key] || en.uninstallable;
}
