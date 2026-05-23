export default {
  "src/**/!(*.test).ts": "eslint --cache --fix",
  "scripts/**/*.ts": "eslint --cache --fix",
  "*.config.ts": "eslint --cache --fix",
};
