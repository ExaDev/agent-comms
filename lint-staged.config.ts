export default {
  "src/**/!(*.test|*.spec).ts": "eslint --cache --fix",
  "!src/bridges/user/web/e2e/**": "eslint --cache --fix",
  "scripts/**/*.ts": "eslint --cache --fix",
  "*.config.ts": "eslint --cache --fix",
};
