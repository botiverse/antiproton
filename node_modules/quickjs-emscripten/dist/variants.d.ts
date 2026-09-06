import { PromisedDefault, QuickJSSyncVariant, QuickJSWASMModule, QuickJSAsyncVariant, QuickJSAsyncWASMModule } from 'quickjs-emscripten-core';
export { default as DEBUG_SYNC } from '@jitl/quickjs-wasmfile-debug-sync';
export { default as RELEASE_SYNC } from '@jitl/quickjs-wasmfile-release-sync';
export { default as DEBUG_ASYNC } from '@jitl/quickjs-wasmfile-debug-asyncify';
export { default as RELEASE_ASYNC } from '@jitl/quickjs-wasmfile-release-asyncify';

/**
 * Create a new, completely isolated WebAssembly module containing the QuickJS library.
 * See the documentation on {@link QuickJSWASMModule}.
 *
 * Note that there is a hard limit on the number of WebAssembly modules in older
 * versions of v8:
 * https://bugs.chromium.org/p/v8/issues/detail?id=12076
 */
declare function newQuickJSWASMModule(
/**
 * Optionally, pass a {@link QuickJSSyncVariant} to construct a different WebAssembly module.
 */
variantOrPromise?: PromisedDefault<QuickJSSyncVariant>): Promise<QuickJSWASMModule>;
/**
 * Create a new, completely isolated WebAssembly module containing a version of the QuickJS library
 * compiled with Emscripten's [ASYNCIFY](https://emscripten.org/docs/porting/asyncify.html) transform.
 *
 * This version of the library offers features that enable synchronous code
 * inside the VM to interact with asynchronous code in the host environment.
 * See the documentation on {@link QuickJSAsyncWASMModule}, {@link QuickJSAsyncRuntime},
 * and {@link QuickJSAsyncContext}.
 *
 * Note that there is a hard limit on the number of WebAssembly modules in older
 * versions of v8:
 * https://bugs.chromium.org/p/v8/issues/detail?id=12076
 */
declare function newQuickJSAsyncWASMModule(
/**
 * Optionally, pass a {@link QuickJSAsyncVariant} to construct a different WebAssembly module.
 */
variantOrPromise?: PromisedDefault<QuickJSAsyncVariant>): Promise<QuickJSAsyncWASMModule>;

export { newQuickJSAsyncWASMModule, newQuickJSWASMModule };
