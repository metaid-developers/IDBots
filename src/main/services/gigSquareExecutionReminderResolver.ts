type ReminderRow = Record<string, unknown>;

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
};

const hasOwn = (row: ReminderRow, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(row, key)
);

const readFirstString = (row: ReminderRow, keys: string[]): string => {
  for (const key of keys) {
    const value = toSafeString(row[key]).trim();
    if (value) return value;
  }
  return '';
};

const rowMatches = (row: ReminderRow, input: {
  serviceId: string;
  serviceName: string;
}): boolean => {
  if (input.serviceId) {
    const ids = [
      readFirstString(row, ['id']),
      readFirstString(row, ['pinId', 'pin_id']),
      readFirstString(row, ['sourceServicePinId', 'source_service_pin_id']),
      readFirstString(row, ['currentPinId', 'current_pin_id']),
    ];
    if (ids.includes(input.serviceId)) return true;
  }

  if (input.serviceName) {
    const names = [
      readFirstString(row, ['providerSkill', 'provider_skill']),
      readFirstString(row, ['serviceName', 'service_name']),
      readFirstString(row, ['displayName', 'display_name']),
    ];
    if (names.includes(input.serviceName)) return true;
  }

  return false;
};

const readReminderFromPayload = (payload: unknown): { found: boolean; value: string } => {
  const payloadJson = toSafeString(payload).trim();
  if (!payloadJson) return { found: false, value: '' };
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    if (!hasOwn(parsed, 'executionReminder')) return { found: false, value: '' };
    return { found: true, value: toSafeString(parsed.executionReminder).trim() };
  } catch {
    return { found: false, value: '' };
  }
};

const readExplicitReminder = (
  row: ReminderRow,
  payloadKeys: string[],
): { found: boolean; value: string } => {
  const rawColumn = hasOwn(row, 'executionReminder') && row.executionReminder != null
    ? row.executionReminder
    : row.execution_reminder;
  if (rawColumn != null) {
    return { found: true, value: toSafeString(rawColumn).trim() };
  }

  for (const key of payloadKeys) {
    const fromPayload = readReminderFromPayload(row[key]);
    if (fromPayload.found) return fromPayload;
  }
  return { found: false, value: '' };
};

export const resolveGigSquareServiceExecutionReminderFromRows = (input: {
  serviceId?: string | null;
  serviceName?: string | null;
  localRows?: ReminderRow[];
  remoteRows?: ReminderRow[];
}): string | null => {
  const serviceId = toSafeString(input.serviceId).trim();
  const serviceName = toSafeString(input.serviceName).trim();
  if (!serviceId && !serviceName) return null;
  const matchInput = { serviceId, serviceName };

  const localRow = (input.localRows || []).find((row) => rowMatches(row, matchInput));
  if (localRow) {
    const localReminder = readExplicitReminder(localRow, ['payloadJson', 'payload_json']);
    if (localReminder.found) return localReminder.value;
  }

  const remoteRow = (input.remoteRows || []).find((row) => rowMatches(row, matchInput));
  if (!remoteRow) return null;
  const remoteReminder = readExplicitReminder(remoteRow, ['contentSummaryJson', 'content_summary_json']);
  return remoteReminder.found ? remoteReminder.value : null;
};
