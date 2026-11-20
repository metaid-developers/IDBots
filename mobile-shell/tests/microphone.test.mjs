import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('voice capture declares OS microphone permissions and preserves WebView runtime requests', () => {
  const manifest = read('../android/app/src/main/AndroidManifest.xml');
  const chromeClient = read('../node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/BridgeWebChromeClient.java');
  const plist = read('../ios/App/App/Info.plist');

  assert.deepEqual({
    androidRecordAudio: manifest.includes('android.permission.RECORD_AUDIO'),
    androidAudioSettings: manifest.includes('android.permission.MODIFY_AUDIO_SETTINGS'),
    androidWebViewRequestsRecordAudio: /onPermissionRequest[\s\S]*Manifest\.permission\.RECORD_AUDIO/.test(chromeClient),
    iosMicrophoneUsageDescription: /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]+<\/string>/.test(plist),
  }, {
    androidRecordAudio: true,
    androidAudioSettings: true,
    androidWebViewRequestsRecordAudio: true,
    iosMicrophoneUsageDescription: true,
  });
});
