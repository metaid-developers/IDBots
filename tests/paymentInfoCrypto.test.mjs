import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  derivePaymentInfoKey,
  encryptPaymentInfo,
  decryptPaymentInfo,
  isValidAlipayQrContent,
  isValidAlipayPid,
  maskDisplayName,
  validatePaymentReceivingInfo,
  PAYMENT_INFO_KDF_SALT_PREFIX,
  PAYMENT_INFO_KDF_INFO,
} = require('../dist-electron/main/services/paymentInfoCrypto.js');
const { deriveBackupKey } = require('../dist-electron/main/services/chainBackupCrypto.js');

// Well-known valid 12-word test mnemonic (never holds funds).
const TEST_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const TEST_GID = 'idqtestglobalmetaid00000000000000000000001';
// Synthetic receiving code in the real shape (qr.alipay.com/<opaque id>);
// never a real account's code.
const TEST_QR = 'https://qr.alipay.com/testcode4unittests0abc';
// Synthetic but shape-valid PID (2088 + 12 digits); never a real PID.
const TEST_PID = '2088000000000001';

test('derivePaymentInfoKey is deterministic and purpose-isolated from the backup key', () => {
  const a = derivePaymentInfoKey(TEST_MNEMONIC, TEST_GID);
  const b = derivePaymentInfoKey(TEST_MNEMONIC, TEST_GID);
  assert.deepEqual(a, b);
  assert.equal(a.length, 32);

  // Same mnemonic + gid must produce DIFFERENT keys for the two purposes
  // (HKDF salt prefix + info isolation) — leaking one never opens the other.
  const backupKey = deriveBackupKey(TEST_MNEMONIC, TEST_GID);
  assert.notDeepEqual(a, backupKey);
  assert.equal(PAYMENT_INFO_KDF_SALT_PREFIX, 'idbots-payment-v1');
  assert.equal(PAYMENT_INFO_KDF_INFO, 'payment-info-key');

  const otherGid = derivePaymentInfoKey(TEST_MNEMONIC, 'idqtestglobalmetaid00000000000000000000002');
  assert.notDeepEqual(a, otherGid);
});

test('encryptPaymentInfo → decryptPaymentInfo round-trip restores the exact info', () => {
  const key = derivePaymentInfoKey(TEST_MNEMONIC, TEST_GID);
  const info = {
    payeeDisplayName: '测试收款人',
    alipayPid: TEST_PID,
    qrContent: TEST_QR,
    qrImageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
  };
  const encrypted = encryptPaymentInfo(key, info);
  assert.ok(Buffer.isBuffer(encrypted));
  assert.ok(encrypted.length > 28); // nonce(12) + tag(16) + body
  assert.deepEqual(decryptPaymentInfo(key, encrypted), info);
});

test('ciphertext contains no plaintext receiving values (no leak at rest)', () => {
  const key = derivePaymentInfoKey(TEST_MNEMONIC, TEST_GID);
  const info = {
    payeeDisplayName: 'MingTestSubject',
    alipayPid: TEST_PID,
    qrContent: TEST_QR,
  };
  const encrypted = encryptPaymentInfo(key, info);
  for (const plain of [info.payeeDisplayName, info.alipayPid, info.qrContent, 'qr.alipay.com', 'base64']) {
    assert.equal(encrypted.includes(Buffer.from(plain, 'utf8')), false, `cipher leaked plaintext: ${plain}`);
  }
});

test('decryptPaymentInfo rejects tampering and the wrong key', () => {
  const key = derivePaymentInfoKey(TEST_MNEMONIC, TEST_GID);
  const encrypted = encryptPaymentInfo(key, { qrContent: TEST_QR });

  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decryptPaymentInfo(key, tampered));

  const wrongKey = derivePaymentInfoKey(TEST_MNEMONIC, 'idqtestglobalmetaid00000000000000000000002');
  assert.throws(() => decryptPaymentInfo(wrongKey, encrypted));
});

test('isValidAlipayQrContent accepts real-shape codes and rejects impostors', () => {
  // ≥2 valid cases.
  assert.equal(isValidAlipayQrContent('https://qr.alipay.com/testcode4unittests0abc'), true);
  assert.equal(isValidAlipayQrContent('https://qr.alipay.com/testcode4unittests0abc'), true);
  assert.equal(isValidAlipayQrContent('  https://qr.alipay.com/abcdefg  '), true); // trimmed

  // ≥2 invalid cases.
  assert.equal(isValidAlipayQrContent('https://qr.alipay.com/'), false); // empty code
  assert.equal(isValidAlipayQrContent('http://qr.alipay.com/syntheticbadcase'), false); // wrong scheme
  assert.equal(isValidAlipayQrContent('https://example.com/syntheticbadcase'), false); // not Alipay
  assert.equal(isValidAlipayQrContent('https://wq.alipay.com/syntheticbadcase'), false); // host impostor
  assert.equal(isValidAlipayQrContent('https://qr.alipay.com/fkx 18773'), false); // whitespace
  assert.equal(isValidAlipayQrContent('https://qr.alipay.com/abc'), false); // too short
});

test('isValidAlipayPid and maskDisplayName follow the documented shapes', () => {
  assert.equal(isValidAlipayPid(TEST_PID), true);
  assert.equal(isValidAlipayPid('2088123456789012'), true);
  assert.equal(isValidAlipayPid('208812345678901'), false); // 15 digits
  assert.equal(isValidAlipayPid('1999123456789012'), false); // wrong prefix
  assert.equal(isValidAlipayPid('208812345678901a'), false); // non-digit

  assert.equal(maskDisplayName('张三'), '张*');
  assert.equal(maskDisplayName('欧阳明'), '欧*明');
  assert.equal(maskDisplayName('A'), 'A');
  assert.equal(maskDisplayName('  李四  '), '李*');
});

test('validatePaymentReceivingInfo normalizes and gates every field', () => {
  // qrContent alone is a usable channel (variant C + degrade share it).
  const qrOnly = validatePaymentReceivingInfo({ qrContent: TEST_QR });
  assert.equal(qrOnly.ok, true);
  assert.deepEqual(qrOnly.value, { qrContent: TEST_QR });

  // pid alone is also a usable channel (scheme variants A/B enhancement).
  const pidOnly = validatePaymentReceivingInfo({ alipayPid: TEST_PID, payeeDisplayName: ' 张三 ' });
  assert.equal(pidOnly.ok, true);
  assert.deepEqual(pidOnly.value, { alipayPid: TEST_PID, payeeDisplayName: '张三' });

  // A non-Alipay link must never be stored as an Alipay channel.
  const badQr = validatePaymentReceivingInfo({ qrContent: 'https://qr.alipay.com.evil.com/x' });
  assert.equal(badQr.ok, false);
  assert.deepEqual(badQr.errors, ['INVALID_QR_CONTENT']);

  assert.equal(validatePaymentReceivingInfo({ alipayPid: '1234' }).ok, false);
  assert.deepEqual(validatePaymentReceivingInfo({}).errors, ['NO_RECEIVING_CHANNEL']);
  assert.deepEqual(validatePaymentReceivingInfo(null).errors, ['INVALID_SHAPE']);
  assert.equal(validatePaymentReceivingInfo({ qrImageDataUrl: 'not-a-data-url' }).ok, false);
});
