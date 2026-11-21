const IMAGE_EXTENSION_RE = /\.(png|jpe?g|webp|avif|gif|bmp)$/i;

export function isSupportedImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSION_RE.test(file.name);
}

/**
 * Decodes any browser-supported image (including .webp, .avif, and large phone photos)
 * onto an offscreen canvas, downscales so the longest side is at most `maxDimension` px,
 * and exports a clean `image/png` Blob safe for WASM/ONNX background removal.
 */
export async function normalizeImageToPngBlob(
  source: File | Blob,
  maxDimension = 1200
): Promise<Blob> {
  const objectUrl = URL.createObjectURL(source);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () =>
        reject(
          new Error(
            "Browser could not decode this image file. Try a PNG, JPG, or WebP."
          )
        );
      element.src = objectUrl;
    });

    const naturalW = Math.max(1, img.naturalWidth);
    const naturalH = Math.max(1, img.naturalHeight);
    const longestSide = Math.max(naturalW, naturalH);
    const scale = longestSide > maxDimension ? maxDimension / longestSide : 1;

    const width = Math.max(1, Math.round(naturalW * scale));
    const height = Math.max(1, Math.round(naturalH * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Browser canvas is unavailable.");
    }

    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Could not encode normalized PNG image."));
        }
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  if (typeof err === "string" && err.trim()) {
    return err.trim();
  }
  try {
    const serialized = JSON.stringify(err);
    if (serialized && serialized !== "{}") {
      return serialized;
    }
  } catch {
    // Ignore serialization failures.
  }
  return "Unknown error";
}
