declare module "onnxruntime-web" {
  export interface WasmEnvFlags {
    wasmPaths?: string | Record<string, string>;
    numThreads?: number;
    proxy?: boolean;
    simd?: boolean;
  }

  export interface OrtEnv {
    wasm: WasmEnvFlags;
    logLevel?: "verbose" | "info" | "warning" | "error" | "fatal";
    debug?: boolean;
  }

  export interface InferenceSessionOptions {
    executionProviders?: readonly string[];
    graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
    executionMode?: "sequential" | "parallel";
    enableCpuMemArena?: boolean;
  }

  export interface Tensor {
    readonly dims: readonly number[];
    readonly type: string;
    readonly data: Float32Array | Uint8Array | Int32Array | ArrayLike<number>;
  }

  export interface TensorConstructor {
    new (
      type: "float32" | "uint8" | "int32",
      data: Float32Array | Uint8Array | Int32Array,
      dims: readonly number[]
    ): Tensor;
  }

  export interface InferenceSession {
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
    run(
      feeds: Record<string, Tensor>
    ): Promise<Record<string, Tensor>>;
    release?(): Promise<void>;
  }

  export interface InferenceSessionFactory {
    create(
      buffer: Uint8Array | ArrayBuffer,
      options?: InferenceSessionOptions
    ): Promise<InferenceSession>;
  }

  export const env: OrtEnv;
  export const Tensor: TensorConstructor;
  export const InferenceSession: InferenceSessionFactory;

  const ortDefault: {
    env: OrtEnv;
    Tensor: TensorConstructor;
    InferenceSession: InferenceSessionFactory;
  };
  export default ortDefault;
}
