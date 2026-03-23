/**
 * FetchBuzzCommentsCommand - fetch comments list for a buzz.
 */
export default class FetchBuzzCommentsCommand {
  async execute({ payload = {}, delegate }) {
    if (!delegate) {
      throw new Error('FetchBuzzCommentsCommand: delegate is required');
    }

    var pinId = this._normalizePinId(payload.pinId || payload.pinid || payload.id || '');
    if (!pinId) {
      return { list: [], total: 0, pinId: '' };
    }

    var endpoint = '/social/buzz/comments?pinId=' + encodeURIComponent(pinId);
    var response = await delegate('metaid_man', endpoint, { method: 'GET' });
    var list = this._normalizeCommentList(response);

    return {
      pinId: pinId,
      list: list,
      total: list.length,
      raw: response,
    };
  }

  _normalizePinId(value) {
    var text = String(value || '').trim();
    if (!text) return '';

    var match = text.match(/[A-Fa-f0-9]{64}i\d+/);
    if (match && match[0]) return match[0];

    var cleaned = text.split('?')[0].split('#')[0].replace(/\/+$/, '');
    if (cleaned.indexOf('metafile://') === 0) cleaned = cleaned.slice('metafile://'.length);
    if (cleaned.indexOf('/pin/') >= 0) cleaned = cleaned.split('/pin/').pop() || '';
    if (cleaned.indexOf('/content/') >= 0) cleaned = cleaned.split('/content/').pop() || '';

    match = cleaned.match(/[A-Fa-f0-9]{64}i\d+/);
    return match && match[0] ? match[0] : String(cleaned || '').trim();
  }

  _normalizeCommentList(response) {
    var payload = response;
    if (response && typeof response === 'object' && typeof response.code === 'number') {
      payload = response.data || {};
    } else if (response && typeof response === 'object' && response.data && typeof response.data === 'object') {
      payload = response.data;
    }

    var source = [];
    if (Array.isArray(payload)) {
      source = payload;
    } else if (Array.isArray(payload && payload.comments)) {
      source = payload.comments;
    } else if (Array.isArray(payload && payload.list)) {
      source = payload.list;
    }

    return source.map((item) => this._normalizeCommentItem(item)).filter(Boolean);
  }

  _normalizeCommentItem(item) {
    if (!item || typeof item !== 'object') return null;

    var pinId = String(item.pinId || item.id || item.pinid || '').trim();
    if (!pinId) return null;

    var content = this._extractCommentContent(item);
    var timestamp = this._normalizeTimestamp(item.timestamp || item.createTime || item.time || item.createdAt);

    return {
      pinId: pinId,
      content: content,
      timestamp: timestamp,
      chainName: String(item.chainName || item.chain || '').trim(),
      createAddress: String(item.createAddress || item.address || item.creatorAddress || '').trim(),
      createMetaid: String(item.CreateMetaid || item.createMetaid || item.metaid || item.metaId || '').trim(),
      likeNum: Number(item.likeNum || item.likeCount || 0) || 0,
      commentNum: Number(item.commentNum || item.commentCount || 0) || 0,
      forwardNum: Number(item.forwardNum || item.forwardCount || 0) || 0,
      raw: item,
    };
  }

  _extractCommentContent(item) {
    var direct = this._pickFirstString([
      item.content,
      item.contentSummary,
      item.body,
      item.message,
      item.text,
    ]);

    if (!direct) return '';
    if (!this._looksLikeJson(direct)) return direct;

    var parsed = this._tryParseJsonObject(direct);
    if (!parsed) return direct;

    var fromJson = this._pickFirstString([
      parsed.content,
      parsed.publicContent,
      parsed.message,
      parsed.text,
    ]);
    return fromJson || direct;
  }

  _pickFirstString(candidates) {
    for (var i = 0; i < candidates.length; i += 1) {
      var value = candidates[i];
      if (value === null || value === undefined) continue;
      if (typeof value === 'string') {
        var text = value.trim();
        if (text) return text;
        continue;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        var converted = String(value).trim();
        if (converted) return converted;
      }
    }
    return '';
  }

  _tryParseJsonObject(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') return null;
    try {
      var parsed = JSON.parse(rawValue);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  _looksLikeJson(text) {
    if (!text) return false;
    var first = text[0];
    var last = text[text.length - 1];
    return (first === '{' && last === '}') || (first === '[' && last === ']');
  }

  _normalizeTimestamp(raw) {
    var value = Number(raw || 0);
    if (!Number.isFinite(value) || value <= 0) return Date.now();
    if (value < 1000000000000) value *= 1000;
    return Math.floor(value);
  }
}
