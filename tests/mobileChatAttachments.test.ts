import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge';
import type { PhoneFileSelectionOptions, PhoneFileSelectionResult, PhoneUploadProgress } from '../src/mobile/bridge/installShim';
import { UPLOAD_MAX_BYTES } from '../src/mobile/bridge/upload';
import { uploadProgressPercent } from '../src/mobile/app/hooks/useChatAttachments';
import { mobileI18n, t as translate } from '../src/mobile/i18n';

const setLanguage = mobileI18n.setLanguage.bind(mobileI18n);

function installPickerDom(t: test.TestContext) {
  const inputs: Array<{
    files: File[];
    dispatch: (type: string) => void;
  }> = [];
  const document = {
    createElement(tag: string) {
      assert.equal(tag, 'input');
      const listeners = new Map<string, () => void>();
      const input = {
        type: '',
        accept: '',
        multiple: false,
        files: [] as File[],
        addEventListener(type: string, listener: () => void) { listeners.set(type, listener); },
        removeEventListener(type: string) { listeners.delete(type); },
        remove() {},
        click() {},
      };
      inputs.push({
        get files() { return input.files; },
        set files(files: File[]) { input.files = files; },
        dispatch: (type: string) => listeners.get(type)?.(),
      });
      return input;
    },
    body: { appendChild() {} },
  };
  const globals = globalThis as Record<string, unknown>;
  globals.document = document;
  t.after(() => { delete globals.document; });
  return inputs;
}

test('mock file selection runs through the real upload client with ordered progress', async (t) => {
  const inputs = installPickerDom(t);
  const bridge = createMobileMockBridge();
  t.after(() => bridge.destroy());
  const progress: PhoneUploadProgress[] = [];
  const selectFile = bridge.electron.dialog.selectFile as unknown as (
    options: PhoneFileSelectionOptions,
  ) => Promise<PhoneFileSelectionResult>;
  const picking = selectFile({ multi: true, onUploadProgress: (event) => progress.push(event) });
  inputs[0].files = [
    new File(['alpha'], 'alpha.txt', { type: 'text/plain' }),
    new File(['beta'], 'beta.txt', { type: 'text/plain' }),
  ];
  inputs[0].dispatch('change');
  const result = await picking;

  assert.equal(result.success, true);
  assert.deepEqual(result.paths, [
    '/data/workspace/uploads/mock-1-alpha.txt',
    '/data/workspace/uploads/mock-2-beta.txt',
  ]);
  assert.deepEqual(progress.filter((event) => event.path).map((event) => event.fileName), ['alpha.txt', 'beta.txt']);
  assert.ok(progress.some((event) => event.loaded === event.total && event.total === 5));
});

test('mock upload exposes typed size, type, quota and network failures', async (t) => {
  const inputs = installPickerDom(t);
  const bridge = createMobileMockBridge();
  t.after(() => bridge.destroy());
  const selectFile = bridge.electron.dialog.selectFile as unknown as (
    options: PhoneFileSelectionOptions,
  ) => Promise<PhoneFileSelectionResult>;
  const cases = [
    { name: 'large.pdf', body: new Uint8Array(UPLOAD_MAX_BYTES + 1), code: 'TOO_LARGE' },
    { name: 'fixture-blocked.exe', body: 'blocked', code: 'BLOCKED_TYPE' },
    { name: 'fixture-quota.txt', body: 'quota', code: 'QUOTA_EXCEEDED' },
    { name: 'fixture-network.txt', body: 'network', code: 'UPLOAD_FAILED' },
  ];
  for (const [index, item] of cases.entries()) {
    const picking = selectFile({ multi: true });
    inputs[index].files = [new File([item.body], item.name, { type: 'text/plain' })];
    inputs[index].dispatch('change');
    const result = await picking;
    assert.equal(result.success, false, item.name);
    assert.equal(result.errorCode, item.code, item.name);
    assert.equal(result.failedIndex, 0, item.name);
  }
});

test('upload progress is bounded and error messages have English and Chinese copy', () => {
  assert.equal(uploadProgressPercent({ loaded: 1, total: 4 }), 25);
  assert.equal(uploadProgressPercent({ loaded: 5, total: 4 }), 100);
  assert.equal(uploadProgressPercent({ loaded: 0, total: 0 }), 0);
  try {
    setLanguage('en');
    assert.match(translate('mobile.chat.uploadError.TOO_LARGE', { name: 'big.pdf' }), /25 MB/);
    assert.match(translate('mobile.chat.uploadError.QUOTA_EXCEEDED', { name: 'big.pdf' }), /Cloud storage is full/);
    assert.match(translate('mobile.chat.uploadError.PERMISSION_DENIED'), /system settings/);
    assert.match(translate('mobile.chat.uploadError.UNAVAILABLE'), /unavailable/);
    setLanguage('zh');
    assert.match(translate('mobile.chat.uploadError.TOO_LARGE', { name: 'big.pdf' }), /25 MB/);
    assert.match(translate('mobile.chat.uploadError.QUOTA_EXCEEDED', { name: 'big.pdf' }), /存储空间不足/);
    assert.match(translate('mobile.chat.uploadError.PERMISSION_DENIED'), /系统设置/);
  } finally {
    setLanguage('en');
  }
});
