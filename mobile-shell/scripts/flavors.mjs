export const FLAVORS = Object.freeze({
  staging: Object.freeze({ name: 'staging', remoteOrigin: 'https://staging.idbots.world' }),
  production: Object.freeze({ name: 'production', remoteOrigin: 'https://app.idbots.world' }),
});

export function getFlavor(name) {
  const flavor = FLAVORS[name];
  if (!flavor) throw new Error(`Unknown native flavor: ${name}`);
  return flavor;
}

export function createCapacitorConfig(flavorName) {
  const flavor = getFlavor(flavorName);
  const remoteUrl = `${flavor.remoteOrigin}/`;
  return {
    appId: 'com.idbots.world',
    appName: 'IDBots',
    webDir: 'www',
    server: {
      url: remoteUrl,
      errorPath: `offline.html?retry=${encodeURIComponent(remoteUrl)}`,
      androidScheme: 'https',
      iosScheme: 'capacitor',
      allowNavigation: [new URL(flavor.remoteOrigin).hostname],
    },
    android: {
      allowMixedContent: false,
      loggingBehavior: 'none',
    },
    ios: {
      contentInset: 'never',
      loggingBehavior: 'none',
    },
    backgroundColor: '#F5F7F9',
  };
}
