import { register } from 'node:module';

register('./stubImportMeta.mjs', import.meta.url);

globalThis.__TEST_ENV__ = {
  VITE_API_URL: '',
  MODE: 'test',
  DEV: false,
  PROD: false,
};
