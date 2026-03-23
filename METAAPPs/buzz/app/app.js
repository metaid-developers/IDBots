/**
 * Buzz demo bootstrap:
 * - service locator configuration
 * - model initialization
 * - command registration
 * - route/app-store sync
 * - component lazy loading
 */

window.ServiceLocator = {
  metaid_man: 'https://www.show.now/man',
  metafs: 'https://file.metaid.io/metafile-indexer/api/v1',
  man_api: 'https://man.metaid.io/api',
  idchat: 'https://api.idchat.io/chat-api/group-chat',
};

window.IDFrameworkConfig = {
  ...(window.IDFrameworkConfig || {}),
  routeComponentBasePath: '@idf/components/',
};

const BUZZ_I18N_CATALOGS = {
  en: {
    buzz: {
      page: {
        documentTitle: 'IDFramework - Buzz Feed Demo',
        title: 'Buzz Feed',
        subtitle: 'Decentralized Social Feed powered by MetaID',
      },
      tabs: {
        new: 'New',
        hot: 'Hot',
        following: 'Following',
        recommend: 'For You',
      },
      list: {
        emptyDefault: 'No buzz data.',
        emptyProfile: 'No posts from this profile.',
        guestFollowing: 'Connect wallet to view following feed.',
        guestRecommend: 'Connect wallet to view recommended feed.',
        fetchFailed: 'Failed to fetch buzz list',
        loadingBuzz: 'Loading buzz...',
        loadingMore: 'Loading more...',
        post: 'Post',
        backHome: 'Back Home',
        refresh: 'Refresh',
        headerTitleProfile: 'Profile Feed',
        headerTitleFeed: 'Buzz Feed',
        timelineSuffix: 'Timeline',
        metaidPrefix: 'MetaID: {metaid}',
        loadingQuotedBuzz: 'Loading quoted buzz...',
        loadingQuotedBuzzFailed: 'Failed to load quoted buzz',
        quoteLoadFailedRetry: 'Load failed, click retry',
        unknown: 'Unknown',
        expand: 'Expand',
        collapse: 'Collapse',
      },
      profile: {
        loadFailed: 'Failed to load profile header',
        displayNamePrefix: 'MetaID {metaid}',
        unknown: 'Unknown',
        connectWalletFirst: 'Please connect your wallet first',
        unfollowConfirm: 'Unfollow this user?',
        followCommandMissing: 'followUser command is not registered',
        unfollowCommandMissing: 'unfollowUser command is not registered',
        followedSuccess: 'Followed successfully',
        followFailed: 'Failed to follow',
        unfollowedSuccess: 'Unfollowed successfully',
        unfollowFailed: 'Failed to unfollow',
        self: 'You',
        processing: 'Processing...',
        follow: 'Follow',
        unfollow: 'Unfollow',
        following: 'Following',
        followers: 'Followers',
        loadingProfile: 'Loading profile...',
        metaidPrefix: 'MetaID: {metaid}',
      },
      userList: {
        fetchCommandMissing: 'fetchUserList command is not registered',
        loadFailed: 'Failed to load user list',
        loadingUsers: 'Loading users...',
        retry: 'Retry',
        empty: 'No users yet.',
        metaidPrefix: 'MetaID: {value}',
        addressPrefix: 'Address: {value}',
        loadMore: 'Load more',
        loading: 'Loading...',
        unknownUser: 'Unknown User',
        dialogAria: 'User relationship list',
        panelTitleFollowing: 'Following',
        panelTitleFollowers: 'Followers',
        close: 'Close',
        following: 'Following',
        followers: 'Followers',
      },
      follow: {
        resolveStatusFailed: 'Failed to resolve follow status',
        unfollowConfirm: 'Unfollow this user?',
        unfollowedSuccess: 'Unfollowed successfully',
        unfollowFailed: 'Failed to unfollow',
        followedSuccess: 'Followed successfully',
        followFailed: 'Failed to follow',
        self: 'You',
        processing: 'Processing...',
        follow: 'Follow',
        unfollow: 'Unfollow',
      },
      actions: {
        connectWalletFirst: 'Please connect your wallet first',
        alreadyLiked: 'You have already liked this buzz',
        likedSuccess: 'Liked successfully',
        likeFailed: 'Failed to like',
        repostConfirm: 'Repost this buzz now?',
        repostedSuccess: 'Reposted successfully',
        repostFailed: 'Failed to repost',
        loadCommentsFailed: 'Failed to load comments',
        enterComment: 'Please enter comment content',
        commentPosted: 'Comment posted successfully',
        commentFailed: 'Failed to comment',
        loadingComments: 'Loading comments...',
        noComments: 'No comments yet.',
        unknown: 'Unknown',
        comment: 'Comment',
        like: 'Like',
        liked: 'Liked',
        liking: 'Liking...',
        repost: 'Repost',
        reposting: 'Reposting...',
        quote: 'Quote',
        comments: 'Comments',
        close: 'Close',
        closeAria: 'Close',
        writeCommentPlaceholder: 'Write your comment...',
        cancel: 'Cancel',
        posting: 'Posting...',
        quoteBuzz: 'Quote Buzz',
        metaidPrefix: 'MetaID: {metaid}',
      },
      composer: {
        loadQuoteFailed: 'Failed to load quoted buzz',
        loadingQuotedBuzz: 'Loading quoted buzz...',
        quotePin: 'Quote Pin: {pin}',
        retry: 'Retry',
        unknown: 'Unknown',
        metaidPrefix: 'MetaID: {metaid}',
        noText: 'This buzz has no text content.',
        uploadLimit: 'You can upload up to {max} images.',
        onlyImages: 'Only image files are supported.',
        eachImageLimit: 'Each image must be smaller than 10MB.',
        frameworkUnavailable: 'IDFramework is not available',
        emptySubmit: 'Please enter content, add image, or keep quote pin.',
        postedSuccess: 'Buzz posted successfully',
        postFailed: 'Failed to post buzz',
        removeImageAria: 'Remove image',
        title: 'New Buzz',
        placeholder: "What's happening?",
        imagesCounter: 'Images: {count}/{max}',
        charsCounter: '{count} chars',
        addImages: 'Add Images ({remain})',
        emoji: 'Emoji',
        reset: 'Reset',
        cancel: 'Cancel',
        post: 'Post',
        posting: 'Posting...',
      },
    },
    connectButton: {
      connect: 'Connect',
      connecting: 'Connecting...',
      editProfile: 'Edit Profile',
      logout: 'Log Out',
    },
  },
  zh: {
    buzz: {
      page: {
        documentTitle: 'IDFramework - Buzz 流示例',
        title: 'Buzz 动态',
        subtitle: '由 MetaID 驱动的去中心化社交流',
      },
      tabs: {
        new: '最新',
        hot: '热门',
        following: '关注',
        recommend: '推荐',
      },
      list: {
        emptyDefault: '暂无动态',
        emptyProfile: '该用户暂无动态',
        guestFollowing: '请先连接钱包后查看关注流',
        guestRecommend: '请先连接钱包后查看推荐流',
        fetchFailed: '获取动态失败',
        loadingBuzz: '正在加载动态...',
        loadingMore: '正在加载更多...',
        post: '发布',
        backHome: '返回首页',
        refresh: '刷新',
        headerTitleProfile: '个人动态',
        headerTitleFeed: 'Buzz 动态',
        timelineSuffix: '时间线',
        metaidPrefix: 'MetaID: {metaid}',
        loadingQuotedBuzz: '正在加载引用动态...',
        loadingQuotedBuzzFailed: '加载引用动态失败',
        quoteLoadFailedRetry: '加载失败，点击重试',
        unknown: '未知',
        expand: '展开',
        collapse: '收起',
      },
      profile: {
        loadFailed: '加载资料头部失败',
        displayNamePrefix: 'MetaID {metaid}',
        unknown: '未知',
        connectWalletFirst: '请先连接钱包',
        unfollowConfirm: '确定取消关注该用户？',
        followCommandMissing: 'followUser 命令未注册',
        unfollowCommandMissing: 'unfollowUser 命令未注册',
        followedSuccess: '关注成功',
        followFailed: '关注失败',
        unfollowedSuccess: '取消关注成功',
        unfollowFailed: '取消关注失败',
        self: '你',
        processing: '处理中...',
        follow: '关注',
        unfollow: '取消关注',
        following: '关注',
        followers: '粉丝',
        loadingProfile: '正在加载资料...',
        metaidPrefix: 'MetaID: {metaid}',
      },
      userList: {
        fetchCommandMissing: 'fetchUserList 命令未注册',
        loadFailed: '加载用户列表失败',
        loadingUsers: '正在加载用户...',
        retry: '重试',
        empty: '暂无用户',
        metaidPrefix: 'MetaID: {value}',
        addressPrefix: '地址: {value}',
        loadMore: '加载更多',
        loading: '加载中...',
        unknownUser: '未知用户',
        dialogAria: '用户关系列表',
        panelTitleFollowing: '关注',
        panelTitleFollowers: '粉丝',
        close: '关闭',
        following: '关注',
        followers: '粉丝',
      },
      follow: {
        resolveStatusFailed: '获取关注状态失败',
        unfollowConfirm: '确定取消关注该用户？',
        unfollowedSuccess: '取消关注成功',
        unfollowFailed: '取消关注失败',
        followedSuccess: '关注成功',
        followFailed: '关注失败',
        self: '你',
        processing: '处理中...',
        follow: '关注',
        unfollow: '取消关注',
      },
      actions: {
        connectWalletFirst: '请先连接钱包',
        alreadyLiked: '你已经点赞过这条动态',
        likedSuccess: '点赞成功',
        likeFailed: '点赞失败',
        repostConfirm: '确定立即转发这条动态？',
        repostedSuccess: '转发成功',
        repostFailed: '转发失败',
        loadCommentsFailed: '加载评论失败',
        enterComment: '请输入评论内容',
        commentPosted: '评论发布成功',
        commentFailed: '评论发布失败',
        loadingComments: '正在加载评论...',
        noComments: '暂无评论',
        unknown: '未知',
        comment: '评论',
        like: '点赞',
        liked: '已点赞',
        liking: '点赞中...',
        repost: '转发',
        reposting: '转发中...',
        quote: '引用',
        comments: '评论',
        close: '关闭',
        closeAria: '关闭',
        writeCommentPlaceholder: '写下你的评论...',
        cancel: '取消',
        posting: '发布中...',
        quoteBuzz: '引用动态',
        metaidPrefix: 'MetaID: {metaid}',
      },
      composer: {
        loadQuoteFailed: '加载引用动态失败',
        loadingQuotedBuzz: '正在加载引用动态...',
        quotePin: '引用 Pin: {pin}',
        retry: '重试',
        unknown: '未知',
        metaidPrefix: 'MetaID: {metaid}',
        noText: '该动态没有文本内容',
        uploadLimit: '最多可上传 {max} 张图片。',
        onlyImages: '仅支持图片文件。',
        eachImageLimit: '每张图片必须小于 10MB。',
        frameworkUnavailable: 'IDFramework 不可用',
        emptySubmit: '请输入内容、添加图片，或保留引用 Pin。',
        postedSuccess: '发布成功',
        postFailed: '发布失败',
        removeImageAria: '移除图片',
        title: '发布动态',
        placeholder: '这一刻想分享什么？',
        imagesCounter: '图片: {count}/{max}',
        charsCounter: '{count} 字',
        addImages: '添加图片 ({remain})',
        emoji: '表情',
        reset: '重置',
        cancel: '取消',
        post: '发布',
        posting: '发布中...',
      },
    },
    connectButton: {
      connect: '连接钱包',
      connecting: '连接中...',
      editProfile: '编辑资料',
      logout: '退出登录',
    },
  },
};

let localeUiBound = false;

function getI18n() {
  if (typeof window === 'undefined' || !window.IDFramework || !window.IDFramework.I18n) return null;
  return window.IDFramework.I18n;
}

function t(key, fallback, params) {
  var i18n = getI18n();
  if (!i18n || typeof i18n.t !== 'function') return fallback || key;
  return i18n.t(key, params || {}, fallback || '');
}

function getLocale() {
  var i18n = getI18n();
  if (!i18n || typeof i18n.getLocale !== 'function') return 'en';
  var locale = String(i18n.getLocale() || '').trim().toLowerCase();
  return locale === 'zh' ? 'zh' : 'en';
}

function setLocale(nextLocale) {
  var i18n = getI18n();
  if (!i18n || typeof i18n.setLocale !== 'function') return;
  i18n.setLocale(nextLocale);
}

function applyPageI18n() {
  if (typeof document === 'undefined') return;
  var locale = getLocale();
  if (document.documentElement) {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }
  document.title = t('buzz.page.documentTitle', 'IDFramework - Buzz Feed Demo');
  var nodes = document.querySelectorAll('[data-i18n]');
  nodes.forEach(function (node) {
    var key = String(node.getAttribute('data-i18n') || '').trim();
    if (!key) return;
    var fallback = String(node.getAttribute('data-i18n-fallback') || node.textContent || '');
    node.textContent = t(key, fallback);
  });
}

function refreshLocaleButtons() {
  if (typeof document === 'undefined') return;
  var locale = getLocale();
  var buttons = document.querySelectorAll('[data-action="set-locale"]');
  buttons.forEach(function (button) {
    var value = String(button.getAttribute('data-locale-value') || '').trim().toLowerCase();
    var active = value === locale;
    if (button.classList && typeof button.classList.toggle === 'function') {
      button.classList.toggle('is-active', active);
    }
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function notifyBuzzUpdated() {
  document.dispatchEvent(new CustomEvent('id:buzz:updated'));
}

function bindLocaleSwitcher() {
  if (localeUiBound || typeof document === 'undefined') return;
  localeUiBound = true;

  document.querySelectorAll('[data-action="set-locale"]').forEach(function (button) {
    button.addEventListener('click', function () {
      var next = String(button.getAttribute('data-locale-value') || '').trim().toLowerCase();
      if (!next) return;
      setLocale(next);
    });
  });

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('id:i18n:changed', function () {
      applyPageI18n();
      refreshLocaleButtons();
      notifyBuzzUpdated();
    });
  }
}

function initBuzzI18n() {
  var i18n = getI18n();
  if (!i18n) return;
  if (typeof i18n.registerMessages === 'function') {
    i18n.registerMessages(BUZZ_I18N_CATALOGS);
  }
  if (typeof i18n.init === 'function') {
    i18n.init();
  }
  bindLocaleSwitcher();
  applyPageI18n();
  refreshLocaleButtons();
}

const BuzzModel = {
  tabs: {
    new: { list: [], nextCursor: '', hasMore: true, isLoading: false, error: '', total: 0 },
    hot: { list: [], nextCursor: '', hasMore: true, isLoading: false, error: '', total: 0 },
    following: { list: [], nextCursor: '', hasMore: true, isLoading: false, error: '', total: 0 },
    recommend: { list: [], nextCursor: '', hasMore: true, isLoading: false, error: '', total: 0 },
  },
  profile: {
    byMetaid: {},
  },
  profileHeader: {
    byMetaid: {},
  },
  userList: {
    byMetaid: {},
    pageSize: 10,
  },
  reportedRecommendIds: {},
  pageSize: 10,
  total: 0,
  nextCursor: '',
  lastUpdatedAt: null,
};

const UserModel = {
  users: {},
  isLoading: false,
  error: null,
};

function normalizeTab(raw) {
  var tab = String(raw || '').trim().toLowerCase();
  var allow = { new: true, hot: true, following: true, recommend: true };
  return allow[tab] ? tab : 'new';
}

function parseProfileMetaid(pathname) {
  var matched = String(pathname || '').match(/^\/profile\/([^/?#]+)/);
  if (!matched || !matched[1]) return '';
  try {
    return decodeURIComponent(matched[1]);
  } catch (_) {
    return matched[1];
  }
}

function isDemoDocumentPath() {
  var pathname = String(window.location.pathname || '');
  return /\/demo-buzz\/index\.html$/.test(pathname);
}

function normalizeRoutePath(pathname) {
  var path = String(pathname || '').trim();
  if (!path) return '/home/new';
  if (path[0] !== '/') path = '/' + path;
  return path;
}

function getRoutePathFromLocation() {
  if (isDemoDocumentPath()) {
    var hash = String(window.location.hash || '').replace(/^#/, '').trim();
    if (!hash) return '/home/new';
    return normalizeRoutePath(hash);
  }
  return normalizeRoutePath(window.location.pathname || '/home/new');
}

function replaceRouteInLocation(nextPath) {
  var routePath = normalizeRoutePath(nextPath);
  if (isDemoDocumentPath()) {
    var targetHash = '#' + routePath;
    if (window.location.hash === targetHash) return;
    var base = String(window.location.pathname || '/demo-buzz/index.html') + String(window.location.search || '');
    window.history.replaceState({}, '', base + targetHash);
    return;
  }
  if (window.location.pathname === routePath) return;
  window.history.replaceState({}, '', routePath);
}

function normalizeRoute(pathname) {
  var path = normalizeRoutePath(pathname || '/');
  if (!path || path === '/' || path === '/home') {
    return {
      path: '/home/new',
      tab: 'new',
      profileMetaid: '',
      params: { tab: 'new' },
      shouldRewrite: true,
    };
  }

  if (path.indexOf('/home/') === 0) {
    var tab = normalizeTab(path.slice('/home/'.length));
    var canonical = '/home/' + tab;
    return {
      path: canonical,
      tab: tab,
      profileMetaid: '',
      params: { tab: tab },
      shouldRewrite: canonical !== path,
    };
  }

  if (path.indexOf('/profile/') === 0) {
    var metaid = parseProfileMetaid(path);
    return {
      path: path,
      tab: '',
      profileMetaid: metaid,
      params: { metaid: metaid },
      shouldRewrite: false,
    };
  }

  return {
    path: '/home/new',
    tab: 'new',
    profileMetaid: '',
    params: { tab: 'new' },
    shouldRewrite: true,
  };
}

function ensureAppStoreShape() {
  if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
  var app = Alpine.store('app');
  if (!app) return null;
  if (!app.route || typeof app.route !== 'object') app.route = {};
  if (!app.route.params || typeof app.route.params !== 'object') app.route.params = {};
  if (!app.buzzTab) app.buzzTab = 'new';
  if (app.profileMetaid === undefined || app.profileMetaid === null) app.profileMetaid = '';
  return app;
}

function ensureBuzzStoreShape() {
  if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
  var buzz = Alpine.store('buzz');
  if (!buzz) return null;
  if (!buzz.tabs || typeof buzz.tabs !== 'object') buzz.tabs = {};
  ['new', 'hot', 'following', 'recommend'].forEach(function (tab) {
    if (!buzz.tabs[tab] || typeof buzz.tabs[tab] !== 'object') {
      buzz.tabs[tab] = {};
    }
    if (!Array.isArray(buzz.tabs[tab].list)) buzz.tabs[tab].list = [];
    if (buzz.tabs[tab].nextCursor === undefined) buzz.tabs[tab].nextCursor = '';
    if (buzz.tabs[tab].hasMore === undefined) buzz.tabs[tab].hasMore = true;
    if (buzz.tabs[tab].isLoading === undefined) buzz.tabs[tab].isLoading = false;
    if (buzz.tabs[tab].error === undefined) buzz.tabs[tab].error = '';
    if (buzz.tabs[tab].total === undefined) buzz.tabs[tab].total = 0;
  });
  if (!buzz.profile || typeof buzz.profile !== 'object') buzz.profile = { byMetaid: {} };
  if (!buzz.profile.byMetaid || typeof buzz.profile.byMetaid !== 'object') buzz.profile.byMetaid = {};
  if (!buzz.profileHeader || typeof buzz.profileHeader !== 'object') buzz.profileHeader = { byMetaid: {} };
  if (!buzz.profileHeader.byMetaid || typeof buzz.profileHeader.byMetaid !== 'object') buzz.profileHeader.byMetaid = {};
  if (!buzz.userList || typeof buzz.userList !== 'object') buzz.userList = {};
  if (!buzz.userList.byMetaid || typeof buzz.userList.byMetaid !== 'object') buzz.userList.byMetaid = {};
  if (!buzz.userList.pageSize || !Number.isFinite(Number(buzz.userList.pageSize)) || Number(buzz.userList.pageSize) <= 0) {
    buzz.userList.pageSize = Number(buzz.pageSize) > 0 ? Number(buzz.pageSize) : 10;
  }
  if (!buzz.followRelation || typeof buzz.followRelation !== 'object') buzz.followRelation = {};
  if (!buzz.followRelation.byTarget || typeof buzz.followRelation.byTarget !== 'object') buzz.followRelation.byTarget = {};
  if (!buzz.reportedRecommendIds || typeof buzz.reportedRecommendIds !== 'object') buzz.reportedRecommendIds = {};
  if (!buzz.pageSize || !Number.isFinite(Number(buzz.pageSize)) || Number(buzz.pageSize) <= 0) buzz.pageSize = 10;
  return buzz;
}

function syncRouteToStore(rewriteIfNeeded) {
  var currentPath = getRoutePathFromLocation();
  var route = normalizeRoute(currentPath);
  if (route.shouldRewrite && (rewriteIfNeeded || route.path !== currentPath)) {
    replaceRouteInLocation(route.path);
  }

  var app = ensureAppStoreShape();
  if (app) {
    app.route.path = route.path;
    app.route.params = route.params;
    if (route.tab) app.buzzTab = route.tab;
    app.profileMetaid = route.profileMetaid || '';
  }
}

window.addEventListener('alpine:init', function () {
  var initFramework = function () {
    if (!window.IDFramework) {
      setTimeout(initFramework, 10);
      return;
    }
    IDFramework.init({
      buzz: BuzzModel,
      user: UserModel,
    });
    ensureAppStoreShape();
    ensureBuzzStoreShape();
    syncRouteToStore(true);
  };

  initFramework();
});

window.addEventListener('DOMContentLoaded', async function () {
  function waitForAlpine() {
    return new Promise(function (resolve) {
      if (window.Alpine && typeof window.Alpine.store === 'function') {
        resolve();
        return;
      }

      var checkInterval = setInterval(function () {
        if (window.Alpine && typeof window.Alpine.store === 'function') {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);

      setTimeout(function () {
        clearInterval(checkInterval);
        resolve();
      }, 12000);
    });
  }

  await waitForAlpine();

  if (!window.IDFramework) {
    console.error('IDFramework is not loaded. Please include idframework.js before app.js');
    return;
  }

  IDFramework.init({
    buzz: BuzzModel,
    user: UserModel,
  });
  ensureAppStoreShape();
  ensureBuzzStoreShape();
  syncRouteToStore(true);
  initBuzzI18n();

  IDFramework.IDController.register('fetchUser', '@idf/commands/FetchUserCommand.js');
  IDFramework.IDController.register('fetchUserInfo', '@idf/commands/FetchUserInfoCommand.js');
  IDFramework.IDController.register('fetchBuzz', '@idf/commands/FetchBuzzCommand.js');
  IDFramework.IDController.register('reportBuzzViewed', '@idf/commands/ReportBuzzViewedCommand.js');
  IDFramework.IDController.register('fetchProfileHeader', '@idf/commands/FetchProfileHeaderCommand.js');
  IDFramework.IDController.register('fetchFollowRelation', '@idf/commands/FetchFollowRelationCommand.js');
  IDFramework.IDController.register('fetchUserList', '@idf/commands/FetchUserListCommand.js');
  IDFramework.IDController.register('followUser', '@idf/commands/FollowUserCommand.js');
  IDFramework.IDController.register('unfollowUser', '@idf/commands/UnfollowUserCommand.js');
  IDFramework.IDController.register('postBuzz', '@idf/commands/PostBuzzCommand.js');
  IDFramework.IDController.register('likeBuzz', '@idf/commands/LikeBuzzCommand.js');
  IDFramework.IDController.register('postComment', '@idf/commands/PostCommentCommand.js');
  IDFramework.IDController.register('fetchBuzzComments', '@idf/commands/FetchBuzzCommentsCommand.js');
  IDFramework.IDController.register('sendChatMessage', '@idf/commands/SendChatMessageCommand.js');
  IDFramework.IDController.register('getPinDetail', '@idf/commands/GetPinDetailCommand.js');
  IDFramework.IDController.register('checkWebViewBridge', '@idf/commands/CheckWebViewBridgeCommand.js');
  IDFramework.IDController.register('checkBtcAddressSameAsMvc', '@idf/commands/CheckBtcAddressSameAsMvcCommand.js');

  try {
    await IDFramework.loadComponent('@idf/components/id-connect-button.js');
  } catch (error) {
    console.error('Failed to load id-connect-button:', error);
  }

  try {
    await IDFramework.loadComponent('@idf/components/id-userinfo-float-panel.js');
  } catch (error) {
    console.error('Failed to load id-userinfo-float-panel:', error);
  }

  try {
    await IDFramework.loadComponent('@idf/components/id-buzz-tabs.js');
  } catch (error) {
    console.error('Failed to load id-buzz-tabs:', error);
  }

  try {
    await IDFramework.loadComponent('@idf/components/id-profile-header.js');
  } catch (error) {
    console.error('Failed to load id-profile-header:', error);
  }

  try {
    await IDFramework.loadComponent('@idf/components/id-user-list.js');
  } catch (error) {
    console.error('Failed to load id-user-list:', error);
  }

  try {
    await IDFramework.loadComponent('@idf/components/id-buzz-list.js');
  } catch (error) {
    console.error('Failed to load id-buzz-list:', error);
  }

  window.addEventListener('popstate', function () {
    syncRouteToStore(false);
  });

  window.addEventListener('hashchange', function () {
    syncRouteToStore(false);
  });

  document.addEventListener('id:buzz:tab-change', function () {
    syncRouteToStore(false);
  });
});
