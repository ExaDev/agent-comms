export default {
  "{src,scripts}/**/!(*.test).ts": "eslint --cache --fix",
  "*.config.ts": "eslint --cache --fix",
};
