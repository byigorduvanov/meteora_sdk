from fastapi import FastAPI
from .routers import meteora

app = FastAPI(title="Meteora DLMM FastAPI")

@app.get("/health")
def health():
    return {"ok": True}

app.include_router(meteora.router)
