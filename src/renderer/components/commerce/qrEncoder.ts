/**
 * qrEncoder — a dependency-free QR Code generator (byte mode, EC levels L/M,
 * versions 1-10, all 8 mask patterns with spec penalty scoring) used by the
 * promo ammo pack poster. Hand-rolled on purpose: the render process must not
 * gain an npm dependency, and the matrix output is unit-tested bit-for-bit
 * against fixtures produced by an independent reference implementation.
 *
 * The algorithm mirrors ISO/IEC 18004 via the well-known Project Nayuki
 * qrcodegen formulation (MIT); every helper below corresponds 1:1 to that
 * reference to keep the port reviewable.
 */

export type QrEcLevel = 'L' | 'M';

export interface QrMatrix {
  size: number;
  version: number;
  mask: number;
  modules: boolean[][];
}

interface EcParams {
  /** ECC codewords per block, index = version (index 0 unused). */
  eccPerBlock: number[];
  /** Error-correction blocks per version, index = version (index 0 unused). */
  numBlocks: number[];
}

const EC_TABLE: Record<QrEcLevel, EcParams> = {
  L: {
    eccPerBlock: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
    numBlocks: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  },
  M: {
    eccPerBlock: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
    numBlocks: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  },
};

/** Spec format-bits enumeration: L=1, M=0 (Q=3, H=2 unsupported here). */
const EC_FORMAT_BITS: Record<QrEcLevel, number> = { L: 1, M: 0 };

const MIN_VERSION = 1;
const MAX_VERSION = 10;

// --- GF(256) arithmetic, field modulus 0x11D (Nayuki reedSolomonMultiply) ---

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** Generator polynomial for `degree` ECC codewords (Nayuki reedSolomonComputeDivisor). */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1; // monomial x^0 at the tail
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** ECC remainder of `data` under `divisor` (Nayuki reedSolomonComputeRemainder). */
function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < divisor.length; i += 1) {
      result[i] ^= gfMul(divisor[i], factor);
    }
  }
  return result;
}

// --- Capacity ---------------------------------------------------------------

function totalCodewords(version: number): number {
  // Spec total (data+ecc) codewords per version, 1..10.
  const table = [-1, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  return table[version];
}

function numDataCodewords(version: number, level: QrEcLevel): number {
  return totalCodewords(version) - EC_TABLE[level].eccPerBlock[version] * EC_TABLE[level].numBlocks[version];
}

function byteModeCapacity(version: number, level: QrEcLevel): number {
  const bits = numDataCodewords(version, level) * 8;
  const countBits = version <= 9 ? 8 : 16;
  const usable = bits - 4 - countBits; // mode + count indicator
  if (usable < 12) return 0;
  return Math.floor((usable - 4) / 8); // conservative: reserve terminator bits
}

// --- Data segment + padding -------------------------------------------------

function makeDataCodewords(text: string, version: number, level: QrEcLevel): number[] {
  const capacityBits = numDataCodewords(version, level) * 8;
  const bits: number[] = [];
  const bytes = new TextEncoder().encode(text);
  if (bytes.length >= 1 << (version <= 9 ? 8 : 16)) throw new Error('QR payload exceeds byte-count indicator');
  appendBits(bits, 4, 4); // byte mode
  appendBits(bits, bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) appendBits(bits, byte, 8);
  if (bits.length > capacityBits) throw new Error('QR data too long for max version');
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length)); // terminator (truncated to fit)
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
    appendBits(bits, pad, 8);
  }
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

function appendBits(target: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) target.push((value >>> i) & 1);
}

// --- ECC + interleaving (mirrors python-qrcode create_bytes: data columns,
// --- then ECC columns; short blocks first, long blocks last) ------------------

function addEccAndInterleave(data: number[], version: number, level: QrEcLevel): number[] {
  const numBlocks = EC_TABLE[level].numBlocks[version];
  const blockEccLen = EC_TABLE[level].eccPerBlock[version];
  const dataLen = data.length;
  if (dataLen !== numDataCodewords(version, level)) throw new Error('QR data length mismatch');
  const shortBlockDataLen = Math.floor(dataLen / numBlocks);
  const numShortBlocks = numBlocks - (dataLen % numBlocks);

  const divisor = rsDivisor(blockEccLen);
  const dcdata: number[][] = [];
  const ecdata: number[][] = [];
  let offset = 0;
  let maxDc = 0;
  for (let i = 0; i < numBlocks; i += 1) {
    const dcLen = shortBlockDataLen + (i < numShortBlocks ? 0 : 1);
    const dc = data.slice(offset, offset + dcLen);
    offset += dcLen;
    ecdata.push(rsRemainder(dc, divisor));
    dcdata.push(dc);
    maxDc = Math.max(maxDc, dcLen);
  }

  const result: number[] = [];
  for (let i = 0; i < maxDc; i += 1) {
    for (const dc of dcdata) if (i < dc.length) result.push(dc[i]);
  }
  for (let i = 0; i < blockEccLen; i += 1) {
    for (const ec of ecdata) if (i < ec.length) result.push(ec[i]);
  }
  return result;
}

// --- Module grid ------------------------------------------------------------

class QrGrid {
  size: number;
  modules: boolean[][];
  isFunction: boolean[][];

  constructor(version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFunctionPatterns(grid: QrGrid, version: number, level: QrEcLevel): void {
  const size = grid.size;
  for (let i = 0; i < size; i += 1) {
    grid.set(6, i, i % 2 === 0);
    grid.set(i, 6, i % 2 === 0);
  }
  drawFinder(grid, 3, 3);
  drawFinder(grid, size - 4, 3);
  drawFinder(grid, 3, size - 4);
  const positions = alignmentPositions(version, size);
  const count = positions.length;
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < count; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) continue;
      drawAlignment(grid, positions[i], positions[j]);
    }
  }
  drawFormatBits(grid, level, 0); // provisional; redrawn per mask
  drawVersionInfo(grid, version);
}

function drawFinder(grid: QrGrid, x: number, y: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const px = x + dx;
      const py = y + dy;
      if (px >= 0 && px < grid.size && py >= 0 && py < grid.size) {
        grid.set(px, py, dist !== 2 && dist !== 4);
      }
    }
  }
}

function drawAlignment(grid: QrGrid, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      grid.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** Nayuki getAlignmentPatternPositions: [6, then descending from size−7 by step, spliced back ascending]. */
function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const positions: number[] = [6];
  for (let pos = size - 7; positions.length < numAlign; pos -= step) {
    positions.splice(1, 0, pos);
  }
  return positions;
}

function drawFormatBits(grid: QrGrid, level: QrEcLevel, mask: number): void {
  const size = grid.size;
  const data = (EC_FORMAT_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i <= 5; i += 1) grid.set(8, i, getBit(bits, i));
  grid.set(8, 7, getBit(bits, 6));
  grid.set(8, 8, getBit(bits, 7));
  grid.set(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i += 1) grid.set(14 - i, 8, getBit(bits, i));
  for (let i = 0; i < 8; i += 1) grid.set(size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i += 1) grid.set(8, size - 15 + i, getBit(bits, i));
  grid.set(8, size - 8, true); // dark module
}

function drawVersionInfo(grid: QrGrid, version: number): void {
  if (version < 7) return;
  const size = grid.size;
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i += 1) {
    const bit = getBit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    grid.set(a, b, bit);
    grid.set(b, a, bit);
  }
}

function drawCodewords(grid: QrGrid, data: number[]): void {
  let i = 0;
  for (let right = grid.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < grid.size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? grid.size - 1 - vert : vert;
        if (!grid.isFunction[y][x] && i < data.length * 8) {
          grid.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
          i += 1;
        }
      }
    }
  }
}

const MASK_FORMULAS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x, _y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid: QrGrid, mask: number): void {
  const formula = MASK_FORMULAS[mask];
  for (let y = 0; y < grid.size; y += 1) {
    for (let x = 0; x < grid.size; x += 1) {
      if (!grid.isFunction[y][x]) {
        grid.modules[y][x] = grid.modules[y][x] !== formula(x, y);
      }
    }
  }
}

// --- Mask penalty (Nayuki getPenaltyScore) -----------------------------------

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

function penaltyScore(grid: QrGrid): number {
  const size = grid.size;
  let result = 0;

  const scanLine = (get: (i: number) => boolean) => {
    let runColor = false;
    let runLen = 0;
    const runHistory = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < size; i += 1) {
      const color = get(i);
      if (color === runColor) {
        runLen += 1;
        if (runLen === 5) result += PENALTY_N1;
        else if (runLen > 5) result += 1;
      } else {
        finderPenaltyAddHistory(runLen, runHistory, size);
        if (!runColor) result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
        runColor = color;
        runLen = 1;
      }
    }
    result += finderPenaltyTerminateAndCount(runColor, runLen, runHistory, size) * PENALTY_N3;
  };

  for (let y = 0; y < size; y += 1) scanLine((i) => grid.modules[y][i]);
  for (let x = 0; x < size; x += 1) scanLine((i) => grid.modules[i][x]);

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = grid.modules[y][x];
      if (color === grid.modules[y][x + 1] && color === grid.modules[y + 1][x] && color === grid.modules[y + 1][x + 1]) {
        result += PENALTY_N2;
      }
    }
  }

  let dark = 0;
  for (const row of grid.modules) {
    for (const cell of row) if (cell) dark += 1;
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

function finderPenaltyAddHistory(runLength: number, runHistory: number[], size: number): void {
  let length = runLength;
  if (runHistory[0] === 0) length += size;
  runHistory.pop();
  runHistory.unshift(length);
}

function finderPenaltyCountPatterns(runHistory: number[]): number {
  const n = runHistory[1];
  const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
  return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
    + (core && runHistory[6] >= n * 4 && runHistory[5] >= n ? 1 : 0);
}

function finderPenaltyTerminateAndCount(
  currentRunColor: boolean,
  currentRunLength: number,
  runHistory: number[],
  size: number,
): number {
  let runLength = currentRunLength;
  if (currentRunColor) {
    finderPenaltyAddHistory(runLength, runHistory, size);
    runLength = 0;
  }
  runLength += size;
  finderPenaltyAddHistory(runLength, runHistory, size);
  return finderPenaltyCountPatterns(runHistory);
}

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

export interface QrEncodeOptions {
  ecLevel?: QrEcLevel;
  /** Force a mask 0-7; default: pick the lowest-penalty mask (ties → lowest index). */
  mask?: number;
}

/**
 * Encode text into a QR matrix (byte mode, auto version 1-10, EC level L or
 * M). Throws when the payload exceeds the highest supported version.
 */
export function encodeQrMatrix(text: string, options: QrEncodeOptions = {}): QrMatrix {
  const level: QrEcLevel = options.ecLevel === 'M' ? 'M' : 'L';
  const bytes = new TextEncoder().encode(text);
  let version = MIN_VERSION;
  while (version < MAX_VERSION && bytes.length > byteModeCapacity(version, level)) version += 1;
  if (bytes.length > byteModeCapacity(version, level)) throw new Error('QR payload too long for version 10');

  const data = makeDataCodewords(text, version, level);
  const allCodewords = addEccAndInterleave(data, version, level);

  if (options.mask !== undefined) {
    if (!Number.isInteger(options.mask) || options.mask < 0 || options.mask > 7) {
      throw new Error('mask must be an integer 0-7');
    }
    const grid = new QrGrid(version);
    drawFunctionPatterns(grid, version, level);
    drawCodewords(grid, allCodewords);
    applyMask(grid, options.mask);
    drawFormatBits(grid, level, options.mask);
    return { size: grid.size, version, mask: options.mask, modules: grid.modules };
  }

  let best: QrGrid | null = null;
  let bestPenalty = Number.POSITIVE_INFINITY;
  let bestMask = 0;
  for (let candidate = 0; candidate < 8; candidate += 1) {
    const grid = new QrGrid(version);
    drawFunctionPatterns(grid, version, level);
    drawCodewords(grid, allCodewords);
    applyMask(grid, candidate);
    drawFormatBits(grid, level, candidate);
    const penalty = penaltyScore(grid);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = candidate;
      best = grid;
    }
  }
  return { size: best!.size, version, mask: bestMask, modules: best!.modules };
}
