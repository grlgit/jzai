/**
 * React shim — 扩展包前端面板不打包 React，运行时由宿主注入。
 *
 * DynamicPanelLoader 在 import() 面板 bundle 之前挂载 window.__JZ_SDK__.react。
 * esbuild 通过 --alias:react=<本文件> 把所有 `import ... from 'react'`
 * （包括第三方库内部的）重定向到这里，保证与宿主共享同一个 React 实例，
 * 避免两份 React 导致的 Hooks 报错。
 */
const React = (window as any).__JZ_SDK__.react;

export default React;

export const useState = React.useState;
export const useEffect = React.useEffect;
export const useRef = React.useRef;
export const useMemo = React.useMemo;
export const useCallback = React.useCallback;
export const useReducer = React.useReducer;
export const useContext = React.useContext;
export const useLayoutEffect = React.useLayoutEffect;
export const useImperativeHandle = React.useImperativeHandle;
export const createContext = React.createContext;
export const forwardRef = React.forwardRef;
export const memo = React.memo;
export const Fragment = React.Fragment;
export const createElement = React.createElement;
export const cloneElement = React.cloneElement;
export const isValidElement = React.isValidElement;
export const Children = React.Children;
