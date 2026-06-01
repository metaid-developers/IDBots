/**
 * id-game-score-leaderboard - Web Component for game score leaderboard
 * Uses Shadow DOM with CSS Variables for theming
 * Structure (Layout) managed via CSS, Skin (Theme) managed via CSS Variables
 */

class IdGameScoreLeaderboard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._isOpen = false;
    this._isLoading = false;
    this._leaderboardData = [];
    this._gameInfo = null;
    this._metaAppPinId = this.getAttribute('meta-app-pin-id') || '';
  }

  static get observedAttributes() {
    return ['meta-app-pin-id'];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'meta-app-pin-id' && oldValue !== newValue) {
      this._metaAppPinId = newValue || '';
    }
  }

  connectedCallback() {
    this.render();
    this._setupEventListeners();
  }

  disconnectedCallback() {
    this._cleanupEventListeners();
  }

  render() {
    const styles = `
      <style>
        :host {
          display: block;
          font-family: var(--id-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
        }

        .leaderboard-button {
          display: flex;
          align-items: center;
          gap: var(--id-spacing-xs, 0.25rem);
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: var(--id-text-inverse, #ffffff);
          border: none;
          padding: var(--id-spacing-sm, 0.5rem) var(--id-spacing-md, 1rem);
          border-radius: var(--id-radius-button, 0.5rem);
          cursor: pointer;
          font-size: var(--id-font-size-base, 1rem);
          font-weight: var(--id-font-weight-semibold, 600);
          transition: all var(--id-transition-base, 0.2s);
          box-shadow: var(--id-shadow-md, 0 4px 6px rgba(0, 0, 0, 0.1));
        }

        .leaderboard-button-icon {
          width: 20px;
           margin-right:2px;
          height: 20px;
          fill: url(#trophy-gradient);
          filter: drop-shadow(0 2px 4px rgba(251, 191, 36, 0.4));
        }

        .leaderboard-button:hover {
          transform: translateY(-2px);
          box-shadow: var(--id-shadow-lg, 0 10px 15px rgba(0, 0, 0, 0.2));
        }

        .leaderboard-button:active {
          transform: translateY(0);
        }

        .modal-overlay {
          display: ${this._isOpen ? 'flex' : 'none'};
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          z-index: 10000;
          align-items: center;
          justify-content: center;
          padding: var(--id-spacing-md, 1rem);
          backdrop-filter: blur(4px);
        }

        .modal-content {
          background: linear-gradient(180deg, #1a1a2e 0%, #16213e 100%);
          border-radius: var(--id-radius-card, 0.5rem);
          width: 100%;
          max-width: 600px;
          max-height: 90vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
          border: 2px solid rgba(255, 215, 0, 0.3);
        }

        .modal-header {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          padding: var(--id-spacing-lg, 1.5rem);
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 2px solid rgba(255, 255, 255, 0.1);
        }

        .modal-title {
          color: var(--id-text-inverse, #ffffff);
          font-size: var(--id-font-size-lg, 1.125rem);
          font-weight: var(--id-font-weight-bold, 700);
          margin: 0;
          display: flex;
          align-items: center;
          gap: var(--id-spacing-sm, 0.5rem);
        }

        .game-icon {
          width: 32px;
          height: 32px;
          border-radius: var(--id-radius-small, 0.25rem);
          object-fit: cover;
        }

        .close-button {
          background: rgba(255, 255, 255, 0.2);
          border: none;
          color: var(--id-text-inverse, #ffffff);
          width: 32px;
          height: 32px;
          border-radius: 50%;
          cursor: pointer;
          font-size: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all var(--id-transition-base, 0.2s);
        }

        .close-button:hover {
          background: rgba(255, 255, 255, 0.3);
          transform: rotate(90deg);
        }

        .modal-body {
          flex: 1;
          overflow-y: auto;
          padding: var(--id-spacing-md, 1rem);
        }

        .loading {
          text-align: center;
          padding: var(--id-spacing-xl, 2rem);
          color: var(--id-text-secondary, #6b7280);
        }

        .leaderboard-list {
          list-style: none;
          padding: 0;
          margin: 0;
        }

        .leaderboard-item {
          display: flex;
          align-items: center;
          padding: var(--id-spacing-md, 1rem);
          margin-bottom: var(--id-spacing-sm, 0.5rem);
          background: rgba(255, 255, 255, 0.05);
          border-radius: var(--id-radius-card, 0.5rem);
          border: 1px solid rgba(255, 255, 255, 0.1);
          transition: all var(--id-transition-base, 0.2s);
        }

        .leaderboard-item:hover {
          background: rgba(255, 255, 255, 0.1);
          transform: translateX(4px);
        }

        .rank {
          width: 50px;
          text-align: center;
          font-weight: var(--id-font-weight-bold, 700);
          font-size: var(--id-font-size-lg, 1.125rem);
          color: #d1d5db;
          position: relative;
        }

        .rank-medal {
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 24px;
        }

        .medal-gold {
          background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
          border-radius: 50%;
          box-shadow: 0 4px 8px rgba(251, 191, 36, 0.4);
        }

        .medal-silver {
          background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%);
          border-radius: 50%;
          box-shadow: 0 4px 8px rgba(156, 163, 175, 0.4);
        }

        .medal-bronze {
          background: linear-gradient(135deg, #d97706 0%, #b45309 100%);
          border-radius: 50%;
          box-shadow: 0 4px 8px rgba(217, 119, 6, 0.4);
        }

        .top-badge {
          position: absolute;
          top: -8px;
          right: -8px;
          background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
          color: white;
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 10px;
          font-weight: bold;
          box-shadow: 0 2px 4px rgba(239, 68, 68, 0.4);
        }

        .avatar {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          object-fit: cover;
          margin-right: var(--id-spacing-md, 1rem);
          border: 2px solid rgba(255, 255, 255, 0.2);
        }

        .user-info {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .user-name {
          color: #e5e7eb;
          font-weight: var(--id-font-weight-semibold, 600);
          font-size: var(--id-font-size-base, 1rem);
        }

        .user-metaid {
          color: #f3f4f6;
          font-size: var(--id-font-size-sm, 0.875rem);
          font-family: monospace;
        }

        .score-container {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 4px;
        }

        .score {
          font-size: var(--id-font-size-xl, 1.5rem);
          font-weight: var(--id-font-weight-bold, 700);
          color: #fbbf24;
          text-shadow: 0 2px 4px rgba(251, 191, 36, 0.3);
        }

        .tx-link {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: var(--id-font-size-xs, 0.75rem);
          color: #60a5fa;
          text-decoration: none;
          opacity: 0.8;
          transition: opacity var(--id-transition-base, 0.2s);
        }

        .tx-link:hover {
          opacity: 1;
        }

        .tx-link-icon {
          width: 12px;
          height: 12px;
          fill: currentColor;
        }

        .empty-state {
          text-align: center;
          padding: var(--id-spacing-xl, 2rem);
          color: var(--id-text-secondary, #6b7280);
        }
      </style>
    `;

    const template = `
      <button class="leaderboard-button" data-action="open">
        <svg class="leaderboard-button-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="trophy-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" style="stop-color:#fbbf24;stop-opacity:1" />
              <stop offset="50%" style="stop-color:#f59e0b;stop-opacity:1" />
              <stop offset="100%" style="stop-color:#d97706;stop-opacity:1" />
            </linearGradient>
          </defs>
          <path d="M12 2C8.13 2 5 5.13 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.87-3.13-7-7-7zm2.85 11.1l-.85.6V16h-4v-2.3l-.85-.6C7.8 12.16 7 10.63 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z"/>
          <path d="M7 22h10v-2H7v2zm5-3c-1.1 0-2-.9-2-2h4c0 1.1-.9 2-2 2z"/>
        </svg>
        <span>分数排行榜</span>
      </button>
      
      <div class="modal-overlay" data-action="close-overlay">
        <div class="modal-content" data-action="stop-propagation">
          <div class="modal-header">
            <h2 class="modal-title">
              ${this._gameInfo?.icon ? `<img src="${this._gameInfo.icon}" alt="${this._gameInfo.appName}" class="game-icon" />` : ''}
              ${this._gameInfo?.appName || '游戏排行榜'}
            </h2>
            <button class="close-button" data-action="close">&times;</button>
          </div>
          <div class="modal-body">
            ${this._isLoading ? `
              <div class="loading">加载中...</div>
            ` : this._leaderboardData.length === 0 ? `
              <div class="empty-state">暂无排行榜数据</div>
            ` : `
              <ul class="leaderboard-list">
                ${this._leaderboardData.map((item, index) => {
                  const rank = item.rank || (index + 1);
                  const showMedal = rank <= 3;
                  const isFirst = rank === 1;
                  const isSecond = rank === 2;
                  const isThird = rank === 3;
                  
                  return `
                  <li class="leaderboard-item">
                    <div class="rank">
                      ${isFirst ? `
                        <div class="rank-medal medal-gold">
                          🥇
                          <span class="top-badge">TOP</span>
                        </div>
                      ` : isSecond ? `
                        <div class="rank-medal medal-silver">🥈</div>
                      ` : isThird ? `
                        <div class="rank-medal medal-bronze">🥉</div>
                      ` : `
                        <span>${rank}</span>
                      `}
                    </div>
                    <img src="${item.avatarUrl}" alt="${item.name}" class="avatar" />
                    <div class="user-info">
                      <div class="user-name">${this.escapeHtml(item.name || 'Unknown')}</div>
                      <div class="user-metaid">MetaID:${item.metaid.slice(0, 6)}</div>
                    </div>
                    <div class="score-container">
                      <div class="score">${item.score.toLocaleString()}</div>
                      ${item.txid ? `
                        <a href="https://www.mvcscan.com/tx/${item.txid.slice(0, -2)}" target="_blank" rel="noopener noreferrer" class="tx-link">
                         
                          <span>查看Tx</span>
                        </a>
                      ` : ''}
                    </div>
                  </li>
                `;
                }).join('')}
              </ul>
            `}
          </div>
        </div>
      </div>
    `;

    this.shadowRoot.innerHTML = styles + template;
    this._setupEventListeners();
  }

  _setupEventListeners() {
    const openButton = this.shadowRoot.querySelector('[data-action="open"]');
    const closeButton = this.shadowRoot.querySelector('[data-action="close"]');
    const overlay = this.shadowRoot.querySelector('[data-action="close-overlay"]');
    const modalContent = this.shadowRoot.querySelector('[data-action="stop-propagation"]');

    if (openButton) {
      openButton.addEventListener('click', () => this._handleOpen());
    }

    if (closeButton) {
      closeButton.addEventListener('click', () => this._handleClose());
    }

    if (overlay) {
      overlay.addEventListener('click', () => this._handleClose());
    }

    if (modalContent) {
      modalContent.addEventListener('click', (e) => e.stopPropagation());
    }
  }

  _cleanupEventListeners() {
    // Event listeners are automatically cleaned up when element is removed
  }

  async _handleOpen() {
    if (!this._metaAppPinId) {
      alert('metaAppPinId 未设置');
      return;
    }

    this._isOpen = true;
    this._isLoading = true;
    this.render();

    try {
      // 1. 获取游戏详情
      await this._fetchGameInfo();

      // 2. 获取排行榜数据
      await this._fetchLeaderboard();

      this._isLoading = false;
      this.render();
    } catch (error) {
      console.error('Failed to load leaderboard:', error);
      this._isLoading = false;
      alert('加载排行榜失败: ' + (error.message || error));
      this.render();
    }
  }

  _handleClose() {
    this._isOpen = false;
    this.render();
  }

  async _fetchGameInfo() {
    
    try {
      const pinDetail = await window.IDFramework.dispatch('getPinDetail', {
        numberOrId: this._metaAppPinId
      });

      if (pinDetail) {
        const item = pinDetail;
        if (item.contentSummary) {
          const summary = typeof item.contentSummary === 'string' 
            ? JSON.parse(item.contentSummary) 
            : item.contentSummary;
          
          let iconUrl = '';
          if (summary.icon) {
            // 移除 metafile:// 前缀
            const pinid = summary.icon.replace('metafile://', '');
            // 获取图标URL
            iconUrl = `https://file.metaid.io/metafile-indexer/api/v1/files/content/${pinid}`;
          }

          this._gameInfo = {
            appName: summary.appName || 'Unknown Game',
            icon: iconUrl
          };
          
        }
      }
    } catch (error) {
      console.error('Failed to fetch game info:', error);
      this._gameInfo = {
        appName: 'Unknown Game',
        icon: ''
      };
    }
  }

  async _fetchLeaderboard() {
    
    const allScores = [];
    let cursor = 0;
    const size = 100;
    const path = '/protocols/gamescorerecording';

    // 自动翻页获取所有数据
    while (true) {
      try {
        const response = await window.IDFramework.dispatch('getPinListByPath', {
          path: path,
          cursor: cursor,
          size: size
        });

        if (response && response.list) {
          // 筛选出当前游戏的数据
          const gameScores = response.list
            .filter(item => {
              if (!item.contentSummary) return false;
              try {
                const summary = typeof item.contentSummary === 'string'
                  ? JSON.parse(item.contentSummary)
                  : item.contentSummary;
                return summary.metaAppPinId === this._metaAppPinId;
              } catch (e) {
                return false;
              }
            })
            .map(item => {
              try {
                const summary = typeof item.contentSummary === 'string'
                  ? JSON.parse(item.contentSummary)
                  : item.contentSummary;
                return {
                  metaid: item.metaid,
                  score: summary.score || 0,
                  txid: item.id
                };
              } catch (e) {
                return null;
              }
            })
            .filter(item => item !== null && item.score > 0);

          allScores.push(...gameScores);

          // 检查是否有下一页
          if (response.nextCursor && response.nextCursor !== null) {
            cursor = response.nextCursor;
          } else {
            break;
          }
        } else {
          break;
        }
      } catch (error) {
        console.error('Failed to fetch leaderboard page:', error);
        break;
      }
    }

    // 过滤掉重复记录：
    // 1. item.id 相同的记录，只保留一个（保留分数最高的）
    // 2. item.metaid 相同且 item.score 相同的记录，只保留一个
    const seenIds = new Set();
    const seenMetaidScores = new Set();
    const filteredScores = [];
    
    // 先按分数从高到低排序，这样在去重时优先保留分数高的记录
    allScores.sort((a, b) => b.score - a.score);
    
    for (const item of allScores) {
      // 检查是否已存在相同的 id
      if (item.txid && seenIds.has(item.txid)) {
        continue;
      }
      
      // 检查是否已存在相同的 metaid+score
      const metaidScoreKey = `${item.metaid}_${item.score}`;
      if (seenMetaidScores.has(metaidScoreKey)) {
        continue;
      }
      
      // 添加到结果中
      filteredScores.push(item);
      if (item.txid) {
        seenIds.add(item.txid);
      }
      seenMetaidScores.add(metaidScoreKey);
    }

    // 再次按分数从高到低排序（确保顺序正确）
    filteredScores.sort((a, b) => b.score - a.score);
    // 处理相同分数的情况：相同分数显示相同名次
    // 获取前20名（如果分数相同，可能超过20个）
    const top20 = [];
    let currentRank = 1;
    let previousScore = null;
    
    for (let i = 0; i < filteredScores.length && top20.length < 20; i++) {
      const item = filteredScores[i];
      if (previousScore !== null && item.score !== previousScore) {
        currentRank = top20.length + 1;
      }
      item.rank = currentRank;
      top20.push(item);
      previousScore = item.score;
    }

    // 获取用户信息
    const leaderboardData = await Promise.all(
      top20.map(async (item) => {
        try {
          const userInfo = await window.IDFramework.dispatch('fetchUserInfo', {
            metaid: item.metaid
          });
          return {
            ...item,
            avatarUrl: userInfo.avatarUrl || '',
            name: userInfo.name || 'Unknown',
            metaid: userInfo.metaid || item.metaid
          };
        } catch (error) {
          console.error('Failed to fetch user info for', item.metaid, error);
          return {
            ...item,
            avatarUrl: '',
            name: 'Unknown',
            metaid: item.metaid
          };
        }
      })
    );
    
    this._leaderboardData = leaderboardData;
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Auto-register
if (!customElements.get('id-game-score-leaderboard')) {
  customElements.define('id-game-score-leaderboard', IdGameScoreLeaderboard);
}
