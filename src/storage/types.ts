export interface UploadResult {
  sizeBytes: number;
}

/** How the media route should hand a stored file to the browser. */
export type ResolvedMedia =
  | { type: "stream"; path: string } // local disk — route streams it itself (Range support)
  | { type: "redirect"; url: string }; // object storage — redirect to a presigned URL

export interface StorageBackend {
  readonly kind: "local" | "s3";
  upload(storageKey: string, localFilePath: string): Promise<UploadResult>;
  exists(storageKey: string): Promise<boolean>;
  resolve(storageKey: string): Promise<ResolvedMedia | null>;
}
