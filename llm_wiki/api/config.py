from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file="../.env", extra="ignore")

    MODE: Literal["local", "hosted"] = "local"
    WORKSPACE_PATH: str = "."

    DATABASE_URL: str = ""
    SUPABASE_URL: str = ""
    SUPABASE_JWT_SECRET: str = ""
    VOYAGE_API_KEY: str = ""
    TURBOPUFFER_API_KEY: str = ""
    EMBEDDING_MODEL: str = "voyage-4-lite"
    EMBEDDING_DIM: int = 512
    LOGFIRE_TOKEN: str = ""
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_REGION: str = "us-east-1"
    S3_BUCKET: str = "supavault-documents"
    MISTRAL_API_KEY: str = ""
    PDF_BACKEND: str = "opendataloader"  # "opendataloader" or "mistral"
    STAGE: str = "dev"
    APP_URL: str = "http://localhost:3000"
    API_URL: str = "http://localhost:8000"

    QUOTA_MAX_PAGES: int = 500  # per-user page limit (free tier)
    QUOTA_MAX_PAGES_PER_DOC: int = 300  # max pages per single document
    QUOTA_MAX_STORAGE_BYTES: int = 1_073_741_824  # 1 GB per user

    CONVERTER_URL: str = ""
    CONVERTER_SECRET: str = ""

    GLOBAL_OCR_ENABLED: bool = True
    GLOBAL_MAX_PAGES: int = 1_000_000
    GLOBAL_MAX_USERS: int = 10_000

    SENTRY_DSN: str = ""

    # Embedding service for semantic search (optional)
    # Point to Ollama or any OpenAI-compatible embedding endpoint
    EMBED_ENDPOINT: str = ""  # e.g., "http://localhost:11434"
    EMBED_MODEL: str = "bge-m3"
    EMBED_DIM: int = 1024

    # When set, local mode uses PostgreSQL instead of SQLite (for unified DB with main platform)
    KB_DATABASE_URL: str = ""

    # Internal HMAC secret shared with the main platform for signed REST proxy requests.
    KB_INTERNAL_SECRET: str = ""

    # Fail-closed switch for KB ACL. When true, no ACL rows means empty access.
    KB_ACL_FAIL_CLOSED: bool = True

    WIKI_LANGUAGE: str = "zh"
    SEARCH_MODE: str = "db"


settings = Settings()
