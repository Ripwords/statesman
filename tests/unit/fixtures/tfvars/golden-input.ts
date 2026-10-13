import type { JsonValue } from '../../../../shared/schemas/variable'

export const GOLDEN_INPUT: Record<string, JsonValue> = {
  region: 'ap-southeast-1',
  count: 3,
  ratio: 1e-7,
  enabled: true,
  nothing: null,
  tricky: 'a "quote" \\ ${not_interp} %{not_directive} $${x}\u0007',
  list: ['a', 1, false],
  tags: { team: 'core', 'needs-quote': 'x' }
}
