import { setup } from '@nuxt/test-utils/e2e'
import { S3Store } from '../../server/storage/s3'
import { terraformAcceptance } from './scenario'

// MinIO from docker-compose.yml, and the bucket its createbucket service makes.
// Worth a second full acceptance run rather than a driver unit test: the two
// stores implement list-by-prefix through completely different code, and the
// retention sweep depends on them agreeing.
const MINIO = {
  S3_BUCKET: 'statesman',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: 'minioadmin',
  S3_SECRET_ACCESS_KEY: 'minioadmin'
}

await setup({ server: true, env: { STORAGE_DRIVER: 's3', ...MINIO } })

terraformAcceptance({
  org: 'tf-s3',
  driver: 's3',
  store: new S3Store({
    bucket: MINIO.S3_BUCKET,
    region: MINIO.S3_REGION,
    endpoint: MINIO.S3_ENDPOINT,
    forcePathStyle: true,
    accessKeyId: MINIO.S3_ACCESS_KEY_ID,
    secretAccessKey: MINIO.S3_SECRET_ACCESS_KEY,
    createBucketIfMissing: true
  })
})
