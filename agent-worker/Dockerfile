# syntax=docker/dockerfile:1.7
# Build context is agent-worker/:  docker build -f agent-worker/Dockerfile agent-worker
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
# Model weights (Silero VAD, turn detector) are fetched at build time as root and
# read at run time as `worker`. Pin the Hugging Face cache inside /app so both see
# the same files; the default (~/.cache) differs per user and the worker crashed
# with "Could not find file model_q8.onnx" on every job.
ENV HF_HOME=/app/.cache/huggingface
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt
COPY agent.py ./
# Pre-download VAD + turn-detector model weights so a cold container never
# fetches them at call time.
RUN python agent.py download-files
RUN useradd --create-home --uid 10001 worker && chown -R worker:worker /app
USER worker
# The worker registers with LiveKit Cloud over an outbound WebSocket; it needs no inbound port.
CMD ["python", "agent.py", "start"]
