export type VersionManifest = {
  schemaVersion: 1;
  packageName: string;
  packageVersion: string;
  compatibility: {
    coreRange: string;
    adapterRange: string;
  };
};

export type RuntimeVersions = {
  coreVersion: string;
  adapterVersion: string;
};

export const createVersionManifest = (
  packageName: string,
  packageVersion: string,
  coreRange: string,
  adapterRange: string
): VersionManifest => ({
  schemaVersion: 1,
  packageName,
  packageVersion,
  compatibility: {
    coreRange,
    adapterRange
  }
});

export const assertVersionManifestCompatibility = (_manifest: VersionManifest, _runtime: RuntimeVersions): void => {
  assertRangeSatisfied('core', _manifest.compatibility.coreRange, _runtime.coreVersion);
  assertRangeSatisfied('adapter', _manifest.compatibility.adapterRange, _runtime.adapterVersion);
};

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
};

const parseVersion = (version: string): ParsedVersion => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Invalid version "${version}". Expected MAJOR.MINOR.PATCH`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
};

const satisfiesCaretRange = (rangeBase: ParsedVersion, actual: ParsedVersion): boolean => {
  if (actual.major !== rangeBase.major) {
    return false;
  }

  if (actual.minor > rangeBase.minor) {
    return true;
  }

  if (actual.minor < rangeBase.minor) {
    return false;
  }

  return actual.patch >= rangeBase.patch;
};

const assertRangeSatisfied = (label: 'core' | 'adapter', range: string, actualVersion: string): void => {
  if (range.startsWith('^')) {
    const rangeBase = parseVersion(range.slice(1));
    const actual = parseVersion(actualVersion);
    if (satisfiesCaretRange(rangeBase, actual)) {
      return;
    }

    throw new Error(
      `Incompatible ${label} version "${actualVersion}" for range "${range}"`
    );
  }

  if (range === actualVersion) {
    return;
  }

  throw new Error(
    `Incompatible ${label} version "${actualVersion}" for range "${range}"`
  );
};
