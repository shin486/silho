"use client";

import type * as OrtTypes from "onnxruntime-web";
import {
  ATR_NUM_CLASSES,
  type SemanticParseMap,
} from "@/lib/utils/garmentIsolator";

const SEGFORMER_MODEL_URL =
  "https://huggingface.co/Xenova/segformer_b2_clothes/resolve/main/onnx/model_quantized.onnx";
const SEGFORMER_CACHE_NAME = "silho-segformer-b2-clothes-v1";
const ORT_WASM_CDN_FALLBACK =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";

const MODEL_INPUT_SIZE = 512;
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

export interface ParseProgressEvent {
  phase: "download" | "init" | "infer";
  /** 0..100 when known, null otherwise. */
  percent: number | null;
}

let cachedSessionPromise: Promise<OrtTypes.InferenceSession> | null = null;

async function fetchModelBytesWithCache(
  onProgress?: (event: ParseProgressEvent) => void
): Promise<Uint8Array> {
  // 1. Check persistent browser Cache API first for instant zero-network subsequent runs
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(SEGFORMER_CACHE_NAME);
      const cached = await cache.match(SEGFORMER_MODEL_URL);
      if (cached && cached.ok) {
        onProgress?.({ phase: "init", percent: 100 });
        return new Uint8Array(await cached.arrayBuffer());
      }
    } catch {
      // Cache API may be restricted in private browsing; proceed to direct fetch
    }
  }

  onProgress?.({ phase: "download", percent: 0 });
  const response = await fetch(SEGFORMER_MODEL_URL, {
    mode: "cors",
    credentials: "omit",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download semantic garment parser (HTTP ${response.status}).`
    );
  }

  const contentLengthHeader = response.headers.get("content-length");
  const totalBytes = contentLengthHeader
    ? Number.parseInt(contentLengthHeader, 10)
    : 0;

  let bytes: Uint8Array;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        if (totalBytes > 0) {
          onProgress?.({
            phase: "download",
            percent: Math.min(99, Math.round((loaded / totalBytes) * 100)),
          });
        }
      }
    }

    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  // Persist into Cache API in the background so future uploads skip downloading
  if (typeof caches !== "undefined" && bytes.byteLength > 0) {
    try {
      const cache = await caches.open(SEGFORMER_CACHE_NAME);
      const cacheCopy = new Uint8Array(bytes.byteLength);
      cacheCopy.set(bytes);
      await cache.put(
        SEGFORMER_MODEL_URL,
        new Response(cacheCopy.buffer, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.byteLength),
          },
        })
      );
    } catch {
      // Non-fatal if browser quota prevents caching
    }
  }

  onProgress?.({ phase: "init", percent: 100 });
  return bytes;
}

async function getOrCreateSession(
  onProgress?: (event: ParseProgressEvent) => void
): Promise<OrtTypes.InferenceSession> {
  if (cachedSessionPromise) {
    return cachedSessionPromise;
  }

  const pending = (async () => {
    const [ortModule, modelBytes] = await Promise.all([
      import("onnxruntime-web"),
      fetchModelBytesWithCache(onProgress),
    ]);

    const ort = (ortModule.default ?? ortModule) as typeof OrtTypes;

    // Preserve @imgly/background-removal's already-configured wasmPaths when present,
    // and fall back cleanly to matching jsDelivr 1.21.0 WASM artifacts otherwise.
    if (!ort.env.wasm.wasmPaths) {
      ort.env.wasm.wasmPaths = ORT_WASM_CDN_FALLBACK;
    }

    try {
      return await ort.InferenceSession.create(modelBytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    } catch (firstErr) {
      console.warn(
        "[semanticClothesParser] Retrying WASM session with CDN fallback & single thread:",
        firstErr
      );
      ort.env.wasm.wasmPaths = ORT_WASM_CDN_FALLBACK;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      return await ort.InferenceSession.create(modelBytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    }
  })();

  pending.catch(() => {
    if (cachedSessionPromise === pending) {
      cachedSessionPromise = null;
    }
  });

  cachedSessionPromise = pending;
  return pending;
}

/**
 * Prepares an ImageNet-normalized NCHW `[1, 3, 512, 512]` Float32Array matching
 * `Xenova/segformer_b2_clothes/preprocessor_config.json`.
 */
function preprocessToSegformerTensor(
  source: CanvasImageSource
): Float32Array {
  const canvas = document.createElement("canvas");
  canvas.width = MODEL_INPUT_SIZE;
  canvas.height = MODEL_INPUT_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Browser 2D canvas unavailable for semantic parsing.");
  }

  // Composite onto crisp neutral white so transparent areas parse cleanly as Background
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);

  const { data } = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  const planeSize = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const tensor = new Float32Array(3 * planeSize);

  const m0 = IMAGENET_MEAN[0];
  const m1 = IMAGENET_MEAN[1];
  const m2 = IMAGENET_MEAN[2];
  const s0 = 1 / (255 * IMAGENET_STD[0]);
  const s1 = 1 / (255 * IMAGENET_STD[1]);
  const s2 = 1 / (255 * IMAGENET_STD[2]);
  const o0 = m0 / IMAGENET_STD[0];
  const o1 = m1 / IMAGENET_STD[1];
  const o2 = m2 / IMAGENET_STD[2];

  const plane1 = planeSize;
  const plane2 = planeSize * 2;

  for (let i = 0; i < planeSize; i++) {
    const p = i * 4;
    tensor[i] = data[p] * s0 - o0;
    tensor[plane1 + i] = data[p + 1] * s1 - o1;
    tensor[plane2 + i] = data[p + 2] * s2 - o2;
  }

  return tensor;
}

/**
 * Converts SegFormer output logits `[1, C, H, W]` into a compact cached
 * `SemanticParseMap` (quantized softmax probabilities + argmax labels).
 */
function logitsToSemanticMap(
  logits: Float32Array,
  dims: readonly number[]
): SemanticParseMap {
  const numClasses = dims.length >= 4 ? dims[1] : ATR_NUM_CLASSES;
  const height = dims.length >= 4 ? dims[2] : 128;
  const width = dims.length >= 4 ? dims[3] : 128;
  const cells = width * height;

  const probs = new Uint8Array(numClasses * cells);
  const labels = new Uint8Array(cells);
  const expScratch = new Float32Array(numClasses);

  for (let i = 0; i < cells; i++) {
    let maxVal = -Infinity;
    let bestClass = 0;

    for (let c = 0; c < numClasses; c++) {
      const v = logits[c * cells + i];
      if (v > maxVal) {
        maxVal = v;
        bestClass = c;
      }
    }

    let sumExp = 0;
    for (let c = 0; c < numClasses; c++) {
      const e = Math.exp(logits[c * cells + i] - maxVal);
      expScratch[c] = e;
      sumExp += e;
    }

    const invSum = sumExp > 0 ? 255 / sumExp : 0;
    for (let c = 0; c < numClasses; c++) {
      const q = Math.round(expScratch[c] * invSum);
      probs[c * cells + i] = q > 255 ? 255 : q;
    }
    labels[i] = bestClass;
  }

  return {
    width,
    height,
    numClasses,
    probs,
    labels,
  };
}

/**
 * Runs SegFormer-B2-Clothes (`Xenova/segformer_b2_clothes` quantized ONNX) entirely
 * in the browser via ONNX Runtime Web WASM and returns a cached 18-class semantic map
 * that powers instant (<50ms) reactive category switching in Add Wardrobe Piece.
 */
export async function parseGarmentSemanticsInBrowser(
  source: CanvasImageSource,
  onProgress?: (event: ParseProgressEvent) => void
): Promise<SemanticParseMap> {
  const session = await getOrCreateSession(onProgress);
  onProgress?.({ phase: "infer", percent: null });

  const ortModule = await import("onnxruntime-web");
  const ort = (ortModule.default ?? ortModule) as typeof OrtTypes;

  const inputData = preprocessToSegformerTensor(source);
  const inputName = session.inputNames[0] ?? "pixel_values";
  const outputName = session.outputNames[0] ?? "logits";

  const inputTensor = new ort.Tensor("float32", inputData, [
    1,
    3,
    MODEL_INPUT_SIZE,
    MODEL_INPUT_SIZE,
  ]);

  const outputs = await session.run({ [inputName]: inputTensor });
  const outputTensor = outputs[outputName] ?? outputs[Object.keys(outputs)[0]];
  if (!outputTensor) {
    throw new Error("Semantic garment parser returned no output tensor.");
  }

  const rawData = outputTensor.data;
  const logits =
    rawData instanceof Float32Array
      ? rawData
      : Float32Array.from(rawData as ArrayLike<number>);

  return logitsToSemanticMap(logits, outputTensor.dims);
}
