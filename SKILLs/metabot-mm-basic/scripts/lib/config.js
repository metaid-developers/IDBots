'use strict';

const fs = require('fs');
const path = require('path');

const SUPPORTED_PAIRS = {
  'BTC/SPACE': ['BTC', 'SPACE'],
  'DOGE/SPACE': ['DOGE', 'SPACE'],
};

function resolveConfigPath({ env }) {
  const base = String(env?.IDBOTS_USER_DATA_PATH || '').trim();
  if (!base) {
    throw new Error('IDBOTS_USER_DATA_PATH is required.');
  }
  return path.join(base, 'metabot-mm-basic', 'config.json');
}

function loadConfig({ env }) {
  const filePath = resolveConfigPath({ env });
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return validateConfig(parsed);
}

function isPositiveNumber(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function validateExactKeys(map, expectedKeys) {
  const keys = Object.keys(map);
  if (keys.length !== expectedKeys.length) {
    return false;
  }
  return expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(map, key));
}

function buildTradeLimitKeys(assets) {
  return assets.flatMap((asset) => [`min_in_${asset}`, `max_in_${asset}`]);
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('config is required.');
  }

  const errors = [];

  if (!config.market_data || !config.market_data.provider) {
    errors.push('market_data.provider');
  }

  if (typeof config.market_data?.quote_fallback_enabled !== 'boolean') {
    errors.push('quote_fallback_enabled');
  }

  if (typeof config.market_data?.execute_fallback_enabled !== 'boolean') {
    errors.push('execute_fallback_enabled');
  }

  if (!config.pairs || typeof config.pairs !== 'object' || Object.keys(config.pairs).length === 0) {
    errors.push('pairs');
  }

  if (config.pairs && typeof config.pairs === 'object') {
    for (const [pairKey, pairConfig] of Object.entries(config.pairs)) {
      const assets = SUPPORTED_PAIRS[pairKey];
      if (!assets) {
        errors.push('pairs');
        continue;
      }

      if (!pairConfig || typeof pairConfig !== 'object') {
        errors.push('pair_config');
        continue;
      }

      if (!pairConfig.trade_limits || typeof pairConfig.trade_limits !== 'object') {
        errors.push('trade_limits');
      } else {
        const expectedTradeKeys = buildTradeLimitKeys(assets);
        if (!validateExactKeys(pairConfig.trade_limits, expectedTradeKeys)) {
          errors.push('trade_limits');
        } else {
          for (const key of expectedTradeKeys) {
            if (!isPositiveNumber(pairConfig.trade_limits[key])) {
              errors.push('trade_limits');
              break;
            }
          }
        }
      }

      if (!pairConfig.max_usable_inventory || typeof pairConfig.max_usable_inventory !== 'object') {
        errors.push('max_usable_inventory');
      } else {
        if (!validateExactKeys(pairConfig.max_usable_inventory, assets)) {
          errors.push('max_usable_inventory');
        } else {
          const values = Object.values(pairConfig.max_usable_inventory);
          if (values.some((value) => !isPositiveNumber(value))) {
            errors.push('max_usable_inventory');
          }
        }
      }

      const targetInventory = pairConfig.target_inventory;
      if (!targetInventory || typeof targetInventory !== 'object') {
        errors.push('target_inventory');
      } else {
        if (!validateExactKeys(targetInventory, assets)) {
          errors.push('target_inventory');
        } else {
          const values = Object.values(targetInventory);
          if (values.some((value) => !isPositiveNumber(value))) {
            errors.push('target_inventory');
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid config: ${errors.join(', ')}`);
  }

  return config;
}

module.exports = {
  resolveConfigPath,
  loadConfig,
  validateConfig,
};
