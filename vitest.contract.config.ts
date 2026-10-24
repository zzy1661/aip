import { makeConfig } from './vitest.shared.js';

export default makeConfig(['tests/contract/**/*.test.ts'], { mode: 'contract' });
