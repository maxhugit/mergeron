FROM cgr.dev/chainguard/wolfi-base:latest
WORKDIR /opt/transcription
# Keep FFmpeg shared libraries for TorchCodec, using the maintained FFmpeg 9
# package rather than Debian's older codec stack. Retain APK provenance for scans.
RUN apk add --no-cache python-3.11 ffmpeg-9.0 libgomp \
 && python3.11 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
COPY requirements.txt ./
# CPU wheels only. The constraints prevent PyPI from replacing them with CUDA builds.
RUN pip install --no-cache-dir --upgrade setuptools==81.0.0 wheel==0.46.3 \
 && pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.11.0 torchaudio==2.11.0 torchcodec==0.17.0 \
 && pip install --no-cache-dir -r requirements.txt \
 && pip check
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-small', revision='536b0662742c02347bc0e980a01041f333bce120', local_dir='/models/asr', allow_patterns=['config.json','model.bin','tokenizer.json','vocabulary.*','preprocessor_config.json'])" \
 && rm -rf /models/asr/.cache \
 && addgroup -g 11003 transcription && adduser -D -H -u 11003 -G transcription transcription
COPY engine.py server.py ./
ARG MERGERON_REVISION=unknown
ARG MERGERON_VERSION=unknown
ARG MERGERON_BUILD_DATE=unknown
ARG MERGERON_RELEASE_CHANNEL=unknown
LABEL org.opencontainers.image.source="https://github.com/maxhugit/mergeron" \
 io.mergeron.version="${MERGERON_VERSION}" io.mergeron.channel="${MERGERON_RELEASE_CHANNEL}" \
 org.opencontainers.image.revision="${MERGERON_REVISION}" org.opencontainers.image.created="${MERGERON_BUILD_DATE}"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 PYANNOTE_METRICS_ENABLED=0 HF_HOME=/tmp/hf OMP_NUM_THREADS=4
USER 11003:11003
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=6 CMD ["python", "-c", "import json,urllib.request; assert json.load(urllib.request.urlopen('http://127.0.0.1:8090/healthz',timeout=2))['ready']"]
CMD ["python", "server.py"]
