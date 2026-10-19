import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import Base, engine
from .routers import auth, backup


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="拍题入卷 备份服务", lifespan=lifespan)

if os.getenv("ENV", "development") != "production":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=os.getenv(
            "CORS_ORIGINS", "http://localhost:8081,http://127.0.0.1:8081"
        ).split(","),
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(auth.router)
app.include_router(backup.router)


@app.get("/api/health")
def health():
    return {"ok": True}
