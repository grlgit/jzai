const config = {
  plugins: {
    "@tailwindcss/postcss": {},
    // 旧内核兼容降级（钉钉/企业微信内置 WebView 等）：在 Tailwind 产物之后运行
    // - oklab-function：oklch()/oklab() 转 rgb 兜底（内核 < Chrome 111）
    // - nesting-rules：展平 CSS 原生嵌套（内核 < Chrome 112）
    // - cascade-layers（展平 @layer）已移除：它会给所有规则追加 :not(#\#) 特异性链，
    //   导致未分层的自定义样式（如链接颜色）被压掉；且仅当内核 < Chrome 99 才需要，
    //   是否真的需要等钉钉内核版本确认后再定。
    // color-mix 不在此处理：Tailwind v4.3 已用 @supports 门控并自带兜底声明
    "postcss-preset-env": {
      stage: false,
      features: {
        "oklab-function": true,
        "nesting-rules": true,
      },
    },
  },
};

export default config;
