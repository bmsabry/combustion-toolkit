# Combustion Toolkit API — FastAPI + Cantera 3.2 on Python 3.11
FROM python:3.11-slim-bookworm AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System deps for Cantera, scipy, and psycopg2
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libsundials-dev \
    libopenblas-dev \
    libhdf5-dev \
    libfmt-dev \
    libboost-dev \
    pkg-config \
    gfortran \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY app ./app
COPY alembic.ini ./alembic.ini
COPY alembic ./alembic

ENV PORT=8000
EXPOSE 8000

# Worker config tuned for ~100 concurrent paid users on Render Standard
# (2 GB RAM / 1 shared vCPU). Notes:
#   • 4 workers ≈ 4× the previous concurrency. Each worker holds its own
#     Cantera Solution pool (~50–150 MB once warm); 4×150 = 600 MB plus
#     base FastAPI + LRU cache, well under Render's 2 GB ceiling.
#   • Sweeps now run on a SEPARATE thread pool inside each worker and
#     return a job_id immediately — they no longer hold the request open
#     for 540 s, so the per-request timeout can be tighter.
#   • --max-requests 250 recycles workers periodically to release any
#     accumulated Cantera/scipy memory before it becomes a leak. Jitter
#     prevents all workers recycling at the same instant.
#   • --timeout 240 still leaves 360 s of headroom under Render's 600 s
#     HTTP ceiling for the longest single-point solve.
CMD ["gunicorn", "app.main:app", \
     "-k", "uvicorn.workers.UvicornWorker", \
     "--bind", "0.0.0.0:8000", \
     "--workers", "4", \
     "--timeout", "240", \
     "--graceful-timeout", "30", \
     "--max-requests", "250", \
     "--max-requests-jitter", "50", \
     "--access-logfile", "-"]
