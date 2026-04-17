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

# Graceful timeout long enough for Cantera cold-start; 2 workers for light concurrency
CMD ["gunicorn", "app.main:app", \
     "-k", "uvicorn.workers.UvicornWorker", \
     "--bind", "0.0.0.0:8000", \
     "--workers", "2", \
     "--timeout", "180", \
     "--graceful-timeout", "30", \
     "--access-logfile", "-"]
