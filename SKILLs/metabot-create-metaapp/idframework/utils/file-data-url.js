function readAsDataUrl(blob) {
  return new Promise(function (resolve, reject) {
    if (typeof FileReader === 'undefined') {
      reject(new Error('FileReader is unavailable'));
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = function () {
      reject(reader.error || new Error('Failed to read file'));
    };
    reader.readAsDataURL(blob);
  });
}

function base64ToBytes(base64) {
  if (typeof atob === 'function') {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(base64, 'base64'));
  }

  throw new Error('No base64 decoder is available');
}

function mimeToExtension(mimeType) {
  var type = String(mimeType || '').trim().toLowerCase();
  if (!type) return 'bin';
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/svg+xml') return 'svg';
  var slashIndex = type.indexOf('/');
  if (slashIndex < 0) return 'bin';
  var subtype = type.slice(slashIndex + 1).split(';')[0].trim();
  if (!subtype) return 'bin';
  return subtype.replace(/[^a-z0-9]+/g, '') || 'bin';
}

export function isDataUrl(value) {
  return /^data:/i.test(String(value || '').trim());
}

export async function fileToDataUrl(file) {
  if (!(file instanceof Blob)) throw new Error('Invalid file object');
  return await readAsDataUrl(file);
}

export function dataUrlFileName(dataUrl, stem = 'file') {
  var match = String(dataUrl || '').match(/^data:([^;,]+)[;,]/i);
  var mimeType = match && match[1] ? match[1] : 'application/octet-stream';
  return String(stem || 'file') + '.' + mimeToExtension(mimeType);
}

export function dataUrlToFile(dataUrl, fileName) {
  var text = String(dataUrl || '').trim();
  var match = text.match(/^data:([^;,]+)?;base64,(.+)$/i);
  if (!match) throw new Error('Invalid data URL');

  var mimeType = match[1] ? String(match[1]) : 'application/octet-stream';
  var bytes = base64ToBytes(match[2]);
  var normalizedName = String(fileName || dataUrlFileName(text, 'file')).trim() || dataUrlFileName(text, 'file');

  if (typeof File === 'function') {
    return new File([bytes], normalizedName, { type: mimeType });
  }

  var blob = new Blob([bytes], { type: mimeType });
  blob.name = normalizedName;
  return blob;
}
