import type { ProviderDriver } from './model';

export interface RemoteRefRecord {
    ref: string;
    expiresAt: string | null;
}

export interface RemoteRefWrite extends RemoteRefRecord {
    mimeType: string;
}

export type ModelDiagnostic =
    | {
          kind: 'upload-fallback';
          driver: ProviderDriver;
          statusCode: number | null;
          disabled: boolean;
      }
    | { kind: 'remote-ref-touch-failed'; driver: ProviderDriver }
    | { kind: 'error-classification-failed'; driver: ProviderDriver }
    | {
          kind: 'reasoning-boundary';
          modelId?: string;
          phase: 'start' | 'end' | 'delta';
          length?: number;
      };

/** Each connection receives its own bound cache; no request may select another one. */
export interface ModelsHost {
    fetch: typeof globalThis.fetch;
    remoteRefs: {
        read(resourceKey: string): Promise<RemoteRefRecord | null>;
        touch(resourceKey: string): Promise<void>;
        write(resourceKey: string, ref: RemoteRefWrite): Promise<void>;
    };
    diagnostics?(event: ModelDiagnostic): void;
}
