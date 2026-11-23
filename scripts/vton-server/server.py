"""
Silho Private GPU VTON Server (FASHN VTON 1.5)
----------------------------------------------
FastAPI server intended to run on a free Google Colab T4 GPU (exposed via
Cloudflare Quick Tunnel) or a local NVIDIA GPU machine so Silho's `/api/tryon`
and `scripts/tailor-benchmark/run.ts` can bypass Hugging Face ZeroGPU limits.

Endpoints:
    GET  /health         -> { status, device, cuda, gpu, dtype, weights_dir, active_jobs }
    POST /jobs           -> Enqueues async try-on job, immediately returns { job_id, status }
                            (bypasses Cloudflare Quick Tunnel's 100s proxy timeout)
    GET  /jobs/{job_id}  -> Returns { job_id, status } while queued/running,
                            image/png bytes when complete, or HTTP 500 JSON on failure
    POST /try-on         -> Synchronous try-on endpoint (for direct / local callers)

Quick start (Colab T4 / local Linux):
    git clone https://github.com/fashn-AI/fashn-vton-1.5.git
    pip install -q -e ./fashn-vton-1.5 fastapi uvicorn python-multipart pillow
    python ./fashn-vton-1.5/scripts/download_weights.py --weights-dir ./weights
    VTON_WEIGHTS_DIR=./weights uvicorn server:app --host 0.0.0.0 --port 8000

Environment variables:
    VTON_WEIGHTS_DIR : Path to downloaded FASHN VTON 1.5 weights (default: "./weights")
    VTON_API_SECRET  : Optional shared secret checked against `x-vton-secret` header
    VTON_HOST        : Bind host when invoked via `python server.py` (default: "0.0.0.0")
    VTON_PORT        : Bind port when invoked via `python server.py` (default: 8000)
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import hmac
import io
import os
import time
from typing import Optional
import uuid

from fastapi import FastAPI, File, Form, Header, HTTPException, Response, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image
import torch
import uvicorn

try:
    from fashn_vton import TryOnPipeline
except ImportError as exc:  # pragma: no cover - runtime environment dependency
    raise RuntimeError(
        "fashn_vton is not installed. Install from https://github.com/fashn-AI/fashn-vton-1.5 "
        "(e.g. `pip install git+https://github.com/fashn-AI/fashn-vton-1.5.git`)."
    ) from exc


VALID_CATEGORIES = {"tops", "bottoms", "one-pieces"}
VALID_GARMENT_PHOTO_TYPES = {"flat-lay", "model"}

WEIGHTS_DIR = os.environ.get("VTON_WEIGHTS_DIR", "./weights")
API_SECRET = os.environ.get("VTON_API_SECRET", "").strip()
JOB_TTL_SECONDS = 600.0
MAX_STORED_JOBS = 32


@dataclass
class TryOnJob:
    job_id: str
    status: str = "queued"  # "queued" | "running" | "done" | "error"
    created_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    png_bytes: Optional[bytes] = None
    error: Optional[str] = None


pipeline: Optional[TryOnPipeline] = None
inference_lock = asyncio.Lock()
jobs: dict[str, TryOnJob] = {}
background_tasks: set[asyncio.Task[None]] = set()


def detect_device_info() -> dict[str, object]:
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
        return {
            "device": f"cuda ({gpu_name})",
            "cuda": True,
            "gpu": gpu_name,
        }
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return {"device": "mps", "cuda": False, "gpu": None}
    return {"device": "cpu", "cuda": False, "gpu": None}


def parse_bool_flag(raw: str) -> bool:
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def verify_secret(provided: Optional[str]) -> None:
    if not API_SECRET:
        return
    if not provided or not hmac.compare_digest(provided.strip(), API_SECRET):
        raise HTTPException(status_code=401, detail="Invalid or missing x-vton-secret")


def prune_stale_jobs() -> None:
    now = time.time()
    expired = [
        jid
        for jid, job in jobs.items()
        if job.finished_at is not None and (now - job.finished_at) > JOB_TTL_SECONDS
    ]
    for jid in expired:
        jobs.pop(jid, None)

    if len(jobs) > MAX_STORED_JOBS:
        finished = sorted(
            (job for job in jobs.values() if job.finished_at is not None),
            key=lambda j: j.finished_at or 0.0,
        )
        for job in finished[: max(0, len(jobs) - MAX_STORED_JOBS)]:
            jobs.pop(job.job_id, None)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global pipeline
    device_info = detect_device_info()
    print(
        f"[vton-server] Loading FASHN VTON 1.5 TryOnPipeline from '{WEIGHTS_DIR}' "
        f"on {device_info['device']}..."
    )
    t0 = time.perf_counter()
    pipeline = TryOnPipeline(weights_dir=WEIGHTS_DIR)

    # On Turing/Volta GPUs (e.g. Tesla T4, sm_75, compute capability < 8.0), PyTorch 2.x
    # lacks native bfloat16 Tensor Cores and float16 causes color blow-out / mask artifacts.
    # Force native float32 on sm < 8.0 and keep native bfloat16 on Ampere+ (sm >= 8.0).
    if pipeline.device.type == "cuda":
        cc_major, cc_minor = torch.cuda.get_device_capability(0)
        if cc_major < 8 and pipeline.inference_dtype != torch.float32:
            pipeline.inference_dtype = torch.float32
            pipeline.tryon_model.to(dtype=torch.float32)
            torch.cuda.empty_cache()
            print(
                f"[vton-server] Forced native float32 for sm_{cc_major}{cc_minor} GPU "
                "(avoiding emulated bf16 / fp16 artifacts)."
            )

    elapsed = time.perf_counter() - t0
    print(
        f"[vton-server] Pipeline ready in {elapsed:.1f}s "
        f"(dtype={pipeline.inference_dtype})."
    )
    try:
        yield
    finally:
        for task in list(background_tasks):
            task.cancel()
        jobs.clear()
        pipeline = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


app = FastAPI(
    title="Silho Private VTON Server",
    version="1.1.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health() -> dict[str, object]:
    device_info = detect_device_info()
    active_jobs = sum(
        1 for job in jobs.values() if job.status in ("queued", "running")
    )
    return {
        "status": "ok" if pipeline is not None else "loading",
        "device": device_info["device"],
        "cuda": device_info["cuda"],
        "gpu": device_info["gpu"],
        "dtype": str(pipeline.inference_dtype) if pipeline is not None else None,
        "weights_dir": WEIGHTS_DIR,
        "active_jobs": active_jobs,
    }


def _run_pipeline_sync(
    person_img: Image.Image,
    garment_img: Image.Image,
    category: str,
    garment_photo_type: str,
    num_timesteps: int,
    guidance_scale: float,
    seed: int,
    segmentation_free: bool,
) -> bytes:
    if pipeline is None:
        raise RuntimeError("TryOnPipeline is not initialized.")

    try:
        with torch.inference_mode():
            result = pipeline(
                person_image=person_img,
                garment_image=garment_img,
                category=category,
                garment_photo_type=garment_photo_type,
                num_samples=1,
                num_timesteps=num_timesteps,
                guidance_scale=guidance_scale,
                seed=seed,
                segmentation_free=segmentation_free,
            )

        out_image = result.images[0]
        buf = io.BytesIO()
        out_image.save(buf, format="PNG")
        return buf.getvalue()
    finally:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


async def _parse_tryon_request(
    person_image: UploadFile,
    garment_image: UploadFile,
    category: str,
    garment_photo_type: str,
    num_timesteps: int,
    guidance_scale: float,
    seed: int,
    segmentation_free: str,
) -> tuple[Image.Image, Image.Image, str, str, int, float, int, bool]:
    clean_category = category.strip().lower()
    if clean_category not in VALID_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid category '{category}'. Expected one of {sorted(VALID_CATEGORIES)}.",
        )

    clean_photo_type = garment_photo_type.strip().lower()
    if clean_photo_type not in VALID_GARMENT_PHOTO_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid garment_photo_type '{garment_photo_type}'. "
                f"Expected one of {sorted(VALID_GARMENT_PHOTO_TYPES)}."
            ),
        )

    clamped_steps = max(1, min(100, int(num_timesteps)))
    clamped_guidance = max(1.0, min(5.0, float(guidance_scale)))
    seg_free_bool = parse_bool_flag(segmentation_free)

    person_bytes = await person_image.read()
    garment_bytes = await garment_image.read()
    if not person_bytes or not garment_bytes:
        raise HTTPException(
            status_code=400,
            detail="Both person_image and garment_image files are required.",
        )

    try:
        person_pil = Image.open(io.BytesIO(person_bytes)).convert("RGB")
        garment_raw = Image.open(io.BytesIO(garment_bytes))
        if garment_raw.mode in ("RGBA", "LA") or (
            garment_raw.mode == "P" and "transparency" in garment_raw.info
        ):
            rgba = garment_raw.convert("RGBA")
            studio_bg = Image.new("RGBA", rgba.size, (246, 246, 244, 255))
            garment_pil = Image.alpha_composite(studio_bg, rgba).convert("RGB")
        else:
            garment_pil = garment_raw.convert("RGB")
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Could not decode input images: {exc}",
        ) from exc

    return (
        person_pil,
        garment_pil,
        clean_category,
        clean_photo_type,
        clamped_steps,
        clamped_guidance,
        int(seed),
        seg_free_bool,
    )


async def _execute_job(
    job: TryOnJob,
    person_pil: Image.Image,
    garment_pil: Image.Image,
    category: str,
    garment_photo_type: str,
    num_timesteps: int,
    guidance_scale: float,
    seed: int,
    segmentation_free: bool,
) -> None:
    t0 = time.perf_counter()
    try:
        async with inference_lock:
            job.status = "running"
            png_bytes = await asyncio.to_thread(
                _run_pipeline_sync,
                person_pil,
                garment_pil,
                category,
                garment_photo_type,
                num_timesteps,
                guidance_scale,
                seed,
                segmentation_free,
            )
        job.png_bytes = png_bytes
        job.status = "done"
        elapsed = time.perf_counter() - t0
        print(
            f"[vton-server] job={job.job_id[:8]} ok | category={category} "
            f"steps={num_timesteps} guidance={guidance_scale:.1f} "
            f"seg_free={segmentation_free} seed={seed} "
            f"size={person_pil.width}x{person_pil.height} time={elapsed:.2f}s"
        )
    except Exception as exc:
        job.error = str(exc)
        job.status = "error"
        print(f"[vton-server] job={job.job_id[:8]} error: {exc}")
    finally:
        job.finished_at = time.time()
        prune_stale_jobs()


@app.post("/jobs")
async def create_job(
    person_image: UploadFile = File(...),
    garment_image: UploadFile = File(...),
    category: str = Form("one-pieces"),
    garment_photo_type: str = Form("flat-lay"),
    num_timesteps: int = Form(30),
    guidance_scale: float = Form(1.5),
    seed: int = Form(42),
    segmentation_free: str = Form("true"),
    x_vton_secret: Optional[str] = Header(default=None, alias="x-vton-secret"),
) -> dict[str, str]:
    verify_secret(x_vton_secret)

    if pipeline is None:
        raise HTTPException(status_code=503, detail="Pipeline is still loading.")

    parsed = await _parse_tryon_request(
        person_image=person_image,
        garment_image=garment_image,
        category=category,
        garment_photo_type=garment_photo_type,
        num_timesteps=num_timesteps,
        guidance_scale=guidance_scale,
        seed=seed,
        segmentation_free=segmentation_free,
    )

    prune_stale_jobs()
    job_id = uuid.uuid4().hex
    job = TryOnJob(job_id=job_id)
    jobs[job_id] = job

    task = asyncio.create_task(_execute_job(job, *parsed))
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)

    return {"job_id": job_id, "status": job.status}


@app.get("/jobs/{job_id}")
async def get_job(
    job_id: str,
    x_vton_secret: Optional[str] = Header(default=None, alias="x-vton-secret"),
) -> Response:
    verify_secret(x_vton_secret)

    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")

    if job.status in ("queued", "running"):
        return JSONResponse(
            content={"job_id": job.job_id, "status": job.status},
            status_code=200,
        )

    if job.status == "error":
        return JSONResponse(
            content={
                "job_id": job.job_id,
                "status": "error",
                "error": job.error or "Inference failed.",
            },
            status_code=500,
        )

    if not job.png_bytes:
        raise HTTPException(status_code=500, detail="Job completed without image bytes.")

    return Response(content=job.png_bytes, media_type="image/png")


@app.post("/try-on")
async def try_on(
    person_image: UploadFile = File(...),
    garment_image: UploadFile = File(...),
    category: str = Form("tops"),
    garment_photo_type: str = Form("flat-lay"),
    num_timesteps: int = Form(30),
    guidance_scale: float = Form(1.5),
    seed: int = Form(42),
    segmentation_free: str = Form("true"),
    x_vton_secret: Optional[str] = Header(default=None, alias="x-vton-secret"),
) -> Response:
    verify_secret(x_vton_secret)

    if pipeline is None:
        raise HTTPException(status_code=503, detail="Pipeline is still loading.")

    (
        person_pil,
        garment_pil,
        clean_category,
        clean_photo_type,
        clamped_steps,
        clamped_guidance,
        seed_int,
        seg_free_bool,
    ) = await _parse_tryon_request(
        person_image=person_image,
        garment_image=garment_image,
        category=category,
        garment_photo_type=garment_photo_type,
        num_timesteps=num_timesteps,
        guidance_scale=guidance_scale,
        seed=seed,
        segmentation_free=segmentation_free,
    )

    t0 = time.perf_counter()
    async with inference_lock:
        try:
            png_bytes = await asyncio.to_thread(
                _run_pipeline_sync,
                person_pil,
                garment_pil,
                clean_category,
                clean_photo_type,
                clamped_steps,
                clamped_guidance,
                seed_int,
                seg_free_bool,
            )
        except Exception as exc:
            print(f"[vton-server] Inference error: {exc}")
            raise HTTPException(
                status_code=500, detail=f"Inference failed: {exc}"
            ) from exc

    elapsed = time.perf_counter() - t0
    print(
        f"[vton-server] /try-on ok | category={clean_category} steps={clamped_steps} "
        f"guidance={clamped_guidance:.1f} seg_free={seg_free_bool} seed={seed_int} "
        f"size={person_pil.width}x{person_pil.height} time={elapsed:.2f}s"
    )
    return Response(content=png_bytes, media_type="image/png")


if __name__ == "__main__":
    host = os.environ.get("VTON_HOST", "0.0.0.0")
    port = int(os.environ.get("VTON_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)
