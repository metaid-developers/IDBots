export function shouldMarkSessionRunningFromStreamMessage(message) {
  if (!message || message.type !== 'user') {
    return false;
  }
  return message.metadata?.suppressRunningStatus !== true;
}

export function shouldRegisterStreamSessionFromFetch(session) {
  return session?.hiddenFromSessionList !== true;
}
