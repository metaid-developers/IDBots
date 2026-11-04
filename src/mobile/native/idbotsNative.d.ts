interface MobileNativeCapabilities {
  camera: boolean;
  photos: boolean;
  files: boolean;
  share: boolean;
  appState: boolean;
  backButton: boolean;
  externalUrls: boolean;
  secureScreen: boolean;
}

interface IdbotsNativeListenerHandle {
  remove(): Promise<void>;
}

interface IdbotsNativeAppPlugin {
  addListener?(
    eventName: 'appStateChange' | 'backButton',
    listener: (event: { isActive?: boolean; canGoBack?: boolean }) => void,
  ): Promise<IdbotsNativeListenerHandle>;
  exitApp?(): Promise<void>;
}

type MobileNativePhotoSource = 'camera' | 'photos';

interface IdbotsNativeBridge {
  readonly nativeBridgeVersion: 1;
  readonly bootstrap: {
    readonly phase: 'document-start';
    readonly origin: string;
    readonly platform: 'android' | 'ios';
  };
  getCapabilities(): MobileNativeCapabilities;
  pickPhoto?(source: MobileNativePhotoSource): Promise<File | null>;
  pickFiles?(multi: boolean): Promise<File[]>;
  shareArtifact?(input: { url: string; filename: string }): Promise<'shared' | 'cancelled'>;
  setSecureScreen?(enabled: boolean): Promise<void>;
  openExternal?(url: string): Promise<void>;
  onAppStateChange?(callback: (active: boolean) => void): () => void;
  onBackButton?(callback: () => boolean): () => void;
}

interface IdbotsNativeProof {
  readonly phase: 'before-react';
  readonly origin: string;
  readonly platform: 'android' | 'ios';
  readonly nativeBridgeVersion: 1;
  readonly confirmedAtMs: number;
}

declare global {
  interface Window {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      Plugins?: {
        App?: IdbotsNativeAppPlugin;
      };
    };
    idbotsNative?: IdbotsNativeBridge;
    idbotsNativeProof?: IdbotsNativeProof;
  }
}

export type {
  IdbotsNativeAppPlugin,
  IdbotsNativeBridge,
  IdbotsNativeListenerHandle,
  IdbotsNativeProof,
  MobileNativeCapabilities,
  MobileNativePhotoSource,
};
