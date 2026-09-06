import { QuickJSWASMModule, AsyncRuntimeOptions, QuickJSAsyncRuntime, ContextOptions, QuickJSAsyncContext } from 'quickjs-emscripten-core';
export * from 'quickjs-emscripten-core';
export { newQuickJSAsyncWASMModule, newQuickJSWASMModule } from './variants.js';
export { default as DEBUG_SYNC } from '@jitl/quickjs-wasmfile-debug-sync';
export { default as RELEASE_SYNC } from '@jitl/quickjs-wasmfile-release-sync';
export { default as DEBUG_ASYNC } from '@jitl/quickjs-wasmfile-debug-asyncify';
export { default as RELEASE_ASYNC } from '@jitl/quickjs-wasmfile-release-asyncify';

/**
 * Get a shared singleton {@link QuickJSWASMModule}. Use this to evaluate code
 * or create Javascript environments.
 *
 * This is the top-level entrypoint for the quickjs-emscripten library.
 *
 * If you need strictest possible isolation guarantees, you may create a
 * separate {@link QuickJSWASMModule} via {@link newQuickJSWASMModule}.
 *
 * To work with the asyncified version of this library, see these functions:
 *
 * - {@link newAsyncRuntime}.
 * - {@link newAsyncContext}.
 * - {@link newQuickJSAsyncWASMModule}.
 */
declare function getQuickJS(): Promise<QuickJSWASMModule>;
/**
 * Provides synchronous access to the shared {@link QuickJSWASMModule} instance returned by {@link getQuickJS}, as long as
 * least once.
 * @throws If called before `getQuickJS` resolves.
 */
declare function getQuickJSSync(): QuickJSWASMModule;
/**
 * Create a new {@link QuickJSAsyncRuntime} in a separate WebAssembly module.
 *
 * Each runtime is isolated in a separate WebAssembly module, so that errors in
 * one runtime cannot contaminate another runtime, and each runtime can execute
 * an asynchronous action without conflicts.
 *
 * Note that there is a hard limit on the number of WebAssembly modules in older
 * versions of v8:
 * https://bugs.chromium.org/p/v8/issues/detail?id=12076
 */
declare function newAsyncRuntime(options?: AsyncRuntimeOptions): Promise<QuickJSAsyncRuntime>;
/**
 * Create a new {@link QuickJSAsyncContext} (with an associated runtime) in an
 * separate WebAssembly module.
 *
 * Each context is isolated in a separate WebAssembly module, so that errors in
 * one runtime cannot contaminate another runtime, and each runtime can execute
 * an asynchronous action without conflicts.
 *
 * Note that there is a hard limit on the number of WebAssembly modules in older
 * versions of v8:
 * https://bugs.chromium.org/p/v8/issues/detail?id=12076
 */
declare function newAsyncContext(options?: ContextOptions): Promise<QuickJSAsyncContext>;

export { getQuickJS, getQuickJSSync, newAsyncContext, newAsyncRuntime };
