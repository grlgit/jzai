FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .

EXPOSE 8100
# SOLVER_API_KEY 由 compose environment 注入
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8100"]
