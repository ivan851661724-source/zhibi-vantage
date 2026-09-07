// ESLint flat config（Next 15 + React 19）
// `pnpm lint`（next lint）使用本配置；规则集 = next/core-web-vitals + TS 推荐。
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // 项目现状：类型层宽松建模（state.ts index signature）尚在收紧过程中，
      // 先以 warn 观察避免 CI 红灯；显式 any 逐文件清理后再提到 error。
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];

export default eslintConfig;
