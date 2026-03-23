export function getP2PStatusBadgeView(status) {
  if (status?.storageLimitReached) {
    return {
      label: 'Storage full',
      dotColorClass: 'bg-amber-400',
      animate: false,
    };
  }

  if (!status?.running) {
    return {
      label: 'P2P offline',
      dotColorClass: 'bg-gray-400',
      animate: false,
    };
  }

  if (typeof status.peerCount === 'number') {
    if (status.peerCount === 0) {
      return {
        label: '0 peers',
        dotColorClass: 'bg-blue-400',
        animate: false,
      };
    }

    return {
      label: `${status.peerCount} peers`,
      dotColorClass: 'bg-green-400',
      animate: false,
    };
  }

  return {
    label: 'P2P online',
    dotColorClass: 'bg-blue-400',
    animate: false,
  };
}
