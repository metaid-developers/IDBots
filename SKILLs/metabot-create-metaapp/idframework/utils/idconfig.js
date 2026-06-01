/**
 * IDFramework API & Constants Configuration
 * Centralized config for base URLs and constant parameters used by delegates and components.
 * Applications can override window.IDConfig or window.ServiceLocator after this script loads.
 */
(function (global) {
  'use strict';

  var IDConfig = {
    // Assist Open API (user registration / pin with asset)
    ASSIST_OPEN_API_BASE: 'https://www.metaso.network/assist-open-api',
    // MVC gas reward endpoint (path appended to ASSIST_OPEN_API_BASE in usage)
    MVC_REWARDS_PATH: '/v1/assist/gas/mvc/address-reward',
    // MetaFS service base URL (user info, avatar)
    METAFS_BASE_URL: 'https://file.metaid.io/metafile-indexer/api/v1',
    // MetaFS uploader base URL (direct/chunked file upload)
    METAFS_UPLOAD_URL: 'https://file.metaid.io/metafile-uploader',
    // Default network: 'mainnet' | 'testnet'
    NETWORK: 'mainnet',
    // Address host for chatpubkey path (align with metafile-indexer; same as IDChat VITE_ADDRESS_HOST)
    ADDRESS_HOST: 'bc1p20k3x2c4mglfxr5wa5sgtgechwstpld80kru2cg4gmm4urvuaqqsvapxu0',
    // Default fee rate for pin operations
    FEE_RATE: 1,
    // Sign message for create user info
    SIGN_MESSAGE_CREATE_USER: 'create User Info',
    // Default avatar image URL when user has no avatar (empty or "/content/"). Uses default_avatar.png under assets.
    DEFAULT_AVATAR_URL: '',
    // Buzz list default path
    BUZZ_PATH: '/protocols/simplebuzz',
    // Buzz list default page size
    BUZZ_PAGE_SIZE: 20,
    // MetaFS user info endpoint by address
    METAFS_USER_BY_ADDRESS_PATH: '/users/address/',
  };

  // ServiceLocator defaults (used by UserDelegate / BusinessDelegate if not set in app)
  var DefaultServiceLocator = {
    metafs: IDConfig.METAFS_BASE_URL,
    metaid_man: 'https://manapi.metaid.io',
  };

  if (!global.ServiceLocator) {
    global.ServiceLocator = DefaultServiceLocator;
  } else {
    if (!global.ServiceLocator.metafs) global.ServiceLocator.metafs = IDConfig.METAFS_BASE_URL;
    if (!global.ServiceLocator.metaid_man) global.ServiceLocator.metaid_man = DefaultServiceLocator.metaid_man;
  }

  global.IDConfig = IDConfig;

  // Default profile save: update Alpine user store only (no chain write). Override window.__createOrUpdateUserInfoImpl for real registration.
  if (typeof global.__createOrUpdateUserInfoImpl === 'undefined') {
    global.__createOrUpdateUserInfoImpl = function (opts) {
      return Promise.resolve().then(function () {
        if (typeof Alpine === 'undefined') return { localOnly: true };
        var userStore = Alpine.store('user');
        if (!userStore || !userStore.user) return { localOnly: true };
        var u = userStore.user;
        var newUser = Object.assign({}, u);
        if (opts.userData && opts.userData.name !== undefined) newUser.name = opts.userData.name;
        if (opts.userData && opts.userData.bio !== undefined) newUser.bio = opts.userData.bio;
        if (opts.userData && opts.userData.avatar) newUser.avatarUrl = 'data:image/png;base64,' + opts.userData.avatar;
        userStore.user = newUser;
        return { localOnly: true };
      });
    };
  }
})(typeof window !== 'undefined' ? window : this);
