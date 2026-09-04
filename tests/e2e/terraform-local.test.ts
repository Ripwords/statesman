import { setup } from '@nuxt/test-utils/e2e'
import { LocalStore } from '../../server/storage/local'
import { terraformAcceptance } from './scenario'

// The server under test runs as a separate process, so its storage driver is
// whatever this env says — not what .env gave this test process.
await setup({ server: true, env: { STORAGE_DRIVER: 'local' } })

terraformAcceptance({
  org: 'tf-local',
  driver: 'local',
  // startServer does not change the working directory, so a relative
  // LOCAL_STORAGE_PATH resolves to the same root on both sides.
  store: new LocalStore(process.env.LOCAL_STORAGE_PATH ?? './.data/state')
})
