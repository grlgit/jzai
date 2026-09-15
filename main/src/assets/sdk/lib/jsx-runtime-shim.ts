/**
 * JSX runtime shim — 配合 esbuild --jsx=automatic 使用。
 * 与 react-shim.ts 同理：运行时取宿主注入的 React，不打包自己的副本。
 */
const React = (window as any).__JZ_SDK__.react;

export const Fragment = React.Fragment;

export function jsx(type: any, props: any, key?: any): any {
  return React.createElement(type, { ...props, key });
}

export const jsxs = jsx;
