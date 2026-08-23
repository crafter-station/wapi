/**
 * Object storage behind a narrow interface.
 *
 * PLAN.md §7 puts media on UploadX rather than a local volume, deliberately the *opposite*
 * call from Postgres: `baileys_auth` is a hot write path inside the send/receive loop, where
 * an external hop is a liability, whereas media is occasional, large and read-heavy. Pushing
 * it out keeps `api` genuinely stateless and takes egress off the box.
 *
 * The interface exists because the SDK is not the contract — `decrypt-media` promises a URL
 * valid for exactly one hour, and that promise must hold whatever sits behind it.
 */

export type StoredObject = { key: string; url: string };

export interface Storage {
  /** Store bytes and return a stable key plus a directly usable URL. */
  put(args: { name: string; data: Buffer; contentType: string }): Promise<StoredObject>;
  /** A URL that expires. `decrypt-media` uses 3600s, matching their documented behaviour. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(keys: string[]): Promise<void>;
}

/** Their documented cap. Enforced before we ever buffer the whole body. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/**
 * UploadX-backed storage.
 *
 * Hosted mode: `UploadxAPI.create()` reads `UPLOADX_TOKEN` and `UPLOADX_URL` and resolves the
 * MinIO connection from the dashboard. Setting `MINIO_*` instead bypasses the dashboard
 * entirely and takes priority — the documented escape hatch if the dashboard is unreachable
 * from inside the container, which is a config change with no deploy.
 *
 * `generateSignedURL` goes straight to MinIO in both modes, so the one-hour promise costs no
 * extra network hop either way.
 */
export async function createUploadxStorage(): Promise<Storage> {
  const { UploadxAPI } = await import("@uploadx-sdk/core/server");
  const api = await UploadxAPI.create();

  return {
    async put({ name, data, contentType }) {
      const [uploaded] = await api.uploadFiles([{ name, data, type: contentType }]);
      if (!uploaded) throw new Error("upload returned no file");
      return { key: uploaded.key, url: uploaded.url };
    },
    signedUrl: (key, ttlSeconds) => api.generateSignedURL(key, ttlSeconds),
    delete: (keys) => api.deleteFiles(keys),
  };
}

/**
 * Lazy singleton.
 *
 * Hosted mode makes `uploadx.crafter.run` a startup dependency, so construction is deferred
 * until the first media request rather than done at boot — an upload outage should not stop
 * the API from serving the other 27 routes.
 */
let cached: Promise<Storage> | null = null;
export const storage = (): Promise<Storage> => (cached ??= createUploadxStorage());
