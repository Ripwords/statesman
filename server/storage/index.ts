import { env } from '../utils/env'
import { LocalStore } from './local'
import { S3Store } from './s3'
import type { StateStore } from './types'

let instance: StateStore | undefined

export function store(): StateStore {
  if (instance) return instance
  const config = env()
  if (config.STORAGE_DRIVER === 's3') {
    // loadEnv rejects STORAGE_DRIVER=s3 without a bucket, so this branch is
    // unreachable with an undefined bucket. The guard keeps that true even if
    // the boot check is ever loosened.
    const bucket = config.S3_BUCKET
    if (!bucket) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3')
    instance = new S3Store({
      bucket,
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY
    })
  } else {
    instance = new LocalStore(config.LOCAL_STORAGE_PATH)
  }
  return instance
}

export type { StateStore } from './types'
