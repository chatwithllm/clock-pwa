# Tiny zero-dependency alert API. Python stdlib only.
FROM python:3.12-alpine
WORKDIR /app
COPY alert_sidecar.py /app/alert_sidecar.py
RUN mkdir -p /data
EXPOSE 8090
CMD ["python3", "/app/alert_sidecar.py"]
