import { readFile, stat } from "node:fs/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";
import type { StorageBackend } from "./types";

/** S3-compatible object storage (Railway Storage Buckets, R2, MinIO, real S3, ...).
 * Required once the web and worker run as separate services/containers that
 * don't share a filesystem — see README's "Deploying to Railway" section. */

const PRESIGNED_URL_TTL_SECONDS = 3600;

let cachedClient: S3Client | undefined;

function client(): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: env.s3Region,
      endpoint: env.s3Endpoint,
      forcePathStyle: true, // required by most S3-compatible providers (R2, MinIO, Railway buckets)
      credentials: {
        accessKeyId: env.s3AccessKeyId ?? "",
        secretAccessKey: env.s3SecretAccessKey ?? "",
      },
    });
  }
  return cachedClient;
}

export const s3Storage: StorageBackend = {
  kind: "s3",

  async upload(storageKey, localFilePath) {
    const [body, stats] = await Promise.all([readFile(localFilePath), stat(localFilePath)]);
    await client().send(
      new PutObjectCommand({
        Bucket: env.s3Bucket,
        Key: storageKey,
        Body: body,
        ContentType: "video/mp4",
      }),
    );
    return { sizeBytes: stats.size };
  },

  async exists(storageKey) {
    try {
      await client().send(new HeadObjectCommand({ Bucket: env.s3Bucket, Key: storageKey }));
      return true;
    } catch {
      return false;
    }
  },

  async resolve(storageKey) {
    if (!(await s3Storage.exists(storageKey))) return null;
    const url = await getSignedUrl(
      client(),
      new GetObjectCommand({ Bucket: env.s3Bucket, Key: storageKey }),
      { expiresIn: PRESIGNED_URL_TTL_SECONDS },
    );
    return { type: "redirect", url };
  },
};
