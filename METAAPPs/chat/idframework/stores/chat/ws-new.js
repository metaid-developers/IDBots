import io from '../../vendors/socket-client.js';

export const CHAT_SOCKET_NOTIFY_TYPES = new Set([
  'WS_SERVER_NOTIFY_GROUP_CHAT',
  'WS_SERVER_NOTIFY_PRIVATE_CHAT',
]);

function maybeParseJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;
  const firstChar = text.charAt(0);
  if (firstChar !== '{' && firstChar !== '[') return value;
  try {
    return JSON.parse(text);
  } catch (_) {
    return value;
  }
}

export function normalizeSocketEnvelope(data, forcedMessageType = '') {
  const forcedType = String(forcedMessageType || '').trim();
  if (forcedType) {
    if (!CHAT_SOCKET_NOTIFY_TYPES.has(forcedType)) return null;
    return {
      messageType: forcedType,
      payload: maybeParseJson(data),
    };
  }

  const wrapper = maybeParseJson(data);
  if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) return null;

  const messageType = String(wrapper.M || '').trim();
  if (!CHAT_SOCKET_NOTIFY_TYPES.has(messageType)) return null;

  const payloadSource = wrapper.D !== undefined
    ? wrapper.D
    : (wrapper.data !== undefined ? wrapper.data : wrapper);
  return {
    messageType: messageType,
    payload: maybeParseJson(payloadSource),
  };
}

export function resolveSocketConfig() {
  const cfg = (typeof window !== 'undefined' && window.IDConfig) ? window.IDConfig : {};
  const locator = (typeof window !== 'undefined' && window.ServiceLocator)
    ? window.ServiceLocator
    : {};
  let fallbackUrl = '';
  try {
    if (locator && locator.idchat) {
      fallbackUrl = new URL(String(locator.idchat)).origin;
    }
  } catch (_) {
    fallbackUrl = '';
  }
  return {
    url: String(
      cfg.CHAT_WS ||
      locator.chat_ws ||
      fallbackUrl ||
      'https://api.idchat.io'
    ).replace(/\/$/, ''),
    pathPrefix: String(
      cfg.CHAT_WS_PATH !== undefined
        ? cfg.CHAT_WS_PATH
        : (locator.chat_ws_path !== undefined ? locator.chat_ws_path : '')
    ).replace(/\/$/, ''),
  };
}

export function resolveSocketTransports() {
  const cfg = (typeof window !== 'undefined' && window.IDConfig) ? window.IDConfig : {};
  const locator = (typeof window !== 'undefined' && window.ServiceLocator)
    ? window.ServiceLocator
    : {};
  const configured = cfg.CHAT_WS_TRANSPORTS !== undefined
    ? cfg.CHAT_WS_TRANSPORTS
    : locator.chat_ws_transports;

  const normalize = (value) => {
    const text = String(value || '').trim().toLowerCase();
    if (text !== 'websocket' && text !== 'polling') return '';
    return text;
  };

  let list = [];
  if (Array.isArray(configured)) {
    list = configured.map(normalize).filter(Boolean);
  } else if (typeof configured === 'string' && configured.trim()) {
    list = configured
      .split(',')
      .map(normalize)
      .filter(Boolean);
  }

  if (!list.length) return ['websocket'];
  return Array.from(new Set(list));
}

export function resolveSocketPath(pathPrefix) {
  const prefix = String(pathPrefix || '').trim().replace(/\/$/, '');
  return prefix ? `${prefix}/socket.io` : '/socket.io';
}

export class WsNewStore {
  constructor() {
    this.socket = null;
    this.currentMetaId = '';
    this.onMessage = null;
    this.onConnect = null;
    this.onDisconnect = null;
    this.isPlayingNotice = false;
    this.noticeAudioUrl = String(
      (typeof window !== 'undefined' &&
        window.IDConfig &&
        window.IDConfig.CHAT_NOTICE_AUDIO_URL) || ''
    ).trim();
  }

  connect(options) {
    const opts = options || {};
    const metaid = String(opts.metaid || '').trim();
    if (!metaid) throw new Error('metaid is required for ws connect');
    const type = String(opts.type || 'pc');
    this.currentMetaId = metaid;
    this.onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : null;
    this.onConnect = typeof opts.onConnect === 'function' ? opts.onConnect : null;
    this.onDisconnect = typeof opts.onDisconnect === 'function' ? opts.onDisconnect : null;

    if (this.socket) {
      this.disconnect();
    }

    const socketConfig = resolveSocketConfig();
    const socketPath = resolveSocketPath(socketConfig.pathPrefix);
    const transports = resolveSocketTransports();
    this.socket = io(socketConfig.url, {
      path: socketPath,
      query: {
        metaid,
        type,
      },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports,
      upgrade: transports.includes('polling'),
      rememberUpgrade: true,
    });

    this.socket.on('connect', () => {
      if (this.onConnect) this.onConnect();
    });

    this.socket.on('disconnect', () => {
      if (this.onDisconnect) this.onDisconnect();
    });

    this.socket.on('message', (data) => {
      this._handleReceivedMessage(data);
    });

    this.socket.on('WS_SERVER_NOTIFY_GROUP_CHAT', (data) => {
      this._handleReceivedMessage(data, 'WS_SERVER_NOTIFY_GROUP_CHAT');
    });

    this.socket.on('WS_SERVER_NOTIFY_PRIVATE_CHAT', (data) => {
      this._handleReceivedMessage(data, 'WS_SERVER_NOTIFY_PRIVATE_CHAT');
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  isConnected() {
    return !!(this.socket && this.socket.connected);
  }

  _handleReceivedMessage(data, forcedMessageType = '') {
    const normalized = normalizeSocketEnvelope(data, forcedMessageType);
    if (!normalized) return;
    if (this.onMessage) this.onMessage(normalized.payload);
    this.playNotice();
  }

  playNotice() {
    try {
      if (!this.noticeAudioUrl) return;
      if (this.isPlayingNotice) return;
      this.isPlayingNotice = true;
      const audio = new Audio(this.noticeAudioUrl);
      audio.volume = 0.7;
      audio.onended = () => {
        setTimeout(() => {
          this.isPlayingNotice = false;
        }, 2500);
      };
      audio.onerror = () => {
        // Disable repeated failed requests (for example missing local asset).
        this.noticeAudioUrl = '';
        this.isPlayingNotice = false;
      };
      audio.play().catch(() => {
        this.isPlayingNotice = false;
      });
    } catch (_) {
      this.isPlayingNotice = false;
    }
  }
}

let singleton = null;
export function getWsNewStore() {
  if (!singleton) singleton = new WsNewStore();
  return singleton;
}
