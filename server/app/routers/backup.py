import json
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..db import get_db
from ..models import Backup, User
from ..schemas import BackupSaved

router = APIRouter(prefix="/api/backup", tags=["backup"])


@router.put("", response_model=BackupSaved)
async def upload_backup(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    max_bytes = int(os.getenv("MAX_UPLOAD_MB", "20")) * 1024 * 1024
    body = await request.body()
    if len(body) > max_bytes:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="备份超过大小限制")
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="备份不是有效的 JSON")
    if not isinstance(payload, dict) or payload.get("app") != "paiti-rujuan":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不是本应用的备份")
    version = payload.get("version")
    if type(version) is not int or not 1 <= version <= 2:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="备份版本不支持")

    now = datetime.now(timezone.utc)
    data = body.decode("utf-8")
    saved = db.query(Backup).filter(Backup.user_id == user.id).first()
    if saved is None:
        saved = Backup(user_id=user.id, version=version, data=data, updated_at=now)
        db.add(saved)
    else:
        saved.version = version
        saved.data = data
        saved.updated_at = now
    db.commit()
    return {"version": version, "updatedAt": now.isoformat()}


@router.get("")
def download_backup(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    saved = db.query(Backup).filter(Backup.user_id == user.id).first()
    if saved is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="云端还没有备份")
    return Response(content=saved.data, media_type="application/json")
