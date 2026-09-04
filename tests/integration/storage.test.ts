import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { conformsToStateStore } from './storage.conformance'
import { LocalStore } from '../../server/storage/local'
import { S3Store } from '../../server/storage/s3'

const dirs: string[] = []
conformsToStateStore('local', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statesman-'))
  dirs.push(dir)
  return new LocalStore(dir)
})
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

// Requires MinIO from docker-compose.yml
conformsToStateStore('s3 (minio)', async () =>
  new S3Store({
    bucket: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    createBucketIfMissing: true
  })
)
