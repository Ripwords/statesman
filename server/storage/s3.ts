import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
  HeadBucketCommand
} from '@aws-sdk/client-s3'
import type { StateStore } from './types'

export type S3StoreOptions = {
  bucket: string
  region: string
  endpoint?: string
  forcePathStyle?: boolean
  accessKeyId?: string
  secretAccessKey?: string
  createBucketIfMissing?: boolean
}

export class S3Store implements StateStore {
  private readonly client: S3Client
  private readonly bucket: string
  private ready: Promise<void> | undefined

  constructor(private readonly options: S3StoreOptions) {
    this.bucket = options.bucket
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
          : undefined
    })
  }

  private async ensureBucket(): Promise<void> {
    if (!this.options.createBucketIfMissing) return
    this.ready ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
      } catch {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }))
      }
    })()
    return this.ready
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    await this.ensureBucket()
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }))
  }

  async get(key: string): Promise<Uint8Array | null> {
    await this.ensureBucket()
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      const bytes = await result.Body?.transformToByteArray()
      return bytes ?? null
    } catch (error) {
      const name = (error as { name?: string }).name
      if (name === 'NoSuchKey' || name === 'NotFound') return null
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await this.ensureBucket()
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  async list(prefix: string): Promise<string[]> {
    await this.ensureBucket()
    const keys: string[] = []
    let token: string | undefined
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })
      )
      for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key)
      token = page.NextContinuationToken
    } while (token)
    return keys
  }
}
