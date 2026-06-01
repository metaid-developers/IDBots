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
    config.noteRouteMode ||
    root.IDFrameworkNoteRouteMode
  );
}

function decodeQueryPart(value) {
  var text = String(value || '').replace(/\+/g, ' ');
  try {
    return decodeURIComponent(text);
  } catch (_) {
    return text;
  }
}

function parseRouteQuery(searchLike) {
  var search = String(searchLike || '').replace(/^\?/, '').trim();
  var query = {};
  if (!search) return query;

  search.split('&').forEach(function eachPair(pair) {
    if (!pair) return;
    var equalIndex = pair.indexOf('=');
    var rawKey = equalIndex >= 0 ? pair.slice(0, equalIndex) : pair;
    var rawValue = equalIndex >= 0 ? pair.slice(equalIndex + 1) : '';
    var key = decodeQueryPart(rawKey);
    if (!key) return;
    query[key] = decodeQueryPart(rawValue);
  });

  return query;
}

function splitPathAndQuery(routeLike) {
  var raw = String(routeLike || '').trim();
  var queryIndex = raw.indexOf('?');
  if (queryIndex < 0) {
    return {
      path: raw,
      query: {},
    };
  }

  return {
    path: raw.slice(0, queryIndex),
    query: parseRouteQuery(raw.slice(queryIndex + 1)),
  };
}

function decodePathSegment(value) {
  var text = String(value || '');
  if (!text) return '';
  try {
    return decodeURIComponent(text);
  } catch (_) {
    return text;
  }
}

function getRawRouteFromLocation(locationLike, globalObject) {
  var hash = String(locationLike && locationLike.hash || '').replace(/^#/, '').trim();
  if (hash) return hash;

  if (resolveNoteRouteMode(locationLike, globalObject) === 'hash') {
    return '/';
  }

  var pathname = String(locationLike && locationLike.pathname || '/').trim();
  var search = String(locationLike && locationLike.search || '');
  return pathname + search;
}

export function normalizeNoteRoutePath(pathname) {
  var path = String(pathname || '').trim();
  if (!path) return '/';
  path = path.replace(/^#/, '').trim();
  if (path.charAt(0) !== '/') path = '/' + path;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

export function parseNoteRoute(locationLike, globalObject) {
  var routeLike = getRawRouteFromLocation(locationLike, globalObject);
  var parsed = splitPathAndQuery(routeLike);
  var path = normalizeNoteRoutePath(parsed.path || '/');
  var query = parsed.query;
  var segments = path.split('/').filter(Boolean);
  var decodedSegments = segments.map(decodePathSegment);
  var params = {};
  var view = 'list';

  if (!decodedSegments.length) {
    view = 'list';
  } else if (decodedSegments[0] === 'mynote') {
    view = 'mynote';
  } else if (decodedSegments[0] === 'draft') {
    view = 'draft';
  } else if (decodedSegments[0] === 'note' && decodedSegments[1] === 'new') {
    view = 'editor';
  } else if (decodedSegments[0] === 'note' && decodedSegments[1] && decodedSegments[2] === 'edit') {
    view = 'editor';
    params.id = decodedSegments[1];
  } else if (decodedSegments[0] === 'note' && decodedSegments[1]) {
    view = 'detail';
    params.id = decodedSegments[1];
  }

  return {
    path: path,
    view: view,
    params: params,
    query: query,
  };
}

export function resolveNoteRouteMode(locationLike, globalObject) {
  var configured = getConfiguredRouteMode(globalObject);
  if (configured) return configured;

  var pathname = String(locationLike && locationLike.pathname || '').trim();
  return /\.html?$/i.test(pathname) ? 'hash' : 'history';
}

export function buildNoteRouteUrl(locationLike, nextPath, globalObject) {
  var routePath = normalizeNoteRoutePath(nextPath);
  if (resolveNoteRouteMode(locationLike, globalObject) === 'hash') {
    var pathname = String(locationLike && locationLike.pathname || '/index.html');
    var search = String(locationLike && locationLike.search || '');
    return pathname + search + '#' + routePath;
  }

  return routePath;
}

export function getCurrentNoteRouteUrl(locationLike, globalObject) {
  if (resolveNoteRouteMode(locationLike, globalObject) === 'hash') {
    var pathname = String(locationLike && locationLike.pathname || '/index.html');
    var search = String(locationLike && locationLike.search || '');
    var hash = String(locationLike && locationLike.hash || '');
    return pathname + search + hash;
  }

  var pathname = normalizeNoteRoutePath(locationLike && locationLike.pathname || '/');
  var search = String(locationLike && locationLike.search || '');
  return pathname + search;
}
