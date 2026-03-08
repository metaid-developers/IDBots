#!/usr/bin/env node
/*
 * weather skill (cross-platform):
 * - Preferred provider: wttr.in
 * - Automatic fallback: Open-Meteo
 *
 * Examples:
 *   node "$SKILLS_ROOT/weather/scripts/index.js" --city "London"
 *   node "$SKILLS_ROOT/weather/scripts/index.js" --city "New York" --format compact
 *   node "$SKILLS_ROOT/weather/scripts/index.js" --city "San Francisco" --provider open-meteo
 *   node "$SKILLS_ROOT/weather/scripts/index.js" --lat 51.5 --lon -0.12
 */

const http = require('node:http');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const DEFAULT_TIMEOUT_MS = 15_000;
let proxyConfigured = false;
let curlAvailableCache;

const TIMEZONE_CITY_HINTS = {
  'Asia/Hong_Kong': 'Hong Kong',
  'Asia/Shanghai': 'Shanghai',
  'Asia/Tokyo': 'Tokyo',
  'Asia/Singapore': 'Singapore',
  'Asia/Seoul': 'Seoul',
  'Europe/London': 'London',
  'Europe/Paris': 'Paris',
  'Europe/Berlin': 'Berlin',
  'America/New_York': 'New York',
  'America/Los_Angeles': 'Los Angeles',
  'America/Chicago': 'Chicago',
  'America/Denver': 'Denver',
  'America/Toronto': 'Toronto',
  'Australia/Sydney': 'Sydney',
};

const WEATHER_CODE_LABELS = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow fall',
  73: 'Moderate snow fall',
  75: 'Heavy snow fall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

function printHelp() {
  console.log(
    [
      'weather skill',
      '',
      'Usage:',
      '  node weather/scripts/index.js --city "<city>" [--format current|compact|forecast] [--units metric|us]',
      '  node weather/scripts/index.js --lat <number> --lon <number> [--units metric|us]',
      '  node weather/scripts/index.js   # auto-detect location via wttr.in',
      '',
      'Options:',
      '  --city, -c      City name (for example "London", "New York").',
      '  --format, -f    wttr output format: current (default), compact, forecast.',
      '  --units, -u     metric (default) or us.',
      '  --provider      wttr (default) or open-meteo.',
      '  --lat           Latitude for direct Open-Meteo lookup.',
      '  --lon           Longitude for direct Open-Meteo lookup.',
      '  --help, -h      Show this help message.',
    ].join('\n')
  );
}

function configureProxyDispatcherIfNeeded() {
  if (proxyConfigured) return;
  proxyConfigured = true;
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  if (!proxy) return;

  try {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new ProxyAgent(proxy));
  } catch (error) {
    // Ignore: fetch can still attempt direct connection.
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`weather skill warning: failed to configure proxy dispatcher (${detail})`);
  }
}

function hasCurl() {
  if (curlAvailableCache !== undefined) return curlAvailableCache;
  try {
    const probe = spawnSync('curl', ['--version'], { stdio: 'ignore' });
    curlAvailableCache = probe.status === 0;
  } catch {
    curlAvailableCache = false;
  }
  return curlAvailableCache;
}

function requestWithCurl(url, timeoutMs) {
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const result = spawnSync('curl', [
    '-sS',
    '-L',
    '--max-time',
    String(timeoutSec),
    '-H',
    'User-Agent: IDBots-weather-skill/1.0',
    '-H',
    'Accept: */*',
    url,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || `curl exited with code ${result.status}`).trim());
  }

  const text = (result.stdout || '').trim();
  if (!text) {
    throw new Error('curl returned empty response');
  }
  return text;
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getStringOption(values, key) {
  const value = values[key];
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProvider(rawValue) {
  const value = rawValue.toLowerCase();
  if (!value) return 'wttr';
  if (value === 'wttr' || value === 'open-meteo') return value;
  throw new Error(`Invalid --provider value: "${rawValue}". Use "wttr" or "open-meteo".`);
}

function normalizeFormat(rawValue) {
  const value = rawValue.toLowerCase();
  if (!value) return 'current';
  if (value === 'current' || value === 'compact' || value === 'forecast') return value;
  throw new Error(`Invalid --format value: "${rawValue}". Use current, compact, or forecast.`);
}

function normalizeUnits(rawValue) {
  const value = rawValue.toLowerCase();
  if (!value) return 'metric';
  if (value === 'metric' || value === 'us') return value;
  throw new Error(`Invalid --units value: "${rawValue}". Use "metric" or "us".`);
}

function parseFloatOrThrow(rawValue, label) {
  const value = Number.parseFloat(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${label} value: "${rawValue}".`);
  }
  return value;
}

function parseCoordinates(values) {
  const latRaw = getStringOption(values, 'lat') || getStringOption(values, 'latitude');
  const lonRaw = getStringOption(values, 'lon') || getStringOption(values, 'longitude');
  if (!latRaw && !lonRaw) return null;
  if (!latRaw || !lonRaw) {
    throw new Error('Both --lat and --lon are required when using coordinates.');
  }

  const latitude = parseFloatOrThrow(latRaw, 'latitude');
  const longitude = parseFloatOrThrow(lonRaw, 'longitude');
  if (latitude < -90 || latitude > 90) {
    throw new Error(`Latitude out of range: ${latitude}. Must be between -90 and 90.`);
  }
  if (longitude < -180 || longitude > 180) {
    throw new Error(`Longitude out of range: ${longitude}. Must be between -180 and 180.`);
  }
  return { latitude, longitude };
}

function requestWithNode(url, timeoutMs) {
  const client = url.startsWith('https://') ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(
      url,
      {
        headers: {
          'User-Agent': 'IDBots-weather-skill/1.0',
          Accept: '*/*',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`HTTP ${(res.statusCode || 500)}: ${text.slice(0, 300)}`));
            return;
          }
          resolve(text);
        });
      }
    );

    req.on('error', (error) => reject(error));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
  });
}

async function requestText(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const errors = [];
  configureProxyDispatcherIfNeeded();

  if (typeof fetch === 'function') {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'IDBots-weather-skill/1.0',
          Accept: '*/*',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      return text;
    } catch (error) {
      errors.push(`fetch: ${toErrorMessage(error)}`);
    }
  }

  try {
    return await requestWithNode(url, timeoutMs);
  } catch (error) {
    errors.push(`node-http: ${toErrorMessage(error)}`);
  }

  if (hasCurl()) {
    try {
      return requestWithCurl(url, timeoutMs);
    } catch (error) {
      errors.push(`curl: ${toErrorMessage(error)}`);
    }
  }

  throw new Error(`all request methods failed for ${url}: ${errors.join(' | ')}`);
}

async function requestJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const raw = await requestText(url, timeoutMs);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON response from ${url}`);
  }
}

function formatOpenMeteoSummary(label, current, units) {
  const code = Number(current.weather_code);
  const condition = WEATHER_CODE_LABELS[code] || `Weather code ${code}`;
  const tempUnit = units === 'us' ? 'F' : 'C';
  const windUnit = units === 'us' ? 'mph' : 'km/h';

  const temperature = typeof current.temperature_2m === 'number'
    ? `${Math.round(current.temperature_2m)}${tempUnit}`
    : 'n/a';
  const apparent = typeof current.apparent_temperature === 'number'
    ? `${Math.round(current.apparent_temperature)}${tempUnit}`
    : 'n/a';
  const humidity = typeof current.relative_humidity_2m === 'number'
    ? `${Math.round(current.relative_humidity_2m)}%`
    : 'n/a';
  const wind = typeof current.wind_speed_10m === 'number'
    ? `${Math.round(current.wind_speed_10m)}${windUnit}`
    : 'n/a';

  return `${label}: ${condition}, ${temperature}, feels ${apparent}, humidity ${humidity}, wind ${wind}`;
}

async function queryWttrByCity(city, format, units) {
  let formatPart = 'format=3';
  if (format === 'compact') {
    formatPart = 'format=%l:+%c+%t+%h+%w';
  } else if (format === 'forecast') {
    formatPart = 'T';
  }

  const unitPart = units === 'us' ? 'u' : 'm';
  const query = `${formatPart}&${unitPart}`;
  const locationPath = city ? encodeURIComponent(city) : '';
  const url = `https://wttr.in/${locationPath}?${query}`;
  const text = (await requestText(url)).trim();
  if (!text) {
    throw new Error('wttr.in returned empty response');
  }
  return text;
}

function inferCityFromTimezone() {
  const tz = (process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim();
  return TIMEZONE_CITY_HINTS[tz] || '';
}

async function geocodeCity(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const payload = await requestJson(url);
  const first = Array.isArray(payload.results) ? payload.results[0] : null;
  if (!first || typeof first.latitude !== 'number' || typeof first.longitude !== 'number') {
    throw new Error(`Open-Meteo geocoding found no coordinates for "${city}"`);
  }
  const labelParts = [first.name, first.admin1, first.country].filter((item) => typeof item === 'string' && item.trim());
  const label = labelParts.join(', ') || city;
  return {
    latitude: first.latitude,
    longitude: first.longitude,
    label,
  };
}

async function queryOpenMeteoByCoordinates(latitude, longitude, label, units) {
  const temperatureUnit = units === 'us' ? 'fahrenheit' : 'celsius';
  const windSpeedUnit = units === 'us' ? 'mph' : 'kmh';
  const url = [
    'https://api.open-meteo.com/v1/forecast',
    `?latitude=${encodeURIComponent(String(latitude))}`,
    `&longitude=${encodeURIComponent(String(longitude))}`,
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code',
    '&timezone=auto',
    `&temperature_unit=${temperatureUnit}`,
    `&wind_speed_unit=${windSpeedUnit}`,
  ].join('');

  const payload = await requestJson(url);
  if (!payload || typeof payload !== 'object' || !payload.current || typeof payload.current !== 'object') {
    throw new Error('Open-Meteo response missing current weather data');
  }

  return formatOpenMeteoSummary(label, payload.current, units);
}

async function queryOpenMeteoByCity(city, units) {
  const location = await geocodeCity(city);
  return queryOpenMeteoByCoordinates(
    location.latitude,
    location.longitude,
    location.label,
    units
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      city: { type: 'string', short: 'c' },
      format: { type: 'string', short: 'f' },
      units: { type: 'string', short: 'u' },
      provider: { type: 'string' },
      lat: { type: 'string' },
      latitude: { type: 'string' },
      lon: { type: 'string' },
      longitude: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const provider = normalizeProvider(getStringOption(values, 'provider'));
  const format = normalizeFormat(getStringOption(values, 'format'));
  const units = normalizeUnits(getStringOption(values, 'units'));
  const coordinates = parseCoordinates(values);
  const city = getStringOption(values, 'city')
    || (process.env.IDBOTS_WEATHER_DEFAULT_CITY || '').trim()
    || inferCityFromTimezone();

  const hasCity = Boolean(city);

  if (coordinates) {
    const label = city || `(${coordinates.latitude}, ${coordinates.longitude})`;
    const summary = await queryOpenMeteoByCoordinates(
      coordinates.latitude,
      coordinates.longitude,
      label,
      units
    );
    console.log(summary);
    return;
  }

  if (provider === 'open-meteo') {
    if (!hasCity) {
      throw new Error('Open-Meteo mode requires location. Pass --city "<city>" or --lat/--lon.');
    }
    const summary = await queryOpenMeteoByCity(city, units);
    console.log(summary);
    return;
  }

  try {
    const text = await queryWttrByCity(hasCity ? city : '', format, units);
    console.log(text);
  } catch (wttrError) {
    if (!hasCity) {
      throw new Error(
        `wttr.in auto-location failed: ${toErrorMessage(wttrError)}. `
        + 'Please pass --city "<city>" for a deterministic fallback.'
      );
    }
    // wttr.in can be blocked in some networks; fallback to Open-Meteo for stability.
    const fallbackText = await queryOpenMeteoByCity(city, units);
    console.error(`wttr.in failed, switched to Open-Meteo: ${toErrorMessage(wttrError)}`);
    console.log(fallbackText);
  }
}

main().catch((error) => {
  console.error(`weather skill error: ${toErrorMessage(error)}`);
  process.exit(1);
});
