"""
Silho Private VTON Server — FitDiT HD (SD3 Diffusion Transformer)
=================================================================
Drop-in high-resolution server exposing the exact same FastAPI contract as
`server.py` (`GET /health`, `POST /jobs`, `GET /jobs/{job_id}`, `POST /try-on`)
so Silho's `/api/tryon` auto-detects `engine: "fitdit"` and sends full 768x1024
inputs for native 1152x1536 / 768x1024 photorealistic renders at $0 on Kaggle
`T4 x 2` (~30 GiB RAM + 2x 15 GiB VRAM) or any >= 18 GiB RAM GPU host.

Multi-GPU (`dual-gpu`) placement on Kaggle T4 x 2:
  - `cuda:0` (~4.0 GB resident): `transformer_vton` (3.83 GB) + `vae` (0.17 GB) + `pose_guider` (0.01 GB)
  - `cuda:1` (~8.1 GB resident): `transformer_garm` (3.83 GB) + `image_encoder_bigG` (3.70 GB) + `image_encoder_large` (0.61 GB)
  - Forward pre/post hooks automatically transfer input tensors `cuda:0 -> cuda:1`
    and output tensors (including `ModelOutput` & `ref_key`/`ref_value` lists) `cuda:1 -> cuda:0`,
    and assert tensor device alignment so `StableDiffusion3TryOnPipeline.__call__`
    never hits cross-device errors and runs with zero CPU offload overhead.

Environment variables:
  FITDIT_REPO_DIR     Path to cloned BoyuanJiang/FitDiT repo (default: "./FitDiT")
  FITDIT_MODEL_DIR    Local dir for BoyuanJiang/FitDiT weights (default: "./fitdit-weights")
  FITDIT_RESOLUTION   "1152x1536" (default, auto-falls back to "768x1024" on OOM) or "768x1024"
  FITDIT_OFFLOAD      "auto" (default), "dual-gpu", "model", "aggressive", or "none"
  VTON_API_SECRET     Optional shared secret checked against `x-vton-secret` header
  VTON_HOST           Bind host (default: "0.0.0.0")
  VTON_PORT           Bind port (default: "8000")
"""

from __future__ import annotations

import asyncio
import gc
import io
import math
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from huggingface_hub import snapshot_download
from PIL import Image

try:
    import cv2
except ImportError:  # pragma: no cover - cv2 is required on FitDiT GPU hosts
    cv2 = None  # type: ignore[assignment]

FITDIT_REPO_DIR = Path(os.environ.get("FITDIT_REPO_DIR", "./FitDiT")).resolve()
FITDIT_MODEL_DIR = Path(
    os.environ.get("FITDIT_MODEL_DIR", "./fitdit-weights")
).resolve()
FITDIT_RESOLUTION = os.environ.get("FITDIT_RESOLUTION", "1152x1536").strip()
FITDIT_OFFLOAD = os.environ.get("FITDIT_OFFLOAD", "auto").strip().lower()
API_SECRET = os.environ.get("VTON_API_SECRET", "").strip()

VALID_RESOLUTIONS = {"768x1024", "1152x1536", "1536x2048"}
if FITDIT_RESOLUTION not in VALID_RESOLUTIONS:
    FITDIT_RESOLUTION = "1152x1536"

CATEGORY_MAP = {
    "tops": "Upper-body",
    "upper": "Upper-body",
    "upper-body": "Upper-body",
    "bottoms": "Lower-body",
    "lower": "Lower-body",
    "lower-body": "Lower-body",
    "one-pieces": "Dresses",
    "dresses": "Dresses",
}

# Clean neutral studio off-white flat-lay canvas (#F6F6F4) for CLIP-L/CLIP-bigG & transformer_garm
STUDIO_FLATLAY_BG: tuple[int, int, int] = (246, 246, 244)

# FitDiT ATR + LIP-neck (19-class) semantic parser indices:
#   0: Background, 1: Hat, 2: Hair, 3: Sunglasses, 4: Upper-clothes, 5: Skirt,
#   6: Pants, 7: Dress, 8: Belt, 9: Left-shoe, 10: Right-shoe, 11: Face,
#   12: Left-leg, 13: Right-leg, 14: Left-arm, 15: Right-arm, 16: Bag,
#   17: Scarf, 18: Neck
SKIN_AND_HEAD_LABELS = (2, 11, 12, 13, 14, 15, 18)
ARM_HAND_LABELS = (14, 15)
SHOE_LABELS = (9, 10)
GARMENT_TARGET_LABELS: dict[str, tuple[int, ...]] = {
    "Upper-body": (4,),
    "Lower-body": (5, 6),
    "Dresses": (4, 5, 6, 7),
}
NON_TARGET_GARMENT_LABELS: dict[str, tuple[int, ...]] = {
    "Upper-body": (1, 3, 5, 6, 9, 10, 16),
    "Lower-body": (1, 3, 4, 7, 9, 10, 16, 17),
    "Dresses": (1, 3, 9, 10, 16),
}
MAX_GARMENT_INPAINT_BBOX_FRACTION = 0.04
GARMENT_EDITORIAL_PADDING_RATIO = 0.06

MAX_STORED_JOBS = 64
JOB_TTL_SECONDS = 900.0
MIN_RECOMMENDED_RAM_SINGLE_GPU_GIB = 16.0


def _ensure_fitdit_on_path() -> None:
    if (FITDIT_REPO_DIR / "src" / "pipeline_stable_diffusion_3_tryon.py").exists():
        repo_str = str(FITDIT_REPO_DIR)
        if repo_str not in sys.path:
            sys.path.insert(0, repo_str)
        return

    cwd_candidate = Path.cwd()
    if (cwd_candidate / "src" / "pipeline_stable_diffusion_3_tryon.py").exists():
        cwd_str = str(cwd_candidate)
        if cwd_str not in sys.path:
            sys.path.insert(0, cwd_str)
        return

    raise RuntimeError(
        f"Could not locate FitDiT repository at '{FITDIT_REPO_DIR}'. "
        "Clone https://github.com/BoyuanJiang/FitDiT and set FITDIT_REPO_DIR."
    )


def _read_host_memory_gib() -> dict[str, Optional[float]]:
    """Reads host RAM/swap in GiB on Linux (/proc/meminfo) with safe cross-platform fallback."""
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        parsed: dict[str, int] = {}
        try:
            for line in meminfo.read_text(encoding="utf-8", errors="ignore").splitlines():
                if ":" not in line:
                    continue
                key, rest = line.split(":", 1)
                parts = rest.strip().split()
                if parts and parts[0].isdigit():
                    parsed[key.strip()] = int(parts[0])  # KiB
            kib_to_gib = 1024.0 * 1024.0
            total = parsed.get("MemTotal")
            avail = parsed.get("MemAvailable", parsed.get("MemFree"))
            swap_total = parsed.get("SwapTotal")
            return {
                "host_ram_gib": round(total / kib_to_gib, 1) if total is not None else None,
                "host_ram_available_gib": round(avail / kib_to_gib, 1) if avail is not None else None,
                "host_swap_gib": round(swap_total / kib_to_gib, 1) if swap_total is not None else None,
            }
        except OSError:
            pass

    if hasattr(os, "sysconf"):
        try:
            page_size = os.sysconf("SC_PAGE_SIZE")
            phys_pages = os.sysconf("SC_PHYS_PAGES")
            if isinstance(page_size, int) and isinstance(phys_pages, int) and phys_pages > 0:
                return {
                    "host_ram_gib": round((page_size * phys_pages) / (1024.0**3), 1),
                    "host_ram_available_gib": None,
                    "host_swap_gib": None,
                }
        except (ValueError, OSError):
            pass

    return {
        "host_ram_gib": None,
        "host_ram_available_gib": None,
        "host_swap_gib": None,
    }


def _move_to_device(obj: Any, device: torch.device) -> Any:
    """Recursively moves tensors inside nested tuples/lists/dicts/ModelOutputs to `device`."""
    if isinstance(obj, torch.Tensor):
        return obj if obj.device == device else obj.to(device=device, non_blocking=True)
    if isinstance(obj, list):
        return [_move_to_device(item, device) for item in obj]
    if isinstance(obj, tuple):
        moved = tuple(_move_to_device(item, device) for item in obj)
        if hasattr(obj, "_fields"):
            return type(obj)(*moved)
        return moved
    if isinstance(obj, dict):
        moved_items = {k: _move_to_device(v, device) for k, v in obj.items()}
        if type(obj) is dict:
            return moved_items
        # Handles transformers.utils.ModelOutput (OrderedDict subclass with attr access)
        try:
            return obj.__class__(**moved_items)
        except TypeError:
            return obj.__class__(moved_items)
    return obj


def _assert_tensors_on_device(obj: Any, expected: torch.device, label: str) -> None:
    """Recursively verifies every tensor in `obj` resides on `expected`."""
    if isinstance(obj, torch.Tensor):
        if obj.device != expected:
            raise RuntimeError(
                f"[fitdit-server] Device mismatch in {label}: "
                f"expected {expected}, got {obj.device}"
            )
        return
    if isinstance(obj, (list, tuple)):
        for item in obj:
            _assert_tensors_on_device(item, expected, label)
        return
    if isinstance(obj, dict):
        for val in obj.values():
            _assert_tensors_on_device(val, expected, label)


def _attach_device_bridge(
    module: torch.nn.Module,
    exec_device: torch.device,
    return_device: torch.device,
    name: str,
) -> list[Any]:
    """
    Bridges a module hosted on `exec_device` (e.g. cuda:1) into a pipeline whose
    main denoising loop executes on `return_device` (e.g. cuda:0).
    """

    def pre_hook(_mod: torch.nn.Module, args: tuple[Any, ...], kwargs: dict[str, Any]):
        moved_args = _move_to_device(args, exec_device)
        moved_kwargs = _move_to_device(kwargs, exec_device)
        _assert_tensors_on_device(moved_args, exec_device, f"{name}.pre(args)")
        _assert_tensors_on_device(moved_kwargs, exec_device, f"{name}.pre(kwargs)")
        return moved_args, moved_kwargs

    def post_hook(_mod: torch.nn.Module, _args: tuple[Any, ...], output: Any):
        moved_out = _move_to_device(output, return_device)
        _assert_tensors_on_device(moved_out, return_device, f"{name}.post(output)")
        return moved_out

    h1 = module.register_forward_pre_hook(pre_hook, with_kwargs=True)
    h2 = module.register_forward_hook(post_hook)
    return [h1, h2]


def _module_device(module: torch.nn.Module) -> Optional[torch.device]:
    for p in module.parameters():
        return p.device
    for b in module.buffers():
        return b.device
    return None


def _release_memory() -> None:
    gc.collect()
    if torch.cuda.is_available():
        for idx in range(torch.cuda.device_count()):
            with torch.cuda.device(idx):
                torch.cuda.empty_cache()


def composite_on_studio_backdrop(
    im: Image.Image,
    bg_color: tuple[int, int, int] = STUDIO_FLATLAY_BG,
) -> tuple[Image.Image, Optional[np.ndarray]]:
    """
    Alpha-safely composites a transparent garment Cutout PNG onto the neutral
    `#F6F6F4` studio backdrop (avoiding Pillow `.convert('RGB')` black transparency fill).
    Returns `(rgb_image, alpha_array_or_None)`.
    """
    has_alpha = im.mode in ("RGBA", "LA") or (
        im.mode == "P" and "transparency" in im.info
    )
    if not has_alpha:
        return im.convert("RGB"), None

    rgba = im.convert("RGBA")
    alpha_arr = np.array(rgba.getchannel("A"), dtype=np.uint8)
    canvas = Image.new("RGBA", rgba.size, (*bg_color, 255))
    composited = Image.alpha_composite(canvas, rgba).convert("RGB")
    return composited, alpha_arr


def trim_and_pad_studio_rgba(
    rgba_np: np.ndarray,
    padding_ratio: float = GARMENT_EDITORIAL_PADDING_RATIO,
    bg_color: Optional[tuple[int, int, int]] = STUDIO_FLATLAY_BG,
) -> Image.Image:
    """
    Tightly crops an RGBA garment numpy array to its non-transparent bounds with
    uniform editorial padding (default 6%), returning either a transparent RGBA PNG
    (`bg_color=None`) or a clean `#F6F6F4` RGB studio flat-lay image.
    """
    h, w = rgba_np.shape[:2]
    alpha = rgba_np[:, :, 3]
    ys, xs = np.where(alpha >= 12)
    if ys.size == 0 or xs.size == 0:
        pil_rgba = Image.fromarray(rgba_np, mode="RGBA")
        if bg_color is None:
            return pil_rgba
        bg = Image.new("RGBA", pil_rgba.size, (*bg_color, 255))
        return Image.alpha_composite(bg, pil_rgba).convert("RGB")

    min_x, max_x = int(xs.min()), int(xs.max())
    min_y, max_y = int(ys.min()), int(ys.max())
    crop_w = max_x - min_x + 1
    crop_h = max_y - min_y + 1
    pad = max(8, int(round(max(crop_w, crop_h) * padding_ratio)))

    out_w = crop_w + pad * 2
    out_h = crop_h + pad * 2
    out_rgba = np.zeros((out_h, out_w, 4), dtype=np.uint8)
    out_rgba[pad : pad + crop_h, pad : pad + crop_w] = rgba_np[
        min_y : max_y + 1, min_x : max_x + 1
    ]

    pil_rgba = Image.fromarray(out_rgba, mode="RGBA")
    if bg_color is None:
        return pil_rgba
    bg = Image.new("RGBA", (out_w, out_h), (*bg_color, 255))
    return Image.alpha_composite(bg, pil_rgba).convert("RGB")


def _find_small_occlusion_holes_np(
    target_mask: np.ndarray,
    hard_occ_mask: np.ndarray,
) -> np.ndarray:
    """
    Detects small enclosed interior holes AND concave Arm/Hand/Shoe waistband/cuff
    notches strictly under 4% of the garment bounding box for Telea inpainting.
    """
    h, w = target_mask.shape
    inpaint_mask = np.zeros((h, w), dtype=np.uint8)
    ys, xs = np.where(target_mask > 0)
    if ys.size == 0 or xs.size == 0:
        return inpaint_mask

    min_y, max_y = int(ys.min()), int(ys.max())
    min_x, max_x = int(xs.min()), int(xs.max())
    bbox_w = max_x - min_x + 1
    bbox_h = max_y - min_y + 1
    max_hole_area = max(16, int(bbox_w * bbox_h * MAX_GARMENT_INPAINT_BBOX_FRACTION))

    candidate = np.zeros((h, w), dtype=np.uint8)

    # 1. Enclosed interior holes via border flood-fill
    if cv2 is not None:
        inv = ((target_mask == 0).astype(np.uint8)) * 255
        padded = np.pad(inv, pad_width=1, mode="constant", constant_values=255)
        ff_mask = np.zeros((h + 4, w + 4), dtype=np.uint8)
        cv2.floodFill(padded, ff_mask, (0, 0), 128)
        exterior = padded[1:-1, 1:-1] == 128
        candidate[(target_mask == 0) & (~exterior)] = 1

    # 2. Short concave Arm/Hand & Shoe notches flanked by garment pixels
    max_bridge_x = max(6, min(56, int(round(bbox_w * 0.18))))
    for y in range(min_y, max_y + 1):
        row_t = np.flatnonzero(target_mask[y, min_x : max_x + 1])
        if row_t.size < 2:
            continue
        diffs = np.diff(row_t)
        gap_indices = np.flatnonzero((diffs > 1) & (diffs <= max_bridge_x + 1))
        for gi in gap_indices:
            gx0 = min_x + int(row_t[gi]) + 1
            gx1 = min_x + int(row_t[gi + 1])
            if np.all(hard_occ_mask[y, gx0:gx1] > 0):
                candidate[y, gx0:gx1] = 1

    if not np.any(candidate):
        return inpaint_mask

    if cv2 is not None:
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(
            candidate, connectivity=4
        )
        total_inpaint = 0
        for lbl in range(1, num_labels):
            area = int(stats[lbl, cv2.CC_STAT_AREA])
            if area <= max_hole_area and total_inpaint + area <= max_hole_area * 2:
                inpaint_mask[labels == lbl] = 1
                total_inpaint += area
    else:
        if int(candidate.sum()) <= max_hole_area:
            inpaint_mask = candidate

    return inpaint_mask


def isolate_garment_from_parse(
    garment_rgb: Image.Image,
    orig_alpha: Optional[np.ndarray],
    parse_array: np.ndarray,
    fitdit_category: str,
    bg_color: Optional[tuple[int, int, int]] = STUDIO_FLATLAY_BG,
) -> tuple[Image.Image, bool]:
    """
    Server-side semantic guardrail ensuring `garment_img` passed into CLIP-L/CLIP-bigG
    and `transformer_garm` contains zero skin/shoe/other-garment pixels outside
    `fitdit_category` (`Upper-body`, `Lower-body`, `Dresses`).

    Returns `(isolated_image, did_strip_contamination)`.
    """
    rgb_np = np.array(garment_rgb.convert("RGB"), dtype=np.uint8)
    h, w = rgb_np.shape[:2]

    if parse_array.shape[:2] != (h, w):
        parse_pil = Image.fromarray(parse_array.astype(np.uint8), mode="L").resize(
            (w, h), Image.NEAREST
        )
        parse_resized = np.array(parse_pil, dtype=np.uint8)
    else:
        parse_resized = parse_array.astype(np.uint8)

    if orig_alpha is not None and orig_alpha.shape[:2] == (h, w):
        fg_mask = orig_alpha >= 20
        base_alpha = orig_alpha.copy()
    else:
        # Estimate foreground from non-background parse labels OR border color difference
        border_pixels = np.concatenate(
            [rgb_np[0, :], rgb_np[-1, :], rgb_np[:, 0], rgb_np[:, -1]], axis=0
        )
        bg_med = np.median(border_pixels, axis=0)
        color_dist = np.abs(rgb_np.astype(np.int16) - bg_med.astype(np.int16)).sum(
            axis=2
        )
        fg_mask = (parse_resized > 0) | (color_dist > 28)
        base_alpha = np.where(fg_mask, 255, 0).astype(np.uint8)

    fg_count = int(fg_mask.sum())
    if fg_count < 64:
        clean = trim_and_pad_studio_rgba(
            np.dstack([rgb_np, base_alpha]), bg_color=bg_color
        )
        return clean, False

    target_ids = GARMENT_TARGET_LABELS.get(fitdit_category, (4,))
    if fitdit_category == "Upper-body":
        upper_cov = float(((parse_resized == 4) & fg_mask).sum()) / fg_count
        dress_cov = float(((parse_resized == 7) & fg_mask).sum()) / fg_count
        if upper_cov < 0.008 and dress_cov >= 0.03:
            target_ids = (7, 8) if dress_cov >= 0.05 else (7,)
        elif upper_cov >= 0.05:
            # Preserve sewn-in waist belts on moto jackets / trench coats
            target_ids = (4, 8)

    skin_mask = np.isin(parse_resized, SKIN_AND_HEAD_LABELS)
    arm_shoe_mask = np.isin(parse_resized, ARM_HAND_LABELS + SHOE_LABELS)
    non_target_cloth = np.isin(
        parse_resized, NON_TARGET_GARMENT_LABELS.get(fitdit_category, ())
    )
    target_bool = np.isin(parse_resized, target_ids) & fg_mask

    skin_ratio = float(((skin_mask | arm_shoe_mask) & fg_mask).sum()) / fg_count
    non_target_cloth_ratio = float((non_target_cloth & fg_mask).sum()) / fg_count
    target_ratio = float(target_bool.sum()) / fg_count

    # Already cleanly isolated flat-lay cutout (tolerates 1-4% SegFormer false positives on
    # glossy leather jackets / dark linings): trim & center cleanly onto #F6F6F4 untouched.
    if (skin_ratio < 0.055 and non_target_cloth_ratio < 0.06) or target_ratio < 0.02:
        clean = trim_and_pad_studio_rgba(
            np.dstack([rgb_np, base_alpha]), bg_color=bg_color
        )
        return clean, False

    target_u8 = target_bool.astype(np.uint8)
    hard_occ_u8 = (arm_shoe_mask & fg_mask).astype(np.uint8)
    soft_other_u8 = ((skin_mask | non_target_cloth) & fg_mask).astype(np.uint8)

    if cv2 is not None:
        kernel_r2 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        kernel_r1 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        dilated_hard_occ = cv2.dilate(hard_occ_u8, kernel_r2, iterations=1)
        dilated_soft_other = cv2.dilate(soft_other_u8, kernel_r1, iterations=1)
    else:
        dilated_hard_occ = hard_occ_u8
        dilated_soft_other = soft_other_u8

    target_u8[(dilated_hard_occ > 0) | (dilated_soft_other > 0)] = 0

    # Reclaim foreground pixels that the garment parser dropped to Background (0)
    # (e.g. glossy leather jacket sleeve creases or dark hardware) strictly when their
    # boundary is dominated by target garment pixels rather than non-target/occluder walls.
    if cv2 is not None:
        non_target_wall = (dilated_hard_occ > 0) | (dilated_soft_other > 0)
        bg_dropout = (
            fg_mask & (parse_resized == 0) & (target_u8 == 0) & (~non_target_wall)
        ).astype(np.uint8)
        if np.any(bg_dropout):
            n_drop, drop_labels = cv2.connectedComponents(bg_dropout, connectivity=4)
            if n_drop > 1:
                k4 = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=np.uint8)
                target_adj = cv2.dilate(target_u8, k4, iterations=1) > 0
                wall_adj = cv2.dilate(non_target_wall.astype(np.uint8), k4, iterations=1) > 0
                for lbl in range(1, n_drop):
                    comp = drop_labels == lbl
                    touch_target = int((comp & target_adj).sum())
                    if touch_target == 0:
                        continue
                    touch_wall = int((comp & wall_adj).sum())
                    if touch_target >= touch_wall * 2.5:
                        target_u8[comp] = 1

    # Keep significant connected components (>= 3% of largest component)
    if cv2 is not None:
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(
            target_u8, connectivity=4
        )
        if num_labels > 1:
            areas = stats[1:, cv2.CC_STAT_AREA]
            max_area = int(areas.max()) if areas.size > 0 else 0
            keep_min = max(48, int(max_area * 0.03))
            cleaned = np.zeros_like(target_u8)
            for lbl in range(1, num_labels):
                if int(stats[lbl, cv2.CC_STAT_AREA]) >= keep_min:
                    cleaned[labels == lbl] = 1
            target_u8 = cleaned

    if int(target_u8.sum()) < 64:
        clean = trim_and_pad_studio_rgba(
            np.dstack([rgb_np, base_alpha]), bg_color=bg_color
        )
        return clean, False

    # Inpaint small occlusion holes (< 4% bbox) via OpenCV Telea
    inpaint_mask = _find_small_occlusion_holes_np(target_u8, dilated_hard_occ)
    work_rgb = rgb_np.copy()
    if cv2 is not None and np.any(inpaint_mask):
        inpaint_u8 = (inpaint_mask * 255).astype(np.uint8)
        work_bgr = cv2.inpaint(
            work_rgb[:, :, ::-1], inpaint_u8, inpaintRadius=5, flags=cv2.INPAINT_TELEA
        )
        work_rgb = work_bgr[:, :, ::-1]
        target_u8[inpaint_mask > 0] = 1
        base_alpha[inpaint_mask > 0] = 255

    # 1.5px inward anti-aliased alpha feather along semantic cut edges:
    # stripped non-target pixels (`target_u8 == 0`) remain strictly alpha=0 so zero
    # skin/shoe/shirt RGB leaks across the cut boundary.
    sem_255 = (target_u8 * 255).astype(np.uint8)
    if cv2 is not None:
        feathered_sem = cv2.GaussianBlur(sem_255, (5, 5), sigmaX=1.0)
        cut_region = ((target_u8 == 0) & (base_alpha >= 16)).astype(np.uint8)
        near_cut = (
            cv2.dilate(
                cut_region,
                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
                iterations=1,
            )
            > 0
        )
        final_alpha = np.where(
            target_u8 == 0,
            0,
            np.where(
                near_cut,
                (
                    (base_alpha.astype(np.uint16) * feathered_sem.astype(np.uint16))
                    // 255
                ).astype(np.uint8),
                base_alpha,
            ),
        ).astype(np.uint8)
    else:
        final_alpha = np.where(target_u8 > 0, base_alpha, 0).astype(np.uint8)

    final_alpha[final_alpha < 10] = 0
    isolated = trim_and_pad_studio_rgba(
        np.dstack([work_rgb, final_alpha]), bg_color=bg_color
    )
    return isolated, True


def pad_and_resize(
    im: Image.Image,
    new_width: int = 768,
    new_height: int = 1024,
    pad_color: tuple[int, int, int] = (255, 255, 255),
    mode: int = Image.LANCZOS,
) -> tuple[Image.Image, int, int]:
    old_width, old_height = im.size
    ratio_w = new_width / max(1, old_width)
    ratio_h = new_height / max(1, old_height)
    if ratio_w < ratio_h:
        new_size = (new_width, max(1, round(old_height * ratio_w)))
    else:
        new_size = (max(1, round(old_width * ratio_h)), new_height)

    im_resized = im.resize(new_size, mode)
    pad_w = math.ceil((new_width - im_resized.width) / 2)
    pad_h = math.ceil((new_height - im_resized.height) / 2)

    new_im = Image.new("RGB", (new_width, new_height), pad_color)
    new_im.paste(im_resized, (pad_w, pad_h))
    return new_im, pad_w, pad_h


def unpad_preserve_hd(
    padded_im: Image.Image,
    pad_w: int,
    pad_h: int,
) -> Image.Image:
    width, height = padded_im.size
    left = max(0, pad_w)
    top = max(0, pad_h)
    right = max(left + 1, width - pad_w)
    bottom = max(top + 1, height - pad_h)
    return padded_im.crop((left, top, right, bottom))


def resize_for_detector(img: Image.Image, target_size: int = 768) -> Image.Image:
    width, height = img.size
    scale = target_size / max(1, min(width, height))
    return img.resize(
        (max(1, int(round(width * scale))), max(1, int(round(height * scale)))),
        Image.LANCZOS,
    )


def detect_device_info() -> dict[str, object]:
    cuda_available = torch.cuda.is_available()
    gpu_count = torch.cuda.device_count() if cuda_available else 0
    gpu_names = (
        [torch.cuda.get_device_name(i) for i in range(gpu_count)]
        if cuda_available
        else []
    )
    vram_per_gpu = (
        [
            round(torch.cuda.get_device_properties(i).total_memory / (1024**3), 1)
            for i in range(gpu_count)
        ]
        if cuda_available
        else []
    )
    cc = torch.cuda.get_device_capability(0) if cuda_available else (0, 0)
    host_mem = _read_host_memory_gib()
    return {
        "device": "cuda:0" if cuda_available else "cpu",
        "cuda": cuda_available,
        "gpu": gpu_names[0] if gpu_names else None,
        "gpus": gpu_names,
        "gpu_count": gpu_count,
        "vram_gb": vram_per_gpu[0] if vram_per_gpu else 0.0,
        "vram_total_gb": round(sum(vram_per_gpu), 1),
        "compute_capability": f"{cc[0]}.{cc[1]}" if cuda_available else None,
        "cc_major": cc[0],
        **host_mem,
    }


def _resolve_offload_mode(device_info: dict[str, object]) -> str:
    if not device_info["cuda"]:
        return "none"
    gpu_count = int(device_info.get("gpu_count") or 0)
    if FITDIT_OFFLOAD == "dual-gpu":
        if gpu_count >= 2:
            return "dual-gpu"
        print(
            "[fitdit-server] WARNING: FITDIT_OFFLOAD=dual-gpu requested, "
            f"but only {gpu_count} CUDA device detected; falling back to 'model' offload."
        )
        return "model"
    if FITDIT_OFFLOAD in ("model", "aggressive", "none"):
        return FITDIT_OFFLOAD

    # Auto mode:
    # - 2+ GPUs (e.g. Kaggle T4 x 2): split across cuda:0 + cuda:1 (zero CPU offload!)
    # - Single GPU >= 28 GB VRAM (e.g. A100/A6000): keep all weights resident on cuda:0
    # - Single GPU < 28 GB VRAM: model CPU offload (requires >= 18 GiB host RAM)
    if gpu_count >= 2:
        return "dual-gpu"
    vram_gb = float(device_info["vram_gb"] or 0.0)
    if vram_gb >= 28.0:
        return "none"
    return "model"


def _resolve_weight_dtype(device_info: dict[str, object]) -> torch.dtype:
    if not device_info["cuda"]:
        return torch.float32
    cc_major = int(device_info["cc_major"] or 0)
    # Turing/Volta (Tesla T4, sm_75): native fp16 Tensor Cores (fast, crisp).
    # Ampere+ (L4/A100, sm >= 8.0): native bfloat16.
    return torch.bfloat16 if cc_major >= 8 else torch.float16


def _log_host_ram_check(device_info: dict[str, object], offload_mode: str) -> None:
    ram_gib = device_info.get("host_ram_gib")
    avail_gib = device_info.get("host_ram_available_gib")
    swap_gib = device_info.get("host_swap_gib")
    gpu_count = int(device_info.get("gpu_count") or 0)
    print(
        f"[fitdit-server] Host RAM: total={ram_gib} GiB, avail={avail_gib} GiB, "
        f"swap={swap_gib} GiB | GPUs={gpu_count} ({device_info.get('gpus')}) | "
        f"placement={offload_mode}"
    )
    if (
        isinstance(ram_gib, (int, float))
        and ram_gib < MIN_RECOMMENDED_RAM_SINGLE_GPU_GIB
        and offload_mode != "dual-gpu"
    ):
        print(
            "[fitdit-server] WARNING: Host RAM is "
            f"{ram_gib} GiB (swap={swap_gib} GiB) with single GPU + '{offload_mode}' offload. "
            "FitDiT (~15.2 GB steady-state including laion/CLIP-ViT-bigG-14's 9.99 GB shard) "
            "frequently triggers Linux OOM-kill on 12 GiB / 0B-swap Colab T4 runtimes. "
            "Use free Kaggle `GPU T4 x2` (~30 GiB RAM, dual-gpu) or run `server.py` "
            "(fashn-vton-1.5) on 12 GiB Colab T4."
        )


class FitDiTRunner:
    def __init__(self, model_root: Path, device_info: dict[str, object]) -> None:
        _ensure_fitdit_on_path()

        from preprocess.dwpose import DWposeDetector
        from preprocess.humanparsing.run_parsing import Parsing
        from src.pipeline_stable_diffusion_3_tryon import (
            StableDiffusion3TryOnPipeline,
        )
        from src.pose_guider import PoseGuider
        from src.transformer_sd3_garm import (
            SD3Transformer2DModel as SD3Transformer2DModel_Garm,
        )
        from src.transformer_sd3_vton import (
            SD3Transformer2DModel as SD3Transformer2DModel_Vton,
        )
        from src.utils_mask import get_mask_location
        from transformers import CLIPVisionModelWithProjection

        self.get_mask_location = get_mask_location
        self.device = str(device_info["device"])
        self.weight_dtype = _resolve_weight_dtype(device_info)
        self.offload_mode = _resolve_offload_mode(device_info)
        self._bridge_handles: list[Any] = []

        _log_host_ram_check(device_info, self.offload_mode)

        is_dual_gpu = self.offload_mode == "dual-gpu"
        main_device = torch.device("cuda:0") if is_dual_gpu else torch.device(self.device)
        cond_device = torch.device("cuda:1") if is_dual_gpu else main_device
        model_root_str = str(model_root)

        # Load every component sequentially with `low_cpu_mem_usage=True` and explicit
        # `gc.collect()` between loads. In `dual-gpu` mode (Kaggle T4 x 2), each module
        # moves directly onto its target GPU immediately after loading so peak host RAM
        # stays low (~6-7 GiB) instead of holding all ~15 GB in CPU RAM simultaneously.
        print("[fitdit-server] [1/6] Loading transformer_garm...")
        transformer_garm = SD3Transformer2DModel_Garm.from_pretrained(
            os.path.join(model_root_str, "transformer_garm"),
            torch_dtype=self.weight_dtype,
            low_cpu_mem_usage=True,
        )
        if is_dual_gpu:
            transformer_garm.to(device=cond_device, dtype=self.weight_dtype)
        _release_memory()

        print("[fitdit-server] [2/6] Loading transformer_vton...")
        transformer_vton = SD3Transformer2DModel_Vton.from_pretrained(
            os.path.join(model_root_str, "transformer_vton"),
            torch_dtype=self.weight_dtype,
            low_cpu_mem_usage=True,
        )
        if is_dual_gpu:
            transformer_vton.to(device=main_device, dtype=self.weight_dtype)
        _release_memory()

        print("[fitdit-server] [3/6] Loading pose_guider...")
        pose_guider = PoseGuider(
            conditioning_embedding_channels=1536,
            conditioning_channels=3,
            block_out_channels=(32, 64, 256, 512),
        )
        pose_ckpt = os.path.join(
            model_root_str, "pose_guider", "diffusion_pytorch_model.bin"
        )
        try:
            state_dict = torch.load(pose_ckpt, map_location="cpu", weights_only=True)
        except TypeError:
            state_dict = torch.load(pose_ckpt, map_location="cpu")
        pose_guider.load_state_dict(state_dict)
        del state_dict
        if is_dual_gpu:
            pose_guider.to(device=main_device, dtype=self.weight_dtype)
        else:
            pose_guider.to(dtype=self.weight_dtype)
        _release_memory()

        print("[fitdit-server] [4/6] Loading CLIP-ViT-large...")
        image_encoder_large = CLIPVisionModelWithProjection.from_pretrained(
            "openai/clip-vit-large-patch14",
            torch_dtype=self.weight_dtype,
            low_cpu_mem_usage=True,
        )
        if is_dual_gpu:
            image_encoder_large.to(device=cond_device, dtype=self.weight_dtype)
        _release_memory()

        print("[fitdit-server] [5/6] Loading CLIP-ViT-bigG...")
        image_encoder_bigG = CLIPVisionModelWithProjection.from_pretrained(
            "laion/CLIP-ViT-bigG-14-laion2B-39B-b160k",
            torch_dtype=self.weight_dtype,
            low_cpu_mem_usage=True,
        )
        if is_dual_gpu:
            image_encoder_bigG.to(device=cond_device, dtype=self.weight_dtype)
        _release_memory()

        print("[fitdit-server] [6/6] Assembling StableDiffusion3TryOnPipeline (VAE + scheduler)...")
        self.pipeline = StableDiffusion3TryOnPipeline.from_pretrained(
            model_root_str,
            torch_dtype=self.weight_dtype,
            low_cpu_mem_usage=True,
            transformer_garm=transformer_garm,
            transformer_vton=transformer_vton,
            pose_guider=pose_guider,
            image_encoder_large=image_encoder_large,
            image_encoder_bigG=image_encoder_bigG,
        )
        _release_memory()

        if is_dual_gpu:
            self.pipeline.vae.to(device=main_device, dtype=self.weight_dtype)

            # Force DiffusionPipeline._execution_device -> main_device (cuda:0).
            # In diffusers 0.31, _execution_device scans components alphabetically
            # (image_encoder_bigG comes before vae/transformer_vton) and would
            # otherwise return cuda:1, causing pose_guider/vae/transformer_vton
            # (all on cuda:0) to receive cuda:1 tensors during __call__.
            base_cls = self.pipeline.__class__

            class _MainDevicePipeline(base_cls):  # type: ignore[valid-type, misc]
                @property
                def _execution_device(self) -> torch.device:
                    return main_device

            self.pipeline.__class__ = _MainDevicePipeline

            self._bridge_handles.extend(
                _attach_device_bridge(
                    self.pipeline.image_encoder_large,
                    exec_device=cond_device,
                    return_device=main_device,
                    name="image_encoder_large",
                )
            )
            self._bridge_handles.extend(
                _attach_device_bridge(
                    self.pipeline.image_encoder_bigG,
                    exec_device=cond_device,
                    return_device=main_device,
                    name="image_encoder_bigG",
                )
            )
            self._bridge_handles.extend(
                _attach_device_bridge(
                    self.pipeline.transformer_garm,
                    exec_device=cond_device,
                    return_device=main_device,
                    name="transformer_garm",
                )
            )
            self._verify_dual_gpu_alignment(main_device, cond_device)
            # Keep ONNX pose/parsing detectors on CPU so both GPUs remain clean for SD3 DiT
            self.dwprocessor = DWposeDetector(model_root=model_root_str, device="cpu")
            self.parsing_model = Parsing(model_root=model_root_str, device="cpu")
        elif self.offload_mode == "model":
            # Do NOT call pipeline.to("cuda:0") before enabling CPU offload
            self.pipeline.enable_model_cpu_offload()
            self.dwprocessor = DWposeDetector(model_root=model_root_str, device="cpu")
            self.parsing_model = Parsing(model_root=model_root_str, device="cpu")
        elif self.offload_mode == "aggressive":
            self.pipeline.enable_sequential_cpu_offload()
            self.dwprocessor = DWposeDetector(model_root=model_root_str, device="cpu")
            self.parsing_model = Parsing(model_root=model_root_str, device="cpu")
        else:
            self.pipeline.to(self.device)
            self.dwprocessor = DWposeDetector(
                model_root=model_root_str, device=self.device
            )
            self.parsing_model = Parsing(
                model_root=model_root_str, device=self.device
            )

        if hasattr(self.pipeline, "vae") and hasattr(
            self.pipeline.vae, "enable_tiling"
        ):
            self.pipeline.vae.enable_tiling()

        _release_memory()

    def _verify_dual_gpu_alignment(
        self, main_device: torch.device, cond_device: torch.device
    ) -> None:
        expected_map = {
            "vae": main_device,
            "pose_guider": main_device,
            "transformer_vton": main_device,
            "image_encoder_large": cond_device,
            "image_encoder_bigG": cond_device,
            "transformer_garm": cond_device,
        }
        for attr, expected in expected_map.items():
            mod = getattr(self.pipeline, attr, None)
            actual = _module_device(mod) if isinstance(mod, torch.nn.Module) else None
            if actual != expected:
                raise RuntimeError(
                    f"[fitdit-server] Dual-GPU placement check failed for '{attr}': "
                    f"expected {expected}, got {actual}"
                )
        exec_dev = self.pipeline._execution_device
        if exec_dev != main_device:
            raise RuntimeError(
                f"[fitdit-server] Pipeline _execution_device mismatch: "
                f"expected {main_device}, got {exec_dev}"
            )
        print(
            f"[fitdit-server] Dual-GPU alignment verified: "
            f"main={main_device} (vae, pose_guider, transformer_vton) | "
            f"cond={cond_device} (CLIP-L, CLIP-bigG, transformer_garm) | "
            f"_execution_device={exec_dev}"
        )

    def _build_mask_and_pose(
        self,
        vton_img: Image.Image,
        fitdit_category: str,
    ) -> tuple[Image.Image, Image.Image]:
        vton_img_det = resize_for_detector(vton_img, target_size=768)
        pose_bgr, _keypoints, _, candidate = self.dwprocessor(
            np.array(vton_img_det)[:, :, ::-1]
        )
        candidate = np.array(candidate, copy=True)
        candidate[candidate < 0] = 0
        if candidate.ndim >= 3 and candidate.shape[0] > 0:
            candidate = candidate[0]
        candidate[:, 0] *= vton_img_det.width
        candidate[:, 1] *= vton_img_det.height

        pose_image = Image.fromarray(pose_bgr[:, :, ::-1])
        model_parse, _ = self.parsing_model(vton_img_det)

        mask, _mask_gray = self.get_mask_location(
            fitdit_category,
            model_parse,
            candidate,
            model_parse.width,
            model_parse.height,
            0,
            0,
            0,
            0,
        )
        mask = mask.resize(vton_img.size).convert("L")
        return mask, pose_image

    def _sanitize_garment_for_category(
        self,
        garment_img: Image.Image,
        fitdit_category: str,
        bg_color: Optional[tuple[int, int, int]] = STUDIO_FLATLAY_BG,
    ) -> tuple[Image.Image, bool]:
        """
        Server-side garment guardrail before `transformer_garm` + `CLIP-L`/`CLIP-bigG`:
        composites transparent cutouts onto `#F6F6F4` and strips any non-target skin,
        shoes, or other-category garments detected by FitDiT's ATR+LIP `Parsing` model.
        """
        garment_rgb, orig_alpha = composite_on_studio_backdrop(
            garment_img, bg_color=STUDIO_FLATLAY_BG
        )
        try:
            garm_det = resize_for_detector(garment_rgb, target_size=768)
            garm_parse, _ = self.parsing_model(garm_det)
            parse_arr = np.array(garm_parse, dtype=np.uint8)
            return isolate_garment_from_parse(
                garment_rgb=garment_rgb,
                orig_alpha=orig_alpha,
                parse_array=parse_arr,
                fitdit_category=fitdit_category,
                bg_color=bg_color,
            )
        except Exception as exc:
            print(
                f"[fitdit-server] WARNING: Garment isolation guardrail skipped ({exc}); "
                "using studio-composited garment."
            )
            if orig_alpha is not None:
                return (
                    trim_and_pad_studio_rgba(
                        np.dstack([np.array(garment_rgb, dtype=np.uint8), orig_alpha]),
                        bg_color=bg_color,
                    ),
                    False,
                )
            return garment_rgb, False

    def _run_at_resolution(
        self,
        person_img: Image.Image,
        garment_img: Image.Image,
        mask: Image.Image,
        pose_image: Image.Image,
        steps: int,
        guidance_scale: float,
        seed: int,
        resolution: str,
    ) -> Image.Image:
        new_width, new_height = (int(part) for part in resolution.split("x"))
        garm_pad, _, _ = pad_and_resize(
            garment_img,
            new_width=new_width,
            new_height=new_height,
            pad_color=STUDIO_FLATLAY_BG,
        )
        person_pad, pad_w, pad_h = pad_and_resize(
            person_img, new_width=new_width, new_height=new_height
        )
        mask_pad, _, _ = pad_and_resize(
            mask.convert("RGB"),
            new_width=new_width,
            new_height=new_height,
            pad_color=(0, 0, 0),
        )
        mask_pad = mask_pad.convert("L")
        pose_pad, _, _ = pad_and_resize(
            pose_image.convert("RGB"),
            new_width=new_width,
            new_height=new_height,
            pad_color=(0, 0, 0),
        )

        generator = torch.Generator("cpu").manual_seed(seed)
        images = self.pipeline(
            height=new_height,
            width=new_width,
            guidance_scale=guidance_scale,
            num_inference_steps=steps,
            generator=generator,
            cloth_image=garm_pad,
            model_image=person_pad,
            mask=mask_pad,
            pose_image=pose_pad,
            num_images_per_prompt=1,
        ).images
        return unpad_preserve_hd(images[0], pad_w, pad_h)

    def run(
        self,
        person_img: Image.Image,
        garment_img: Image.Image,
        fitdit_category: str,
        steps: int,
        guidance_scale: float,
        seed: int,
        resolution: str,
    ) -> tuple[bytes, str]:
        with torch.inference_mode():
            clean_garment, stripped = self._sanitize_garment_for_category(
                garment_img, fitdit_category, bg_color=STUDIO_FLATLAY_BG
            )
            if stripped:
                print(
                    f"[fitdit-server] Garment guardrail isolated '{fitdit_category}' "
                    f"onto #F6F6F4 studio canvas ({clean_garment.width}x{clean_garment.height})."
                )
            mask, pose_image = self._build_mask_and_pose(person_img, fitdit_category)
            active_res = resolution
            try:
                out_img = self._run_at_resolution(
                    person_img=person_img,
                    garment_img=clean_garment,
                    mask=mask,
                    pose_image=pose_image,
                    steps=steps,
                    guidance_scale=guidance_scale,
                    seed=seed,
                    resolution=active_res,
                )
            except torch.cuda.OutOfMemoryError:
                if active_res == "768x1024":
                    raise
                print(
                    f"[fitdit-server] CUDA OOM at {active_res}, clearing cache and retrying at 768x1024..."
                )
                _release_memory()
                active_res = "768x1024"
                out_img = self._run_at_resolution(
                    person_img=person_img,
                    garment_img=clean_garment,
                    mask=mask,
                    pose_image=pose_image,
                    steps=steps,
                    guidance_scale=guidance_scale,
                    seed=seed,
                    resolution=active_res,
                )

        buf = io.BytesIO()
        out_img.save(buf, format="PNG")
        return buf.getvalue(), active_res

    def isolate_garment_bytes(
        self,
        garment_img: Image.Image,
        fitdit_category: str,
        transparent: bool = True,
    ) -> bytes:
        with torch.inference_mode():
            isolated, _ = self._sanitize_garment_for_category(
                garment_img=garment_img,
                fitdit_category=fitdit_category,
                bg_color=None if transparent else STUDIO_FLATLAY_BG,
            )
        buf = io.BytesIO()
        isolated.save(buf, format="PNG")
        return buf.getvalue()

    def close(self) -> None:
        for handle in self._bridge_handles:
            try:
                handle.remove()
            except Exception:
                pass
        self._bridge_handles.clear()


@dataclass
class TryOnJob:
    job_id: str
    status: str = "queued"
    png_bytes: Optional[bytes] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None


runner: Optional[FitDiTRunner] = None
inference_lock = asyncio.Lock()
jobs: dict[str, TryOnJob] = {}
background_tasks: set[asyncio.Task[None]] = set()


def verify_secret(provided: Optional[str]) -> None:
    if API_SECRET and (provided or "").strip() != API_SECRET:
        raise HTTPException(
            status_code=401, detail="Invalid or missing x-vton-secret."
        )


def prune_stale_jobs() -> None:
    now = time.time()
    expired = [
        job_id
        for job_id, job in jobs.items()
        if job.finished_at is not None and (now - job.finished_at) > JOB_TTL_SECONDS
    ]
    for job_id in expired:
        jobs.pop(job_id, None)

    if len(jobs) > MAX_STORED_JOBS:
        finished = sorted(
            (job for job in jobs.values() if job.finished_at is not None),
            key=lambda j: j.finished_at or j.created_at,
        )
        for job in finished[: max(0, len(jobs) - MAX_STORED_JOBS)]:
            jobs.pop(job.job_id, None)


def _ensure_model_weights() -> Path:
    if (FITDIT_MODEL_DIR / "model_index.json").exists():
        return FITDIT_MODEL_DIR
    print(
        f"[fitdit-server] Downloading ungated BoyuanJiang/FitDiT weights to '{FITDIT_MODEL_DIR}'..."
    )
    FITDIT_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id="BoyuanJiang/FitDiT",
        local_dir=str(FITDIT_MODEL_DIR),
    )
    return FITDIT_MODEL_DIR


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global runner
    device_info = detect_device_info()
    model_dir = _ensure_model_weights()
    print(
        f"[fitdit-server] Loading FitDiT from '{model_dir}' on {device_info['device']} "
        f"(gpu_count={device_info['gpu_count']}, vram_total={device_info['vram_total_gb']}GB, "
        f"res={FITDIT_RESOLUTION}, offload={_resolve_offload_mode(device_info)})..."
    )
    t0 = time.perf_counter()
    runner = FitDiTRunner(model_dir, device_info)
    elapsed = time.perf_counter() - t0
    print(
        f"[fitdit-server] Ready in {elapsed:.1f}s "
        f"(dtype={runner.weight_dtype}, placement={runner.offload_mode}, res={FITDIT_RESOLUTION})."
    )
    try:
        yield
    finally:
        for task in list(background_tasks):
            task.cancel()
        jobs.clear()
        if runner is not None:
            runner.close()
        runner = None
        _release_memory()


app = FastAPI(
    title="Silho Private VTON Server (FitDiT HD)",
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
        "status": "ok" if runner is not None else "loading",
        "engine": "fitdit",
        "resolution": FITDIT_RESOLUTION,
        "placement": runner.offload_mode if runner is not None else None,
        "offload": runner.offload_mode if runner is not None else None,
        "device": device_info["device"],
        "execution_device": (
            str(runner.pipeline._execution_device) if runner is not None else None
        ),
        "cuda": device_info["cuda"],
        "gpu": device_info["gpu"],
        "gpu_count": device_info["gpu_count"],
        "vram_gb": device_info["vram_gb"],
        "vram_total_gb": device_info["vram_total_gb"],
        "host_ram_gib": device_info["host_ram_gib"],
        "host_ram_available_gib": device_info["host_ram_available_gib"],
        "host_swap_gib": device_info["host_swap_gib"],
        "dtype": str(runner.weight_dtype) if runner is not None else None,
        "model_dir": str(FITDIT_MODEL_DIR),
        "active_jobs": active_jobs,
        "async_jobs": True,
    }


def _run_pipeline_sync(
    person_img: Image.Image,
    garment_img: Image.Image,
    fitdit_category: str,
    num_timesteps: int,
    guidance_scale: float,
    seed: int,
    resolution: str,
) -> tuple[bytes, str]:
    if runner is None:
        raise RuntimeError("FitDiTRunner is not initialized.")
    try:
        return runner.run(
            person_img=person_img,
            garment_img=garment_img,
            fitdit_category=fitdit_category,
            steps=num_timesteps,
            guidance_scale=guidance_scale,
            seed=seed,
            resolution=resolution,
        )
    finally:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


async def _parse_tryon_request(
    person_image: UploadFile,
    garment_image: UploadFile,
    category: str,
    num_timesteps: int,
    guidance_scale: float,
    seed: int,
    resolution: Optional[str],
) -> tuple[Image.Image, Image.Image, str, int, float, int, str]:
    clean_category = category.strip().lower()
    fitdit_category = CATEGORY_MAP.get(clean_category)
    if not fitdit_category:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid category '{category}'. Expected tops, bottoms, or one-pieces.",
        )

    clamped_steps = max(12, min(40, int(num_timesteps)))
    clamped_guidance = max(1.0, min(5.0, float(guidance_scale)))
    chosen_res = (resolution or FITDIT_RESOLUTION).strip()
    if chosen_res not in VALID_RESOLUTIONS:
        chosen_res = FITDIT_RESOLUTION

    person_bytes = await person_image.read()
    garment_bytes = await garment_image.read()
    if not person_bytes or not garment_bytes:
        raise HTTPException(
            status_code=400,
            detail="Both person_image and garment_image files are required.",
        )

    try:
        person_pil = Image.open(io.BytesIO(person_bytes)).convert("RGB")
        # Preserve RGBA alpha channel on garment cutouts so `_sanitize_garment_for_category`
        # composites cleanly onto `#F6F6F4` rather than filling transparency with black.
        garment_raw = Image.open(io.BytesIO(garment_bytes))
        garment_raw.load()
        garment_pil = (
            garment_raw.convert("RGBA")
            if (
                garment_raw.mode in ("RGBA", "LA")
                or (garment_raw.mode == "P" and "transparency" in garment_raw.info)
            )
            else garment_raw.convert("RGB")
        )
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Could not decode input images: {exc}",
        ) from exc

    return (
        person_pil,
        garment_pil,
        fitdit_category,
        clamped_steps,
        clamped_guidance,
        int(seed),
        chosen_res,
    )


async def _execute_job(
    job: TryOnJob,
    person_pil: Image.Image,
    garment_pil: Image.Image,
    fitdit_category: str,
    num_timesteps: int,
    guidance_scale: float,
    seed: int,
    resolution: str,
) -> None:
    t0 = time.perf_counter()
    try:
        async with inference_lock:
            job.status = "running"
            png_bytes, used_res = await asyncio.to_thread(
                _run_pipeline_sync,
                person_pil,
                garment_pil,
                fitdit_category,
                num_timesteps,
                guidance_scale,
                seed,
                resolution,
            )
        job.png_bytes = png_bytes
        job.status = "done"
        elapsed = time.perf_counter() - t0
        print(
            f"[fitdit-server] job={job.job_id[:8]} ok | category={fitdit_category} "
            f"res={used_res} steps={num_timesteps} guidance={guidance_scale:.1f} "
            f"seed={seed} in={person_pil.width}x{person_pil.height} time={elapsed:.2f}s"
        )
    except Exception as exc:
        job.error = str(exc)
        job.status = "error"
        print(f"[fitdit-server] job={job.job_id[:8]} error: {exc}")
    finally:
        job.finished_at = time.time()
        prune_stale_jobs()


@app.post("/jobs")
async def create_job(
    person_image: UploadFile = File(...),
    garment_image: UploadFile = File(...),
    category: str = Form("tops"),
    garment_photo_type: str = Form("flat-lay"),
    num_timesteps: int = Form(25),
    guidance_scale: float = Form(2.0),
    seed: int = Form(42),
    segmentation_free: str = Form("true"),
    resolution: Optional[str] = Form(None),
    x_vton_secret: Optional[str] = Header(default=None, alias="x-vton-secret"),
) -> dict[str, str]:
    del garment_photo_type, segmentation_free
    verify_secret(x_vton_secret)

    if runner is None:
        raise HTTPException(status_code=503, detail="FitDiT pipeline is still loading.")

    parsed = await _parse_tryon_request(
        person_image=person_image,
        garment_image=garment_image,
        category=category,
        num_timesteps=num_timesteps,
        guidance_scale=guidance_scale,
        seed=seed,
        resolution=resolution,
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
    num_timesteps: int = Form(25),
    guidance_scale: float = Form(2.0),
    seed: int = Form(42),
    segmentation_free: str = Form("true"),
    resolution: Optional[str] = Form(None),
    x_vton_secret: Optional[str] = Header(default=None, alias="x-vton-secret"),
) -> Response:
    del garment_photo_type, segmentation_free
    verify_secret(x_vton_secret)

    if runner is None:
        raise HTTPException(status_code=503, detail="FitDiT pipeline is still loading.")

    parsed = await _parse_tryon_request(
        person_image=person_image,
        garment_image=garment_image,
        category=category,
        num_timesteps=num_timesteps,
        guidance_scale=guidance_scale,
        seed=seed,
        resolution=resolution,
    )

    t0 = time.perf_counter()
    async with inference_lock:
        try:
            png_bytes, used_res = await asyncio.to_thread(_run_pipeline_sync, *parsed)
        except Exception as exc:
            print(f"[fitdit-server] Inference error: {exc}")
            raise HTTPException(
                status_code=500, detail=f"Inference failed: {exc}"
            ) from exc

    elapsed = time.perf_counter() - t0
    print(
        f"[fitdit-server] /try-on ok | category={parsed[2]} res={used_res} "
        f"steps={parsed[3]} guidance={parsed[4]:.1f} seed={parsed[5]} time={elapsed:.2f}s"
    )
    return Response(content=png_bytes, media_type="image/png")


@app.post("/isolate-garment")
async def isolate_garment_endpoint(
    image: UploadFile = File(...),
    category: str = Form("tops"),
    background: str = Form("transparent"),
    x_vton_secret: Optional[str] = Header(default=None, alias="x-vton-secret"),
) -> Response:
    verify_secret(x_vton_secret)
    if runner is None:
        raise HTTPException(status_code=503, detail="FitDiT pipeline is still loading.")

    fitdit_category = CATEGORY_MAP.get(category.strip().lower())
    if not fitdit_category:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid category '{category}'. Expected tops, bottoms, or one-pieces.",
        )

    raw_bytes = await image.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="An image file is required.")

    try:
        raw_pil = Image.open(io.BytesIO(raw_bytes))
        raw_pil.load()
        garment_pil = (
            raw_pil.convert("RGBA")
            if (
                raw_pil.mode in ("RGBA", "LA")
                or (raw_pil.mode == "P" and "transparency" in raw_pil.info)
            )
            else raw_pil.convert("RGB")
        )
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not decode garment image: {exc}"
        ) from exc

    transparent = background.strip().lower() != "studio"
    png_bytes = await asyncio.to_thread(
        runner.isolate_garment_bytes,
        garment_pil,
        fitdit_category,
        transparent,
    )
    return Response(content=png_bytes, media_type="image/png")


if __name__ == "__main__":
    host = os.environ.get("VTON_HOST", "0.0.0.0")
    port = int(os.environ.get("VTON_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)
