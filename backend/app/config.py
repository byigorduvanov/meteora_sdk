from pydantic import BaseModel
from functools import lru_cache
import os

class Settings(BaseModel):
    NODE_HELPER_URL: str = os.getenv("NODE_HELPER_URL", "http://localhost:4000")
    FASTAPI_HOST: str = os.getenv("FASTAPI_HOST", "0.0.0.0")
    FASTAPI_PORT: int = int(os.getenv("FASTAPI_PORT", "8000"))

@lru_cache
def get_settings() -> Settings:
    return Settings()
