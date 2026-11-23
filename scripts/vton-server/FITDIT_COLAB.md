# Free \$0 FitDiT HD Server — Kaggle `GPU T4 x2` Guide

Run **FitDiT** (`BoyuanJiang/FitDiT`, SD3 Diffusion Transformer, native **`1152×1536`**, ungated weights) for **\$0** on **Kaggle Notebooks** (**~29–30 GiB RAM + 2× 15 GiB Tesla T4**, 30 free GPU hours/week) with zero 24-hour API quota limits.

> **Why Kaggle `T4 x2` instead of free Google Colab T4?**
> Free Google Colab T4 only provides **12 GiB host RAM with `0B` swap**, which gets Linux OOM-killed while opening `laion/CLIP-ViT-bigG-14`'s `9.99 GB` checkpoint shard (`~15.2 GB` steady-state RAM with CPU offload).
> - **Use Kaggle `GPU T4 x2`** for **FitDiT HD** (`fitdit_server.py` auto-splits across `cuda:0` + `cuda:1` with **zero CPU offload**, using only ~4.0 GB on `cuda:0` and ~8.1 GB on `cuda:1`).
> - **Use `scripts/vton-server/server.py` (`fashn-vton-1.5`)** if you ever want a lightweight fallback on standard 12 GiB Google Colab T4.

---

## Step 0 — Kaggle Notebook Settings (Required)

1. Go to [kaggle.com/code](https://www.kaggle.com/code) → **New Notebook**.
2. In the right **Session options** sidebar:
   - **Accelerator:** select **`GPU T4 x2`** (gives 2× 15 GiB T4s + ~30 GiB RAM).
   - **Internet:** toggle **ON** *(required to clone FitDiT, download ungated Hugging Face weights, and open the Cloudflare Quick Tunnel; Kaggle requires one-time phone verification to enable Internet)*.
   - **Persistence:** optional (`Files only` caches `/kaggle/working` across restarts if desired).

---

## Cell 1 — Verify Hardware, Clone FitDiT & Install Dependencies (~60s)

```bash
!nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader
!free -h

!git clone https://github.com/BoyuanJiang/FitDiT.git /kaggle/working/FitDiT
!pip install -q "diffusers==0.31.0" "transformers==4.44.2" "accelerate==0.34.2" \
    "huggingface_hub>=0.26.5" onnxruntime opencv-python scikit-image einops \
    fastapi uvicorn python-multipart
!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /kaggle/working/cloudflared
!chmod +x /kaggle/working/cloudflared
```

Confirm `nvidia-smi` prints **two** `Tesla T4` lines (`0` and `1`) and `free -h` shows **`~29–31 GiB`** total RAM.

---

## Cell 2 — Upload `fitdit_server.py` into `/kaggle/working/fitdit_server.py`

Either:
- **Option A (Upload):** Click **File → Upload** (or drag `scripts/vton-server/fitdit_server.py` from your local Silho repo into the Kaggle **Output / `/kaggle/working`** file browser), **or**
- **Option B (Paste cell):** Create a cell starting with `%%writefile /kaggle/working/fitdit_server.py` and paste the contents of `scripts/vton-server/fitdit_server.py`.

Verify it exists:

```bash
!ls -lh /kaggle/working/fitdit_server.py
```

---

## Cell 3 — Start FitDiT HD Server (`dual-gpu`) + Cloudflare Tunnel

```python
import os, re, subprocess, time, urllib.request

env = os.environ.copy()
env["FITDIT_REPO_DIR"] = "/kaggle/working/FitDiT"
env["FITDIT_MODEL_DIR"] = "/kaggle/working/fitdit-weights"
env["FITDIT_RESOLUTION"] = "1152x1536"   # Auto-falls back to 768x1024 on OOM
env["FITDIT_OFFLOAD"] = "auto"           # Auto-selects "dual-gpu" on T4 x 2 (cuda:0 + cuda:1)
env["VTON_PORT"] = "8000"

server = subprocess.Popen(
    ["python", "/kaggle/working/fitdit_server.py"],
    env=env,
    stdout=open("/kaggle/working/fitdit.log", "w"),
    stderr=subprocess.STDOUT,
)

print("Loading FitDiT HD on dual T4 (first run downloads ungated weights, ~2–4 min)...")
while True:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=2) as r:
            body = r.read().decode()
            if '"status":"ok"' in body or '"status": "ok"' in body:
                print("\nSERVER READY:", body)
                break
    except Exception:
        pass
    if server.poll() is not None:
        print(open("/kaggle/working/fitdit.log").read()[-3000:])
        raise RuntimeError("fitdit_server.py exited early — see log above")
    time.sleep(4)

print("\nStartup log tail:")
print(open("/kaggle/working/fitdit.log").read()[-1200:])

tunnel = subprocess.Popen(
    ["/kaggle/working/cloudflared", "tunnel", "--url", "http://127.0.0.1:8000"],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)
for line in tunnel.stdout:
    m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
    if m:
        print("\n=== Paste into Silho .env.local ===")
        print(f'VTON_API_URL="{m.group(0)}"')
        print('# Keep WeShopAI primary (default), or uncomment below to run FitDiT HD first:')
        print('# TRYON_PRIMARY_ENGINE="vton-api"')
        break
```

> **Verify in the startup output:**
> - `"engine": "fitdit"`, `"placement": "dual-gpu"`, `"gpu_count": 2`, `"resolution": "1152x1536"`
> - Log line: `[fitdit-server] Dual-GPU alignment verified: main=cuda:0 (vae, pose_guider, transformer_vton) | cond=cuda:1 (CLIP-L, CLIP-bigG, transformer_garm)`

---

## Step 4 — Connect to Silho

1. Paste the printed `https://...trycloudflare.com` URL into Silho's `.env.local` as `VTON_API_URL` (keeping `WeShopAI` primary as the default, so **FitDiT HD** automatically takes over whenever `WeShopAI` hits its 24h cap — or optionally set `TRYON_PRIMARY_ENGINE="vton-api"` to test FitDiT HD directly).
2. Restart Silho (`npm run start`).
3. Expand **Tailor Fit** after a render to confirm the **`FITDIT HD`** badge.

> **Paid Colab High-RAM / L4 note:** If you ever run on a single-GPU High-RAM runtime (`>= 24 GiB` RAM, e.g. Colab L4 or A100), `fitdit_server.py` also works automatically (`FITDIT_OFFLOAD=auto` uses `model` offload on `< 28 GB` VRAM and `none` on `>= 28 GB` VRAM).
