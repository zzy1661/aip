import { makeConfig } from './vitest.shared.js';

export default makeConfig(['tests/unit/**/*.test.ts'], { mode: 'unit' });
