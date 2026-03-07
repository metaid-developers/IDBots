import io from '../socket-client.js';

function resolveSocketConfig() {
  const cfg = (typeof window !== 'undefined' && window.IDConfig) ? window.IDConfig : {};
  return {
    url: String(cfg.CHAT_WS || 'https://www.show.now').replace(/\/$/, ''),
    pathPrefix: String(cfg.CHAT_WS_PATH || '/socket').replace(/\/$/, ''),
  };
}

export class WsNewStore {
  constructor() {
    this.socket = null;
    this.currentMetaId = '';
    this.onMessage = null;
    this.onConnect = null;
    this.onDisconnect = null;
    this.isPlayingNotice = false;
    this.noticeAudioUrl = new URL('../../assets/audio/noctice.mp3', import.meta.url).href;
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
    this.socket = io(socketConfig.url, {
      path: `${socketConfig.pathPrefix}/socket.io`,
      query: {
        metaid,
        type,
      },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket', 'polling'],
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

  _handleReceivedMessage(data) {
    let wrapper = data;
    if (typeof data === 'string') {
      try {
        wrapper = JSON.parse(data);
      } catch (_) {
        return;
      }
    }
    if (!wrapper || typeof wrapper !== 'object') return;
    const messageType = String(wrapper.M || '');
    if (messageType === 'WS_SERVER_NOTIFY_GROUP_CHAT' || messageType === 'WS_SERVER_NOTIFY_PRIVATE_CHAT') {
      if (this.onMessage) this.onMessage(wrapper.D);
      this.playNotice();
    }
  }

  playNotice() {
    try {
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
