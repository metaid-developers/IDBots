function normalizeRouteMode(value) {
  var mode = String(value || '').trim().toLowerCase();
  return mode === 'hash' || mode === 'history' ? mode : '';
}

function getConfiguredRouteMode(globalObject) {
  var root = globalObject && typeof globalObject === 'object' ? globalObject : {};
  var config = root.IDFrameworkConfig && typeof root.IDFrameworkConfig === 'object'
    ? root.IDFrameworkConfig
    : {};

  return normalizeRouteMode(
    config.buzzRouteMode ||
    root.IDFrameworkBuzzRouteMode
  );
}

export function normalizeBuzzRoutePath(pathname) {
  var path = String(pathname || '').trim();
  if (!path) return '/home/new';
  if (path.charAt(0) !== '/') path = '/' + path;
  return path;
}

export function resolveBuzzRouteMode(locationLike, globalObject) {
  var configured = getConfiguredRouteMode(globalObject);
  if (configured) return configured;

  var pathname = String(locationLike && locationLike.pathname || '').trim();
  return /\.html?$/i.test(pathname) ? 'hash' : 'history';
}

export function getBuzzRoutePathFromLocation(locationLike, globalObject) {
  if (resolveBuzzRouteMode(locationLike, globalObject) === 'hash') {
    var hash = String(locationLike && locationLike.hash || '').replace(/^#/, '').trim();
    return normalizeBuzzRoutePath(hash || '/home/new');
  }

  return normalizeBuzzRoutePath(locationLike && locationLike.pathname || '/home/new');
}

export function buildBuzzRouteUrl(locationLike, nextPath, globalObject) {
  var routePath = normalizeBuzzRoutePath(nextPath);
  if (resolveBuzzRouteMode(locationLike, globalObject) === 'hash') {
    var pathname = String(locationLike && locationLike.pathname || '/index.html');
    var search = String(locationLike && locationLike.search || '');
    return pathname + search + '#' + routePath;
  }

  return routePath;
}

export function getCurrentBuzzRouteUrl(locationLike, globalObject) {
  if (resolveBuzzRouteMode(locationLike, globalObject) === 'hash') {
    var pathname = String(locationLike && locationLike.pathname || '/index.html');
    var search = String(locationLike && locationLike.search || '');
    var hash = String(locationLike && locationLike.hash || '');
    return pathname + search + hash;
  }

  return normalizeBuzzRoutePath(locationLike && locationLike.pathname || '/home/new');
}
