import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import {
  S3Client, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command
} from '@aws-sdk/client-s3'
import { conformsToStateStore } from './storage.conformance'
import { LocalStore } from '../../server/storage/local'
import { S3Store } from '../../server/storage/s3'

const MINIO = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  forcePathStyle: true,
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin'
} as const

const dirs: string[] = []
conformsToStateStore('local', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statesman-'))
  dirs.push(dir)
  return new LocalStore(dir)
})

// Requires MinIO from docker-compose.yml. make() runs once per test, so each
// run creates several buckets; they are torn down below rather than left to
// accumulate in the dev container.
const buckets: string[] = []
conformsToStateStore('s3 (minio)', async () => {
  const bucket = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  buckets.push(bucket)
  return new S3Store({ bucket, ...MINIO, createBucketIfMissing: true })
})

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })

  const client = new S3Client({
    region: MINIO.region,
    endpoint: MINIO.endpoint,
    forcePathStyle: MINIO.forcePathStyle,
    credentials: {
      accessKeyId: MINIO.accessKeyId,
      secretAccessKey: MINIO.secretAccessKey
    }
  })
  for (const Bucket of buckets) {
    // A bucket must be emptied before it can be dropped.
    let token: string | undefined
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket, ContinuationToken: token })
      )
      const objects = (page.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === 'string')
        .map((Key) => ({ Key }))
      if (objects.length > 0) {
        await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects } }))
      }
      token = page.NextContinuationToken
    } while (token)
    await client.send(new DeleteBucketCommand({ Bucket }))
  }
  client.destroy()
})
