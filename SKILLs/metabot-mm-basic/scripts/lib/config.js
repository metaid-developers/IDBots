'use strict';

const fs = require('fs');
const path = require('path');

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
  return JSON.parse(raw);
}

function isPositiveNumber(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('config is required.');
  }

  const errors = [];

  if (!config.market_data || !config.market_data.provider) {
    errors.push('market_data.provider');
  }

  if (config.market_data?.quote_fallback_enabled === undefined) {
    errors.push('quote_fallback_enabled');
  }

  if (config.market_data?.execute_fallback_enabled === undefined) {
    errors.push('execute_fallback_enabled');
  }

  if (!config.pairs || typeof config.pairs !== 'object' || Object.keys(config.pairs).length === 0) {
    errors.push('pairs');
  }

  if (config.pairs && typeof config.pairs === 'object') {
    for (const [, pairConfig] of Object.entries(config.pairs)) {
      if (!pairConfig || typeof pairConfig !== 'object') {
        errors.push('pair_config');
        continue;
      }

      if (!pairConfig.trade_limits || typeof pairConfig.trade_limits !== 'object') {
        errors.push('trade_limits');
      } else {
        const values = Object.values(pairConfig.trade_limits);
        if (values.length === 0 || values.some((value) => !isPositiveNumber(value))) {
          errors.push('trade_limits');
        }
      }

      if (!pairConfig.max_usable_inventory || typeof pairConfig.max_usable_inventory !== 'object') {
        errors.push('max_usable_inventory');
      } else {
        const values = Object.values(pairConfig.max_usable_inventory);
        if (values.length === 0 || values.some((value) => !isPositiveNumber(value))) {
          errors.push('max_usable_inventory');
        }
      }

      const targetInventory = pairConfig.target_inventory;
      if (!targetInventory || typeof targetInventory !== 'object') {
        errors.push('target_inventory');
      } else {
        const values = Object.values(targetInventory);
        if (values.length === 0 || values.some((value) => !isPositiveNumber(value))) {
          errors.push('target_inventory');
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
