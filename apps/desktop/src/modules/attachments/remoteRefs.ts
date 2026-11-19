import type { ModelsHost, RemoteRefRecord, RemoteRefWrite } from '@touchai/models/contracts';

export interface AttachmentRemoteRefStore {
    read(
        attachmentId: number,
        providerId: number
    ): Promise<(RemoteRefRecord & { id: number; createdAt: string }) | null>;
    touch(id: number): Promise<void>;
    write(attachmentId: number, providerId: number, ref: RemoteRefWrite): Promise<void>;
}

/** Existing SQL records remain private to this connection-bound Desktop adapter. */
export function createAttachmentRemoteRefs(options: {
    providerId?: number;
    bindingUpdatedAt: string | null;
    isCurrentBinding(): Promise<boolean>;
    store: AttachmentRemoteRefStore;
}) {
    const resources = new Map<string, number>();
    const keys = new Map<number, string>();
    const touched = new Map<string, number>();
    let disposed = false;
    const remoteRefs: ModelsHost['remoteRefs'] = {
        async read(key) {
            const attachmentId = resources.get(key);
            if (
                disposed ||
                attachmentId === undefined ||
                options.providerId === undefined ||
                !(await options.isCurrentBinding())
            )
                return null;
            const record = await options.store.read(attachmentId, options.providerId);
            if (!record) return null;
            // Old records do not carry an endpoint fingerprint. A profile edit
            // invalidates earlier uploads without changing their stored shape.
            const bindingTime = Date.parse(options.bindingUpdatedAt ?? '');
            if (Number.isFinite(bindingTime) && Date.parse(record.createdAt) < bindingTime)
                return null;
            if (disposed || !(await options.isCurrentBinding())) return null;
            touched.set(key, record.id);
            return { ref: record.ref, expiresAt: record.expiresAt };
        },
        async touch(key) {
            const id = touched.get(key);
            touched.delete(key);
            if (!disposed && id !== undefined && (await options.isCurrentBinding()))
                await options.store.touch(id);
        },
        async write(key, ref) {
            const attachmentId = resources.get(key);
            if (
                !disposed &&
                attachmentId !== undefined &&
                options.providerId !== undefined &&
                (await options.isCurrentBinding())
            )
                await options.store.write(attachmentId, options.providerId, ref);
        },
    };
    return Object.freeze({
        remoteRefs,
        resourceKey(attachmentId: number): string | undefined {
            if (disposed || options.providerId === undefined) return undefined;
            let key = keys.get(attachmentId);
            if (key) return key;
            key = crypto.randomUUID();
            keys.set(attachmentId, key);
            resources.set(key, attachmentId);
            // Eviction disables reuse, never resolves an old token to another file.
            while (keys.size > 512) {
                const oldest = keys.keys().next().value!;
                const oldKey = keys.get(oldest)!;
                keys.delete(oldest);
                resources.delete(oldKey);
                touched.delete(oldKey);
            }
            return key;
        },
        dispose() {
            disposed = true;
            resources.clear();
            keys.clear();
            touched.clear();
        },
    });
}
