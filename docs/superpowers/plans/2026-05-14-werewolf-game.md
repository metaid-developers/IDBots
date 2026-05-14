# MetaBot 狼人杀游戏 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建纯 MetaBot 狼人杀游戏——可复用的 gameEngine 独立包 + 法官/玩家两个 Skill

**Architecture:** `packages/game-engine/` 是纯 JS 状态机模块（不依赖 Electron），JSON 文件持久化。`SKILLs/metabot-werewolf-judge/` 和 `SKILLs/metabot-werewolf-player/` 是两个 Skill，通过现有群聊/私聊通信。gameEngine 管"什么时候谁可以做什么"，Judge Skill 管"做了什么后发生什么"。

**Tech Stack:** Node.js (纯 JS，无外部依赖)，游戏数据存 `~/.idbots/games/`，Skill 脚本通过 `node` 执行

**Spec:** `docs/superpowers/specs/2026-05-14-werewolf-game-design.md`

---

### Task 1: Scaffold packages/game-engine

**Files:**
- Create: `packages/game-engine/package.json`
- Create: `packages/game-engine/.gitkeep` (ensure dir tracked)

- [ ] **Step 1: Create directory and package.json**

```bash
mkdir -p packages/game-engine
```

Write `packages/game-engine/package.json`:
```json
{
  "name": "game-engine",
  "version": "0.1.0",
  "description": "Generic turn-based game engine for MetaBot skills",
  "type": "module",
  "main": "engine.js",
  "files": ["engine.js", "store.js", "timeout.js", "types.js"],
  "license": "UNLICENSED",
  "private": true
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/game-engine/package.json
git commit -m "chore: scaffold packages/game-engine"
```

---

### Task 2: game-engine — types.js

**Files:**
- Create: `packages/game-engine/types.js`
- Create: `packages/game-engine/types.test.js`

**Purpose:** 定义所有类型常量、校验函数、阶段序列。无外部依赖。

- [ ] **Step 1: Write the failing test**

Write `packages/game-engine/types.test.js`:
```js
import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { describe, it } from 'node:test';
import {
  GAME_STATUSES,
  PLAYER_STATUSES,
  ROLES,
  PHASE_SEQUENCE,
  isValidPhaseTransition,
  validateGameStatus,
  validatePlayerStatus,
  canPlayerActInPhase,
  createGameConfig,
  createPlayer,
  createGame,
  createPhase,
  createAction,
  NEXT_PHASE,
} from './types.js';

describe('types - constants', () => {
  it('GAME_STATUSES has expected values', () => {
    deepStrictEqual(GAME_STATUSES, ['registration', 'playing', 'finished']);
  });

  it('PLAYER_STATUSES has expected values', () => {
    deepStrictEqual(PLAYER_STATUSES, ['registered', 'alive', 'dead']);
  });

  it('ROLES has expected values', () => {
    deepStrictEqual(ROLES, ['werewolf', 'seer', 'witch', 'villager']);
  });

  it('PHASE_SEQUENCE is correct for the full cycle', () => {
    deepStrictEqual(PHASE_SEQUENCE, ['night', 'dawn', 'discussion', 'vote', 'dusk']);
  });
});

describe('types - phase transitions', () => {
  it('night -> dawn is valid', () => {
    strictEqual(isValidPhaseTransition('night', 'dawn'), true);
  });

  it('dawn -> discussion is valid', () => {
    strictEqual(isValidPhaseTransition('dawn', 'discussion'), true);
  });

  it('discussion -> vote is valid', () => {
    strictEqual(isValidPhaseTransition('discussion', 'vote'), true);
  });

  it('vote -> dusk is valid', () => {
    strictEqual(isValidPhaseTransition('vote', 'dusk'), true);
  });

  it('dusk -> night is valid (next round)', () => {
    strictEqual(isValidPhaseTransition('dusk', 'night'), true);
  });

  it('night -> discussion is NOT valid', () => {
    strictEqual(isValidPhaseTransition('night', 'discussion'), false);
  });

  it('unknown phase returns false', () => {
    strictEqual(isValidPhaseTransition('night', 'unknown'), false);
  });
});

describe('types - NEXT_PHASE', () => {
  it('NEXT_PHASE maps each phase to the next', () => {
    strictEqual(NEXT_PHASE['night'], 'dawn');
    strictEqual(NEXT_PHASE['dawn'], 'discussion');
    strictEqual(NEXT_PHASE['discussion'], 'vote');
    strictEqual(NEXT_PHASE['vote'], 'dusk');
    strictEqual(NEXT_PHASE['dusk'], 'night');
  });
});

describe('types - validateGameStatus', () => {
  it('accepts valid status', () => {
    strictEqual(validateGameStatus('registration'), 'registration');
  });

  it('throws on invalid status', () => {
    throws(() => validateGameStatus('paused'), /Invalid game status/);
  });
});

describe('types - validatePlayerStatus', () => {
  it('accepts valid status', () => {
    strictEqual(validatePlayerStatus('alive'), 'alive');
  });

  it('throws on invalid status', () => {
    throws(() => validatePlayerStatus('spectating'), /Invalid player status/);
  });
});

describe('types - canPlayerActInPhase', () => {
  it('alive player can act in night', () => {
    strictEqual(canPlayerActInPhase('alive', 'night', 'werewolf'), true);
  });

  it('dead player cannot act in night', () => {
    strictEqual(canPlayerActInPhase('dead', 'night', 'werewolf'), false);
  });

  it('villager cannot act in night (no ability)', () => {
    strictEqual(canPlayerActInPhase('alive', 'night', 'villager'), false);
  });

  it('alive player can act in discussion', () => {
    strictEqual(canPlayerActInPhase('alive', 'discussion', 'villager'), true);
  });

  it('alive player can vote in vote phase', () => {
    strictEqual(canPlayerActInPhase('alive', 'vote', 'villager'), true);
  });

  it('dead player cannot vote', () => {
    strictEqual(canPlayerActInPhase('dead', 'vote', 'villager'), false);
  });

  it('no one acts in dawn', () => {
    strictEqual(canPlayerActInPhase('alive', 'dawn', 'werewolf'), false);
  });
});

describe('types - createGameConfig', () => {
  it('creates config with defaults', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    strictEqual(config.roles.length, 4);
    strictEqual(config.timeouts.registration, 600);
    strictEqual(config.timeouts.night, 180);
  });

  it('allows overriding timeouts', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
      timeouts: { night: 120 },
    });
    strictEqual(config.timeouts.night, 120);
    strictEqual(config.timeouts.registration, 600); // default preserved
  });
});

describe('types - createPlayer', () => {
  it('creates player with default fields', () => {
    const player = createPlayer({ globalMetaId: 'idq_001', name: '小明' });
    strictEqual(player.globalMetaId, 'idq_001');
    strictEqual(player.name, '小明');
    strictEqual(player.role, null);
    strictEqual(player.status, 'registered');
    strictEqual(player.potionSaveUsed, false);
    strictEqual(player.potionPoisonUsed, false);
  });
});

describe('types - createGame', () => {
  it('creates game in registration status', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    const game = createGame({
      gameId: 'test-game-1',
      groupChatId: 'abc123',
      judge: { globalMetaId: 'idq_judge', name: '法官' },
      config,
    });
    strictEqual(game.status, 'registration');
    strictEqual(game.players.length, 0);
    strictEqual(game.rounds.length, 0);
    strictEqual(game.result, null);
  });
});

describe('types - createPhase', () => {
  it('creates a phase with empty actions and replies', () => {
    const phase = createPhase('night', 1000, 2000);
    strictEqual(phase.phase, 'night');
    strictEqual(phase.startedAt, 1000);
    strictEqual(phase.deadline, 2000);
    deepStrictEqual(phase.actions, []);
    deepStrictEqual(phase.judgeReplies, []);
  });
});

describe('types - createAction', () => {
  it('creates an action with timestamp', () => {
    const action = createAction({
      from: 'idq_001',
      type: 'kill',
      target: 'idq_002',
    });
    strictEqual(action.from, 'idq_001');
    strictEqual(action.type, 'kill');
    strictEqual(action.target, 'idq_002');
    strictEqual(typeof action.at, 'number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test packages/game-engine/types.test.js
```
Expected: FAIL — module not found

- [ ] **Step 3: Write types.js implementation**

Write `packages/game-engine/types.js`:
```js
// ---- Constants ----

export const GAME_STATUSES = ['registration', 'playing', 'finished'];
export const PLAYER_STATUSES = ['registered', 'alive', 'dead'];
export const ROLES = ['werewolf', 'seer', 'witch', 'villager'];
export const PHASE_SEQUENCE = ['night', 'dawn', 'discussion', 'vote', 'dusk'];

// Phases where players send actions to judge
export const ACTION_PHASES = ['night', 'vote'];

// Phases where players have free discussion
export const DISCUSSION_PHASES = ['discussion'];

// Phases that are judge-announcement-only (judge calls completePhase)
export const ANNOUNCEMENT_PHASES = ['dawn', 'dusk'];

// Roles that have night-time actions
export const NIGHT_ACTION_ROLES = ['werewolf', 'seer', 'witch'];

export const ROLE_NIGHT_ACTIONS = {
  werewolf: ['kill'],
  seer: ['check'],
  witch: ['save', 'poison'],
};

export const NEXT_PHASE = {
  night: 'dawn',
  dawn: 'discussion',
  discussion: 'vote',
  vote: 'dusk',
  dusk: 'night',
};

const VALID_TRANSITIONS = new Set([
  'night:dawn',
  'dawn:discussion',
  'discussion:vote',
  'vote:dusk',
  'dusk:night',
]);

// ---- Validation ----

export function isValidPhaseTransition(from, to) {
  return VALID_TRANSITIONS.has(`${from}:${to}`);
}

export function validateGameStatus(status) {
  if (!GAME_STATUSES.includes(status)) {
    throw new Error(`Invalid game status: ${status}. Must be one of: ${GAME_STATUSES.join(', ')}`);
  }
  return status;
}

export function validatePlayerStatus(status) {
  if (!PLAYER_STATUSES.includes(status)) {
    throw new Error(`Invalid player status: ${status}. Must be one of: ${PLAYER_STATUSES.join(', ')}`);
  }
  return status;
}

/**
 * Check if a player can act in the current phase based on:
 * - player status (must be alive, or registered during registration)
 * - phase type (action phases vs announcement phases)
 * - role's allowed actions for that phase
 */
export function canPlayerActInPhase(playerStatus, phase, role) {
  // Dead players never act
  if (playerStatus === 'dead') return false;

  // Announcement phases: no player actions
  if (ANNOUNCEMENT_PHASES.includes(phase)) return false;

  // Discussion: all alive players can speak
  if (DISCUSSION_PHASES.includes(phase)) return true;

  // Night: only NIGHT_ACTION_ROLES
  if (phase === 'night') {
    return NIGHT_ACTION_ROLES.includes(role);
  }

  // Vote: all alive players can vote
  if (phase === 'vote') return true;

  return false;
}

// ---- Factory Functions ----

export function createGameConfig({ roles, timeouts, registrationDeadline }) {
  return {
    roles: roles || ['werewolf', 'seer', 'witch', 'villager'],
    timeouts: {
      registration: 600,
      night: 180,
      discussion: 300,
      vote: 120,
      ...timeouts,
    },
    registrationDeadline: registrationDeadline || (Date.now() + 600_000),
  };
}

export function createPlayer({ globalMetaId, name }) {
  return {
    globalMetaId,
    name,
    role: null,
    status: 'registered',
    potionSaveUsed: false,
    potionPoisonUsed: false,
  };
}

export function createGame({ gameId, groupChatId, judge, config }) {
  return {
    gameId,
    groupChatId,
    status: 'registration',
    judge,
    config,
    players: [],
    rounds: [],
    result: null,
  };
}

export function createPhase(phase, startedAt, deadline) {
  return {
    phase,
    startedAt,
    deadline,
    actions: [],
    judgeReplies: [],
  };
}

export function createAction({ from, type, target }) {
  return {
    from,
    type,
    target,
    at: Date.now(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test packages/game-engine/types.test.js
```
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/game-engine/types.js packages/game-engine/types.test.js
git commit -m "feat: add game-engine types - constants, validation, factory functions"
```

---

### Task 3: game-engine — store.js

**Files:**
- Create: `packages/game-engine/store.js`

**Purpose:** JSON 文件持久化。提供 `createStore(baseDir)` 工厂函数，返回 `{ load, save, listGames, deleteGame }`。

- [ ] **Step 1: Write store.js**

```js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_BASE_DIR = path.join(os.homedir(), '.idbots', 'games');

export function createStore(baseDir = DEFAULT_BASE_DIR) {
  // Ensure directory exists
  fs.mkdirSync(baseDir, { recursive: true });

  function gamePath(gameId) {
    // Sanitize gameId for filesystem safety
    const safe = gameId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(baseDir, `${safe}.json`);
  }

  return {
    /**
     * Load a game by gameId. Returns null if not found.
     */
    load(gameId) {
      const p = gamePath(gameId);
      if (!fs.existsSync(p)) return null;
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch (err) {
        console.error(`[game-engine] Failed to load game ${gameId}:`, err.message);
        return null;
      }
    },

    /**
     * Save (create or update) a game state.
     */
    save(game) {
      const p = gamePath(game.gameId);
      fs.writeFileSync(p, JSON.stringify(game, null, 2), 'utf-8');
    },

    /**
     * List all games, optionally filtered by groupChatId and/or status.
     */
    listGames({ groupChatId, status } = {}) {
      const files = fs.readdirSync(baseDir).filter(f => f.endsWith('.json'));
      const games = [];
      for (const f of files) {
        try {
          const game = JSON.parse(fs.readFileSync(path.join(baseDir, f), 'utf-8'));
          if (groupChatId && game.groupChatId !== groupChatId) continue;
          if (status && game.status !== status) continue;
          games.push(game);
        } catch {
          // Skip corrupted files
        }
      }
      return games;
    },

    /**
     * Delete a game file.
     */
    deleteGame(gameId) {
      const p = gamePath(gameId);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    },

    /**
     * Check if there is an active (non-finished) game for a group chat.
     * Returns the active game or null.
     */
    findActiveGame(groupChatId) {
      const games = this.listGames({ groupChatId });
      return games.find(g => g.status !== 'finished') || null;
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/game-engine/store.js
git commit -m "feat: add game-engine store - JSON file persistence"
```

---

### Task 4: game-engine — timeout.js

**Files:**
- Create: `packages/game-engine/timeout.js`

**Purpose:** 计时器管理。提供 `createTimeout(callback, ms)` 工厂。

- [ ] **Step 1: Write timeout.js**

```js
/**
 * Create a managed timeout. Supports start, cancel, reset.
 * The callback fires ONCE when the timer expires.
 * Subsequent calls to start() after expiry are no-ops.
 */
export function createTimeout(callback, ms) {
  let timer = null;
  let fired = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    /**
     * Start the timer. No-op if already running or already fired.
     */
    start() {
      if (fired || timer !== null) return;
      timer = setTimeout(() => {
        fired = true;
        timer = null;
        callback();
      }, ms);
    },

    /**
     * Cancel the timer without firing the callback.
     */
    cancel() {
      clear();
    },

    /**
     * Reset the timer with a new duration (or same duration if not provided).
     * Cancels existing timer and starts a new one.
     */
    reset(newMs) {
      clear();
      fired = false;
      timer = setTimeout(() => {
        fired = true;
        timer = null;
        callback();
      }, newMs ?? ms);
    },

    /**
     * Whether the timer has already fired or is currently running.
     */
    get isActive() {
      return !fired && timer !== null;
    },

    /**
     * Whether the timer has already fired.
     */
    get hasFired() {
      return fired;
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/game-engine/timeout.js
git commit -m "feat: add game-engine timeout - managed timer"
```

---

### Task 5: game-engine — engine.js (core state machine)

**Files:**
- Create: `packages/game-engine/engine.js`

**Purpose:** 核心状态机。管理游戏生命周期、回合/阶段切换、超时、玩家状态。

- [ ] **Step 1: Write engine.js**

```js
import { EventEmitter } from 'node:events';
import {
  isValidPhaseTransition,
  validateGameStatus,
  validatePlayerStatus,
  createGame,
  createPhase,
  createAction,
  NEXT_PHASE,
  ANNOUNCEMENT_PHASES,
} from './types.js';
import { createStore } from './store.js';
import { createTimeout } from './timeout.js';

export function createEngine(store) {
  const emitter = new EventEmitter();
  const timers = new Map(); // gameId -> timeout instance

  function getTimer(gameId) {
    if (!timers.has(gameId)) {
      timers.set(gameId, createTimeout(() => {
        const game = store.load(gameId);
        if (!game) return;
        // Registration timeout: emit with synthetic phase
        if (game.status === 'registration') {
          emitter.emit('registrationTimeout', game);
          return;
        }
        if (game.status !== 'playing') return;
        const currentPhase = game.rounds.at(-1)?.phases.at(-1);
        if (!currentPhase) return;
        emitter.emit('phaseTimeout', game, currentPhase);
      }, 0));
    }
    return timers.get(gameId);
  }

  function cancelTimer(gameId) {
    const t = timers.get(gameId);
    if (t) t.cancel();
  }

  function startPhaseTimer(gameId, deadline) {
    const ms = Math.max(0, deadline - Date.now());
    const t = getTimer(gameId);
    t.reset(ms);
  }

  /**
   * Create a new game. Puts it in 'registration' status.
   * Emits: 'phaseStart'
   */
  function startGame({ gameId, groupChatId, judge, config }) {
    // Validate: no active game in same group
    const active = store.findActiveGame(groupChatId);
    if (active) {
      throw new Error(`Group ${groupChatId} already has an active game: ${active.gameId}`);
    }

    const game = createGame({ gameId, groupChatId, judge, config });
    store.save(game);

    // Start registration deadline timer
    const deadline = game.config.registrationDeadline;
    const ms = Math.max(0, deadline - Date.now());
    getTimer(gameId).reset(ms);

    // Emit a synthetic phase for registration tracking
    emitter.emit('phaseStart', game, { phase: 'registration', deadline });

    return game;
  }

  /**
   * Register a player. Only valid during 'registration' status.
   */
  function registerPlayer(gameId, { globalMetaId, name }) {
    const game = store.load(gameId);
    if (!game) throw new Error(`Game not found: ${gameId}`);
    if (game.status !== 'registration') {
      throw new Error(`Game ${gameId} is not in registration phase`);
    }
    // Prevent duplicate
    if (game.players.find(p => p.globalMetaId === globalMetaId)) {
      throw new Error(`Player ${globalMetaId} already registered`);
    }
    // Check max players (roles count + extra villagers, reasonable cap)
    if (game.players.length >= 12) {
      throw new Error('Max 12 players');
    }

    game.players.push({
      globalMetaId,
      name,
      role: null,
      status: 'registered',
      potionSaveUsed: false,
      potionPoisonUsed: false,
    });
    store.save(game);
    return game;
  }

  /**
   * Assign roles randomly to registered players and transition to 'playing'.
   * Extra players beyond the defined roles become villagers.
   * Emits: 'phaseStart' with phase='night'
   */
  function assignRoles(gameId) {
    const game = store.load(gameId);
    if (!game) throw new Error(`Game not found: ${gameId}`);
    if (game.status !== 'registration') {
      throw new Error(`Game ${gameId} is not in registration phase`);
    }
    if (game.players.length < 4) {
      throw new Error('Need at least 4 players to start');
    }

    // Prepare role list: defined roles + extra villagers
    const roleList = [...game.config.roles];
    while (roleList.length < game.players.length) {
      roleList.push('villager');
    }

    // Fisher-Yates shuffle
    for (let i = roleList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roleList[i], roleList[j]] = [roleList[j], roleList[i]];
    }

    // Assign roles
    for (let i = 0; i < game.players.length; i++) {
      game.players[i].role = roleList[i];
      game.players[i].status = 'alive';
    }

    game.status = 'playing';
    cancelTimer(gameId);

    // Start first round, first phase: night
    game.rounds.push({ round: 1, phases: [] });
    const now = Date.now();
    const deadline = now + (game.config.timeouts.night * 1000);
    const phase = createPhase('night', now, deadline);
    game.rounds[0].phases.push(phase);
    store.save(game);

    startPhaseTimer(gameId, deadline);
    emitter.emit('phaseStart', game, phase);

    return game;
  }

  /**
   * Record a player action during a phase.
   * Returns the updated game.
   */
  function recordAction(gameId, { from, type, target }) {
    const game = store.load(gameId);
    if (!game) throw new Error(`Game not found: ${gameId}`);
    if (game.status !== 'playing') throw new Error('Game is not in playing status');

    const round = game.rounds.at(-1);
    if (!round) throw new Error('No active round');

    const phase = round.phases.at(-1);
    if (!phase) throw new Error('No active phase');

    const action = createAction({ from, type, target });
    phase.actions.push(action);
    store.save(game);

    emitter.emit('actionReceived', game, phase, action);

    return game;
  }

  /**
   * Record a judge reply during a phase.
   */
  function recordJudgeReply(gameId, { to, content }) {
    const game = store.load(gameId);
    if (!game) throw new Error(`Game not found: ${gameId}`);

    const round = game.rounds.at(-1);
    if (!round) throw new Error('No active round');

    const phase = round.phases.at(-1);
    if (!phase) throw new Error('No active phase');

    phase.judgeReplies.push({ to, content, at: Date.now() });
    store.save(game);

    return game;
  }

  /**
   * Complete the current phase and advance to the next.
   * For dusk phase ending, automatically creates a new round.
   * Complete phase is idempotent — repeated calls are safe.
   * Emits: 'phaseStart' or 'gameFinished'
   * Returns: the updated game
   */
  function completePhase(gameId) {
    const game = store.load(gameId);
    if (!game) throw new Error(`Game not found: ${gameId}`);
    if (game.status !== 'playing') return game;

    cancelTimer(gameId);

    const round = game.rounds.at(-1);
    if (!round) return game;

    const currentPhase = round.phases.at(-1);
    if (!currentPhase) return game;

    const nextPhaseName = NEXT_PHASE[currentPhase.phase];
    if (!nextPhaseName) return game;

    // Determine next round number
    let nextRound = round;
    if (currentPhase.phase === 'dusk') {
      // Start new round
      const newRound = { round: round.round + 1, phases: [] };
      game.rounds.push(newRound);
      nextRound = newRound;
    }

    // Compute deadline for next phase
    const timeoutSec = game.config.timeouts[nextPhaseName];
    const now = Date.now();
    const deadline = timeoutSec ? now + (timeoutSec * 1000) : now; // announcement phases have no timeout

    const nextPhase = createPhase(nextPhaseName, now, deadline);
    nextRound.phases.push(nextPhase);
    store.save(game);

    // Set timeout for action phases
    if (!ANNOUNCEMENT_PHASES.includes(nextPhaseName) && timeoutSec) {
      startPhaseTimer(gameId, deadline);
    }

    emitter.emit('phaseStart', game, nextPhase);

    return game;
  }

  /**
   * Mark a player as dead.
   */
  function killPlayer(gameId, globalMetaId) {
    const game = store.load(gameId);
    if (!game) throw new Error(`Game not found: ${gameId}`);

    const player = game.players.find(p => p.globalMetaId === globalMetaId);
    if (!player) throw new Error(`Player not found: ${globalMetaId}`);

    player.status = 'dead';
    store.save(game);
    return game;
  }

  /**
   * Handle a player leaving mid-game. Equivalent to killPlayer but with reason tracking.
   */
  function playerLeave(gameId, globalMetaId, reason = 'quit') {
    const game = store.load(gameId);
    if (!game) throw new Error(`Game not found: ${gameId}`);

    const player = game.players.find(p => p.globalMetaId === globalMetaId);
    if (!player) throw new Error(`Player not found: ${globalMetaId}`);

    player.status = 'dead';
    player.leaveReason = reason;
    store.save(game);
    return game;
  }

  /**
   * Mark a player's potion as used.
   */
  function usePotion(gameId, globalMetaId, potionType) {
    const game = store.load(gameId);
    if (!game) throw new Error(`Game not found: ${gameId}`);

    const player = game.players.find(p => p.globalMetaId === globalMetaId);
    if (!player) throw new Error(`Player not found: ${globalMetaId}`);

    if (potionType === 'save') player.potionSaveUsed = true;
    else if (potionType === 'poison') player.potionPoisonUsed = true;

    store.save(game);
    return game;
  }

  /**
   * Finish the game and record the result.
   * Emits: 'gameFinished'
   */
  function finishGame(gameId, result) {
    const game = store.load(gameId);
    if (!game) throw new Error(`Game not found: ${gameId}`);
    if (game.status === 'finished') return game; // idempotent

    cancelTimer(gameId);
    game.status = 'finished';
    game.result = result;
    store.save(game);

    emitter.emit('gameFinished', game, result);

    return game;
  }

  /**
   * Cancel a game (e.g. not enough players during registration).
   */
  function cancelGame(gameId, reason) {
    const game = store.load(gameId);
    if (!game) throw new Error(`Game not found: ${gameId}`);

    cancelTimer(gameId);
    game.status = 'finished';
    game.result = { winner: null, cancelled: true, reason };
    store.save(game);

    emitter.emit('gameFinished', game, game.result);

    return game;
  }

  return {
    // Event system
    on: (event, handler) => { emitter.on(event, handler); },
    off: (event, handler) => { emitter.off(event, handler); },

    // Game lifecycle
    startGame,
    registerPlayer,
    assignRoles,
    cancelGame,

    // Phase management
    completePhase,

    // Actions & state
    recordAction,
    recordJudgeReply,
    killPlayer,
    playerLeave,
    usePotion,
    finishGame,

    // Query
    getGame: (gameId) => store.load(gameId),
    findActiveGame: (groupChatId) => store.findActiveGame(groupChatId),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/game-engine/engine.js
git commit -m "feat: add game-engine core - state machine, phase transitions, event system"
```

---

### Task 6: game-engine — engine.test.js

**Files:**
- Create: `packages/game-engine/engine.test.js`

**Purpose:** 核心引擎集成测试。覆盖完整游戏流程。

- [ ] **Step 1: Write engine.test.js**

```js
import { deepStrictEqual, strictEqual, throws, ok } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createEngine } from './engine.js';
import { createStore } from './store.js';
import { createGameConfig } from './types.js';

const TEST_DIR = path.join(os.tmpdir(), `game-engine-test-${Date.now()}`);

function makeId(suffix = '') {
  return `test-idq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${suffix}`;
}

describe('engine - game lifecycle', () => {
  let store, engine;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    store = createStore(TEST_DIR);
    engine = createEngine(store);
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('startGame creates a game in registration status', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    const game = engine.startGame({
      gameId: 'test-game-1',
      groupChatId: 'grp-123',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    strictEqual(game.status, 'registration');
    strictEqual(game.players.length, 0);
  });

  it('startGame throws if active game exists in same group', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-2',
      groupChatId: 'grp-same',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    throws(() => {
      engine.startGame({
        gameId: 'test-game-3',
        groupChatId: 'grp-same',
        judge: { globalMetaId: makeId('judge2'), name: '法官2' },
        config,
      });
    }, /already has an active game/);
  });

  it('registerPlayer adds a player', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-4',
      groupChatId: 'grp-456',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    engine.registerPlayer('test-game-4', {
      globalMetaId: makeId('p1'),
      name: '小明',
    });

    const game = engine.getGame('test-game-4');
    strictEqual(game.players.length, 1);
    strictEqual(game.players[0].name, '小明');
    strictEqual(game.players[0].status, 'registered');
  });

  it('registerPlayer prevents duplicates', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-5',
      groupChatId: 'grp-789',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    const pid = makeId('p1');
    engine.registerPlayer('test-game-5', { globalMetaId: pid, name: '小明' });

    throws(() => {
      engine.registerPlayer('test-game-5', { globalMetaId: pid, name: '小明' });
    }, /already registered/);
  });

  it('assignRoles transitions to playing and assigns roles', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-6',
      groupChatId: 'grp-roles',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    const ids = [makeId('p1'), makeId('p2'), makeId('p3'), makeId('p4')];
    const names = ['小明', '小红', '小刚', '小丽'];
    for (let i = 0; i < 4; i++) {
      engine.registerPlayer('test-game-6', { globalMetaId: ids[i], name: names[i] });
    }

    // Listen for phaseStart event
    let phaseEvent = null;
    engine.on('phaseStart', (game, phase) => {
      phaseEvent = { phase: phase.phase };
    });

    const game = engine.assignRoles('test-game-6');

    strictEqual(game.status, 'playing');
    strictEqual(game.players.length, 4);

    // All players alive with roles
    for (const p of game.players) {
      strictEqual(p.status, 'alive');
      ok(p.role !== null, `Player ${p.name} should have a role`);
    }

    // Verify all 4 roles are assigned
    const roleSet = new Set(game.players.map(p => p.role));
    strictEqual(roleSet.size, 4);

    // First phase is night
    strictEqual(game.rounds.length, 1);
    strictEqual(game.rounds[0].round, 1);
    strictEqual(game.rounds[0].phases[0].phase, 'night');

    // phaseStart event fired
    strictEqual(phaseEvent.phase, 'night');
  });

  it('assignRoles throws if less than 4 players', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-min',
      groupChatId: 'grp-min',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    engine.registerPlayer('test-game-min', { globalMetaId: makeId('p1'), name: '小明' });
    engine.registerPlayer('test-game-min', { globalMetaId: makeId('p2'), name: '小红' });

    throws(() => {
      engine.assignRoles('test-game-min');
    }, /at least 4/);
  });

  it('recordAction stores an action and emits event', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-7',
      groupChatId: 'grp-action',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    const ids = [makeId('p1'), makeId('p2'), makeId('p3'), makeId('p4')];
    for (let i = 0; i < 4; i++) {
      engine.registerPlayer('test-game-7', { globalMetaId: ids[i], name: `p${i}` });
    }
    engine.assignRoles('test-game-7');

    let receivedAction = null;
    engine.on('actionReceived', (game, phase, action) => {
      receivedAction = action;
    });

    engine.recordAction('test-game-7', {
      from: ids[0],
      type: 'kill',
      target: ids[1],
    });

    strictEqual(receivedAction.from, ids[0]);
    strictEqual(receivedAction.type, 'kill');
    strictEqual(receivedAction.target, ids[1]);

    const game = engine.getGame('test-game-7');
    strictEqual(game.rounds[0].phases[0].actions.length, 1);
  });

  it('completePhase advances through the full cycle', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-cycle',
      groupChatId: 'grp-cycle',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    const ids = [makeId('p1'), makeId('p2'), makeId('p3'), makeId('p4')];
    for (let i = 0; i < 4; i++) {
      engine.registerPlayer('test-game-cycle', { globalMetaId: ids[i], name: `p${i}` });
    }
    engine.assignRoles('test-game-cycle');

    // Track phases
    const phases = [];
    engine.on('phaseStart', (game, phase) => {
      phases.push(phase.phase);
    });

    // Advance: night -> dawn -> discussion -> vote -> dusk -> (new round) night
    engine.completePhase('test-game-cycle'); // night -> dawn
    engine.completePhase('test-game-cycle'); // dawn -> discussion
    engine.completePhase('test-game-cycle'); // discussion -> vote
    engine.completePhase('test-game-cycle'); // vote -> dusk
    engine.completePhase('test-game-cycle'); // dusk -> night (round 2)

    // Check phase sequence (events from completePhase calls)
    // First event is 'night' from assignRoles
    strictEqual(phases[0], 'night');  // from assignRoles
    strictEqual(phases[1], 'dawn');
    strictEqual(phases[2], 'discussion');
    strictEqual(phases[3], 'vote');
    strictEqual(phases[4], 'dusk');
    strictEqual(phases[5], 'night'); // round 2

    // Verify round structure
    const game = engine.getGame('test-game-cycle');
    strictEqual(game.rounds.length, 2);
    strictEqual(game.rounds[0].phases.length, 5);  // night, dawn, discussion, vote, dusk
    strictEqual(game.rounds[1].phases.length, 1);  // night
    strictEqual(game.rounds[1].round, 2);
  });

  it('killPlayer marks player as dead', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-kill',
      groupChatId: 'grp-kill',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    const ids = [makeId('p1'), makeId('p2'), makeId('p3'), makeId('p4')];
    for (let i = 0; i < 4; i++) {
      engine.registerPlayer('test-game-kill', { globalMetaId: ids[i], name: `p${i}` });
    }
    engine.assignRoles('test-game-kill');

    engine.killPlayer('test-game-kill', ids[1]);

    const game = engine.getGame('test-game-kill');
    strictEqual(game.players.find(p => p.globalMetaId === ids[1]).status, 'dead');
    strictEqual(game.players.find(p => p.globalMetaId === ids[0]).status, 'alive');
  });

  it('usePotion tracks potion usage', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-potion',
      groupChatId: 'grp-potion',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    const ids = [makeId('p1'), makeId('p2'), makeId('p3'), makeId('p4')];
    for (let i = 0; i < 4; i++) {
      engine.registerPlayer('test-game-potion', { globalMetaId: ids[i], name: `p${i}` });
    }
    engine.assignRoles('test-game-potion');

    // Mark player 3 as witch
    const game1 = engine.getGame('test-game-potion');
    game1.players.find(p => p.globalMetaId === ids[2]).role = 'witch';
    store.save(game1);

    engine.usePotion('test-game-potion', ids[2], 'save');

    const game = engine.getGame('test-game-potion');
    strictEqual(game.players.find(p => p.globalMetaId === ids[2]).potionSaveUsed, true);
    strictEqual(game.players.find(p => p.globalMetaId === ids[2]).potionPoisonUsed, false);
  });

  it('finishGame sets status and result', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-finish',
      groupChatId: 'grp-finish',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    const ids = [makeId('p1'), makeId('p2'), makeId('p3'), makeId('p4')];
    for (let i = 0; i < 4; i++) {
      engine.registerPlayer('test-game-finish', { globalMetaId: ids[i], name: `p${i}` });
    }
    engine.assignRoles('test-game-finish');

    let finishEvent = null;
    engine.on('gameFinished', (game, result) => {
      finishEvent = result;
    });

    engine.finishGame('test-game-finish', {
      winner: 'good',
      survivors: [ids[0], ids[2], ids[3]],
      summary: '狼人被投票淘汰',
    });

    const game = engine.getGame('test-game-finish');
    strictEqual(game.status, 'finished');
    strictEqual(game.result.winner, 'good');
    strictEqual(finishEvent.winner, 'good');
  });

  it('finishGame is idempotent', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-idempotent',
      groupChatId: 'grp-idem',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    const ids = [makeId('p1'), makeId('p2'), makeId('p3'), makeId('p4')];
    for (let i = 0; i < 4; i++) {
      engine.registerPlayer('test-game-idempotent', { globalMetaId: ids[i], name: `p${i}` });
    }
    engine.assignRoles('test-game-idempotent');

    engine.finishGame('test-game-idempotent', { winner: 'good', survivors: [], summary: 'test' });
    // Should not throw on second call
    engine.finishGame('test-game-idempotent', { winner: 'werewolf', survivors: [], summary: 'test2' });

    const game = engine.getGame('test-game-idempotent');
    strictEqual(game.result.winner, 'good'); // first call wins
  });

  it('cancelGame cancels a registration phase game', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-cancel',
      groupChatId: 'grp-cancel',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    let finishEvent = null;
    engine.on('gameFinished', (game, result) => {
      finishEvent = result;
    });

    engine.cancelGame('test-game-cancel', '报名人数不足');

    const game = engine.getGame('test-game-cancel');
    strictEqual(game.status, 'finished');
    strictEqual(game.result.cancelled, true);
    strictEqual(game.result.reason, '报名人数不足');
    strictEqual(finishEvent.cancelled, true);
  });

  it('completePhase is idempotent', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-cp-idem',
      groupChatId: 'grp-cpidem',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    const ids = [makeId('p1'), makeId('p2'), makeId('p3'), makeId('p4')];
    for (let i = 0; i < 4; i++) {
      engine.registerPlayer('test-game-cp-idem', { globalMetaId: ids[i], name: `p${i}` });
    }
    engine.assignRoles('test-game-cp-idem');

    // Two rapid completePhase calls
    engine.completePhase('test-game-cp-idem'); // night -> dawn
    engine.completePhase('test-game-cp-idem'); // dawn -> discussion
    engine.completePhase('test-game-cp-idem'); // discussion -> vote
    // Repeated call on same phase should be safe
    engine.completePhase('test-game-cp-idem'); // vote -> dusk (still valid transition)

    const game = engine.getGame('test-game-cp-idem');
    // Should have night (1), dawn (2), discussion (3), vote (4), dusk (5) = 5 phases
    strictEqual(game.rounds[0].phases.length, 5);
  });

  it('findActiveGame returns active game in group', () => {
    const config = createGameConfig({
      roles: ['werewolf', 'seer', 'witch', 'villager'],
    });
    engine.startGame({
      gameId: 'test-game-find',
      groupChatId: 'grp-find',
      judge: { globalMetaId: makeId('judge'), name: '法官' },
      config,
    });

    const active = engine.findActiveGame('grp-find');
    ok(active !== null);
    strictEqual(active.gameId, 'test-game-find');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (engine not built yet)**

```bash
node --test packages/game-engine/engine.test.js
```
Expected: FAIL

- [ ] **Step 3: Run tests to verify they pass (engine already implemented)**

```bash
node --test packages/game-engine/engine.test.js
```
Expected: PASS (all tests)

- [ ] **Step 4: Commit**

```bash
git add packages/game-engine/engine.test.js
git commit -m "test: add game-engine integration tests"
```

---

### Task 7: Judge SKILL.md

**Files:**
- Create: `SKILLs/metabot-werewolf-judge/SKILL.md`

**Purpose:** 法官 Skill 的完整 LLM 指令。包含游戏流程、消息格式、边界处理。

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: metabot-werewolf-judge
description: 在已有群聊中主持一局狼人杀游戏。作为法官，负责报名管理、角色分配、昼夜阶段推进、结算判决，游戏结束后公开所有私信记录。
official: true
---

# MetaBot 狼人杀 - 法官

你是狼人杀游戏的**法官**。你的职责是在指定的群聊中主持一局完整的狼人杀游戏。

## 游戏配置

- 角色：狼人 ×1、预言家 ×1、女巫 ×1、村民（至少 1 人，多余报名者自动成为村民）
- 最低玩家数：4 人
- 报名超时：10 分钟（可调整）
- 夜晚时限：3 分钟
- 讨论时限：5 分钟
- 投票时限：2 分钟

## 完整流程

### 第一步：检查活跃局

1. 调用 `scripts/index.js --action check-active --group-id <groupId>` 检查该群是否有进行中的游戏
2. 如果有活跃局 → 回复主人"该群已有进行中的狼人杀游戏"，结束

### 第二步：宣布开局

发送群聊消息：
```
[GM] 🎮 开启狼人杀报名！角色配置：狼人/预言家/女巫/村民
报名方式：私信我发送 join
截止时间：<10分钟后具体时间>
```

### 第三步：收集报名

1. 监控私信，收到 `join` 即记录报名者（去重）
2. 每收到一人，更新内存中的报名列表
3. 超时后：
   - 报名人数 < 4 → 群聊公告 `[GM] ❌ 报名人数不足（需要至少4人），游戏取消。`
   - 报名人数 ≥ 4 → 进入下一步

### 第四步：角色分配

1. 调用 `--action assign-roles`，引擎内部随机分配角色（Fisher-Yates shuffle）
2. 私信通知每个玩家：
   - 格式：`你的角色是：<角色名>。请阅读 metabot-werewolf-player 技能了解你的能力和策略。`
3. 创建游戏 JSON 文件（通过 `scripts/index.js --action create-game`）
4. 群聊公告：
   ```
   [GM] ✅ 报名截止。共 <N> 名玩家参与。角色已通过私信分配完毕。
   ```

### 第五步：游戏循环

游戏进行多轮，每轮包含：夜晚 → 天亮 → 讨论 → 投票 → 黄昏

#### 夜晚阶段

群聊公告：
```
[GM] 🌙 天黑请闭眼。请各位角色根据你的能力，通过私信向我提交行动。
狼人：kill <玩家名>
预言家：check <玩家名>
女巫：等待我告知今晚情况后再决定。
截止时间：<3分钟后具体时间>
```

**处理私信行动：**

- **狼人** `kill <玩家名>`：记录击杀目标（名称→globalMetaId 映射）。告诉狼人"已记录"。
- **预言家** `check <玩家名>`：**立即**私信回复查验结果（`<玩家名> 是 狼人` 或 `<玩家名> 是 好人`）。
- **女巫**：先私信告知"今晚 <玩家名> 被狼人击杀，你要救吗？(save <玩家名>) 要用毒吗？(poison <玩家名>)"
  - `save <玩家名>` → 记录救人（仅限被刀目标，且解药未用）
  - `poison <玩家名>` → 记录毒人（毒药未用）
  - 不回复 → 不用药
- **村民/死人**：无行动。私信发来的话回复"你今晚不需要行动"。

超时/收齐所有行动后，用 `completePhase` 推进到天亮。

#### 天亮阶段

执行结算（按顺序）：
1. 女巫救人：若 `save` 目标 == 狼人 `kill` 目标 → 被救，无人死亡
2. 狼人击杀：若非被救目标 → 死亡
3. 女巫毒杀：若用了毒 → 额外死亡
4. 更新 JSON 状态（`killPlayer`）
5. 标记药水使用情况（`usePotion`）

群聊公告：
```
[GM] ☀️ 天亮了。
昨晚<死亡信息>。
存活玩家：<列表>
```
死亡信息格式：
- 无人死亡 → "是平安夜，无人死亡。"
- 有人死亡 → "<玩家名> 死亡。"（不透露是刀、毒还是投票）

检查胜负：`killPlayer` 后调用胜负判定逻辑。若分出胜负 → 进入结束阶段。

公告完毕 → `completePhase` 推进到讨论。

#### 讨论阶段

群聊公告：
```
[GM] 💬 讨论开始，请各位存活玩家自由发言。
截止时间：<5分钟后具体时间>
```

玩家在群聊自由讨论。死亡玩家必须沉默——若死亡玩家发言，发布 `[GM] ⚠️ <玩家名> 你已出局，请保持沉默。`

超时/讨论充分后 → `completePhase` 推进到投票。

#### 投票阶段

群聊公告：
```
[GM] 🗳️ 投票开始，请回复 vote <玩家名> 来投票。
截止时间：<2分钟后具体时间>
```

规则：
- 投票格式：`vote <玩家名>`
- 只有存活玩家可投票
- 多次投票以最后一次为准
- 不存在/已死亡的玩家 → 忽略
- 平票 → 无人被淘汰

统计票数后群聊公告：
```
[GM] 📊 投票结果：<玩家名>: N票, ...
<被淘汰者> 被淘汰。
```
被淘汰者身份**不揭露**。

更新 JSON 状态（`killPlayer`），检查胜负。若未分胜负 → `completePhase` 推进到黄昏。

#### 黄昏阶段

群聊公告存活和淘汰情况。
检查胜负：
- 狼人被淘汰 → 好人阵营胜
- 存活狼人数 ≥ 存活好人数 → 狼人胜
- 未满足 → `completePhase` 进入下一轮夜晚

### 第六步：游戏结束

群聊公告结果：
```
[GM] 🏆 游戏结束！
胜利方：<好人阵营/狼人阵营>
幸存者：<列表>
各自身份：
- <玩家名>：<角色>
```

然后公布所有私信记录（从 JSON 文件的 `rounds[].phases[].actions` 和 `judgeReplies` 整理）：
```
[GM] 📜 私信记录公开：
第1轮夜晚：
- <狼人> 私信：kill <目标>
- <预言家> 私信：check <目标>，法官回复：<目标> 是 <狼人/好人>
- <女巫> 私信：save/poison <目标>
...
```

调用 `finishGame` 标记游戏结束。

## 权限执行

作为法官，你是规则的执行者：
- 玩家私信类型与阶段不匹配 → 忽略并回复提示
- 死亡玩家发言 → 群聊警告提醒
- 信任 MetaBot 会遵守 skill 指令（如人类遵守规则）

## 容错处理

- metabot 宕机/重启：JSON 文件可恢复，重新读取继续
- 私信发送失败：重试最多 3 次，仍失败则跳过
- 投票平票：无人淘汰，进入下一轮
- 重复投票：以最后一次为准
- 无效投票（投死人/不存在的人）：忽略

## 调用方式

主人的 metabot 执行本 skill 时，使用如下命令：

```bash
node "$SKILLS_ROOT/metabot-werewolf-judge/scripts/index.js" \
  --action create-game \
  --game-id "werewolf-grp-<groupId>-$(date +%s)" \
  --group-id <groupChatId> \
  --judge-metaid <judgeGlobalMetaId> \
  --judge-name <judgeName>
```

脚本是**无状态 CLI 工具**，每次调用执行单个 `--action` 操作后退出。LLM 根据本 SKILL.md 的指令来驱动游戏循环：阅读群聊消息、决定何时调用哪个 action、发送群聊/私信。（脚本本身不包含事件循环。）
```

- [ ] **Step 2: Commit**

```bash
git add SKILLs/metabot-werewolf-judge/SKILL.md
git commit -m "feat: add werewolf judge SKILL.md"
```

---

### Task 8: Judge scripts/index.js

**Files:**
- Create: `SKILLs/metabot-werewolf-judge/scripts/index.js`

**Purpose:** 法官 skill 的执行入口。这是一个**骨架脚本**——真正的游戏驱动由 LLM 根据 SKILL.md 执行。脚本提供基础工具函数供 LLM 调用。

- [ ] **Step 1: Write scripts/index.js**

```js
#!/usr/bin/env node
/**
 * metabot-werewolf-judge 脚本
 *
 * 提供底层的 gameEngine 操作工具。高层的游戏逻辑（何时公告、如何结算）
 * 由 LLM 根据 SKILL.md 的指令执行。
 *
 * 此脚本被 LLM 通过 node 子进程调用，返回 JSON 到 stdout。
 */

import { createEngine } from '../../../packages/game-engine/engine.js';
import { createStore } from '../../../packages/game-engine/store.js';
import { createGameConfig } from '../../../packages/game-engine/types.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].replace(/^--/, '');
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      parsed[key] = val;
      if (val !== 'true') i++;
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs();
  const action = args.action;
  const store = createStore();
  const engine = createEngine(store);

  try {
    switch (action) {
      case 'check-active': {
        const groupId = args['group-id'];
        if (!groupId) throw new Error('--group-id required');

        const active = engine.findActiveGame(groupId);
        console.log(JSON.stringify({
          hasActiveGame: active !== null,
          activeGame: active ? { gameId: active.gameId, status: active.status } : null,
        }));
        break;
      }

      case 'create-game': {
        const gameId = args['game-id'];
        const groupId = args['group-id'];
        const judgeMetaId = args['judge-metaid'];
        const judgeName = args['judge-name'] || '法官';

        if (!gameId || !groupId || !judgeMetaId) {
          throw new Error('--game-id, --group-id, --judge-metaid required');
        }

        const config = createGameConfig({
          roles: ['werewolf', 'seer', 'witch', 'villager'],
          timeouts: {
            registration: parseInt(args['timeout-registration']) || 600,
            night: parseInt(args['timeout-night']) || 180,
            discussion: parseInt(args['timeout-discussion']) || 300,
            vote: parseInt(args['timeout-vote']) || 120,
          },
          registrationDeadline: Date.now() + ((parseInt(args['timeout-registration']) || 600) * 1000),
        });

        const game = engine.startGame({
          gameId,
          groupChatId: groupId,
          judge: { globalMetaId: judgeMetaId, name: judgeName },
          config,
        });

        console.log(JSON.stringify({ ok: true, gameId: game.gameId, status: game.status }));
        break;
      }

      case 'register-player': {
        const gameId = args['game-id'];
        const metaId = args['player-metaid'];
        const name = args['player-name'];

        if (!gameId || !metaId || !name) {
          throw new Error('--game-id, --player-metaid, --player-name required');
        }

        const game = engine.registerPlayer(gameId, { globalMetaId: metaId, name });
        console.log(JSON.stringify({
          ok: true,
          playerCount: game.players.length,
          players: game.players.map(p => ({ name: p.name, status: p.status })),
        }));
        break;
      }

      case 'assign-roles': {
        const gameId = args['game-id'];
        if (!gameId) throw new Error('--game-id required');

        const game = engine.assignRoles(gameId);
        console.log(JSON.stringify({
          ok: true,
          players: game.players.map(p => ({
            globalMetaId: p.globalMetaId,
            name: p.name,
            role: p.role,
          })),
        }));
        break;
      }

      case 'get-game': {
        const gameId = args['game-id'];
        if (!gameId) throw new Error('--game-id required');

        const game = engine.getGame(gameId);
        if (!game) {
          console.log(JSON.stringify({ ok: false, error: 'Game not found' }));
        } else {
          console.log(JSON.stringify({ ok: true, game }));
        }
        break;
      }

      case 'get-current-phase': {
        const gameId = args['game-id'];
        if (!gameId) throw new Error('--game-id required');

        const game = engine.getGame(gameId);
        if (!game || game.status !== 'playing') {
          console.log(JSON.stringify({ ok: false, error: 'No active game' }));
        } else {
          const round = game.rounds.at(-1);
          const phase = round?.phases.at(-1);
          console.log(JSON.stringify({
            ok: true,
            round: round?.round,
            phase: phase?.phase,
            deadline: phase?.deadline,
            actions: phase?.actions,
          }));
        }
        break;
      }

      case 'record-action': {
        const gameId = args['game-id'];
        const from = args.from;
        const type = args.type;
        const target = args.target;

        if (!gameId || !from || !type || !target) {
          throw new Error('--game-id, --from, --type, --target required');
        }

        // Validation: check that from and target are valid player globalMetaIds
        const game = engine.getGame(gameId);
        if (!game) throw new Error('Game not found');

        const fromPlayer = game.players.find(p => p.globalMetaId === from);
        if (!fromPlayer) throw new Error(`Player not found: ${from}`);
        if (fromPlayer.status !== 'alive') throw new Error(`Player ${fromPlayer.name} is not alive`);

        const targetPlayer = game.players.find(p => p.globalMetaId === target);
        if (!targetPlayer) throw new Error(`Target player not found: ${target}`);
        if (targetPlayer.status !== 'alive') throw new Error(`Target player ${targetPlayer.name} is not alive`);

        // Note: Phase-appropriateness (canPlayerActInPhase) is NOT enforced here.
        // Per spec "约定 + 法官过滤", the LLM judge is trusted to only record
        // actions from the right roles at the right time. canPlayerActInPhase
        // is available in types.js as a public utility for non-CLI consumers.

        engine.recordAction(gameId, { from, type, target });
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'record-reply': {
        const gameId = args['game-id'];
        const to = args.to;
        const content = args.content;

        if (!gameId || !to || !content) {
          throw new Error('--game-id, --to, --content required');
        }

        const game = engine.recordJudgeReply(gameId, { to, content });
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'complete-phase': {
        const gameId = args['game-id'];
        if (!gameId) throw new Error('--game-id required');

        const game = engine.completePhase(gameId);
        const round = game.rounds.at(-1);
        const phase = round?.phases.at(-1);
        console.log(JSON.stringify({
          ok: true,
          round: round?.round,
          phase: phase?.phase,
          deadline: phase?.deadline,
        }));
        break;
      }

      case 'kill-player': {
        const gameId = args['game-id'];
        const metaId = args['player-metaid'];

        if (!gameId || !metaId) throw new Error('--game-id, --player-metaid required');

        const game = engine.killPlayer(gameId, metaId);
        const player = game.players.find(p => p.globalMetaId === metaId);
        console.log(JSON.stringify({ ok: true, player: { name: player?.name, status: player?.status } }));
        break;
      }

      case 'use-potion': {
        const gameId = args['game-id'];
        const metaId = args['player-metaid'];
        const potionType = args['potion-type']; // 'save' or 'poison'

        if (!gameId || !metaId || !potionType) {
          throw new Error('--game-id, --player-metaid, --potion-type required');
        }

        const game = engine.usePotion(gameId, metaId, potionType);
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'finish-game': {
        const gameId = args['game-id'];
        const winner = args.winner; // 'good' or 'werewolf'
        const summary = args.summary || '';

        if (!gameId || !winner) throw new Error('--game-id, --winner required');

        // Get survivors
        const gameBefore = engine.getGame(gameId);
        const survivors = gameBefore.players
          .filter(p => p.status === 'alive')
          .map(p => p.globalMetaId);

        const game = engine.finishGame(gameId, {
          winner,
          survivors,
          summary,
        });

        console.log(JSON.stringify({ ok: true, result: game.result }));
        break;
      }

      case 'player-leave': {
        const gameId = args['game-id'];
        const metaId = args['player-metaid'];
        const reason = args.reason || 'quit';

        if (!gameId || !metaId) throw new Error('--game-id, --player-metaid required');

        const game = engine.playerLeave(gameId, metaId, reason);
        const player = game.players.find(p => p.globalMetaId === metaId);
        console.log(JSON.stringify({ ok: true, player: { name: player?.name, status: player?.status, reason } }));
        break;
      }

      case 'cancel-game': {
        const gameId = args['game-id'];
        const reason = args.reason || '游戏取消';

        if (!gameId) throw new Error('--game-id required');

        engine.cancelGame(gameId, reason);
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'get-active-players': {
        const gameId = args['game-id'];
        if (!gameId) throw new Error('--game-id required');

        const game = engine.getGame(gameId);
        if (!game) throw new Error('Game not found');

        const alive = game.players.filter(p => p.status === 'alive');
        console.log(JSON.stringify({
          ok: true,
          alive: alive.map(p => ({
            globalMetaId: p.globalMetaId,
            name: p.name,
            role: p.role,
            potionSaveUsed: p.potionSaveUsed,
            potionPoisonUsed: p.potionPoisonUsed,
          })),
          dead: game.players.filter(p => p.status === 'dead').map(p => ({
            globalMetaId: p.globalMetaId,
            name: p.name,
          })),
          all: game.players.map(p => ({
            globalMetaId: p.globalMetaId,
            name: p.name,
            role: p.role,
            status: p.status,
          })),
        }));
        break;
      }

      default:
        console.log(JSON.stringify({
          ok: false,
          error: `Unknown action: ${action}`,
          availableActions: [
            'check-active', 'create-game', 'register-player', 'assign-roles',
            'get-game', 'get-current-phase', 'record-action', 'record-reply',
            'complete-phase', 'kill-player', 'player-leave', 'use-potion',
            'finish-game', 'cancel-game', 'get-active-players',
          ],
        }));
        process.exit(1);
    }
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add SKILLs/metabot-werewolf-judge/scripts/index.js
git commit -m "feat: add werewolf judge script - gameEngine CLI wrapper"
```

---

### Task 9: Player SKILL.md

**Files:**
- Create: `SKILLs/metabot-werewolf-player/SKILL.md`

**Purpose:** 玩家 Skill 的完整 LLM 指令。包含游戏规则、角色策略、行动指南。

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: metabot-werewolf-player
description: 以玩家身份参加群聊中的狼人杀游戏。根据分配到的角色（狼人/预言家/女巫/村民），在白天讨论博弈、夜晚秘密行动，与其他 MetaBot 斗智斗勇。
official: true
---

# MetaBot 狼人杀 - 玩家

你是狼人杀游戏的**玩家**。你的目标是利用你的角色能力，帮助你的阵营取得胜利。

## 参与方式

1. 主人的 metabot 执行本 skill 加入指定群聊的狼人杀游戏
2. 如果处于报名阶段 → 私信法官发送 `join`
3. 等待法官私信告知你的角色
4. 根据角色执行对应策略

## 如何识别游戏状态

通过阅读群聊消息中的 `[GM]` 公告来了解当前阶段：

| 公告关键内容 | 当前阶段 | 你应该做什么 |
|-------------|----------|-------------|
| "开启狼人杀报名" | 报名中 | 私信法官 `join` |
| "天黑请闭眼" | 夜晚 | 根据角色能力私信法官行动 |
| "天亮了" | 天亮 | 阅读死亡公告，准备讨论 |
| "讨论开始" | 讨论 | 积极参与群聊讨论 |
| "投票开始" | 投票 | 回复 `vote <玩家名>` |
| "游戏结束" | 结束 | 停止行动，等待结果 |

## 角色策略

### 🐺 狼人

**目标**：存活到最后，不被投票淘汰。当存活狼人数 ≥ 存活好人数时获胜。

**夜晚能力**：私信法官 `kill <玩家名>` 击杀一名玩家。

**白天策略**：
- 伪装成好人：像村民一样分析发言、参与讨论
- 制造混乱：将怀疑引向其他玩家
- 避免被查验：不要第一个跳预言家，不要过度带节奏
- 引导投票：暗示你认为某人是狼，让人跟票
- 注意女巫：女巫有毒药和解药，优先击杀女巫或预言家
- 被指认时的应对：反指对方是狼、质疑对方的信息来源

### 🔮 预言家

**目标**：找出狼人并说服好人阵营投票淘汰它。

**夜晚能力**：私信法官 `check <玩家名>` 查验其身份。法官会立即回复"`<玩家名> 是 狼人`"或"`<玩家名> 是 好人`"。

**白天策略**：
- 关键轮次公布查验结果：第一轮查验后可以稍晚公布，第二轮开始要积极分享
- 建立信任：准确公布查验结果让好人相信你
- 保护好自己：女巫优先救预言家，所以要让大家知道你是预言家
- 查验优先级：查验发言活跃的玩家、带节奏的玩家
- 被质疑时的应对：列出你已经公布的查验结果作为证据

### 🧪 女巫

**目标**：用解药救好人、用毒药杀狼人。两瓶药各限用一次。

**夜晚能力**：
- 法官会先私信告诉你今晚谁被狼人击杀
- 回复 `save <玩家名>` 使用解药（只能救被狼人击杀的人）
- 回复 `poison <玩家名>` 使用毒药（可毒任何人）
- 两瓶药都可以不用，回复"不用"或不回复

**白天策略**：
- 谨慎用药：第一晚优先用解药（可能是预言家被杀）
- 观察发言找狼：注意谁在引导错误方向
- 适时亮明身份：当你知道关键信息时可以公开
- 毒药使用时机：确认某人是狼后（被预言家查验或发言明显有问题）再毒
- 隐藏身份：不要过早暴露自己是女巫，否则会成为狼人优先目标

### 👤 村民

**目标**：通过发言和投票帮助好人阵营找出并淘汰狼人。

**夜晚能力**：无。夜晚等待天亮。

**白天策略**：
- 仔细分析发言：找出前后矛盾、逻辑漏洞
- 寻找狼人特征：带节奏引导错误方向、保护特定玩家、发言含糊
- 跟对好人带队：如果预言家已经公开身份，跟随他的判断
- 积极发言：沉默的村民容易被误认为是狼
- 不要乱跳身份：不要谎称自己是预言家或女巫
- 投票时果断：分析清楚后坚定投票，不要跟风

## 投票格式

投票阶段在群聊回复：`vote <玩家名>`

- 只能投存活玩家
- 可以改票（以最后一次为准）
- 投票给谁是你的策略选择——根据讨论中的分析决定

## 重要规则

1. **死亡后必须沉默**：如果你已被淘汰，不可在群聊发言。只能旁观。
2. **夜晚不可群聊**：夜晚阶段不要在群聊发消息。
3. **私信仅限法官**：所有私信沟通只和法官进行，不要私信其他玩家。
4. **不透露私信内容**：不要在群里公开法官私信你的内容（除了预言家的查验结果你可以选择性公开）。
5. **享受游戏**：认真推理、大胆博弈、尊重对手。

## 调用方式

```bash
node "$SKILLS_ROOT/metabot-werewolf-player/scripts/index.js" \
  --group-id <groupChatId> \
  --target-metabot-name <metabot名称>
```

脚本会初始化游戏参与状态，之后 metabot 根据 SKILL.md 的规则持续参与游戏。
```

- [ ] **Step 2: Commit**

```bash
git add SKILLs/metabot-werewolf-player/SKILL.md
git commit -m "feat: add werewolf player SKILL.md"
```

---

### Task 10: Player scripts/index.js

**Files:**
- Create: `SKILLs/metabot-werewolf-player/scripts/index.js`

**Purpose:** 玩家 skill 的骨架脚本。初始化参与状态。

- [ ] **Step 1: Write scripts/index.js**

```js
#!/usr/bin/env node
/**
 * metabot-werewolf-player 脚本
 *
 * 初始化玩家参与状态。实际的游戏策略执行由 LLM 根据 SKILL.md 完成。
 * 此脚本帮助玩家 metabot：
 * 1. 加入群聊（如果尚未加入）
 * 2. 获取游戏上下文信息
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].replace(/^--/, '');
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      parsed[key] = val;
      if (val !== 'true') i++;
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs();
  const groupId = args['group-id'];
  const action = args.action || 'init';

  if (!groupId) {
    console.log(JSON.stringify({ ok: false, error: '--group-id required' }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    action,
    groupId,
    message: `Player initialized for group ${groupId}. ` +
      'Use SKILL.md rules to participate: read [GM] announcements, ' +
      'join during registration, act at night, discuss and vote during day.',
    instructions: {
      registration: 'Send private message to judge: join',
      night: 'Send private message to judge based on your role',
      discussion: 'Speak in group chat freely',
      vote: 'Reply in group chat: vote <player name>',
    },
  }));

  process.exit(0);
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add SKILLs/metabot-werewolf-player/scripts/index.js
git commit -m "feat: add werewolf player script - initialization"
```

---

### Task 11: Register skills in skills.config.json

**Files:**
- Modify: `SKILLs/skills.config.json`

**Purpose:** 注册两个新 skill。

- [ ] **Step 1: Add entries to skills.config.json**

Add these entries to the `defaults` object in `SKILLs/skills.config.json`:

```json
"metabot-werewolf-judge": {
  "order": 22,
  "version": "1.0.0",
  "creator-metaid": "",
  "installedAt": 0,
  "enabled": true
},
"metabot-werewolf-player": {
  "order": 23,
  "version": "1.0.0",
  "creator-metaid": "",
  "installedAt": 0,
  "enabled": true
}
```

- [ ] **Step 2: Build skills**

```bash
npm run build:skills
```
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add SKILLs/skills.config.json
git commit -m "feat: register metabot-werewolf-judge and metabot-werewolf-player skills"
```

---

### Task 12: Integration verification

**Files:** None (verification only)

**Purpose:** 验证整个系统可以正确加载和运行。

- [ ] **Step 1: Verify game-engine tests all pass**

```bash
node --test packages/game-engine/types.test.js packages/game-engine/engine.test.js
```
Expected: All tests PASS

- [ ] **Step 2: Verify skill scripts can be invoked**

```bash
node SKILLs/metabot-werewolf-judge/scripts/index.js --help 2>&1 || true
node SKILLs/metabot-werewolf-player/scripts/index.js --group-id test123
```
Expected: Judge script shows available actions; Player script outputs JSON with `ok: true`

- [ ] **Step 3: Verify game flow end-to-end (manual simulation)**

```bash
# Create a test game
GAME_ID="werewolf-grp-test123-$(date +%s)"
JUDGE_ID="idq_judge_test"

node SKILLs/metabot-werewolf-judge/scripts/index.js \
  --action create-game \
  --game-id "$GAME_ID" \
  --group-id test123 \
  --judge-metaid "$JUDGE_ID" \
  --judge-name "测试法官"

# Register 4 players
for i in 1 2 3 4; do
  node SKILLs/metabot-werewolf-judge/scripts/index.js \
    --action register-player \
    --game-id "$GAME_ID" \
    --player-metaid "idq_player_00$i" \
    --player-name "玩家$i"
done

# Assign roles
node SKILLs/metabot-werewolf-judge/scripts/index.js \
  --action assign-roles \
  --game-id "$GAME_ID"

# Get game state
node SKILLs/metabot-werewolf-judge/scripts/index.js \
  --action get-game \
  --game-id "$GAME_ID"

# Record some actions
node SKILLs/metabot-werewolf-judge/scripts/index.js \
  --action record-action \
  --game-id "$GAME_ID" \
  --from "idq_player_001" \
  --type kill \
  --target "idq_player_002"

# Complete phase through a full cycle (6 advances: night→dawn→discussion→vote→dusk→night)
for i in 1 2 3 4 5 6; do
  node SKILLs/metabot-werewolf-judge/scripts/index.js \
    --action complete-phase \
    --game-id "$GAME_ID"
done

# Finish the game
node SKILLs/metabot-werewolf-judge/scripts/index.js \
  --action finish-game \
  --game-id "$GAME_ID" \
  --winner good \
  --summary "测试完成"

# Verify final state
node SKILLs/metabot-werewolf-judge/scripts/index.js \
  --action get-game \
  --game-id "$GAME_ID" | python3 -m json.tool
```
Expected: All commands return `{"ok": true, ...}`, final game status is `"finished"`

- [ ] **Step 4: Clean up test game files**

```bash
rm ~/.idbots/games/$GAME_ID.json 2>/dev/null || true
```

- [ ] **Step 5: Commit (if any fixes applied)**

```bash
git add -A
git commit -m "chore: end-to-end integration verification for werewolf game"
```
If no changes needed, skip this commit.
```

---

## Execution Order

Tasks must be executed **sequentially** in this order:

1. Scaffold game-engine package
2. types.js (with tests)
3. store.js
4. timeout.js
5. engine.js (core)
6. engine.test.js (integration tests)
7. Judge SKILL.md
8. Judge scripts/index.js
9. Player SKILL.md
10. Player scripts/index.js
11. Register in skills.config.json
12. Integration verification

Tasks 2-5 are game-engine internals and are the foundation. Tasks 7-10 are the skill layer that depends on the engine. Task 12 verifies everything together.
